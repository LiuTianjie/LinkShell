import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, gatewayChallengeMessage, verifySignature } from "../src/crypto.js";
import { RelayClient, type RelaySocket } from "../src/relay-client.js";
import type { ClientFrame } from "../src/relay.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

class Socket implements RelaySocket {
  readyState = 1;
  sent: ClientFrame[] = [];
  onopen: RelaySocket["onopen"] = null;
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  send(data: string) { this.sent.push(JSON.parse(data) as ClientFrame); }
  close(code?: number, reason?: string) { this.readyState = 3; this.onclose?.({ code, reason }); }
  message(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

it("keeps a delayed token and stale ready frames on their original gateway socket across reauthentication", async () => {
  const identity = createIdentity();
  const sockets: Socket[] = [];
  let finish!: (token: string) => void;
  const token = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; })).mockResolvedValue("current-token");
  const client = new RelayClient({
    identity, name: "Test", role: "device", url: "ws://127.0.0.1/v2/connect", pingMs: 0, token,
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
  });
  try {
    client.start();
    sockets[0].message({ t: "challenge", nonce: "old-nonce" });
    client.reauthenticate();
    sockets[1].message({ t: "challenge", nonce: "current-nonce" });
    await Promise.resolve();
    finish("previous-token");
    await Promise.resolve();
    expect(sockets[0].sent).toEqual([]);
    expect(sockets[1].sent).toHaveLength(1);
    const frame = sockets[1].sent[0];
    expect(frame).toMatchObject({ t: "auth", token: "current-token" });
    if (frame.t !== "auth") throw new Error("Expected gateway authentication");
    expect(verifySignature(identity.signKey, gatewayChallengeMessage("current-nonce"), frame.signature)).toBe(true);
    sockets[0].message({ t: "ready", userId: "previous-account" });
    expect(client.status).toBe("connecting");
    sockets[1].message({ t: "ready", userId: "current-account" });
    sockets[0].message({ t: "ready", userId: "previous-account" });
    expect(client.account?.userId).toBe("current-account");
  } finally { client.stop(); }
});

it("ignores late authentication and ready frames after the owner stops the connection", async () => {
  const socket = new Socket();
  let finish!: (token: string) => void;
  const client = new RelayClient({
    identity: createIdentity(), name: "Test", role: "device", url: "ws://127.0.0.1/v2/connect", pingMs: 0,
    token: () => new Promise<string>((resolve) => { finish = resolve; }), createSocket: () => socket,
  });
  client.start();
  socket.message({ t: "challenge", nonce: "stopped-nonce" });
  client.stop();
  finish("late-token");
  await Promise.resolve();
  socket.message({ t: "ready", userId: "signed-out-account" });
  expect(socket.sent).toEqual([]);
  expect(client.status).toBe("stopped");
  expect(client.account).toBeUndefined();
});

