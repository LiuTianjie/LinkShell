import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Pre-marker CLI: `curl -X POST http://127.0.0.1:<port>/hook --data-binary @-`. */
const LEGACY_LOCAL_HOOK =
  /https?:\/\/127\.0\.0\.1:\d+\/hook(?:\?|"|'|\s|$|\\)/;

function hookEntryText(entry: unknown): string {
  try {
    return JSON.stringify(entry);
  } catch {
    return String(entry);
  }
}

/** True for current (`/hook?m=lsh-…`) and legacy localhost `/hook` curl entries. */
export function isLinkShellHookEntry(entry: unknown, marker?: string): boolean {
  const raw = hookEntryText(entry);
  if (marker && raw.includes(`/hook?m=${marker}`)) return true;
  if (raw.includes("/hook?m=lsh-")) return true;
  if (raw.includes("/hook?m=") && raw.includes("LINKSHELL_ID")) return true;
  return LEGACY_LOCAL_HOOK.test(raw) && raw.includes("--data-binary @-");
}

function sweepHooksObject(hooks: Record<string, unknown>): boolean {
  let changed = false;
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((entry) => !isLinkShellHookEntry(entry));
    if (filtered.length !== entries.length) {
      changed = true;
      if (filtered.length === 0) delete hooks[eventName];
      else hooks[eventName] = filtered;
    }
  }
  return changed;
}

/** Remove leftover LinkShell hook entries from one JSON settings/hooks file. */
export function sweepLinkShellHookEntries(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const hooks = raw.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
    const changed = sweepHooksObject(hooks as Record<string, unknown>);
    if (!changed) return false;
    if (Object.keys(hooks as object).length === 0) delete raw.hooks;
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-shot leftover sweep. LinkShell no longer writes hook configs; this only
 * deletes historical curl-hook entries so they cannot fire after upgrade.
 */
export function sweepLinkShellHookConfigs(home: string, extraPaths: string[] = []): string[] {
  const candidates = [
    join(home, ".claude", "settings.json"),
    join(home, ".claude", "settings.local.json"),
    join(home, ".codex", "hooks.json"),
    join(home, ".gemini", "settings.json"),
    ...extraPaths,
  ];
  const swept: string[] = [];
  for (const path of candidates) {
    if (sweepLinkShellHookEntries(path)) swept.push(path);
  }
  return swept;
}
