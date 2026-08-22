import { existsSync } from "node:fs";
import { join } from "node:path";

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
  const url = `http://127.0.0.1:${port}/hook?m=${marker}&lid=$LINKSHELL_ID`;
  return [
    `if [ -n "\${CURSOR_TRACE_ID:-}" ] || [ -n "\${CURSOR_PROJECT_DIR:-}" ]; then printf '%s\\n' '{}'; exit 0; fi`,
    `body=$(curl -s --connect-timeout 1 --max-time ${timeoutSec} -X POST "${url}" -H 'Content-Type: application/json' --data-binary @- 2>/dev/null) || true`,
    `case "$body" in '{'*) printf '%s\\n' "$body" ;; *) printf '%s\\n' '{}' ;; esac`,
  ].join("; ");
}

/** Copilot loads CWD `hooks.json`. Cursor's coding agent also reads that file
 *  when the folder is a Cursor project, so writing it there freezes the IDE. */
export function shouldWriteProjectHooksJson(
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return !exists(join(cwd, ".cursor"));
}
