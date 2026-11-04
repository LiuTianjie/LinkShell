import { execFile } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A process with a file open for writing on its stdout. */
export interface WriterProcess {
  pid: number;
  pgid: number;
  ppid: number;
}

/** Where a background task's process can be found: macOS (lsof) and Linux (/proc). */
export const canFindTaskProcesses = process.platform === "darwin" || process.platform === "linux";

/**
 * The processes whose stdout is `path` (resolved), opened for writing. Claude
 * runs a background shell with its stdout and stderr on the task's output
 * file, so this finds that shell and whatever it started.
 */
export async function stdoutWriters(path: string): Promise<WriterProcess[]> {
  if (process.platform === "linux") return linuxWriters(path);
  if (process.platform !== "darwin") return [];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("lsof", ["-a", "-d", "1", "-F", "pgfa", "--", path], { timeout: 5000 }));
  } catch (error) {
    // lsof exits 1 when nothing has the file open.
    stdout = String((error as { stdout?: unknown }).stdout ?? "");
  }
  const found: { pid: number; pgid: number }[] = [];
  let pid = 0, pgid = 0, fd = "";
  for (const line of stdout.split("\n")) {
    const value = line.slice(1);
    if (line[0] === "p") { pid = Number(value); pgid = 0; fd = ""; }
    else if (line[0] === "g") pgid = Number(value);
    else if (line[0] === "f") fd = value;
    else if (line[0] === "a" && fd === "1" && (value === "w" || value === "u") && pid > 0 && pgid > 0) found.push({ pid, pgid });
  }
  const writers: WriterProcess[] = [];
  for (const entry of found) {
    try {
      const { stdout: ps } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(entry.pid)], { timeout: 5000 });
      const ppid = Number(ps.trim());
      if (ppid > 0) writers.push({ ...entry, ppid });
    } catch {
      // Gone since lsof looked.
    }
  }
  return writers;
}

function linuxWriters(path: string): WriterProcess[] {
  const writers: WriterProcess[] = [];
  let pids: string[];
  try { pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name)); } catch { return []; }
  for (const pid of pids) {
    try {
      if (readlinkSync(`/proc/${pid}/fd/1`) !== path) continue;
      const flags = /flags:\s*(\d+)/.exec(readFileSync(`/proc/${pid}/fdinfo/1`, "utf8"))?.[1];
      // O_WRONLY or O_RDWR.
      if (!flags || (parseInt(flags, 8) & 3) === 0) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const [, ppid, pgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      writers.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid) });
    } catch {
      // Not ours to read, or gone.
    }
  }
  return writers;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Ends the process group of the shell writing `path`: the group's leader must
 * write the file on its stdout and be a child of one of `parents` (the Claude
 * processes that have the session), so nothing else is ever signalled.
 * Resolves whether there was such a group.
 */
export async function stopTaskGroup(path: string, parents: Set<number>, options: { graceMs?: number } = {}): Promise<boolean> {
  const writers = await stdoutWriters(path);
  const leaders = writers.filter((writer) => writer.pid === writer.pgid && writer.pgid > 1 && writer.pid !== process.pid && parents.has(writer.ppid));
  if (leaders.length === 0) return false;
  for (const leader of leaders) {
    try { process.kill(-leader.pgid, "SIGTERM"); } catch { /* already gone */ }
  }
  const deadline = Date.now() + (options.graceMs ?? 3000);
  while (leaders.some((leader) => groupAlive(leader.pgid)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  for (const leader of leaders) {
    if (!groupAlive(leader.pgid)) continue;
    try { process.kill(-leader.pgid, "SIGKILL"); } catch { /* already gone */ }
  }
  return true;
}
