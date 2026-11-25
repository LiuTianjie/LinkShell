import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// The module reads LINKSHELL_HOME once, as it loads.
const home = mkdtempSync(join(tmpdir(), "lsh-daemon-"));
process.env.LINKSHELL_HOME = home;
const daemon = await import("../src/utils/daemon.js");
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The pid of a process that has just ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

/** Spawns a fake LinkShell host process whose argv carries `--_foreground-host`. */
function spawnFakeHost(script: string) {
  return spawn(process.execPath, ["-e", script, "--", "host", "--_foreground-host"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
}

describe("background processes", () => {
  it.skipIf(process.platform === "win32")("knows a running daemon by its pid file and rejects recycled unrelated PIDs", async () => {
    const child = spawnFakeHost("setInterval(() => {}, 1000); process.stdout.write('ready');");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
      daemon.savePid("host", child.pid!);
      expect(daemon.readPid("host")).toBe(child.pid);
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, "host.pid")).mode & 0o777).toBe(0o600);
    } finally {
      child.kill("SIGKILL");
      await exited;
      daemon.removePid("host");
    }

    // Current vitest worker PID does not match linkshell host: readPid cleans stale file and returns null.
    daemon.savePid("host", process.pid);
    expect(daemon.readPid("host")).toBeNull();
    expect(existsSync(join(home, "host.pid"))).toBe(false);
  });

  it("forgets a daemon that is gone, and removes its pid file", () => {
    daemon.savePid("host", deadPid());
    expect(daemon.readPid("host")).toBeNull();
    expect(existsSync(join(home, "host.pid"))).toBe(false);
  });

  it("takes a pid file that isn't a pid for no daemon", () => {
    writeFileSync(join(home, "gateway.pid"), "not a pid");
    expect(daemon.readPid("gateway")).toBeNull();
    expect(daemon.readPid("bridge")).toBeNull();
  });

  it("has nothing to stop when the daemon is gone", () => {
    daemon.savePid("host", deadPid());
    expect(daemon.stopDaemon("host")).toBe(false);
    expect(existsSync(join(home, "host.pid"))).toBe(false);
  });

  it("rejects process-group and fractional PID files", () => {
    for (const value of ["-1", "0", "1.5"]) {
      writeFileSync(join(home, "host.pid"), value);
      expect(daemon.readPid("host")).toBeNull();
    }
  });

  it.skipIf(process.platform === "win32")("waits for actual shutdown even when the PID file is already gone", async () => {
    const child = spawnFakeHost("process.on('SIGTERM', () => setTimeout(() => process.exit(0), 250)); setInterval(() => {}, 1000); process.stdout.write('ready');");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
      daemon.savePid("host", child.pid!);
      const stopped = daemon.stopDaemonAndWait("host", 3000, child.pid!);
      daemon.removePid("host");
      expect(await stopped).toBe(true);
      expect(() => process.kill(child.pid!, 0)).toThrow();
      expect(existsSync(join(home, "host.pid"))).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it.skipIf(process.platform === "win32")("escalates to SIGKILL and cleans stale pid/lock files when daemon ignores SIGTERM", async () => {
    const child = spawnFakeHost("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const runDir = join(home, "run");
    mkdirSync(runDir, { recursive: true });
    const lockFile = join(runDir, "host.lock");
    writeFileSync(lockFile, '{"pid":1}\n');
    try {
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
      daemon.savePid("host", child.pid!);
      expect(await daemon.stopDaemonAndWait("host", 150)).toBe(true);
      await exited;
      expect(existsSync(join(home, "host.pid"))).toBe(false);
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
      daemon.removePid("host");
    }
  });

  it.skipIf(process.platform === "win32")("reports an unresponsive daemon without force-killing when forceKill is false", async () => {
    const child = spawnFakeHost("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
      daemon.savePid("host", child.pid!);
      await expect(daemon.stopDaemonAndWait("host", 100, undefined, { forceKill: false })).rejects.toThrow("did not stop");
      expect(daemon.readPid("host")).toBe(child.pid);
    } finally {
      child.kill("SIGKILL");
      await exited;
      daemon.removePid("host");
    }
  });

  it.skipIf(process.platform === "win32")("verifies process cmdline before signaling PID in stopDaemon() and stopDaemonAndWait()", async () => {
    expect(daemon.matchesServiceProcess("host", "/usr/local/bin/node /opt/linkshell/dist/index.js host --_foreground-host")).toBe(true);
    expect(daemon.matchesServiceProcess("gateway", "node /opt/linkshell/dist/index.js gateway --_foreground-gw --port 8787")).toBe(true);
    expect(daemon.matchesServiceProcess("host", "/usr/bin/python3 -m http.server 8000")).toBe(false);

    // Simulate a recycled PID running an unrelated node script: neither stopDaemon nor stopDaemonAndWait may kill it!
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); process.stdout.write('up');"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const exited = new Promise<void>((resolve) => unrelated.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve) => unrelated.stdout!.once("data", () => resolve()));
      daemon.savePid("host", unrelated.pid!);
      expect(daemon.stopDaemon("host")).toBe(false);
      expect(existsSync(join(home, "host.pid"))).toBe(false);
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();

      daemon.savePid("host", unrelated.pid!);
      expect(await daemon.stopDaemonAndWait("host", 500, unrelated.pid!)).toBe(false);
      expect(existsSync(join(home, "host.pid"))).toBe(false);
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    } finally {
      unrelated.kill("SIGKILL");
      await exited;
      daemon.removePid("host");
    }
  });
});

