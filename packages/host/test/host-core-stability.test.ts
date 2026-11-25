import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { RTCPeerConnection } from "werift";
import { DirectPeer } from "../src/direct.js";
import { parseProcNetTcp, procNetListeners, ProxyStreams } from "../src/ports.js";
import { acquireHostLock, ensureSecureRunDir, hostPaths, isLinkShellHostCmdline, startHost } from "../src/host.js";
import { HostRpcServer, buildDesktopOpenCommand, openDesktopPath, resolveLinuxTerminalCommand } from "../src/rpc/server.js";
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

  it("reclaims Linux host.lock on EPERM or recycled non-LinkShell PID, and keeps live LinkShell PID locks", () => {
    const dir = tempDir("lsh-lock-linux-");
    const lockPath = join(dir, "host.lock");
    expect(isLinkShellHostCmdline("/usr/bin/node\0/usr/local/bin/linkshell\0host\0--daemon\0")).toBe(true);
    expect(isLinkShellHostCmdline("/usr/bin/python3\0app.py\0")).toBe(false);

    // 1. EPERM from kill(pid, 0) means another user owns the recycled PID -> reclaim lock.
    writeFileSync(lockPath, `${JSON.stringify({ pid: 4242, startedAt: 1000 })}\n`);
    const releaseEperm = acquireHostLock(lockPath, {
      platform: "linux",
      killZero: () => {
        const err = new Error("Operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      },
    });
    releaseEperm();

    // 2. Recycled PID owned by same user running a non-LinkShell binary -> reclaim lock.
    writeFileSync(lockPath, `${JSON.stringify({ pid: 5252, startedAt: 1000 })}\n`);
    const releaseRecycled = acquireHostLock(lockPath, {
      platform: "linux",
      socketReachable: false,
      killZero: () => {},
      readProcCmdline: () => "/usr/bin/python3\0server.py\0",
    });
    releaseRecycled();

    // 3. Live PID whose /proc/<pid>/cmdline IS a LinkShell host -> reject acquisition.
    writeFileSync(lockPath, `${JSON.stringify({ pid: 6262, startedAt: 1000 })}\n`);
    expect(() =>
      acquireHostLock(lockPath, {
        platform: "linux",
        socketReachable: false,
        killZero: () => {},
        readProcCmdline: () => "/usr/bin/node\0/usr/lib/node_modules/linkshell-cli/dist/index.js\0host\0",
      }),
    ).toThrow(/already running/);
  });

  it.skipIf(process.platform === "win32")("prefers writable $XDG_RUNTIME_DIR on Linux for long homes and enforces 0700/0600 permissions", async () => {
    const xdg = tempDir("lsh-xdg-");
    const longHome = join(xdg, "a".repeat(95));
    const linuxPaths = hostPaths(longHome, { platform: "linux", env: { XDG_RUNTIME_DIR: xdg }, uid: 1000 });
    expect(linuxPaths.runDir.startsWith(join(xdg, "linkshell-"))).toBe(true);
    expect(Buffer.byteLength(linuxPaths.codexSocket)).toBeLessThanOrEqual(100);

    // Falls back to /tmp when XDG_RUNTIME_DIR is missing or not writable.
    const fallbackPaths = hostPaths(longHome, { platform: "linux", env: { XDG_RUNTIME_DIR: join(xdg, "missing") }, uid: 1000 });
    expect(fallbackPaths.runDir.startsWith("/tmp/linkshell-1000-")).toBe(true);

    // Verify startHost enforces 0700 on home/runDir and 0600 on state.db (+ sidecars) and host.sock.
    const home = tempDir("lsh-perms-");
    const host = await startHost({ home, version: "test", drivers: () => [], discoveryIntervalMs: 0, log: () => {} });
    cleanups.push(() => host.stop());
    expect(statSync(host.paths.home).mode & 0o777).toBe(0o700);
    expect(statSync(host.paths.runDir).mode & 0o777).toBe(0o700);
    expect(statSync(host.paths.database).mode & 0o777).toBe(0o600);
    expect(statSync(host.paths.hostSocket).mode & 0o777).toBe(0o600);
    for (const sidecar of [`${host.paths.database}-wal`, `${host.paths.database}-shm`]) {
      if (existsSync(sidecar)) expect(statSync(sidecar).mode & 0o777).toBe(0o600);
    }
  });

  it("advertises mDNS in LAN mode when lanPort is configured and ensures identity.json first", async () => {
    const home = tempDir("lsh-lan-mdns-");
    let spawnedArgs: string[] = [];
    const fakeChild = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      killed: false,
      unref: () => {},
      kill() {
        this.killed = true;
        this.exitCode = 0;
        this.emit("exit", 0);
        return true;
      },
    }) as unknown as ChildProcess;

    const host = await startHost({
      home,
      version: "test",
      lanPort: 8787,
      mdns: true,
      spawnMdnsProcess: (_cmd, args) => {
        spawnedArgs = args;
        return fakeChild;
      },
      drivers: () => [],
      discoveryIntervalMs: 0,
      log: () => {},
    });
    cleanups.push(() => host.stop());

    expect(existsSync(join(home, "identity.json"))).toBe(true);
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(spawnedArgs).toContain("8787");
      expect(spawnedArgs).toContain("hostport=8787");
    }
  });

  it("probes $TERMINAL and major Linux terminal emulators for desktop.openPath terminal", () => {
    expect(
      resolveLinuxTerminalCommand("/srv/app", {
        env: { TERMINAL: "/usr/bin/kitty" },
        hasCommand: (cmd) => cmd === "/usr/bin/kitty",
      }),
    ).toEqual({ command: "/usr/bin/kitty", args: ["--directory", "/srv/app"] });

    expect(
      buildDesktopOpenCommand("/srv/app/file.ts", false, "terminal", "linux", {
        env: {},
        hasCommand: (cmd) => cmd === "konsole",
      }),
    ).toEqual({ command: "konsole", args: ["--workdir", "/srv/app"] });

    expect(
      buildDesktopOpenCommand("/srv/app", true, "terminal", "linux", {
        env: {},
        hasCommand: (cmd) => cmd === "wezterm",
      }),
    ).toEqual({ command: "wezterm", args: ["start", "--cwd", "/srv/app"] });

    expect(
      buildDesktopOpenCommand("/srv/app", true, "terminal", "linux", {
        env: {},
        hasCommand: (cmd) => cmd === "alacritty" || cmd === "x-terminal-emulator",
      }),
    ).toEqual({ command: "alacritty", args: ["--working-directory", "/srv/app"] });
  });

  it.skipIf(process.platform === "win32")("parses Linux /proc/net/tcp{,6} and resolves socket owners when ss is unavailable", async () => {
    const tcp4 = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55501 1 0000 100 0 0 10 0",
      "   1: 0100007F:1436 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 55502 1 0000 100 0 0 10 0",
    ].join("\n");
    const tcp6 = [
      "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 66602 1 0000 100 0 0 10 0",
    ].join("\n");

    expect(parseProcNetTcp(tcp4)).toEqual([{ port: 5173, inode: "55501" }]);
    expect(parseProcNetTcp(tcp6)).toEqual([{ port: 8080, inode: "66602" }]);

    const fakeProc = tempDir("lsh-proc-");
    mkdirSync(join(fakeProc, "net"), { recursive: true });
    writeFileSync(join(fakeProc, "net", "tcp"), tcp4);
    writeFileSync(join(fakeProc, "net", "tcp6"), tcp6);
    mkdirSync(join(fakeProc, "4321", "fd"), { recursive: true });
    writeFileSync(join(fakeProc, "4321", "comm"), "node\n");
    symlinkSync("socket:[55501]", join(fakeProc, "4321", "fd", "20"));
    mkdirSync(join(fakeProc, "9876", "fd"), { recursive: true });
    writeFileSync(join(fakeProc, "9876", "comm"), "python3\n");
    symlinkSync("socket:[66602]", join(fakeProc, "9876", "fd", "7"));

    const found = await procNetListeners(fakeProc);
    expect(found).toEqual([
      { port: 5173, pid: 4321, process: "node" },
      { port: 8080, pid: 9876, process: "python3" },
    ]);
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
