import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIdentity,
  gatewayChallengeMessage,
  publicIdentity,
  sign,
  type Identity,
  type PeerRole,
} from "@linkshell/wire";
import { Gateway, type GatewaySocket } from "../src/relay.js";
import { GatewayStore } from "../src/store.js";

class MockSocket extends EventEmitter implements GatewaySocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closed: { code?: number; reason?: string }[] = [];
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly ping = vi.fn();
  readonly terminate = vi.fn(() => {
    this.readyState = 3;
    this.emit("close");
  });

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed.push({ code, reason });
    this.emit("close");
  }

  receive(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }

  frames<T = Record<string, unknown>>(): T[] {
    return this.sent.map((entry) => JSON.parse(entry) as T);
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function connectPeer(
  gateway: Gateway,
  identity: Identity,
  role: PeerRole,
  options: { name?: string; token?: string; locked?: boolean; namingConfigured?: boolean } = {},
): Promise<MockSocket> {
  const socket = new MockSocket();
  gateway.acceptTransport(socket);
  const challenge = socket.frames<{ t: string; nonce: string }>().find((f) => f.t === "challenge");
  if (!challenge) throw new Error("missing challenge");
  socket.receive({
    t: "auth",
    role,
    identity: publicIdentity(identity),
    signature: sign(identity, gatewayChallengeMessage(challenge.nonce)),
    name: options.name ?? role,
    token: options.token,
    locked: options.locked,
    namingConfigured: options.namingConfigured,
  });
  await vi.waitFor(() => {
    expect(socket.frames<{ t: string }>().some((f) => f.t === "ready")).toBe(true);
  });
  return socket;
}

describe("Gateway HoL avoidance, machine replacement presence, and cleanup", () => {
  it("never pauses a machine socket when one receiver overflows maxBufferedBytes and keeps other devices + heartbeats live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-hol-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const gateway = new Gateway({
      port: 0,
      databasePath: join(dir, "relay.db"),
      verifyToken: async () => ({ userId: "alice" }),
      log: () => {},
      maxBufferedBytes: 1024,
    });
    cleanups.push(() => gateway.stop());

    const machineId = createIdentity();
    const slowDeviceId = createIdentity();
    const fastDeviceId = createIdentity();

    const machineSocket = await connectPeer(gateway, machineId, "machine", { token: "tok" });
    const slowSocket = await connectPeer(gateway, slowDeviceId, "device", { token: "tok" });
    const fastSocket = await connectPeer(gateway, fastDeviceId, "device", { token: "tok" });

    // Simulate slow receiver backlog above maxBufferedBytes.
    slowSocket.bufferedAmount = 2048;

    machineSocket.receive({ t: "to", to: slowDeviceId.id, d: "frame-for-slow" });
    machineSocket.receive({ t: "to", to: fastDeviceId.id, d: "frame-for-fast" });

    // Sender's shared multiplexed socket is NEVER paused.
    expect(machineSocket.pause).not.toHaveBeenCalled();

    // Only the slow receiver is closed with 1013 / backpressure, and sender receives undeliverable.
    expect(slowSocket.closed).toEqual([{ code: 1013, reason: "backpressure" }]);
    expect(fastSocket.closed).toEqual([]);
    expect(machineSocket.frames()).toContainEqual({
      t: "undeliverable",
      to: slowDeviceId.id,
      reason: "backpressure",
    });

    // Healthy receiver still got its frame, and sweep() still pings live peers.
    expect(fastSocket.frames()).toContainEqual(
      expect.objectContaining({ t: "from", d: "frame-for-fast" }),
    );
    (gateway as unknown as { sweep: () => void }).sweep();
    expect(machineSocket.ping).toHaveBeenCalledTimes(1);
    expect(fastSocket.ping).toHaveBeenCalledTimes(1);
  });

  it("emits presence online:false before online:true when a machine replaces its socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-replace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const gateway = new Gateway({
      port: 0,
      databasePath: join(dir, "relay.db"),
      verifyToken: async () => ({ userId: "alice" }),
      log: () => {},
    });
    cleanups.push(() => gateway.stop());

    const machineId = createIdentity();
    const deviceId = createIdentity();

    const firstMachine = await connectPeer(gateway, machineId, "machine", { token: "tok" });
    const deviceSocket = await connectPeer(gateway, deviceId, "device", { token: "tok" });
    const baseline = deviceSocket.sent.length;

    const secondMachine = await connectPeer(gateway, machineId, "machine", { token: "tok" });
    expect(firstMachine.closed).toEqual([{ code: 4000, reason: "replaced by a newer connection" }]);
    expect(secondMachine.readyState).toBe(1);

    const events = deviceSocket
      .frames<{ t: string; name?: string; data?: { id: string; online: boolean } }>()
      .slice(baseline)
      .filter((frame) => frame.t === "event" && frame.name === "presence")
      .map((frame) => frame.data);

    expect(events).toEqual([
      { id: machineId.id, online: false },
      { id: machineId.id, online: true },
    ]);
  });

  it("cleans up locked and namingConfigured on disconnect and prunes expired turnTimes in sweep()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-cleanup-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const gateway = new Gateway({
      port: 0,
      databasePath: join(dir, "relay.db"),
      verifyToken: async () => ({ userId: "alice" }),
      log: () => {},
    });
    cleanups.push(() => gateway.stop());

    const machineId = createIdentity();
    const deviceId = createIdentity();

    const machineSocket = await connectPeer(gateway, machineId, "machine", {
      token: "tok",
      locked: true,
      namingConfigured: true,
    });
    const deviceSocket = await connectPeer(gateway, deviceId, "device", { token: "tok" });

    deviceSocket.receive({ t: "req", id: 1, method: "machines.list", params: {} });
    await vi.waitFor(() => {
      const res = deviceSocket.frames<{ t: string; id?: number; result?: { machines: Record<string, unknown>[] } }>().find((f) => f.t === "res" && f.id === 1);
      expect(res?.result?.machines[0]).toMatchObject({ online: true, locked: true, namingConfigured: true });
    });

    // Request TURN credentials so turnTimes is populated for this machine.
    machineSocket.receive({ t: "req", id: 2, method: "turn.credentials", params: {} });
    await vi.waitFor(() => {
      expect(machineSocket.frames<{ t: string; id?: number }>().some((f) => f.t === "res" && f.id === 2)).toBe(true);
    });
    const turnTimes = (gateway as unknown as { turnTimes: Map<string, number[]> }).turnTimes;
    expect(turnTimes.has(machineId.id)).toBe(true);

    // Disconnect clears locked & namingConfigured.
    machineSocket.close(1000, "bye");
    deviceSocket.receive({ t: "req", id: 3, method: "machines.list", params: {} });
    await vi.waitFor(() => {
      const res = deviceSocket.frames<{ t: string; id?: number; result?: { machines: Record<string, unknown>[] } }>().find((f) => f.t === "res" && f.id === 3);
      const entry = res?.result?.machines[0];
      expect(entry?.online).toBe(false);
      expect(entry).not.toHaveProperty("locked");
      expect(entry).not.toHaveProperty("namingConfigured");
    });

    // Expired turnTimes entries are pruned in sweep().
    turnTimes.set(machineId.id, [Date.now() - 61_000]);
    (gateway as unknown as { sweep: () => void }).sweep();
    expect(turnTimes.has(machineId.id)).toBe(false);
  });

  it("configures SQLite pragmas and supports idle WAL checkpoint()", () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-store-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const store = new GatewayStore(join(dir, "relay.db"));
    cleanups.push(() => store.close());

    const db = (store as unknown as { db: { prepare: (sql: string) => { get: () => Record<string, unknown> } } }).db;
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });

    store.upsertPeer({
      id: "m1",
      role: "machine",
      signKey: "s",
      boxKey: "b",
      name: "Mac",
      lastSeen: Date.now(),
    });
    expect(() => store.checkpoint()).not.toThrow();
  });

  it("runs PASSIVE WAL checkpoint during sweep even while peers are online, and terminates unresponsive backpressured sockets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-hardening-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const gateway = new Gateway({
      port: 0,
      databasePath: join(dir, "relay.db"),
      verifyToken: async () => ({ userId: "alice" }),
      log: () => {},
      maxBufferedBytes: 512,
      backpressureTerminateMs: 25,
    });
    cleanups.push(() => gateway.stop());

    const checkpointSpy = vi.spyOn(gateway.store, "checkpoint");
    const machineId = createIdentity();
    const deadDeviceId = createIdentity();
    const machineSocket = await connectPeer(gateway, machineId, "machine", { token: "tok" });
    const deadSocket = await connectPeer(gateway, deadDeviceId, "device", { token: "tok" });

    // Sweep while peers are active must still run PASSIVE checkpoint once the interval elapses.
    (gateway as unknown as { sweep: () => void }).sweep();
    expect(checkpointSpy).toHaveBeenCalledWith("PASSIVE");

    // Simulate a TCP-dead receiver whose close() never completes the closing handshake.
    deadSocket.close = (code?: number, reason?: string) => {
      deadSocket.closed.push({ code, reason });
      // ReadyState stays CLOSING (2) and "close" is never emitted until terminate().
      deadSocket.readyState = 2;
    };
    deadSocket.bufferedAmount = 1024;
    machineSocket.receive({ t: "to", to: deadDeviceId.id, d: "payload" });

    expect(deadSocket.closed).toEqual([{ code: 1013, reason: "backpressure" }]);
    await vi.waitFor(() => {
      expect(deadSocket.terminate).toHaveBeenCalledTimes(1);
    });
  });

  it("immediately rejects pending pair.claim when the target host drops instead of hanging 30s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-claim-drop-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const gateway = new Gateway({
      port: 0,
      databasePath: join(dir, "relay.db"),
      log: () => {},
    });
    cleanups.push(() => gateway.stop());

    const machineId = createIdentity();
    const deviceId = createIdentity();
    const machineSocket = await connectPeer(gateway, machineId, "machine");
    const deviceSocket = await connectPeer(gateway, deviceId, "device");

    machineSocket.receive({ t: "req", id: 1, method: "pair.offer", params: {} });
    let code = "";
    await vi.waitFor(() => {
      const res = machineSocket.frames<{ t: string; id?: number; result?: { code: string } }>().find((f) => f.t === "res" && f.id === 1);
      expect(res?.result?.code).toBeTruthy();
      code = res!.result!.code;
    });

    // Start claim; machine receives pair.request then drops before deciding.
    deviceSocket.receive({ t: "req", id: 2, method: "pair.claim", params: { code, proof: "p" } });
    await vi.waitFor(() => {
      expect(machineSocket.frames<{ t: string; name?: string }>().some((f) => f.t === "event" && f.name === "pair.request")).toBe(true);
    });
    machineSocket.close(1006, "dropped");

    await vi.waitFor(() => {
      const res = deviceSocket.frames<{ t: string; id?: number; error?: { code: string } }>().find((f) => f.t === "res" && f.id === 2);
      expect(res?.error?.code).toBe("machine_offline");
    });
  });

  it("selectively invalidates route cache on upsertPeer without wiping unaffected routes", () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-routes-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const store = new GatewayStore(join(dir, "relay.db"));
    cleanups.push(() => store.close());

    const peer = (id: string, role: PeerRole, userId?: string) => ({
      id,
      role,
      signKey: `s-${id}`,
      boxKey: `b-${id}`,
      name: id,
      userId,
      lastSeen: Date.now(),
    });
    store.upsertPeer(peer("m1", "machine", "u1"));
    store.upsertPeer(peer("d1", "device", "u1"));
    store.upsertPeer(peer("m2", "machine", "u2"));
    store.upsertPeer(peer("d2", "device", "u2"));

    expect(store.route("m1", "d1")).toBe("account");
    expect(store.route("m2", "d2")).toBe("account");

    const routes = (store as unknown as { routes: Map<string, unknown> }).routes;
    expect(routes.size).toBe(2);

    // Reconnecting m1 with the same userId (only name/lastSeen changed) must preserve all cached routes.
    store.upsertPeer({ ...peer("m1", "machine", "u1"), name: "Mac Renamed" });
    expect(routes.size).toBe(2);

    // Changing m1's userId invalidates only m1's routes and leaves m2->d2 cached.
    store.upsertPeer(peer("m1", "machine", "u3"));
    expect(routes.has("m1\nd1")).toBe(false);
    expect(routes.has("m2\nd2")).toBe(true);
    expect(store.route("m1", "d1")).toBeUndefined();
    expect(store.route("m2", "d2")).toBe("account");
  });

  it("closes unauthenticated sockets that send >64KB frames before auth with 1009", () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-preauth-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const gateway = new Gateway({
      port: 0,
      databasePath: join(dir, "relay.db"),
      log: () => {},
    });
    cleanups.push(() => gateway.stop());

    const socket = new MockSocket();
    gateway.acceptTransport(socket);
    socket.emit("message", "x".repeat(70 * 1024));
    expect(socket.closed).toEqual([{ code: 1009, reason: "message too big" }]);
  });
});