describe("Linux /proc identity parsing", () => {
  it("parses NUL-delimited /proc/<pid>/cmdline and /proc/<pid>/stat with tricky comm names", () => {
    expect(
      daemon.parseProcCmdline(Buffer.from("/usr/bin/node\0/opt/linkshell/index.js\0host\0--_foreground-host\0")),
    ).toBe("/usr/bin/node /opt/linkshell/index.js host --_foreground-host");

    expect(daemon.parseProcStatState("1234 (node) S 1 1234 1234 0 -1")).toBe("S");
    expect(daemon.parseProcStatState("1234 (my (weird) proc) Z 1 1234")).toBe("Z");
    expect(daemon.parseProcStatState("malformed")).toBeUndefined();
  });

  it("uses /proc directly on Linux and rejects zombie processes", () => {
    const mockProc = (files: Record<string, Buffer | string>) => (path: string) => {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[path]!;
    };

    expect(
      daemon.verifyDaemonIdentity("host", 4242, {
        platform: "linux",
        readProcFile: mockProc({
          "/proc/4242/stat": "4242 (node) S 1 4242 4242",
          "/proc/4242/cmdline": Buffer.from("/usr/bin/node\0/usr/lib/linkshell/index.js\0host\0--_foreground-host\0"),
        }),
      }),
    ).toBe(true);

    // Zombie process must fail identity verification even if cmdline matches.
    expect(
      daemon.verifyDaemonIdentity("host", 4242, {
        platform: "linux",
        readProcFile: mockProc({
          "/proc/4242/stat": "4242 (node) Z 1 4242 4242",
          "/proc/4242/cmdline": Buffer.from("/usr/bin/node\0/usr/lib/linkshell/index.js\0host\0--_foreground-host\0"),
        }),
      }),
    ).toBe(false);

    // Unrelated command line on Linux fails verification.
    expect(
      daemon.verifyDaemonIdentity("host", 4242, {
        platform: "linux",
        readProcFile: mockProc({
          "/proc/4242/stat": "4242 (python3) S 1 4242 4242",
          "/proc/4242/cmdline": Buffer.from("/usr/bin/python3\0-m\0http.server\0"),
        }),
      }),
    ).toBe(false);
  });
});

