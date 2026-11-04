import { execFile, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

// A host that dies without running its stop path (SIGKILL, a crash) leaves its
// agents, MCP servers and agent-run commands reparented to launchd/init, where
// many keep running: nothing closes them, and some ignore stdin closing. Each
// long-lived child is written down while it runs, so the next host can end what
// the last one left. Windows has no `ps` to prove a pid is still the same
// process, so there nothing is recorded and nothing is ended.

const run = promisify(execFile);

export interface ChildEntry {
  pid: number;
  kind: string;
  /** What was spawned, compared with `ps` so a reused pid is never mistaken for ours. */
  argv: string[];
  /** Wall-clock ms right after spawn returned: the process started just before. */
  startedAt: number;
  /** Spawned as its own process group, so its own children go with it. */
  group: boolean;
}

interface Seen {
  pgid: number;
  started: number;
  command: string;
}

const FILE = /^children-(\d+)\.json$/;
/** `ps` start times have one-second resolution, and on Linux drift with clock adjustments since boot. */
const START_TOLERANCE_MS = 10_000;
const supported = process.platform !== "win32";

/** One file per host process: a host still shutting down never overwrites its successor's. */
export class ChildRegistry {
  private readonly entries = new Map<number, ChildEntry>();
  readonly path: string;

  constructor(readonly runDir: string) {
    this.path = join(runDir, `children-${process.pid}.json`);
  }

  add(entry: ChildEntry): void {
    this.entries.set(entry.pid, entry);
    this.write();
  }

  remove(pid: number): void {
    if (this.entries.delete(pid)) this.write();
  }

  list(): ChildEntry[] {
    return [...this.entries.values()];
  }

  private write(): void {
    try {
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.list()), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      // The run directory went away: there is nothing left to protect.
    }
  }

  /** At a clean stop: ends what the drivers' own stop paths left running, then forgets the file. */
  async close(log: (message: string) => void): Promise<void> {
    const index = active.indexOf(this);
    if (index >= 0) active.splice(index, 1);
    // A second host in this process (tests only) may have had its children recorded here.
    if (active.length === 0 && this.entries.size > 0) await reap(this.list(), log, "still running at stop");
    this.entries.clear();
    rmSync(this.path, { force: true });
  }
}

// Process-wide because a host is one per process, and the spawn sites sit deep
// in drivers that know nothing of the host's paths.
const active: ChildRegistry[] = [];

/** Children spawned from now on are recorded under `runDir`, until the registry is closed. */
export function openChildRegistry(runDir: string): ChildRegistry {
  const registry = new ChildRegistry(runDir);
  if (supported) active.push(registry);
  return registry;
}

/** Records a running child; returns what to call once it has exited. */
export function trackPid(pid: number | undefined, kind: string, command: string, args: readonly string[], group: boolean): () => void {
  const registry = active.at(-1);
  if (!registry || !pid) return () => {};
  registry.add({ pid, kind, argv: [command, ...args], startedAt: Date.now(), group });
  return () => registry.remove(pid);
}

export function trackChild(child: ChildProcess, kind: string, command: string, args: readonly string[], group: boolean): void {
  if (!child.pid) return;
  child.once("exit", trackPid(child.pid, kind, command, args, group));
}

/**
 * Ends the children earlier hosts recorded under `runDir` that are still the
 * same processes. Call only once no other host answers on this run directory.
 */
export async function reapOrphans(runDir: string, log: (message: string) => void): Promise<number> {
  if (!supported) return 0;
  const files: string[] = [];
  try {
    for (const name of readdirSync(runDir)) {
      const match = FILE.exec(name);
      const host = Number(match?.[1]);
      // A host that is still alive (starting up beside us before its socket
      // exists, or still shutting down) keeps its own. A dead host's pid that
      // was reused only delays its record to a later start.
      if (match && (host === process.pid || !alive(host))) files.push(join(runDir, name));
    }
  } catch {
    return 0;
  }
  const entries = files.flatMap((file) => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? parsed.filter(validEntry) : [];
    } catch {
      return [];
    }
  });
  const ended = entries.length > 0 ? await reap(entries, log, "left by an earlier host") : 0;
  for (const file of files) rmSync(file, { force: true });
  return ended;
}

function validEntry(value: unknown): value is ChildEntry {
  const entry = value as ChildEntry;
  return !!entry && Number.isSafeInteger(entry.pid) && entry.pid > 1 && typeof entry.kind === "string"
    && Array.isArray(entry.argv) && entry.argv.length > 0 && entry.argv.every((part) => typeof part === "string")
    && typeof entry.startedAt === "number" && typeof entry.group === "boolean";
}

async function processTable(): Promise<Map<number, Seen>> {
  const { stdout } = await run("ps", ["-A", "-ww", "-o", "pid=,pgid=,lstart=,command="], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 5000,
  });
  const table = new Map<number, Seen>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line);
    if (!match) continue;
    const started = Date.parse(`${match[3]} GMT`);
    if (Number.isFinite(started)) table.set(Number(match[1]), { pgid: Number(match[2]), started, command: match[4]! });
  }
  return table;
}

/**
 * Still the process we spawned: started when we spawned it, and its command line
 * is what we ran. A script run through its shebang shows as `node /path/script …`,
 * so the program is looked for by name among the words, and the arguments at the end.
 */
export function sameProcess(entry: ChildEntry, seen: { started: number; command: string }): boolean {
  if (Math.abs(seen.started - entry.startedAt) > START_TOLERANCE_MS) return false;
  const [program, ...args] = entry.argv;
  const name = basename(program!);
  const command = seen.command.trimEnd();
  if (!name || !command.split(" ").some((word) => word === program || basename(word) === name)) return false;
  return args.length === 0 || command.endsWith(` ${args.join(" ")}`);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const send = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
};

/** SIGTERM, up to three seconds, then SIGKILL, for the entries `ps` confirms are still ours. */
async function reap(entries: ChildEntry[], log: (message: string) => void, why: string): Promise<number> {
  let before;
  try {
    before = await processTable();
  } catch {
    return 0;
  }
  const ours = entries.filter((entry) => entry.pid !== process.pid && before.has(entry.pid) && sameProcess(entry, before.get(entry.pid)!));
  if (ours.length === 0) return 0;
  // Only a leader seen at the head of its own group has the group signalled.
  const target = (entry: ChildEntry, table: Map<number, Seen>) => (entry.group && table.get(entry.pid)?.pgid === entry.pid ? -entry.pid : entry.pid);
  for (const entry of ours) {
    log(`[host] ending ${entry.kind} (pid ${entry.pid}) ${why}`);
    send(target(entry, before), "SIGTERM");
  }
  const deadline = Date.now() + 3000;
  while (ours.some((entry) => alive(entry.pid)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  let after: Map<number, Seen>;
  try {
    after = await processTable();
  } catch {
    after = new Map();
  }
  const groups = new Set([...after.values()].map((seen) => seen.pgid));
  for (const entry of ours) {
    const seen = after.get(entry.pid);
    if (seen && sameProcess(entry, seen)) send(target(entry, after), "SIGKILL");
    // The leader went on SIGTERM but left children behind. A pid is never handed
    // out while a group of that id exists, so with no process of that pid the
    // group is still the one we saw a moment ago.
    else if (!seen && entry.group && before.get(entry.pid)?.pgid === entry.pid && groups.has(entry.pid)) send(-entry.pid, "SIGKILL");
  }
  return ours.length;
}
