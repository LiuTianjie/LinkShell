import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openChildRegistry, reapOrphans, sameProcess, trackChild, type ChildEntry } from "../src/children.js";
import { stopAgent } from "../src/process.js";

const STUBBORN_ACP = fileURLToPath(new URL("./fixtures/stubborn-acp.mjs", import.meta.url));
const STUBBORN_HOST = fileURLToPath(new URL("./fixtures/stubborn-host.mts", import.meta.url));
chmodSync(STUBBORN_ACP, 0o755);
const posix = process.platform !== "win32";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const SLEEPER = "process.on('SIGHUP', () => {}); setInterval(() => {}, 1000)";
const cleanup: (() => void)[] = [];
const sleeper = (options: { detached?: boolean; script?: string } = {}) => {
  const child = spawn(process.execPath, ["-e", options.script ?? SLEEPER], { stdio: "ignore", detached: options.detached });
  cleanup.push(() => { try { process.kill(child.pid!, "SIGKILL"); } catch {} });
  return child;
};
const exited = (child: ChildProcess) => new Promise<void>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", () => resolve())));

afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

describe.runIf(posix)("children left by a host that died", () => {
  it("ends a recorded child that is still the same process, never one whose pid was reused", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "lsh-children-"));
    const orphan = sleeper({ detached: true });
    const unrelated = sleeper();
    const now = Date.now();
    const entries: ChildEntry[] = [
      { pid: orphan.pid!, kind: "agent", argv: [process.execPath, "-e", SLEEPER], startedAt: now, group: true },
      // Its pid, but another program: what a pid handed out again looks like.
      { pid: unrelated.pid!, kind: "agent", argv: ["/usr/local/bin/gemini", "--acp"], startedAt: now, group: false },
    ];
    writeFileSync(join(runDir, "children-999999.json"), JSON.stringify(entries));
    // The same pid and program, started at another time: also not ours.
    const later = sleeper();
    writeFileSync(join(runDir, "children-999998.json"), JSON.stringify([{ pid: later.pid!, kind: "agent", argv: [process.execPath, "-e", SLEEPER], startedAt: now - 3_600_000, group: false }]));

    const log: string[] = [];
    expect(await reapOrphans(runDir, (message) => log.push(message))).toBe(1);
    await exited(orphan);
    expect(alive(unrelated.pid!)).toBe(true);
    expect(alive(later.pid!)).toBe(true);
    expect(log.join("\n")).toContain(`pid ${orphan.pid}`);
    expect(readdirSync(runDir)).toEqual([]);
    rmSync(runDir, { recursive: true, force: true });
  });

  it("matches a script started through its shebang and rejects other arguments", () => {
    const entry: ChildEntry = { pid: 2, kind: "agent", argv: ["/opt/agents/grok", "agent", "stdio"], startedAt: 1_000_000, group: true };
    expect(sameProcess(entry, { started: 1_000_000, command: "node /opt/agents/grok agent stdio" })).toBe(true);
    expect(sameProcess(entry, { started: 1_000_000, command: "/opt/agents/grok agent stdio" })).toBe(true);
    expect(sameProcess(entry, { started: 1_000_000, command: "/opt/agents/grok agent other" })).toBe(false);
    expect(sameProcess(entry, { started: 1_000_000, command: "vim agent stdio" })).toBe(false);
    expect(sameProcess(entry, { started: 1_000_000 + 60_000, command: "/opt/agents/grok agent stdio" })).toBe(false);
  });

  it("survives a missing, empty or corrupt run directory", async () => {
    expect(await reapOrphans(join(tmpdir(), "lsh-children-missing-dir"), () => {})).toBe(0);
    const runDir = mkdtempSync(join(tmpdir(), "lsh-children-"));
    writeFileSync(join(runDir, "children-999997.json"), "{ not json");
    writeFileSync(join(runDir, "children-999996.json"), JSON.stringify([{ pid: 1, kind: "x", argv: ["launchd"], startedAt: 0, group: true }, { pid: "7" }]));
    expect(await reapOrphans(runDir, () => {})).toBe(0);
    expect(readdirSync(runDir)).toEqual([]);
    rmSync(runDir, { recursive: true, force: true });
  });

  it("leaves the record of a host that is still running", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "lsh-children-"));
    const child = sleeper();
    const live = sleeper();
    writeFileSync(join(runDir, `children-${live.pid}.json`), JSON.stringify([{ pid: child.pid!, kind: "agent", argv: [process.execPath, "-e", SLEEPER], startedAt: Date.now(), group: false }]));
    expect(await reapOrphans(runDir, () => {})).toBe(0);
    expect(alive(child.pid!)).toBe(true);
    expect(readdirSync(runDir)).toEqual([`children-${live.pid}.json`]);
    rmSync(runDir, { recursive: true, force: true });
  });

  it("records a child while it runs and forgets it when it exits", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "lsh-children-"));
    const registry = openChildRegistry(runDir);
    try {
      const child = sleeper({ script: "setTimeout(() => {}, 300)" });
      trackChild(child, "agent", process.execPath, ["-e", "setTimeout(() => {}, 300)"], false);
      expect(JSON.parse(readFileSync(registry.path, "utf8"))).toMatchObject([{ pid: child.pid, kind: "agent" }]);
      await exited(child);
      expect(JSON.parse(readFileSync(registry.path, "utf8"))).toEqual([]);
    } finally {
      await registry.close(() => {});
    }
    expect(existsSync(registry.path)).toBe(false);
    rmSync(runDir, { recursive: true, force: true });
  });

  it("ends an agent's whole process group when it is stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-children-"));
    const pids = join(dir, "pids");
    const agent = spawn(STUBBORN_ACP, [], { env: { ...process.env, STUBBORN_ACP_PIDS: pids }, stdio: ["pipe", "pipe", "ignore"], detached: true });
    cleanup.push(() => { try { process.kill(-agent.pid!, "SIGKILL"); } catch {} });
    const [, grandchild] = (await waitFor(() => existsSync(pids) && readFileSync(pids, "utf8"))).split(" ").map(Number);
    await stopAgent(agent, { group: true });
    await waitFor(() => !alive(grandchild!), 2000);
    expect(alive(agent.pid!)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.runIf(posix)("a host killed outright", () => {
  it("leaves nothing running once the next host has started", async () => {
    const home = mkdtempSync(join(tmpdir(), "lsh-crash-"));
    mkdirSync(home, { recursive: true });
    const pids = join(home, "agent-pids");
    const env = { ...process.env, STUBBORN_ACP_PIDS: pids, LINKSHELL_HOME: home };
    const first = spawn(process.execPath, ["--import", "tsx", STUBBORN_HOST, home, STUBBORN_ACP], { env, stdio: ["ignore", "pipe", "pipe"], cwd: fileURLToPath(new URL("..", import.meta.url)) });
    let output = "";
    first.stdout!.on("data", (data: Buffer) => { output += data.toString(); });
    first.stderr!.on("data", (data: Buffer) => { output += data.toString(); });
    const [agent, grandchild] = (await waitFor(() => existsSync(pids) && output.includes("ready") && readFileSync(pids, "utf8"), 30_000)).split(" ").map(Number);
    cleanup.push(() => { for (const pid of [agent!, grandchild!]) try { process.kill(pid, "SIGKILL"); } catch {} });

    // A crash: the host's stop path never runs.
    first.kill("SIGKILL");
    await exited(first);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(agent!)).toBe(true);
    expect(alive(grandchild!)).toBe(true);

    rmSync(pids);
    const second = spawn(process.execPath, ["--import", "tsx", STUBBORN_HOST, home, STUBBORN_ACP], { env, stdio: ["ignore", "pipe", "pipe"], cwd: fileURLToPath(new URL("..", import.meta.url)) });
    let secondOutput = "";
    second.stdout!.on("data", (data: Buffer) => { secondOutput += data.toString(); });
    second.stderr!.on("data", (data: Buffer) => { secondOutput += data.toString(); });
    const [newAgent, newGrandchild] = (await waitFor(() => existsSync(pids) && secondOutput.includes("ready") && readFileSync(pids, "utf8"), 30_000)).split(" ").map(Number);
    cleanup.push(() => { for (const pid of [newAgent!, newGrandchild!]) try { process.kill(pid, "SIGKILL"); } catch {} });
    expect(secondOutput).toContain(`ending agent (pid ${agent}) left by an earlier host`);
    expect(alive(agent!)).toBe(false);
    await waitFor(() => !alive(grandchild!), 2000);

    // A clean stop leaves nothing either, and no record behind.
    second.kill("SIGTERM");
    await exited(second);
    expect(second.exitCode).toBe(0);
    expect(alive(newAgent!)).toBe(false);
    await waitFor(() => !alive(newGrandchild!), 2000);
    expect(readdirSync(join(home, "run")).filter((name) => name.startsWith("children-"))).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
});
