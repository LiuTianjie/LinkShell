import { describe, expect, it, vi } from "vitest";
import {
  createFusionController,
  FUSION_MAX_RECONNECTS,
  fusionReconnectDelay,
} from "../src/core/fusion-store";

type Invoke = (method: string, params?: Record<string, unknown>) => unknown;

/** A controller with fake time, a fake bridge and an in-memory event target. */
function harness(invokeImpl: Invoke) {
  const posted: Array<Record<string, unknown>> = [];
  const target = new EventTarget();
  let clock = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const restart = vi.fn(async () => undefined);
  const release = vi.fn();
  const opened: Array<{ port: number; closed: boolean }> = [];
  const streams = {
    open: vi.fn(async (port: number) => {
      const entry = { port, closed: false };
      opened.push(entry);
      return { write: vi.fn(), close: () => { entry.closed = true; } } as never;
    }),
  };
  const controller = createFusionController({
    invoke: (async (method: string, params?: Record<string, unknown>) => invokeImpl(method, params)) as never,
    postMessage: (message) => {
      posted.push(message);
      return true;
    },
    eventTarget: target,
    retain: () => ({ streams, release }),
    restart,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: clock + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((t) => t.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    now: () => clock,
  });
  const advance = async (ms: number) => {
    clock += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > clock) break;
      timers.shift();
      due.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.resolve();
  };
  const tunnelEvent = (detail: Record<string, unknown>) =>
    target.dispatchEvent(new CustomEvent("linkshell-fusion-tunnel", { detail }));
  return { controller, posted, restart, release, streams, opened, advance, tunnelEvent };
}

