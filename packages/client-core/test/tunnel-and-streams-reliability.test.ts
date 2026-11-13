import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerTunnel,
  createIdentity,
  publicIdentity,
  type PublicIdentity,
  type RelayClient,
  type RelayEvents,
  type RelayStatus,
  type TunnelFrame,
} from "@linkshell/wire";
import { HostLink } from "../src/host-link.js";
import { HostStreams, type DirectConnection } from "../src/streams.js";
import { TunnelSocket } from "../src/tunnel-socket.js";

class FakeRelay {
  status: RelayStatus = "online";
  lastError?: { code: string; message: string };
  readonly sent: { to: string; frame: TunnelFrame }[] = [];
  private readonly frameListeners = new Set<(from: PublicIdentity, via: "paired" | "account", frame: TunnelFrame) => void>();
  private readonly undeliverableListeners = new Set<(to: string, reason: string, channel?: string) => void>();
  private readonly statusListeners = new Set<(status: RelayStatus) => void>();
  private readonly eventListeners = new Map<string, Set<(data: unknown) => void>>();

  onFrame(fn: (from: PublicIdentity, via: "paired" | "account", frame: TunnelFrame) => void) {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }
  onUndeliverable(fn: (to: string, reason: string, channel?: string) => void) {
    this.undeliverableListeners.add(fn);
    return () => this.undeliverableListeners.delete(fn);
  }
  onStatus(fn: (status: RelayStatus) => void) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
  on<N extends keyof RelayEvents>(name: N, fn: (data: RelayEvents[N]) => void) {
    let set = this.eventListeners.get(name);
    if (!set) this.eventListeners.set(name, (set = new Set()));
    const entry = fn as (data: unknown) => void;
    set.add(entry);
    return () => set.delete(entry);
  }
  waitOnline() {
    return Promise.resolve(this.status === "online");
  }
  send(to: string, frame: TunnelFrame) {
    this.sent.push({ to, frame });
  }
  emitFrame(from: PublicIdentity, frame: TunnelFrame) {
    for (const fn of this.frameListeners) fn(from, "paired", frame);
  }
  emitUndeliverable(to: string, reason: string, channel?: string) {
    for (const fn of this.undeliverableListeners) fn(to, reason, channel);
  }
  emitPresence(data: { id: string; online: boolean; reset?: boolean }) {
    for (const fn of this.eventListeners.get("presence") ?? []) fn(data);
  }
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TunnelSocket presence failover and channel-scoped undeliverable", () => {
  it("ignores undeliverable for another channel and fails immediately on matching or unchannelled undeliverable", async () => {
    const device = createIdentity();
    const machine = createIdentity();
    const machinePub = publicIdentity(machine);
    const relay = new FakeRelay();

    const tunnel = new TunnelSocket(relay as unknown as RelayClient, device, machinePub);
    const errors: unknown[] = [];
    let closed = false;
    tunnel.onerror = (err) => errors.push(err);
    tunnel.onclose = () => {
      closed = true;
    };

    await Promise.resolve();
    const hello = relay.sent[0]!.frame as Extract<TunnelFrame, { k: "hello" }>;
    const answered = answerTunnel(machine, publicIdentity(device), hello);
    relay.emitFrame(machinePub, answered.welcome);
    expect(tunnel.readyState).toBe(1);

    // Stray undeliverable from an older/other channel must NOT close the active tunnel.
    relay.emitUndeliverable(machinePub.id, "offline", "stale-channel-id");
    expect(tunnel.readyState).toBe(1);
    expect(closed).toBe(false);

    // Matching channel fails the tunnel immediately.
    relay.emitUndeliverable(machinePub.id, "offline", hello.ch);
    expect(tunnel.readyState).toBe(3);
    expect(closed).toBe(true);
    expect(errors).toEqual([{ message: "电脑不在线", code: "offline" }]);
  });

  it("resets immediately when gateway emits machine offline or reset presence", async () => {
    const device = createIdentity();
    const machine = createIdentity();
    const machinePub = publicIdentity(machine);
    const otherMachine = publicIdentity(createIdentity());

    // 1. Offline presence fails over immediately.
    const relay1 = new FakeRelay();
    const tunnel1 = new TunnelSocket(relay1 as unknown as RelayClient, device, machinePub);
    const errors1: unknown[] = [];
    tunnel1.onerror = (e) => errors1.push(e);
    await Promise.resolve();
    const hello1 = relay1.sent[0]!.frame as Extract<TunnelFrame, { k: "hello" }>;
    relay1.emitFrame(machinePub, answerTunnel(machine, publicIdentity(device), hello1).welcome);
    expect(tunnel1.readyState).toBe(1);

    relay1.emitPresence({ id: otherMachine.id, online: false });
    expect(tunnel1.readyState).toBe(1);

    relay1.emitPresence({ id: machinePub.id, online: false });
    expect(tunnel1.readyState).toBe(3);
    expect(errors1).toEqual([{ message: "电脑不在线", code: "offline" }]);

    // 2. Machine re-authenticating (online presence / reset while tunnel already opened or hello sent) fails over immediately.
    const relay2 = new FakeRelay();
    const tunnel2 = new TunnelSocket(relay2 as unknown as RelayClient, device, machinePub);
    const errors2: unknown[] = [];
    tunnel2.onerror = (e) => errors2.push(e);
    await Promise.resolve();
    expect(tunnel2.readyState).toBe(0);
    expect(relay2.sent).toHaveLength(1);

    relay2.emitPresence({ id: machinePub.id, online: true, reset: true });
    expect(tunnel2.readyState).toBe(3);
    expect(errors2).toEqual([{ message: "连接已断开", code: "reset" }]);
  });
});

