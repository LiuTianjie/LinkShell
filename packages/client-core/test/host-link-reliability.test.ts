import { afterEach, describe, expect, it, vi } from "vitest";
import { HostLink, translateSocketError, type SocketLike } from "../src/host-link.js";

type RpcFrame = { id: number; method: string; params: Record<string, unknown> };

class MockSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  onmessage: SocketLike["onmessage"] = null;
  readonly sent: RpcFrame[] = [];
  closedCount = 0;
  autoMachineInfo = true;

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  fail(message: string) {
    this.onerror?.({ message });
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: message });
  }

  close() {
    this.closedCount += 1;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "closed" });
  }

  send(data: string) {
    const frame = JSON.parse(data) as RpcFrame;
    this.sent.push(frame);
    if (this.autoMachineInfo && frame.method === "machine.info") {
      this.resolve(frame.id, { machineId: "host", hostname: "Mac", platform: "darwin", hostVersion: "test", agents: [] });
    }
  }

  resolve(id: number, result: unknown) {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  }
}

const links: HostLink[] = [];

afterEach(() => {
  for (const link of links.splice(0)) link.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HostLink reliability", () => {
  it("lowers the stuck-socket guard in reconnectNow to 5s and bypasses guards when forced", async () => {
    vi.useFakeTimers();
    const sockets: MockSocket[] = [];
    const link = new HostLink({
      url: "ws://host",
      heartbeatMs: 0,
      createSocket: () => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket;
      },
    });
    links.push(link);

    link.start();
    expect(sockets).toHaveLength(1);

    // Within 5s, unforced reconnectNow keeps the in-progress socket.
    await vi.advanceTimersByTimeAsync(4_900);
    link.reconnectNow();
    expect(sockets).toHaveLength(1);

    // Past 5s, unforced reconnectNow replaces the stuck socket.
    await vi.advanceTimersByTimeAsync(200);
    link.reconnectNow();
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closedCount).toBe(1);

    // Once online, unforced reconnectNow is a no-op, whereas reconnectNow(true) forces a fresh socket immediately.
    sockets[1]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(link.status).toBe("online");

    link.reconnectNow();
    expect(sockets).toHaveLength(2);

    link.reconnectNow(true);
    expect(sockets).toHaveLength(3);
    expect(sockets[1]!.closedCount).toBe(1);
    expect(link.status).toBe("connecting");
  });

  it("deduplicates concurrent probes at 2500ms default and forces reconnect on failure", async () => {
    vi.useFakeTimers();
    const sockets: MockSocket[] = [];
    const link = new HostLink({
      url: "ws://host",
      heartbeatMs: 0,
      createSocket: () => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket;
      },
    });
    links.push(link);

    link.start();
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(link.status).toBe("online");

    // Simulate a half-open socket that neither answers nor emits onclose when closed.
    sockets[0]!.autoMachineInfo = false;
    sockets[0]!.close = () => {
      sockets[0]!.closedCount += 1;
      sockets[0]!.readyState = 3;
    };
    const baselineSent = sockets[0]!.sent.length;

    const p1 = link.probe();
    const p2 = link.probe();
    const p3 = link.probe();
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    expect(sockets[0]!.sent.length - baselineSent).toBe(1);

    await vi.advanceTimersByTimeAsync(2499);
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(await p1).toBe(false);
    expect(sockets).toHaveLength(2);
    expect(link.status).toBe("connecting");
  });

  it("decouples waitOnline wait time from peer.request execution budget in call()", async () => {
    vi.useFakeTimers();
    const sockets: MockSocket[] = [];
    const link = new HostLink({
      url: "ws://host",
      heartbeatMs: 0,
      minBackoffMs: 60_000,
      maxBackoffMs: 60_000,
      createSocket: () => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket;
      },
    });
    links.push(link);

    link.start();
    const pendingCall = link.call("projects.list", { limit: 10 }, 30_000);

    // Spend 28s of the 30s call budget waiting to come online.
    await vi.advanceTimersByTimeAsync(28_000);
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(link.status).toBe("online");

    const projectsReq = sockets[0]!.sent.find((frame) => frame.method === "projects.list")!;
    expect(projectsReq).toBeDefined();

    // Even though only 2s remained of the original 30s deadline, peer.request gets at least 15s.
    await vi.advanceTimersByTimeAsync(12_000);
    sockets[0]!.resolve(projectsReq.id, { projects: [] });
    await expect(pendingCall).resolves.toEqual({ projects: [] });
  });

  it("preserves exponential backoff when sockets fail during machine.info bootstrap", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor = 0.8 + 0.2 = 1.0
    const sockets: MockSocket[] = [];
    const link = new HostLink({
      url: "ws://host",
      heartbeatMs: 0,
      minBackoffMs: 1_000,
      maxBackoffMs: 16_000,
      createSocket: () => {
        const socket = new MockSocket();
        socket.autoMachineInfo = false;
        sockets.push(socket);
        return socket;
      },
    });
    links.push(link);

    link.start();
    // Socket 1 opens, then drops before machine.info answers -> backoff should be 1000ms (attempt 0 -> 1).
    sockets[0]!.open();
    sockets[0]!.fail("ECONNRESET");
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);

    // Socket 2 opens and hangs on machine.info (10s timeout) -> backoff should be 2000ms (attempt 1 -> 2), NOT reset to 1000ms!
    sockets[1]!.open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(link.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    // Socket 3 succeeds machine.info -> attempt resets to 0, so a subsequent disconnect backs off 1000ms.
    sockets[2]!.autoMachineInfo = true;
    sockets[2]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(link.status).toBe("online");

    sockets[2]!.fail("ECONNRESET");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(4);
  });

  it("translates raw English OS and WebSocket errors into clear Chinese user-facing messages", () => {
    expect(translateSocketError("connect ECONNREFUSED 127.0.0.1:7878")).toBe("连接被拒绝，请确认电脑上的 LinkShell 正在运行");
    expect(translateSocketError("connect ETIMEDOUT 192.168.1.10:7878")).toBe("连接电脑超时，请检查网络连接");
    expect(translateSocketError("getaddrinfo ENOTFOUND my-mac.local")).toBe("找不到电脑的网络地址，请检查网络设置");
    expect(translateSocketError("read ECONNRESET")).toBe("网络连接意外中断");
    expect(translateSocketError("Network request failed")).toBe("网络请求失败，请检查网络连接");
    expect(translateSocketError("WebSocket is closed before the connection is established")).toBe("连接已断开");
    expect(translateSocketError("电脑不在线")).toBe("电脑不在线");

    const statuses: { status: string; error?: string }[] = [];
    const socket = new MockSocket();
    const link = new HostLink({ url: "ws://host", heartbeatMs: 0, createSocket: () => socket });
    links.push(link);
    link.onStatus((status, error) => statuses.push({ status, error }));
    link.start();
    socket.fail("connect ECONNREFUSED 192.168.1.5:7878");
    expect(link.lastError).toBe("连接被拒绝，请确认电脑上的 LinkShell 正在运行");
    expect(statuses.at(-1)).toEqual({
      status: "reconnecting",
      error: "连接被拒绝，请确认电脑上的 LinkShell 正在运行",
    });
  });
});