const link = (port = 47391) => ({ call: vi.fn(async () => ({ port, token: "t", hosts: [] })) }) as never;
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("fusion-store", () => {
  it("backs off 1, 2, 4, 8, 16 s and caps there", () => {
    expect([1, 2, 3, 4, 5, 6].map(fusionReconnectDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 16_000]);
  });

  it("holds the computer's connection for a tunnel it starts itself and releases it on Disconnect", async () => {
    const h = harness((method) => (method === "fusionStart" ? { mode: "tunnel", tunnelId: "tun-1", port: 6000 } : { hubRunning: true, connected: false }));
    await h.controller.startFusion({ computerKey: "k", name: "Mac", link: link(), streams: { open: vi.fn() } as never });
    expect(h.release).not.toHaveBeenCalled();
    h.tunnelEvent({ tunnelId: "tun-1", connId: "c1", type: "open" });
    await flush();
    // The bridge pipes through the retained connection's streams, not the page's.
    expect(h.streams.open).toHaveBeenCalledWith(47391, expect.anything());
    await h.controller.stopFusion("k", "Mac");
    expect(h.release).toHaveBeenCalledTimes(1);
    // Disposing tells main about every open connection, so FusionLocal sees its socket close.
    expect(h.posted).toContainEqual({ action: "fusionTunnel", tunnelId: "tun-1", connId: "c1", type: "close" });
    expect(h.opened[0]?.closed).toBe(true);
  });

  it("reuses the live bridge when the same tunnel comes back, instead of black-holing its connections", async () => {
    const h = harness((method) => (method === "fusionStart" ? { mode: "tunnel", tunnelId: "tun-1", port: 6000 } : { hubRunning: true }));
    await h.controller.startFusion({ computerKey: "k", name: "Mac", link: link(), streams: { open: vi.fn() } as never });
    h.tunnelEvent({ tunnelId: "tun-1", connId: "c1", type: "open" });
    await flush();
    const second = vi.fn();
    await h.controller.startFusion({ computerKey: "k", name: "Mac", link: link(), streams: { open: vi.fn() } as never, releaseConnection: second });
    expect(second).toHaveBeenCalledTimes(1);
    expect(h.opened[0]?.closed).toBe(false);
    expect(h.posted.filter((m) => m.type === "close")).toHaveLength(0);
  });

  it("answers data for an unknown connection with a close", async () => {
    const h = harness((method) => (method === "fusionStart" ? { mode: "tunnel", tunnelId: "tun-1", port: 6000 } : { hubRunning: true }));
    await h.controller.startFusion({ computerKey: "k", name: "Mac", link: link(), streams: { open: vi.fn() } as never });
    h.tunnelEvent({ tunnelId: "tun-1", connId: "ghost", type: "data", data: "AA==" });
    expect(h.posted).toContainEqual({ action: "fusionTunnel", tunnelId: "tun-1", connId: "ghost", type: "close" });
  });

  it("reconnects with backoff when a running hub drops, then gives up with a visible error", async () => {
    let state: Record<string, unknown> = { hubRunning: true, connected: true, apps: [{ bundle: "a", name: "A" }] };
    const h = harness((method) => {
      if (method === "fusionStart") return { mode: "direct", host: "10.0.0.2", port: 47391 };
      if (method === "fusionState") return state;
      return {};
    });
    await h.controller.startFusion({ computerKey: "k", name: "Mac", link: link(), streams: { open: vi.fn() } as never });
    await flush();
    expect(h.controller.stateOf("k").phase).toBe("connected");

    state = { hubRunning: false, connected: false, lastExit: { reason: "timeout", message: "远端 Mac 已无响应" } };
    for (let attempt = 1; attempt <= FUSION_MAX_RECONNECTS; attempt++) {
      await h.controller.refreshFusionState("k", "Mac");
      expect(h.controller.stateOf("k").phase).toBe("reconnecting");
      expect(h.controller.stateOf("k").reconnectAttempt).toBe(attempt);
      await h.advance(fusionReconnectDelay(attempt));
      expect(h.restart).toHaveBeenCalledTimes(attempt);
    }
    await h.controller.refreshFusionState("k", "Mac");
    const final = h.controller.stateOf("k");
    expect(final.phase).toBe("error");
    expect(final.error).toContain("远端 Mac 已无响应");
    await h.advance(60_000);
    expect(h.restart).toHaveBeenCalledTimes(FUSION_MAX_RECONNECTS);
  });

  it("a successful reconnect resets the attempt counter", async () => {
    let state: Record<string, unknown> = { hubRunning: true, connected: true };
    const h = harness((method) => (method === "fusionStart" ? { mode: "direct", host: "h", port: 1 } : method === "fusionState" ? state : {}));
    await h.controller.startFusion({ computerKey: "k", name: "Mac", link: link(), streams: { open: vi.fn() } as never });
    await flush();
    state = { hubRunning: false, connected: false };
    await h.controller.refreshFusionState("k", "Mac");
    expect(h.controller.stateOf("k").reconnectAttempt).toBe(1);
    state = { hubRunning: true, connected: true };
    await h.controller.refreshFusionState("k", "Mac");
    expect(h.controller.stateOf("k").phase).toBe("connected");
    expect(h.controller.stateOf("k").reconnectAttempt).toBe(0);
  });

  it("Disconnect sticks: no reconnect, and the store remembers it until the next explicit start", async () => {
    let state: Record<string, unknown> = { hubRunning: true, connected: true };
    const h = harness((method) => (method === "fusionStart" ? { mode: "direct", host: "h", port: 1 } : method === "fusionState" ? state : {}));
    await h.controller.startFusion({ computerKey: "k", name: "Mac", link: link(), streams: { open: vi.fn() } as never });
    await flush();
    await h.controller.stopFusion("k", "Mac");
    expect(h.controller.isPaused("k")).toBe(true);
    state = { hubRunning: false, connected: false };
    await h.controller.refreshFusionState("k", "Mac");
    await h.advance(60_000);
    expect(h.restart).not.toHaveBeenCalled();
    expect(h.controller.stateOf("k").phase).toBe("idle");
    await h.controller.startFusion({ computerKey: "k", name: "Mac", link: link(), streams: { open: vi.fn() } as never });
    expect(h.controller.isPaused("k")).toBe(false);
  });

  it("a hub that dies before ever connecting counts as a failed attempt instead of looping silently", async () => {
    let state: Record<string, unknown> = { hubRunning: true, connected: false };
    const h = harness((method) => (method === "fusionStart" ? { mode: "direct", host: "h", port: 1 } : method === "fusionState" ? state : {}));
    await h.controller.startFusion({ computerKey: "k", name: "Mac", link: link(), streams: { open: vi.fn() } as never });
    await flush();
    state = { hubRunning: false, connected: false, lastExit: { reason: "tls", message: "融合连接的会话凭据已失效" } };
    await h.advance(16_000);
    await h.controller.refreshFusionState("k", "Mac");
    expect(h.controller.stateOf("k").phase).toBe("reconnecting");
    expect(h.controller.stateOf("k").reconnectAttempt).toBeGreaterThanOrEqual(1);
  });
});
