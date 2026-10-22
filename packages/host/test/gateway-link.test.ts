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

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "lsh-gateway-link-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise((resolve) => server.once("listening", resolve));
  const sent: { to: string; frame: TunnelFrame }[] = [];
  let machine: WebSocket | undefined;
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ t: "challenge", nonce: "n" }));
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.t === "auth") {
        machine = socket;
        socket.send(JSON.stringify({ t: "ready", userId: "owner" }));
      } else if (frame.t === "req") {
        socket.send(JSON.stringify({ t: "res", id: frame.id, result: frame.method === "devices.list" ? { devices: [] } : {} }));
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
  return { link, sent, transports, deliver, hello };
}

describe("GatewayLink channels", () => {
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
