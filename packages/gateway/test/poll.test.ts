import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentity, publicIdentity, sign, gatewayChallengeMessage, RelayClient, type RelaySocket } from "@linkshell/wire";
import { startGateway, type StartGatewayOptions } from "../src/serve.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(pollLimits?: StartGatewayOptions["pollLimits"]) {
  const dir = mkdtempSync(join(tmpdir(), "linkshell-poll-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const gateway = await startGateway({ port: 0, host: "127.0.0.1", databasePath: join(dir, "relay.db"), log: () => {}, verifyToken: async (t) => t === "account" ? { userId: "owner" } : undefined, pollLimits });
  cleanup.push(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.port}`;
  const post = async (path: string, body: unknown, token?: string) => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const opened = await (await post("/v2/poll", {})).json() as { id: string; token: string };
  const path = `/v2/poll/${opened.id}`;
  let ack = 0, request = 0;
  const exchange = async (frames: unknown[] = [], waitMs = 100) => {
    const body = { request: ++request, ack, frames: frames.map((f) => JSON.stringify(f)), waitMs };
    const res = await post(path, body, opened.token);
    expect(res.status).toBe(200);
    const result = await res.json() as { frames: { seq: number; frame: string }[]; closed?: string };
    for (const entry of result.frames) ack = Math.max(ack, entry.seq);
    return { ...result, decoded: result.frames.map((entry) => JSON.parse(entry.frame)), body };
  };
  return { gateway, base, post, opened, path, exchange, transport: () => transport(post) };
}

type Post = (path: string, body: unknown, token?: string) => Promise<Response>;

/** Another poll transport on the same gateway, with its own numbering. */
async function transport(post: Post) {
  const res = await post("/v2/poll", {});
  if (res.status !== 200) return { status: res.status, error: ((await res.json()) as { error: string }).error } as const;
  const opened = await res.json() as { id: string; token: string };
  let ack = 0, request = 0;
  const exchange = async (frames: unknown[] = [], waitMs = 50) => {
    const body = { request: ++request, ack, frames: frames.map((f) => JSON.stringify(f)), waitMs };
    const res = await post(`/v2/poll/${opened.id}`, body, opened.token);
    const result = await res.json() as { frames: { seq: number; frame: string }[]; closed?: string; error?: string };
    for (const entry of result.frames ?? []) ack = Math.max(ack, entry.seq);
    return { status: res.status, ...result, decoded: (result.frames ?? []).map((entry) => JSON.parse(entry.frame)) };
  };
  /** Answers the challenge as `identity`; resolves with everything the gateway said. */
  const authenticate = async (identity = createIdentity()) => {
    const challenge = (await exchange()).decoded[0];
    const auth = await exchange([{ t: "auth", identity: publicIdentity(identity), role: "device", name: "Watch", signature: sign(identity, gatewayChallengeMessage(challenge.nonce)), token: "account" }]);
    return { identity, auth };
  };
  return { status: 200, opened, exchange, authenticate } as const;
}

function machineOn(base: string) {
  const machine = new RelayClient({ url: base.replace("http:", "ws:") + "/v2/connect", identity: createIdentity(), role: "machine", name: "Mac", token: () => "account", createSocket: (url) => new WebSocket(url) as unknown as RelaySocket });
  cleanup.push(() => machine.stop());
  machine.start();
  return machine;
}

async function until(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("HTTPS transport for the v2 relay", () => {
  it("requires its session secret, then the same signed gateway authentication", async () => {
    const { post, path, exchange, gateway } = await setup();
    expect((await post(path, {})).status).toBe(401);
    const challenge = (await exchange()).decoded[0];
    expect(challenge.t).toBe("challenge");
    const identity = createIdentity();
    const auth = await exchange([{ t: "auth", identity: publicIdentity(identity), role: "device", name: "Watch", signature: sign(identity, gatewayChallengeMessage(challenge.nonce)), token: "account" }]);
    expect(auth.decoded).toContainEqual({ t: "ready", userId: "owner" });
    expect(gateway.relay.connected).toBe(1);
    const list = await exchange([{ t: "req", id: 1, method: "machines.list", params: {} }]);
    expect(list.decoded).toContainEqual({ t: "res", id: 1, result: { machines: [] } });
  });

  it("retains responses until acknowledged and never replays retried mutation frames", async () => {
    const { base, post, path, opened, exchange } = await setup();
    const machine = new RelayClient({ url: base.replace("http:", "ws:") + "/v2/connect", identity: createIdentity(), role: "machine", name: "Mac", token: () => "account", createSocket: (url) => new WebSocket(url) as unknown as RelaySocket });
    cleanup.push(() => machine.stop()); machine.start();
    expect(await machine.waitOnline(5000)).toBe(true);
    const identity = createIdentity();
    const challenge = (await exchange()).decoded[0];
    await exchange([{ t: "auth", identity: publicIdentity(identity), role: "device", name: "Watch", signature: sign(identity, gatewayChallengeMessage(challenge.nonce)), token: "account" }]);
    let routed = 0;
    machine.onFrame(() => routed++);
    const body = { request: 3, ack: 2, frames: [JSON.stringify({ t: "to", to: machine.identity.id, d: JSON.stringify({ k: "close", ch: "test" }) })], waitMs: 10 };
    expect((await post(path, body, opened.token)).status).toBe(200);
    expect((await post(path, body, opened.token)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(routed).toBe(1);
    expect((await post(path, { ...body, frames: [] }, opened.token)).status).toBe(409);
    expect((await post(path, { ...body, request: 5 }, opened.token)).status).toBe(409);
    const resBody = { request: 4, ack: 2, frames: [JSON.stringify({ t: "req", id: 7, method: "machines.list", params: {} })], waitMs: 100 };
    const first = await (await post(path, resBody, opened.token)).json();
    const retry = await (await post(path, resBody, opened.token)).json();
    expect(retry).toEqual(first);
  });

  it("closes concurrent authentication without retaining an authenticated peer", async () => {
    const { exchange, gateway } = await setup();
    const challenge = (await exchange()).decoded[0];
    const identity = createIdentity();
    const frame = { t: "auth", identity: publicIdentity(identity), role: "device", name: "Watch", signature: sign(identity, gatewayChallengeMessage(challenge.nonce)), token: "account" };
    const result = await exchange([frame, frame]);
    expect(result.closed).toBe("auth first");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gateway.relay.connected).toBe(0);
  });

  it("rejects unsigned authentication and malformed request limits", async () => {
    const { exchange, post, path, opened } = await setup();
    await exchange();
    const result = await exchange([{ t: "auth", identity: publicIdentity(createIdentity()), role: "device", name: "Watch", signature: "invalid" }]);
    expect(result.closed).toBe("bad_signature");
    expect(result.decoded[0].code).toBe("bad_signature");
    expect((await post(path, { request: 3, ack: 0, frames: [], waitMs: 60_000 }, opened.token)).status).toBe(400);
  });

  it("frees a closed transport's slot at once, and still tells its client why it closed", async () => {
    const { gateway, transport } = await setup();
    const first = await transport();
    const second = await transport();
    if (first.status !== 200 || second.status !== 200) throw new Error("open failed");
    expect(gateway.poll.stats).toMatchObject({ open: 3, pending: 3 });
    const { identity } = await first.authenticate();
    expect(gateway.poll.stats).toMatchObject({ open: 3, pending: 2 });
    // The same watch reconnecting: the gateway replaces the first transport.
    await second.authenticate(identity);
    expect(gateway.poll.stats).toMatchObject({ open: 2, pending: 1, lingering: 1 });
    const told = await first.exchange();
    expect(told.status).toBe(200);
    expect(told.closed).toBe("replaced by a newer connection");
    // One that fails authentication is gone at once too.
    const third = await transport();
    if (third.status !== 200) throw new Error("open failed");
    await third.exchange();
    const refused = await third.exchange([{ t: "auth", identity: publicIdentity(createIdentity()), role: "device", name: "Watch", signature: "invalid" }]);
    expect(refused.closed).toBe("bad_signature");
    expect(gateway.poll.stats).toMatchObject({ open: 2, pending: 1, lingering: 2 });
  });

  it("tells a device's machines it went away when the same device reconnects", async () => {
    const { base, transport } = await setup();
    const machine = machineOn(base);
    expect(await machine.waitOnline(5000)).toBe(true);
    const presence: boolean[] = [];
    machine.on("presence", ({ online }) => presence.push(online));
    const first = await transport();
    if (first.status !== 200) throw new Error("open failed");
    const { identity } = await first.authenticate();
    await until(() => presence.length === 1);
    const second = await transport();
    if (second.status !== 200) throw new Error("open failed");
    await second.authenticate(identity);
    // Offline before online: the machine drops the old connection's channels before any new hello.
    await until(() => presence.length === 3);
    expect(presence).toEqual([true, false, true]);
  });

  it("keeps transports that haven't authenticated from crowding out ones that have", async () => {
    const { gateway, transport, exchange } = await setup({ maxPending: 4, maxSessions: 3 });
    // setup's own transport is pending; authenticate a second.
    const watch = await transport();
    if (watch.status !== 200) throw new Error("open failed");
    await watch.authenticate();
    const idle: Awaited<ReturnType<typeof transport>>[] = [];
    for (let i = 0; i < 10; i++) idle.push(await transport());
    expect(idle.every((entry) => entry.status === 200)).toBe(true);
    expect(gateway.poll.stats).toMatchObject({ open: 5, pending: 4 });
    expect((await watch.exchange()).status).toBe(200);
    // The oldest unauthenticated ones made room and say so.
    expect((await exchange()).closed).toBe("gateway busy");
    // A watch opening now still gets in, though every pending slot was taken.
    const late = await transport();
    if (late.status !== 200) throw new Error("open failed");
    expect((await late.authenticate()).auth.decoded).toContainEqual({ t: "ready", userId: "owner" });
    const third = await transport();
    if (third.status !== 200) throw new Error("open failed");
    await third.authenticate();
    expect(gateway.poll.stats.open - gateway.poll.stats.pending).toBe(3);
    // Authenticated slots are bounded on their own.
    expect(await transport()).toEqual({ status: 503, error: "gateway_busy" });
  });

  it("caps a response by bytes, returns the same response to a retry, and sends an oversized frame alone", async () => {
    const { base, post, gateway, transport } = await setup();
    const machine = machineOn(base);
    expect(await machine.waitOnline(5000)).toBe(true);
    const watch = await transport();
    if (watch.status !== 200) throw new Error("open failed");
    const { identity } = await watch.authenticate();
    await watch.exchange();
    for (let i = 0; i < 4; i++) machine.send(identity.id, { k: "data", ch: "c", box: String(i).repeat(100_000) });
    machine.send(identity.id, { k: "data", ch: "c", box: "x".repeat(600_000) });
    await until(() => gateway.poll.stats.queuedBytes > 1_000_000);
    const path = `/v2/poll/${watch.opened.id}`;
    const poll = async (request: number, ack: number) => {
      const res = await post(path, { request, ack, frames: [], waitMs: 1000 }, watch.opened.token);
      expect(res.status).toBe(200);
      return await res.json() as { frames: { seq: number; frame: string }[] };
    };
    // The watch's own numbering went up to 3 (challenge, auth, empty poll); it has read the challenge and `ready`.
    let ack = 2, request = 3;
    const sizes: number[] = [];
    while (sizes.length < 5) {
      const reply = await poll(++request, ack);
      const retry = await poll(request, ack);
      expect(retry).toEqual(reply);
      const bytes = reply.frames.reduce((sum, entry) => sum + Buffer.byteLength(entry.frame), 0);
      expect(reply.frames.length).toBeGreaterThan(0);
      if (reply.frames.length > 1) expect(bytes).toBeLessThanOrEqual(256 * 1024);
      for (const entry of reply.frames) sizes.push(Buffer.byteLength(entry.frame));
      ack = reply.frames.at(-1)!.seq;
      if (sizes.length < 5) expect(reply.frames.length).toBe(2);
    }
    expect(sizes.at(-1)).toBeGreaterThan(600_000);
  });

  it("bounds what transports may hold, each and together, and drops one whose watch stopped polling", async () => {
    const { base, gateway, transport } = await setup({ maxQueue: 300_000, maxQueuedTotal: 500_000, staleMs: 300 });
    const machine = machineOn(base);
    expect(await machine.waitOnline(5000)).toBe(true);
    const watches = [];
    for (let i = 0; i < 3; i++) {
      const watch = await transport();
      if (watch.status !== 200) throw new Error("open failed");
      watches.push({ ...watch, ...(await watch.authenticate()) });
    }
    const [slow, first, second] = watches;
    machine.send(slow.identity.id, { k: "data", ch: "c", box: "a".repeat(200_000) });
    machine.send(slow.identity.id, { k: "data", ch: "c", box: "a".repeat(200_000) });
    expect((await slow.exchange([], 1000)).closed).toBe("receiver too slow");
    machine.send(first.identity.id, { k: "data", ch: "c", box: "a".repeat(250_000) });
    await until(() => gateway.poll.stats.queuedBytes > 250_000);
    machine.send(second.identity.id, { k: "data", ch: "c", box: "a".repeat(250_000) });
    expect((await second.exchange([], 1000)).closed).toBe("gateway busy");
    const delivered = await first.exchange([], 1000);
    expect(delivered.closed).toBeUndefined();
    expect(delivered.decoded.at(-1)).toMatchObject({ t: "from" });
    // Acknowledged frames leave the budget.
    await first.exchange();
    expect(gateway.poll.stats.queuedBytes).toBeLessThan(10_000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    machine.send(first.identity.id, { k: "data", ch: "c", box: "late" });
    expect((await first.exchange([], 1000)).closed).toBe("receiver gone");
  });
});
