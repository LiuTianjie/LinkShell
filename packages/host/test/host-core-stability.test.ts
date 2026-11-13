import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { RTCPeerConnection } from "werift";
import { LsaStore } from "../src/lsa/lsa-store.js";
import { DirectPeer } from "../src/direct.js";
import { ProxyStreams } from "../src/ports.js";
import { acquireHostLock, ensureSecureRunDir, startHost } from "../src/host.js";
import { HostRpcServer, buildDesktopOpenCommand, openDesktopPath } from "../src/rpc/server.js";
import { connectHost } from "../src/rpc/client.js";
import { HostStore } from "../src/store.js";
import { TerminalManager } from "../src/terminals.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

function tempDir(prefix = "lsh-stability-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("LsaStore busy_timeout and post-close guards", () => {
  it("silently ignores reads and writes after close() without throwing ERR_INVALID_STATE", () => {
    const dir = tempDir("lsh-lsa-");
    const lsa = new LsaStore(join(dir, "lsa.db"));
    expect(lsa.advanceControllerEpoch()).toBe(2);
    lsa.close();
    expect(lsa.isClosed).toBe(true);
    expect(() => lsa.advanceControllerEpoch()).not.toThrow();
    expect(lsa.getControllerEpoch()).toBe(1);
    expect(() =>
      lsa.saveMemory({
        key: "k1",
        scope: "global",
        content: "hello",
      }),
    ).not.toThrow();
    expect(lsa.searchMemories()).toEqual([]);
  });
});