describe("HostStreams race cleanup and capped direct.offer retries", () => {
  function fakeOnlineLink() {
    let status = "online" as "online" | "reconnecting";
    const statusListeners = new Set<(s: "online" | "reconnecting") => void>();
    const onlineListeners = new Set<() => void>();
    const notifListeners = new Map<string, Set<(params: unknown) => void>>();
    const link = {
      get status() {
        return status;
      },
      call: vi.fn(),
      on(name: string, fn: (params: unknown) => void) {
        let set = notifListeners.get(name);
        if (!set) notifListeners.set(name, (set = new Set()));
        set.add(fn);
        return () => set.delete(fn);
      },
      onStatus(fn: (s: "online" | "reconnecting") => void) {
        statusListeners.add(fn);
        return () => statusListeners.delete(fn);
      },
      onOnline(fn: () => void) {
        onlineListeners.add(fn);
        return () => onlineListeners.delete(fn);
      },
      setStatus(next: "online" | "reconnecting") {
        status = next;
        for (const fn of statusListeners) fn(next);
        if (next === "online") for (const fn of onlineListeners) fn();
      },
      notify(name: string, params: unknown) {
        for (const fn of notifListeners.get(name) ?? []) fn(params);
      },
    };
    return link;
  }

  it("cleans up a relayed stream immediately if dropped or stopped while proxy.open is in flight", async () => {
    const link = fakeOnlineLink();
    let resolveOpen!: (value: { streamId: string }) => void;
    link.call.mockImplementation((method: string) => {
      if (method === "proxy.open") {
        return new Promise<{ streamId: string }>((resolve) => {
          resolveOpen = resolve;
        });
      }
      return Promise.resolve({});
    });

    const streams = new HostStreams(link as unknown as HostLink, { iceServers: () => undefined });
    const dataSpy = vi.fn();
    const closedSpy = vi.fn();
    const opening = streams.open(3000, { data: dataSpy, closed: closedSpy });

    // Stop streams while proxy.open is still pending; link remains online.
    streams.stop();
    resolveOpen({ streamId: "leaked-1" });

    await expect(opening).rejects.toThrow("连接已断开");
    expect(link.call).toHaveBeenCalledWith("proxy.close", { streamId: "leaked-1" });

    // Any subsequent proxy.data for that streamId is ignored rather than delivered to a dead handler.
    link.notify("proxy.data", { streamId: "leaked-1", data: btoa("hello") });
    expect(dataSpy).not.toHaveBeenCalled();
  });

  it("caps consecutive direct.offer retries to 3 per link session (15s -> 45s -> pause) and resets on link reconnect", async () => {
    vi.useFakeTimers();
    const link = fakeOnlineLink();
    let offers = 0;
    link.call.mockImplementation(async (method: string) => {
      if (method === "direct.offer") {
        offers += 1;
        throw new Error("UDP blocked");
      }
      return {};
    });

    const connector = vi.fn((): DirectConnection => ({
      offer: () => Promise.resolve("v=0"),
      accept: () => Promise.resolve(),
      send: () => {},
      onState: () => {},
      onMessage: () => {},
      close: () => {},
    }));

    const streams = new HostStreams(link as unknown as HostLink, {
      connector,
      iceServers: () => ["stun:stun.example.com:3478"],
    });

    // Attempt 1 runs immediately.
    await vi.advanceTimersByTimeAsync(0);
    expect(offers).toBe(1);
    expect(streams.path).toBe("relay");

    // Backoff 1: 15s -> Attempt 2.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(offers).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(offers).toBe(2);

    // Backoff 2: 45s -> Attempt 3.
    await vi.advanceTimersByTimeAsync(44_999);
    expect(offers).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(offers).toBe(3);

    // Paused after 3 consecutive failures on this link session: even 10 minutes or incidental connect() won't retry.
    await vi.advanceTimersByTimeAsync(600_000);
    streams.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(offers).toBe(3);

    // Link reconnect resets the 3-attempt cap.
    link.setStatus("reconnecting");
    link.setStatus("online");
    await vi.advanceTimersByTimeAsync(0);
    expect(offers).toBe(4);
  });
});
