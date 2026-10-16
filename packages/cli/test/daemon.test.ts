import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("background processes", () => {
  it("knows a running daemon by its pid file", () => {
    daemon.savePid("host", process.pid);
    expect(daemon.readPid("host")).toBe(process.pid);
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

  it("waits for actual shutdown even when the PID file is already gone", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 250)); setInterval(() => {}, 1000); process.stdout.write('ready');"], { stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
      daemon.savePid("host", child.pid!);
      const stopped = daemon.stopDaemonAndWait("host", 3000, child.pid!);
      daemon.removePid("host");
      await stopped;
      expect(() => process.kill(child.pid!, 0)).toThrow();
      expect(existsSync(join(home, "host.pid"))).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("reports an unresponsive daemon without force-killing it", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');"], { stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
      daemon.savePid("host", child.pid!);
      await expect(daemon.stopDaemonAndWait("host", 100)).rejects.toThrow("did not stop");
      expect(daemon.readPid("host")).toBe(child.pid);
    } finally {
      child.kill("SIGKILL");
      await exited;
      daemon.removePid("host");
    }
  });
});

describe("host launch settings", () => {
  it("keeps the actual development port and explicit host options without saving credentials", () => {
    vi.stubEnv("LINKSHELL_GATEWAY", "off");
    vi.stubEnv("LINKSHELL_DEV_PORT", "0");
    vi.stubEnv("OPENAI_API_KEY", "never-save-this");
    try {
      daemon.saveHostLaunch(123, 7878);
      expect(daemon.readHostLaunch(123)).toMatchObject({ LINKSHELL_GATEWAY: "off", LINKSHELL_DEV_PORT: "7878" });
      expect(daemon.readHostLaunch(124)).toEqual({});
      expect(readFileSync(join(home, "host-launch.json"), "utf8")).not.toContain("never-save-this");
      daemon.removePid("host");
      expect(daemon.readHostLaunch(123)).toEqual({});
    } finally { vi.unstubAllEnvs(); }
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

  it("is set aside once it is full, keeping only the one before", () => {
    writeFileSync(log, "a".repeat(200));
    daemon.rotateLog(log, 100);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("a".repeat(200));

    writeFileSync(log, "b".repeat(200));
    daemon.rotateLog(log, 100);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("b".repeat(200));
  });

  it("need not exist yet", () => {
    expect(() => daemon.rotateLog(join(home, "never-written.log"), 100)).not.toThrow();
  });
});