describe("host and gateway launch settings", () => {
  it("keeps the actual development port and explicit host options without saving credentials", () => {
    vi.stubEnv("LINKSHELL_GATEWAY", "off");
    vi.stubEnv("LINKSHELL_DEV_PORT", "0");
    vi.stubEnv("OPENAI_API_KEY", "never-save-this");
    try {
      daemon.saveHostLaunch(123, 7878);
      expect(daemon.readHostLaunch(123)).toMatchObject({ LINKSHELL_GATEWAY: "off", LINKSHELL_DEV_PORT: "7878" });
      expect(daemon.readHostLaunch(124)).toEqual({});
      expect(readFileSync(join(home, "host-launch.json"), "utf8")).not.toContain("never-save-this");
      if (process.platform !== "win32") expect(statSync(join(home, "host-launch.json")).mode & 0o777).toBe(0o600);
      daemon.removePid("host");
      expect(daemon.readHostLaunch(123)).toEqual({});
    } finally { vi.unstubAllEnvs(); }
  });

  it("saves and reads gateway port/host launch metadata with 0600 permissions", () => {
    daemon.saveGatewayLaunch(777, 9999, "127.0.0.1");
    expect(daemon.readGatewayLaunch(777)).toEqual({ pid: 777, port: 9999, host: "127.0.0.1" });
    expect(daemon.readGatewayLaunch(778)).toBeUndefined();
    if (process.platform !== "win32") expect(statSync(join(home, "gateway-launch.json")).mode & 0o777).toBe(0o600);
    daemon.removePid("gateway");
    expect(daemon.readGatewayLaunch(777)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("tightens an existing permissive directory to 0700 in ensurePrivateDir()", () => {
    const sub = join(home, "permissive-sub");
    mkdirSync(sub, { mode: 0o755 });
    chmodSync(sub, 0o755);
    daemon.ensurePrivateDir(sub);
    expect(statSync(sub).mode & 0o777).toBe(0o700);
  });
});

describe("a daemon's log", () => {
  const log = join(home, "host.log");

  it("is left alone while it is small", () => {
    writeFileSync(log, "one line\n");
    daemon.rotateLog(log, 100);
    expect(readFileSync(log, "utf8")).toBe("one line\n");
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it("rotates across up to maxFiles generations and drops older ones", () => {
    writeFileSync(log, "a".repeat(200));
    daemon.rotateLog(log, 100, 3);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("a".repeat(200));

    writeFileSync(log, "b".repeat(200));
    daemon.rotateLog(log, 100, 3);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("b".repeat(200));
    expect(readFileSync(`${log}.2`, "utf8")).toBe("a".repeat(200));

    writeFileSync(log, "c".repeat(200));
    daemon.rotateLog(log, 100, 3);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("c".repeat(200));
    expect(readFileSync(`${log}.2`, "utf8")).toBe("b".repeat(200));
    expect(readFileSync(`${log}.3`, "utf8")).toBe("a".repeat(200));

    writeFileSync(log, "d".repeat(200));
    daemon.rotateLog(log, 100, 3);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("d".repeat(200));
    expect(readFileSync(`${log}.3`, "utf8")).toBe("b".repeat(200));
    expect(existsSync(`${log}.4`)).toBe(false);
  });

  it("supports copytruncate rotation for long-running open O_APPEND logs", () => {
    const liveLog = join(home, "live.log");
    writeFileSync(liveLog, "x".repeat(250));
    expect(daemon.copyTruncateLog(liveLog, 100, 2)).toBe(true);
    expect(statSync(liveLog).size).toBe(0);
    expect(readFileSync(`${liveLog}.1`, "utf8")).toBe("x".repeat(250));
    expect(daemon.copyTruncateLog(liveLog, 100, 2)).toBe(false);
  });

  it("need not exist yet", () => {
    expect(() => daemon.rotateLog(join(home, "never-written.log"), 100)).not.toThrow();
  });
});
