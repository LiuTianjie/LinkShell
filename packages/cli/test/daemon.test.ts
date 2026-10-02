import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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