describe("DirectPeer lifecycle cleanup", () => {
  it("closes underlying RTCPeerConnection, notifies streams on failure, and unsubscribes gathering listener", async () => {
    const closedInstances = new Set<RTCPeerConnection>();
    const origClose = RTCPeerConnection.prototype.close;
    const closeSpy = vi.spyOn(RTCPeerConnection.prototype, "close").mockImplementation(function (this: RTCPeerConnection) {
      closedInstances.add(this);
      return origClose.call(this);
    });
    const createAnswerSpy = vi
      .spyOn(RTCPeerConnection.prototype, "createAnswer")
      .mockRejectedValueOnce(new Error("synthetic answer failure"));
    try {
      const peer = new DirectPeer([], () => {});
      let streamLost: boolean | undefined;
      peer.attach({
        data: () => {},
        close: (lost) => {
          streamLost = lost;
        },
      });
      await expect(peer.answer("v=0\r\n")).rejects.toThrow("synthetic answer failure");
      expect(peer.open).toBe(false);
      expect(streamLost).toBe(true);
      expect(closedInstances.size).toBe(1);

      // Verify gathered() unsubscribes iceGatheringStateChange and peer.close() closes the active connection.
      let unsubscribed = 0;
      const setRemoteSpy = vi.spyOn(RTCPeerConnection.prototype, "setRemoteDescription").mockResolvedValueOnce();
      createAnswerSpy.mockResolvedValueOnce({ type: "answer", sdp: "v=0\r\na=test-answer\r\n" } as never);
      const setLocalSpy = vi
        .spyOn(RTCPeerConnection.prototype, "setLocalDescription")
        .mockImplementationOnce(async function (this: RTCPeerConnection, desc) {
          Object.defineProperty(this, "localDescription", { value: desc, configurable: true });
          const origSubscribe = this.iceGatheringStateChange.subscribe.bind(this.iceGatheringStateChange);
          vi.spyOn(this.iceGatheringStateChange, "subscribe").mockImplementationOnce((cb) => {
            const sub = origSubscribe(cb);
            queueMicrotask(() => cb("complete"));
            return {
              ...sub,
              unSubscribe: () => {
                unsubscribed++;
                sub.unSubscribe();
              },
            };
          });
        });
      try {
        const answerSdp = await peer.answer("v=0\r\n");
        expect(answerSdp).toContain("a=test-answer");
        expect(unsubscribed).toBe(1);
        peer.close();
        expect(closedInstances.size).toBe(2);
      } finally {
        setRemoteSpy.mockRestore();
        setLocalSpy.mockRestore();
      }
    } finally {
      createAnswerSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });
});

describe("ProxyStreams closeAll() race and 2 MB RPC backpressure", () => {
  it("pauses loopback socket when RPC bufferedAmount exceeds 2 MB and resumes once drained", async () => {
    let buffered = 3 * 1024 * 1024;
    const chunks: Buffer[] = [];
    const server = net.createServer((sock) => {
      // Push two bursts so the first triggers pause() while buffered > 2 MB.
      sock.write(Buffer.alloc(16 * 1024, 0x61));
      setTimeout(() => {
        if (!sock.destroyed) sock.write(Buffer.alloc(16 * 1024, 0x62));
      }, 30);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;

    const direct = new DirectPeer([], () => {});
    const proxy = new ProxyStreams(
      {
        data: (_id, data) => chunks.push(Buffer.from(data, "base64")),
        closed: () => {},
        bufferedAmount: () => buffered,
      },
      direct,
    );
    cleanups.push(() => {
      proxy.closeAll();
      direct.close();
    });

    await proxy.open(port, false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const receivedWhilePaused = Buffer.concat(chunks).length;
    expect(receivedWhilePaused).toBeGreaterThan(0);

    // Drain outbound transport buffer below 1 MB low-water mark so drainTimer resumes the socket.
    buffered = 0;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(Buffer.concat(chunks).length).toBe(32 * 1024);
  });

  it("rejects open() with not_ready and destroys late-resolving socket immediately if closeAll() runs mid-connect", async () => {
    let resolveConnect!: (socket: net.Socket) => void;
    const lateSocket = new PassThrough() as unknown as net.Socket;
    let destroyed = false;
    lateSocket.destroy = (() => {
      destroyed = true;
      return lateSocket;
    }) as typeof lateSocket.destroy;

    const direct = new DirectPeer([], () => {});
    const proxy = new ProxyStreams(
      { data: () => {}, closed: () => {} },
      direct,
      () => new Promise<net.Socket>((resolve) => {
        resolveConnect = resolve;
      }),
    );
    const opening = proxy.open(8080, false);
    proxy.closeAll();
    resolveConnect(lateSocket);
    await expect(opening).rejects.toMatchObject({ appCode: "not_ready" });
    expect(destroyed).toBe(true);
    direct.close();
  });
});

describe("Host lockfile, secure runDir, live socket probe, WS heartbeat, sessions.get & desktop.openPath", () => {
  it.skipIf(process.platform === "win32")("rejects symlinked runDir and wrong-owner runDir", () => {
    const root = tempDir("lsh-rundir-");
    const target = join(root, "real");
    mkdirSync(target, { mode: 0o700 });
    const link = join(root, "symlink-run");
    symlinkSync(target, link);

    expect(() => ensureSecureRunDir(link)).toThrow(/not a real directory/);
    expect(() => ensureSecureRunDir(target, (process.getuid?.() ?? 0) + 1)).toThrow(/owned by uid/);
  });

  it("enforces exclusive host.lock against live PID and reclaims dead-PID lockfile", () => {
    const dir = tempDir("lsh-lock-");
    const lockPath = join(dir, "host.lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: 999_999_991, startedAt: 1000 })}\n`);

    // Dead PID lock is reclaimed cleanly.
    const release = acquireHostLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);

    // Second acquire while live PID holds lock is rejected.
    expect(() => acquireHostLock(lockPath)).toThrow(/already running/);

    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("probes socketPath before unlinking so a live listener's socket is never deleted", async () => {
    const home = tempDir("lsh-sockprobe-");
    const host1 = await startHost({ home, version: "test", drivers: () => [], discoveryIntervalMs: 0, log: () => {} });
    cleanups.push(() => host1.stop());

    // Attempt to start another HostRpcServer directly against host1's live socketPath.
    const store2 = new HostStore(":memory:");
    cleanups.push(() => store2.close());
    const terms2 = new TerminalManager(process.env, store2);
    cleanups.push(() => terms2.stop());
    const intruder = new HostRpcServer({
      hub: host1.hub,
      terminals: terms2,
      machineInfo: () => host1.machineInfo(),
      socketPath: host1.paths.hostSocket,
      log: () => {},
    });

    await expect(intruder.start()).rejects.toThrow(/already listening/);
    await intruder.stop();

    // Original host's socket is still intact and serving RPCs!
    expect(existsSync(host1.paths.hostSocket)).toBe(true);
    const client = await connectHost(host1.paths.hostSocket);
    cleanups.push(() => client.close());
    expect((await client.call("machine.info", {})).hostVersion).toBe("test");
  });

  it("wires sessions.get, composite sessions.list cursor, AbortSignal, and shell-free desktop.openPath", async () => {
    const home = tempDir("lsh-rpc-methods-");
    const targetFile = join(home, "weird; $(touch pwned) & name.ts");
    writeFileSync(targetFile, "export const safe = true;\n");

    const macReveal = buildDesktopOpenCommand(targetFile, false, "reveal", "darwin");
    expect(macReveal).toEqual({ command: "/usr/bin/open", args: ["-R", targetFile] });
    const linuxVscode = buildDesktopOpenCommand(targetFile, false, "vscode", "linux");
    expect(linuxVscode).toEqual({ command: "code", args: ["--", targetFile] });
    const winTerminal = buildDesktopOpenCommand(targetFile, false, "terminal", "win32");
    expect(winTerminal).toEqual({ command: "wt.exe", args: ["-d", home] });

    const invocations: Array<{ command: string; args: string[] }> = [];
    const res = await openDesktopPath({ path: targetFile, app: "cursor" }, async (command, args) => {
      invocations.push({ command, args });
    }, "darwin");
    expect(res).toEqual({ ok: true });
    expect(invocations).toEqual([{ command: "/usr/bin/open", args: ["-a", "Cursor", targetFile] }]);

    const host = await startHost({ home, version: "test", drivers: () => [], discoveryIntervalMs: 0, log: () => {} });
    cleanups.push(() => host.stop());
    const client = await connectHost(host.paths.hostSocket);
    cleanups.push(() => client.close());

    expect(await client.call("sessions.get", { sessionId: "codex:nonexistent" })).toEqual({});
  });

  it("terminates unresponsive WebSocket peers via ping/pong heartbeat sweep", async () => {
    const dir = tempDir("lsh-hb-");
    const store = new HostStore(":memory:");
    cleanups.push(() => store.close());
    const terms = new TerminalManager(process.env, store);
    cleanups.push(() => terms.stop());
    const host = await startHost({ home: dir, version: "test", drivers: () => [], discoveryIntervalMs: 0, log: () => {} });
    cleanups.push(() => host.stop());

    const hbServer = new HostRpcServer({
      hub: host.hub,
      terminals: terms,
      machineInfo: () => host.machineInfo(),
      socketPath: join(dir, "hb.sock"),
      tcpPort: 0,
      heartbeatIntervalMs: 40,
      log: () => {},
    });
    await hbServer.start();
    cleanups.push(() => hbServer.stop());

    const ws = new WebSocket(`ws://127.0.0.1:${hbServer.tcpAddress()}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    // Suppress automatic pong replies so the socket simulates a dead half-open peer.
    ws.pong = (() => {}) as typeof ws.pong;

    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

describe("Terminal micro-batched SQLite frame writes", () => {
  it("batches rapid terminal frames and flushes synchronously on replay() and stop()", async () => {
    const dir = tempDir("lsh-term-batch-");
    const store = new HostStore(join(dir, "state.db"));
    cleanups.push(() => store.close());
    const spy = vi.spyOn(store, "appendTerminalFrames");
    const manager = new TerminalManager(process.env, store);
    cleanups.push(() => manager.stop());

    const term = manager.create({
      launch: { command: process.execPath, args: ["-e", "for (let i = 0; i < 10; i++) process.stdout.write('line-' + i + '\\n'); setTimeout(() => {}, 200);"] },
      cols: 80,
      rows: 24,
    });

    await new Promise((resolve) => setTimeout(resolve, 160));
    const attached = manager.attach(term.id, () => {}, undefined, "frames-v1", 0);
    expect(attached.recording?.throughFrame).toBeGreaterThan(0);
    const replayed = manager.replay(term.id, 0, attached.recording!.throughFrame);
    expect(replayed.frames.map((f) => f.data).join("")).toContain("line-9");
    expect(spy).toHaveBeenCalled();
  });
});