describe("RelayClient resilience", () => {
  it("times out a pre-ready handshake after 15s, closes the hung socket, and reconnects", () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const errors: Array<{ status: string; code?: string; message?: string }> = [];
    const client = new RelayClient({
      identity: createIdentity(),
      name: "Test",
      role: "device",
      url: "ws://127.0.0.1/v2/connect",
      pingMs: 0,
      createSocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    });
    client.onStatus((status, error) => errors.push({ status, code: error?.code, message: error?.message }));
    try {
      client.start();
      expect(sockets).toHaveLength(1);
      expect(client.status).toBe("connecting");

      vi.advanceTimersByTime(14_999);
      expect(client.status).toBe("connecting");
      expect(sockets[0].readyState).toBe(1);

      vi.advanceTimersByTime(1);
      expect(sockets[0].readyState).toBe(3);
      expect(client.status).toBe("offline");
      expect(client.lastError).toEqual({ code: "handshake_timeout", message: "连接网关超时" });
      expect(errors.filter((entry) => entry.code === "handshake_timeout")).toHaveLength(1);

      vi.advanceTimersByTime(1_000);
      expect(sockets).toHaveLength(2);
      expect(client.status).toBe("connecting");

      // Reaching ready clears the handshake timer so staying online past 15s does not drop it.
      sockets[1].message({ t: "ready" });
      expect(client.status).toBe("online");
      vi.advanceTimersByTime(20_000);
      expect(client.status).toBe("online");
      expect(sockets).toHaveLength(2);
    } finally {
      client.stop();
    }
  });

  it("clears the handshake timer on early socket close without firing a duplicate timeout", () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const codes: string[] = [];
    const client = new RelayClient({
      identity: createIdentity(),
      name: "Test",
      role: "device",
      url: "ws://127.0.0.1/v2/connect",
      pingMs: 0,
      minBackoffMs: 20_000,
      maxBackoffMs: 30_000,
      createSocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    });
    client.onStatus((_status, error) => {
      if (error) codes.push(error.code);
    });
    try {
      client.start();
      sockets[0].close(1006, "reset");
      expect(codes).toEqual(["disconnected"]);
      vi.advanceTimersByTime(15_000);
      expect(codes).toEqual(["disconnected"]);
    } finally {
      client.stop();
    }
  });

  it("recovers from up to 3 consecutive 4000 closes, resets after 15s online, and stops after >3 consecutive 4000s", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const sockets: Socket[] = [];
    const client = new RelayClient({
      identity: createIdentity(),
      name: "Test",
      role: "machine",
      url: "ws://127.0.0.1/v2/connect",
      pingMs: 0,
      createSocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      client.start();
      expect(sockets).toHaveLength(1);

      // 3 consecutive 4000 events (online briefly < 15s each): each schedules a 5_000 + 0.5 * 10_000 = 10_000ms retry.
      for (let i = 0; i < 3; i++) {
        const current = sockets[sockets.length - 1]!;
        current.message({ t: "ready" });
        vi.advanceTimersByTime(2_000);
        current.close(4000, "replaced by a newer connection");
        expect(client.status).toBe("offline");
        expect(client.lastError?.code).toBe("replaced");

        vi.advanceTimersByTime(9_999);
        expect(sockets).toHaveLength(i + 1);
        vi.advanceTimersByTime(1);
        expect(sockets).toHaveLength(i + 2);
      }

      // Now stay online for >= 15_000ms: replacedCount resets to 0.
      sockets[3]!.message({ t: "ready" });
      expect(client.status).toBe("online");
      vi.advanceTimersByTime(15_000);

      // After reset, 3 more consecutive 4000 events still reconnect, and only the 4th stops permanently.
      for (let i = 0; i < 3; i++) {
        const current = sockets[sockets.length - 1]!;
        current.close(4000, "replaced");
        expect(client.status).toBe("offline");
        expect(client.lastError?.code).toBe("replaced");
        vi.advanceTimersByTime(10_000);
        sockets[sockets.length - 1]!.message({ t: "ready" });
        vi.advanceTimersByTime(1_000);
      }
      expect(sockets).toHaveLength(7);

      // 4th consecutive 4000 (replacedCount = 4 > 3) stops permanently.
      sockets[6]!.close(4000, "replaced");
      expect(client.status).toBe("offline");
      expect(client.lastError?.code).toBe("replaced");
      vi.advanceTimersByTime(120_000);
      expect(sockets).toHaveLength(7);
    } finally {
      client.stop();
    }
  });

  it("widens first reconnect jitter after dropping from online and forwards undeliverable channel", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.8);
    const sockets: Socket[] = [];
    const undeliverables: Array<[string, string, string | undefined]> = [];
    const client = new RelayClient({
      identity: createIdentity(),
      name: "Test",
      role: "device",
      url: "ws://127.0.0.1/v2/connect",
      pingMs: 0,
      createSocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    });
    client.onUndeliverable((to, reason, channel) => undeliverables.push([to, reason, channel]));
    try {
      client.start();
      sockets[0]!.message({ t: "ready" });
      sockets[0]!.message({ t: "undeliverable", to: "peer-1", reason: "offline", channel: "ch-42" });
      expect(undeliverables).toEqual([["peer-1", "offline", "ch-42"]]);

      // Drop from online with random=0.8 -> 500 + 0.8 * 2500 = 2500ms.
      sockets[0]!.close(1006, "gateway restarted");
      vi.advanceTimersByTime(2_499);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(2);
    } finally {
      client.stop();
    }
  });
});
