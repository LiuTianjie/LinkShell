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
});
