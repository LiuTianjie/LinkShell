import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Claude Code records every running process and the session it has open in
// <config>/sessions/<pid>.json. That is how to tell that the desktop app, or
// a `claude` in some terminal, still has a session: its command line needn't
// name it (a session created in that process doesn't appear there).

export interface SessionHolder {
  pid: number;
  /** How that Claude was started: "claude-desktop", "cli", "sdk-ts", … */
  entrypoint?: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // No permission to signal it still means it exists.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Running Claude processes that have `sessionId` open. */
export function sessionHolders(configDir: string, sessionId: string): SessionHolder[] {
  const dir = join(configDir, "sessions");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const holders: SessionHolder[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const entry = JSON.parse(readFileSync(join(dir, name), "utf8")) as { pid?: unknown; sessionId?: unknown; entrypoint?: unknown };
      const pid = typeof entry.pid === "number" ? entry.pid : Number(name.slice(0, -5));
      if (entry.sessionId !== sessionId || !alive(pid)) continue;
      holders.push({ pid, entrypoint: typeof entry.entrypoint === "string" ? entry.entrypoint : undefined });
    } catch {
      // Being written, or left behind by a crash: not a holder.
    }
  }
  return holders;
}

/** True when `pid` was started (directly or not) by `ancestor`. */
export async function descendsFrom(pid: number, ancestor: number): Promise<boolean> {
  let current = pid;
  for (let hops = 0; hops < 8 && current > 1; hops++) {
    if (current === ancestor) return true;
    try {
      const { stdout } = await execFileAsync("/bin/ps", ["-o", "ppid=", "-p", String(current)], { timeout: 3000 });
      current = Number(stdout.trim());
      if (!Number.isInteger(current)) return false;
    } catch {
      return false;
    }
  }
  return current === ancestor;
}
