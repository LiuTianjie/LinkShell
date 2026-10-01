import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { HostLink, pairByLink, TunnelSocket } from "../../client-core/src/index.js";
import { startHost, type RunningHost } from "../../host/src/host.js";
import { connectHost, type HostClient } from "../../host/src/rpc/client.js";
import {
  codeSecret,
  createIdentity,
  decodePairingLink,
  pairingProof,
  publicIdentity,
  RELAY_PATH,
  RelayClient,
  type Identity,
  type MachineEntry,
  type RelaySocket,
} from "@linkshell/wire";
import { Gateway, type GatewayOptions } from "../src/server.js";

// A real gateway, a real host and a scripted device, all in-process.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ACCOUNTS: Record<string, { userId: string; email: string }> = {
  "token-alice": { userId: "alice", email: "alice@example.com" },
  "token-bob": { userId: "bob", email: "bob@example.com" },
};

async function world(options: { machineToken?: string; heartbeatMs?: number; admit?: GatewayOptions["admit"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lsh-gw-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const routed: string[] = [];
  const gateway = new Gateway({
    port: 0,
    host: "127.0.0.1",
    databasePath: join(dir, "gateway.db"),
    verifyToken: async (token) => ACCOUNTS[token],
    log: () => {},
    onRouted: (frame) => routed.push(frame),
    heartbeatMs: options.heartbeatMs,
    admit: options.admit,
  });
  const port = await gateway.start();
  cleanups.push(() => gateway.stop());
  const url = `ws://127.0.0.1:${port}`;
  const home = join(dir, "host");
  const host: RunningHost = await startHost({
    home,
    version: "test",
    env: { PATH: process.env.PATH, HOME: dir, SHELL: "/bin/sh", ENV: "", PS1: "$ " },
    drivers: () => [],
    log: () => {},
    gateway: { url, name: "Test Mac", token: options.machineToken ? () => options.machineToken : undefined },
  });
  cleanups.push(() => host.stop());
  const local = await connectHost(host.paths.hostSocket);
  cleanups.push(() => local.close());
  await until(async () => (await local.call("gateway.status", {})).status === "online");
  return { gateway, url, host, local, routed };
}

function device(url: string, name: string, token?: string) {
  const identity = createIdentity();
  const relay = new RelayClient({
    url: url + RELAY_PATH,
    identity,
    role: "device",
    name,
    token: token ? () => token : undefined,
    createSocket: (target) => new WebSocket(target) as unknown as RelaySocket,
  });
  relay.start();
  cleanups.push(() => relay.stop());
  return { identity, relay };
}

function connect(relay: RelayClient, identity: Identity, machine: MachineEntry | ReturnType<typeof publicIdentity>) {
  const link = new HostLink({ url: "tunnel", createSocket: () => new TunnelSocket(relay, identity, machine), heartbeatMs: 0 });
  link.start();
  cleanups.push(() => link.stop());
  return link;
}

async function until(check: () => boolean | Promise<boolean>, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function pairByQr(local: HostClient, relay: RelayClient, identity: Identity) {
  const offer = await local.call("pairing.start", {});
  expect(offer.link.length).toBeLessThan(200);
  const link = decodePairingLink(offer.link)!;
  const machine = await pairByLink(relay, identity, link);
  expect(machine.signKey).toBe(link.signKey);
  return { machine, link, offer };
}

describe("gateway v2 end to end", () => {
  it("pairs by QR and runs RPC and a terminal through the tunnel, sealed", async () => {
    const { url, local, routed } = await world();
    const phone = device(url, "iPhone");
    const paired: string[] = [];
    local.on("pairing.done", ({ device: d }) => paired.push(d.name));
    const { machine } = await pairByQr(local, phone.relay, phone.identity);
    await until(() => paired.includes("iPhone"));

    const link = connect(phone.relay, phone.identity, machine);
    const info = await link.call("machine.info", {});
    expect(info.hostname).toBeTruthy();

    let output = "";
    link.on("terminal.output", ({ data }) => (output += data));
    const { terminal } = await link.call("terminals.create", { cols: 80, rows: 24 });
    await link.call("terminals.attach", { terminalId: terminal.id });
    await link.call("terminals.input", { terminalId: terminal.id, data: "echo SECRET-$((40+2))\n" });
    await until(() => /\nSECRET-42/.test(output));

    // Remote devices can't use the terminal shim's methods.
    await expect(link.call("desktop.launch", { agent: "codex", args: [] })).rejects.toThrow(/only available locally/);

    // The gateway routed plenty, but nothing readable.
    expect(routed.length).toBeGreaterThan(5);
    const everything = routed.join("\n");
    for (const secret of ["machine.info", "terminals.create", "SECRET", info.hostname, "echo"]) expect(everything).not.toContain(secret);
  });

  it("pairs by typed code, and refuses a wrong code", async () => {
    const { url, local } = await world();
    const phone = device(url, "Pixel");
    const offer = await local.call("pairing.start", {});
    const wrong = offer.code === "000000" ? "111111" : "000000";
    await expect(phone.relay.request("pair.claim", { code: wrong, proof: pairingProof(codeSecret(wrong), publicIdentity(phone.identity)) })).rejects.toThrow();
    // Right code, wrong proof: the machine refuses.
    await expect(phone.relay.request("pair.claim", { code: offer.code, proof: pairingProof(codeSecret("999999"), publicIdentity(phone.identity)) })).rejects.toThrow(/refused/);
    const fresh = await local.call("pairing.start", {});
    const { machine } = await phone.relay.request("pair.claim", { code: fresh.code, proof: pairingProof(codeSecret(fresh.code), publicIdentity(phone.identity)) });
    const link = connect(phone.relay, phone.identity, machine);
    expect((await link.call("machine.info", {})).hostname).toBeTruthy();
  });

  it("won't route for a device that never paired, and stops after revoking", async () => {
    const { url, local, host } = await world();
    const stranger = device(url, "Stranger");
    await stranger.relay.waitOnline(5000);
    const machineId = host.gateway!.identity.id;
    const errors: string[] = [];
    const socket = new TunnelSocket(stranger.relay, stranger.identity, publicIdentity(host.gateway!.identity));
    socket.onerror = (event) => errors.push(String((event as { code?: string }).code));
    await until(() => errors.length > 0);
    expect(errors[0]).toBe("not_allowed");

    const phone = device(url, "iPhone");
    const { machine } = await pairByQr(local, phone.relay, phone.identity);
    expect(machine.id).toBe(machineId);
    const link = connect(phone.relay, phone.identity, machine);
    await link.call("machine.info", {});
    const { devices } = await local.call("gateway.status", {});
    await local.call("devices.revoke", { deviceId: devices[0]!.id });
    const after = device(url, "iPhone again");
    const again = new TunnelSocket(after.relay, after.identity, machine);
    const reasons: string[] = [];
    again.onerror = (event) => reasons.push(String((event as { code?: string }).code));
    await until(() => reasons.length > 0);
    expect(reasons[0]).toBe("not_allowed");
  });

  it("lets devices on the machine's account in without pairing, and nobody else", async () => {
    const { url, host } = await world({ machineToken: "token-alice" });
    const mine = device(url, "Alice's phone", "token-alice");
    await mine.relay.waitOnline(5000);
    const { machines } = await mine.relay.request("machines.list", {});
    expect(machines).toMatchObject([{ id: host.gateway!.identity.id, via: "account", online: true, name: "Test Mac" }]);
    const link = connect(mine.relay, mine.identity, machines[0]!);
    expect((await link.call("machine.info", {})).hostname).toBeTruthy();

    const other = device(url, "Bob's phone", "token-bob");
    await other.relay.waitOnline(5000);
    expect((await other.relay.request("machines.list", {})).machines).toEqual([]);
  });

  it("keeps healthy connections across heartbeats", async () => {
    const { url, local } = await world({ heartbeatMs: 60 });
    const phone = device(url, "iPhone");
    let drops = 0;
    phone.relay.onStatus((status) => status === "offline" && drops++);
    await phone.relay.waitOnline(5000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(drops).toBe(0);
    expect((await local.call("gateway.status", {})).status).toBe("online");
  });

  it("rejects a bad account token instead of connecting anonymously", async () => {
    const { url } = await world();
    const phone = device(url, "iPhone", "token-forged");
    await until(() => phone.relay.lastError?.code === "token_invalid");
  });

  it("admits computers only through the admission check (a subscription on the official gateway)", async () => {
    const subscribed = new Set(["alice"]);
    const admit: GatewayOptions["admit"] = async ({ role, userId }) =>
      role === "machine" && !(userId && subscribed.has(userId)) ? "需要 Pro 订阅" : undefined;
    // Subscribed: the computer comes online, and a device may connect without an account.
    const { url } = await world({ machineToken: "token-alice", admit });
    const phone = device(url, "iPhone");
    await phone.relay.waitOnline(5000);
    // Not subscribed: refused with the reason.
    const bob = createIdentity();
    const machine = new RelayClient({
      url: url + RELAY_PATH,
      identity: bob,
      role: "machine",
      name: "Bob's Mac",
      token: () => "token-bob",
      createSocket: (target) => new WebSocket(target) as unknown as RelaySocket,
    });
    machine.start();
    cleanups.push(() => machine.stop());
    await until(() => machine.lastError?.code === "not_admitted");
    expect(machine.lastError?.message).toBe("需要 Pro 订阅");
  });

  it("holds a fast sender back instead of buffering for a slow receiver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-gw-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const limit = 256 * 1024;
    const gateway = new Gateway({
      port: 0,
      host: "127.0.0.1",
      databasePath: join(dir, "gateway.db"),
      verifyToken: async (token) => ACCOUNTS[token],
      log: () => {},
      maxBufferedBytes: limit,
    });
    const url = `ws://127.0.0.1:${await gateway.start()}`;
    cleanups.push(() => gateway.stop());
    // Two peers on one account may reach each other; the device reads nothing for a while.
    const sender = new RelayClient({
      url: url + RELAY_PATH,
      identity: createIdentity(),
      role: "machine",
      name: "Mac",
      token: () => "token-alice",
      createSocket: (target) => new WebSocket(target) as unknown as RelaySocket,
    });
    sender.start();
    cleanups.push(() => sender.stop());
    let receiverSocket: WebSocket | undefined;
    const receiverIdentity = createIdentity();
    const receiver = new RelayClient({
      url: url + RELAY_PATH,
      identity: receiverIdentity,
      role: "device",
      name: "iPhone",
      token: () => "token-alice",
      createSocket: (target) => (receiverSocket = new WebSocket(target)) as unknown as RelaySocket,
    });
    let received = 0;
    receiver.onFrame(() => received++);
    receiver.start();
    cleanups.push(() => receiver.stop());
    await sender.waitOnline(5000);
    await receiver.waitOnline(5000);

    receiverSocket!.pause();
    const frames = 400;
    const payload = "x".repeat(64 * 1024);
    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, gateway.bufferedBytes)), 5);
    for (let i = 0; i < frames; i++) sender.send(receiverIdentity.id, { k: "data", ch: "c", box: payload });
    await new Promise((resolve) => setTimeout(resolve, 600));
    // 26 MB were sent; the gateway holds a few frames past its limit, not all of it.
    expect(received).toBe(0);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(limit * 8);
    // Once the receiver reads again, everything arrives, in order.
    receiverSocket!.resume();
    await until(() => received === frames, 15_000);
    clearInterval(watch);
    expect(peak).toBeLessThan(limit * 8);
  });

  it("follows a login, a gateway change and a logout on a running host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-gw-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const gateway = new Gateway({
      port: 0,
      host: "127.0.0.1",
      databasePath: join(dir, "gateway.db"),
      verifyToken: async (token) => ACCOUNTS[token],
      log: () => {},
      admit: async ({ role, userId }) => (role === "machine" && !userId ? "需要登录" : undefined),
    });
    const url = `ws://127.0.0.1:${await gateway.start()}`;
    cleanups.push(() => gateway.stop());
    // What `linkshell login` / `logout` / `host --gateway` change on the computer.
    const computer: { gateway?: string; token?: string } = {};
    const host = await startHost({
      home: join(dir, "host"),
      version: "test",
      env: { PATH: process.env.PATH, HOME: dir, SHELL: "/bin/sh", ENV: "", PS1: "$ " },
      drivers: () => [],
      log: () => {},
      gateway: { url: () => computer.gateway, token: () => computer.token, name: "Test Mac" },
    });
    cleanups.push(() => host.stop());
    const local = await connectHost(host.paths.hostSocket);
    cleanups.push(() => local.close());
    const changes: string[] = [];
    local.on("gateway.changed", (status) => changes.push(status.status));
    expect((await local.call("gateway.status", {})).status).toBe("off");

    // A gateway is chosen before logging in: refused, with the reason.
    computer.gateway = url;
    await local.call("gateway.refresh", {});
    await until(async () => (await local.call("gateway.status", {})).error?.code === "not_admitted");

    // Logging in brings the same host online, on the account.
    computer.token = "token-alice";
    await local.call("gateway.refresh", {});
    await until(async () => (await local.call("gateway.status", {})).status === "online");
    expect((await local.call("gateway.status", {})).account).toMatchObject({ userId: "alice" });
    const phone = device(url, "Alice's phone", "token-alice");
    await phone.relay.waitOnline(5000);
    const { machines } = await phone.relay.request("machines.list", {});
    expect(machines).toMatchObject([{ via: "account", online: true }]);
    expect((await connect(phone.relay, phone.identity, machines[0]!).call("machine.info", {})).hostname).toBeTruthy();

    // Logging out takes it off the gateway.
    computer.gateway = undefined;
    computer.token = undefined;
    expect((await local.call("gateway.refresh", {})).status).toBe("off");
    await until(async () => (await phone.relay.request("machines.list", {})).machines.every((machine) => !machine.online));
    await until(() => changes.at(-1) === "off");
    expect((await local.call("gateway.status", {})).status).toBe("off");
  });
});
