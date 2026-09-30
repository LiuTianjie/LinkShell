import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * LinkShell 1.x registered Copilot hooks (`~/.copilot/hooks/linkshell*.json`)
 * that post to a local port, and a killed session left them behind. Copilot
 * treats the failing hook as a veto, so every tool call is blocked. Removes
 * those files, and only those: named by 1.x and posting to a local /hook.
 */
export function removeLegacyCopilotHooks(dir: string, log: (message: string) => void): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!/^linkshell(-lsh-[\w-]+)?\.json$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (!/curl [^"']*["']?http:\/\/127\.0\.0\.1:\d+\/hook/.test(readFileSync(path, "utf8"))) continue;
      unlinkSync(path);
      removed++;
    } catch {
      // Leave anything unreadable alone.
    }
  }
  if (removed > 0) log(`[host] removed ${removed} Copilot hook file(s) left by LinkShell 1.x (${dir})`);
  return removed;
}
