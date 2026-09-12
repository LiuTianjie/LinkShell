import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Optional expansion written into hook commands. Claude Code scans `$VAR` /
 * `${VAR}` and *skips* the hook (noisy "required env var(s) not set") when
 * those vars are missing. Native `claude` has no `LINKSHELL_ID`. `:-` makes
 * the client treat it as optional; an empty lid is already accepted by the
 * hook server (some CLIs do not inherit the PTY env).
 */
export const LINKSHELL_ID_EXPANSION = "${LINKSHELL_ID:-}";

/**
 * Shell command written into Claude / Codex / Copilot / Gemini hook configs.
 *
 * Cursor (and some other clients) parse hook stdout as JSON and *block the
 * tool* when the body is empty, "ok", or otherwise invalid. A bare
 * `curl … || true` is not enough: a down server still prints nothing, and
 * our own observe-path used to print the word `ok`.
 *
 * Always emit a JSON object. Forward the server body only when it looks like
 * one (permission decisions). Otherwise fail-open with `{}`.
 *
 * Cursor's own coding agent also reads a project `hooks.json`. If this command
 * ever runs inside Cursor, skip the network hop entirely so a LinkShell
 * session cannot freeze the IDE agent.
 */
export function buildLinkShellHookCommand(port: number, marker: string, timeoutSec: number): string {
  const url = `http://127.0.0.1:${port}/hook?m=${marker}&lid=${LINKSHELL_ID_EXPANSION}`;
  return [
    `if [ -n "\${CURSOR_TRACE_ID:-}" ] || [ -n "\${CURSOR_PROJECT_DIR:-}" ]; then printf '%s\\n' '{}'; exit 0; fi`,
    `body=$(curl -s --connect-timeout 1 --max-time ${timeoutSec} -X POST "${url}" -H 'Content-Type: application/json' --data-binary @- 2>/dev/null) || true`,
    `case "$body" in '{'*) printf '%s\\n' "$body" ;; *) printf '%s\\n' '{}' ;; esac`,
  ].join("; ");
}

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

/**
 * Rewrite leftover `lid=$LINKSHELL_ID` (no default) so Claude Code no longer
 * treats LINKSHELL_ID as a required env var. Leaves `${LINKSHELL_ID:-}` alone.
 */
export function rewriteBareLinkShellId(source: string): string {
  return source.replace(/lid=\$LINKSHELL_ID(?!:-)/g, () => `lid=${LINKSHELL_ID_EXPANSION}`);
}

/** Copilot loads CWD `hooks.json`. Cursor's coding agent also reads that file
 *  when the folder is a Cursor project, so writing it there freezes the IDE. */
export function shouldWriteProjectHooksJson(
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return !exists(join(cwd, ".cursor"));
}
