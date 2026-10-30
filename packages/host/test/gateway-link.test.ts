import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentity, openTunnel, publicIdentity, type Identity, type TunnelFrame } from "@linkshell/wire";
import { GatewayLink } from "../src/gateway.js";
import type { RpcTransport } from "../src/rpc/server.js";

// GatewayLink against a scripted gateway: it signs every peer in to one account and lets the test
// deliver frames "from" any device and read what the host sends back.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function world(options: { update?: (name: string, reply: (error?: { code: string; message: string }) => void) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lsh-gateway-link-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise((resolve) => server.once("listening", resolve));
  const sent: { to: string; frame: TunnelFrame }[] = [];
  const names: string[] = [];
  const signedInNames: string[] = [];
  let machine: WebSocket | undefined;
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ t: "challenge", nonce: "n" }));
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.t === "auth") {
        machine = socket;
        signedInNames.push(frame.name);
        socket.send(JSON.stringify({ t: "ready", userId: "owner" }));
      } else if (frame.t === "req") {
        if (frame.method === "machines.update") {
          names.push(frame.params.name);
          const reply = (error?: { code: string; message: string }) => socket.send(JSON.stringify({ t: "res", id: frame.id, ...(error ? { error } : { result: {} }) }));
          if (options.update) options.update(frame.params.name, reply);
          else reply();
        } else socket.send(JSON.stringify({ t: "res", id: frame.id, result: frame.method === "devices.list" ? { devices: [] } : {} }));
      } else if (frame.t === "to") {
        sent.push({ to: frame.to, frame: JSON.parse(frame.d) });
      }
    });
  });
  const transports: { transport: RpcTransport; closed: boolean }[] = [];
  const address = server.address();
  const link = new GatewayLink({
    url: `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
    home: dir,
    token: () => "account",
    name: "Test Mac",
    serve: (transport) => {
      const entry = { transport, closed: false };
      transports.push(entry);
      transport.onClose(() => (entry.closed = true));
    },
    log: () => {},
  });
  link.start();
  cleanups.push(() => link.stop());
  await until(() => link.status().status === "online");
  const machineIdentity = publicIdentity(link.identity);
  const deliver = (device: Identity, frame: TunnelFrame, via: "paired" | "account" = "account") =>
    machine!.send(JSON.stringify({ t: "from", from: publicIdentity(device), via, d: JSON.stringify(frame) }));
  const hello = (device: Identity, ch: string) => deliver(device, openTunnel(device, machineIdentity, ch).hello);
  return { link, sent, transports, deliver, hello, names, signedInNames };
}

describe("GatewayLink channels", () => {
  it("serializes rapid renames and sends only the latest choice after a delayed acknowledgement", async () => {
    let finishFirst: (() => void) | undefined;
    const { link, names, signedInNames } = await world({ update: (_name, reply) => {
      if (!finishFirst) finishFirst = reply;
      else reply();
    } });
    const first = link.rename("First");
    await until(() => names.length === 1);
    const second = link.rename("Second");
    const latest = link.rename("Latest");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(names).toEqual(["First"]);
    finishFirst!();
    await Promise.all([first, second, latest]);
    await until(() => names.length === 2);
    expect(names).toEqual(["First", "Latest"]);
    expect(signedInNames).toEqual(["Test Mac"]);
  });

  it("retries an unacknowledged metadata write while the connection stays online", async () => {
    let attempted = 0;
    const { link, names, signedInNames } = await world({ update: (_name, reply) => {
      if (++attempted > 1) reply();
    } });
    void link.rename("Office");
    await until(() => names.length === 2, 8000);
    expect(names).toEqual(["Office", "Office"]);
    expect(link.status().status).toBe("online");
    expect(signedInNames).toEqual(["Test Mac"]);
  }, 10_000);

  it("retries ordinary gateway failures with the newest name and cancels retries when stopped", async () => {
    let attempts = 0;
    const { link, names } = await world({ update: (_name, reply) => {
      if (++attempts === 1 || attempts === 3) reply({ code: "internal", message: "temporarily busy" });
      else reply();
    } });
    await link.rename("Before");
    await link.rename("After");
    await until(() => names.length === 2);
    expect(names).toEqual(["Before", "After"]);
    await link.rename("Stop pending retry");
    await until(() => names.length === 3);
    link.stop();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(names).toHaveLength(3);
  });

  it("uses the latest name when an old gateway requires reauthentication", async () => {
    const { link, names, signedInNames } = await world({ update: (_name, reply) => reply({ code: "unknown_method", message: "old gateway" }) });
    await link.rename("Office");
    await until(() => signedInNames.length === 2 && link.status().status === "online");
    await link.rename("Home");
    await until(() => signedInNames.length === 3 && link.status().status === "online");
    expect(signedInNames).toEqual(["Test Mac", "Office", "Home"]);
    expect(names).toEqual(["Office"]);
  });

  it("answers a frame on a channel it doesn't have with close, a limited number of times", async () => {
    const { sent, deliver } = await world();
    const phone = createIdentity();
    deliver(phone, { k: "data", ch: "gone", box: "0.AAAA" });
    await until(() => sent.length === 1);
    expect(sent[0]).toEqual({ to: phone.id, frame: { k: "close", ch: "gone", reason: "unknown channel" } });
    // Again on the same channel: it was told already.
    deliver(phone, { k: "data", ch: "gone", box: "0.AAAA" });
    // A flood over many channels gets a few replies, not one each.
    for (let i = 0; i < 20; i++) deliver(phone, { k: "data", ch: `flood-${i}`, box: "0.AAAA" });
    // A device that couldn't have had a channel here (not paired, not on the account) gets nothing.
    deliver(createIdentity(), { k: "data", ch: "stranger", box: "0.AAAA" }, "paired");
    // A close for an unknown channel is never answered: two sides that both forgot would loop.
    deliver(phone, { k: "close", ch: "other" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sent.map(({ frame }) => frame.ch)).toEqual(["gone", ...Array.from({ length: 7 }, (_, i) => `flood-${i}`)]);
    expect(sent.every(({ to, frame }) => to === phone.id && frame.k === "close")).toBe(true);
  });

  it("keeps at most four channels per device, closing the oldest", async () => {
    const { sent, transports, hello } = await world();
    const watch = createIdentity();
    const phone = createIdentity();
    hello(phone, "phone-1");
    for (let i = 1; i <= 4; i++) hello(watch, `watch-${i}`);
    await until(() => transports.length === 5);
    expect(transports.every((entry) => !entry.closed)).toBe(true);
    hello(watch, "watch-5");
    await until(() => transports.length === 6);
    await until(() => transports[1]!.closed);
    expect(transports.filter((entry) => entry.closed)).toHaveLength(1);
    // The phone's channel is its own.
    expect(transports[0]!.closed).toBe(false);
    expect(sent).toContainEqual({ to: watch.id, frame: { k: "close", ch: "watch-1", reason: "superseded by a newer channel" } });
    // Reopening a channel it holds replaces it and doesn't count twice.
    hello(watch, "watch-5");
    await until(() => transports.length === 7);
    expect(transports.filter((entry) => entry.closed)).toHaveLength(2);
    expect(transports[5]!.closed).toBe(true);
    expect(transports.slice(2, 5).every((entry) => !entry.closed)).toBe(true);
  });
});
