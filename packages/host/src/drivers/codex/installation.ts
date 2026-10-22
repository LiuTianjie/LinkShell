import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The Windows desktop app keeps its CLI in versioned directories, outside PATH. */
export function windowsDesktopCodexCandidates(env: NodeJS.ProcessEnv): string[] {
  const localAppData = Object.entries(env).find(([key]) => key.toLowerCase() === "localappdata")?.[1]
    || join(homedir(), "AppData", "Local");
  if (!isAbsolute(localAppData)) return [];
  const root = join(localAppData, "OpenAI", "Codex", "bin");
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
      if (!entry.isDirectory()) return [];
      const command = join(root, entry.name, "codex.exe");
      try {
        const stat = statSync(command);
        return stat.isFile() ? [{ command, modified: stat.mtimeMs }] : [];
      } catch {
        return [];
      }
    }).sort((a, b) => b.modified - a.modified || a.command.localeCompare(b.command)).map(entry => entry.command);
  } catch {
    return [];
  }
}

/** The Mac apps ship their own CLI; a host started from Finder may have no `codex` on PATH. */
export function macAppCodexCandidates(home = homedir()): string[] {
  return ["/Applications", join(home, "Applications")].flatMap(apps => [
    join(apps, "Codex.app/Contents/Resources/codex"),
    join(apps, "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
  ]).filter(command => {
    try {
      return statSync(command).isFile();
    } catch {
      return false;
    }
  });
}
