import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The environment the user's agents see in their own terminal: runs the login
 * shell once and captures its env (the same approach editors use). A daemon
 * started by launchd or from a bare process would otherwise miss PATH
 * additions, API keys and proxy settings from the user's shell profile, and
 * agents would fail auth. Falls back to the current environment.
 */
export async function resolveLoginShellEnv(timeoutMs = 10_000): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return process.env;
  const shell = process.env.SHELL || "/bin/zsh";
  const marker = `__LINKSHELL_ENV_${randomUUID()}__`;
  try {
    const { stdout } = await execFileAsync(shell, ["-ilc", `printf '%s' '${marker}'; command env -0`], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LINKSHELL_RESOLVING_SHELL_ENV: "1" },
    });
    const start = stdout.indexOf(marker);
    if (start < 0) return process.env;
    const resolved: NodeJS.ProcessEnv = {};
    for (const entry of stdout.slice(start + marker.length).split("\0")) {
      const index = entry.indexOf("=");
      if (index > 0) resolved[entry.slice(0, index)] = entry.slice(index + 1);
    }
    delete resolved.LINKSHELL_RESOLVING_SHELL_ENV;
    return { ...process.env, ...resolved };
  } catch {
    return process.env;
  }
}

// What a running Claude Code session puts in its children's environment: who
// the parent is, how to reach it, and how it tuned itself. Inherited by an
// agent LinkShell starts, they make that agent a child of the other session
// (Claude then keeps no transcript, so no handoff) and override the phone's
// choices (CLAUDE_EFFORT). The user's own settings (API keys, CLAUDE_CONFIG_DIR,
// ANTHROPIC_BASE_URL…) are not in the list.
const CLAUDE_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_ACCOUNT_UUID",
  // A parent host's auth routing prevents standalone Claude from using the
  // user's own credentials (including providers configured by CC Switch).
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
  "CLAUDE_CODE_DISABLE_CRON",
  "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
  "CLAUDE_CODE_EAGER_FLUSH",
  "CLAUDE_CODE_REPORT_FINDINGS",
];

/**
 * The environment without what a surrounding Claude Code session added —
 * LinkShell started from inside one (its terminal, a command it ran). Only
 * then: `CLAUDECODE` marks it.
 */
export function withoutClaudeSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.CLAUDECODE) return env;
  const clean = { ...env };
  for (const name of CLAUDE_SESSION_VARIABLES) delete clean[name];
  return clean;
}
