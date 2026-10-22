import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The environment the user's agents see in their own terminal: runs the login
 * shell once and captures its env (the same approach editors use). A daemon
 * started by launchd or from a bare process would otherwise miss PATH
 * additions, API keys and proxy settings from the user's shell profile, and
 * agents would fail auth. Falls back to the current environment.
 */
export async function resolveLoginShellEnv(timeoutMs = 20_000, log?: (message: string) => void): Promise<NodeJS.ProcessEnv> {
  if (process.platform === "win32") return withRegistryPath(process.env);
  const shell = process.env.SHELL || "/bin/zsh";
  const problems: string[] = [];
  // Interactive first: most people set PATH and proxies in .zshrc. A profile that
  // breaks without a terminal still usually works as a plain login shell.
  for (const flags of ["-ilc", "-lc"]) {
    try {
      const resolved = await shellEnv(shell, flags, timeoutMs);
      if (resolved) return withCommonPaths({ ...process.env, ...resolved });
      problems.push(`${flags}: no environment in its output`);
    } catch (error) {
      const killed = (error as { killed?: boolean }).killed;
      problems.push(`${flags}: ${killed ? `no answer in ${timeoutMs / 1000} s` : (error as Error).message.split("\n")[0]}`);
    }
  }
  // Without it, a host started by the desktop app has Finder's PATH (/usr/bin:/bin…):
  // agents installed with Homebrew or npm are missed, and the ones found lack proxy settings.
  log?.(`[host] couldn't read the login shell's environment (${shell} ${problems.join("; ")}): agents get only the common install directories on PATH`);
  return withCommonPaths(process.env);
}

async function shellEnv(shell: string, flags: string, timeoutMs: number): Promise<NodeJS.ProcessEnv | undefined> {
  const marker = `__LINKSHELL_ENV_${randomUUID()}__`;
  const child = execFileAsync(shell, [flags, `printf '%s' '${marker}'; command env -0`], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LINKSHELL_RESOLVING_SHELL_ENV: "1" },
  });
  // An open stdin lets a profile's prompt (compinit's "insecure directories", a
  // `read`) wait for an answer until the timeout; end-of-input answers it.
  child.child.stdin?.end();
  const { stdout } = await child;
  const start = stdout.indexOf(marker);
  if (start < 0) return undefined;
  const resolved: NodeJS.ProcessEnv = {};
  for (const entry of stdout.slice(start + marker.length).split("\0")) {
    const index = entry.indexOf("=");
    if (index > 0) resolved[entry.slice(0, index)] = entry.slice(index + 1);
  }
  delete resolved.LINKSHELL_RESOLVING_SHELL_ENV;
  return resolved.PATH ? resolved : undefined;
}

/**
 * Windows: the tray app's environment is from when it started, so an agent installed since is not on
 * its PATH. The registry holds the current Machine and User PATH; they go first, then anything the
 * process had that they don't.
 */
async function withRegistryPath(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const read = async (key: string) => {
    try {
      const { stdout } = await execFileAsync("reg.exe", ["query", key, "/v", "Path"], { timeout: 5000, windowsHide: true });
      return registryValue(stdout, env);
    } catch {
      return [];
    }
  };
  const [machine, user] = await Promise.all([
    read("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    read("HKCU\\Environment"),
  ]);
  if (!machine.length && !user.length) return env;
  const name = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const seen = new Set<string>();
  const entries = [...machine, ...user, ...(env[name] ?? "").split(";")].filter((entry) => {
    const key = entry.trim().replace(/[\\/]+$/, "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...env, [name]: entries.join(";") };
}

/** The entries of a `reg query … /v Path` answer, with %VARIABLES% expanded from `env`. */
export function registryValue(output: string, env: NodeJS.ProcessEnv): string[] {
  const match = /\bPath\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output);
  if (!match) return [];
  const lookup = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return match[1]!.trim().replace(/%([^%]+)%/g, (whole, name: string) => lookup(name) ?? whole).split(";").filter(Boolean);
}

/** Where agents' CLIs are usually installed; appended, so the user's own order still wins. */
export function withCommonPaths(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = env.HOME || homedir();
  const present = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const common = [
    "/opt/homebrew/bin", "/usr/local/bin",
    join(home, ".local/bin"), join(home, ".npm-global/bin"), join(home, ".bun/bin"),
    join(home, ".volta/bin"), join(home, "Library/pnpm"), join(home, ".cargo/bin"),
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ].filter((dir) => !present.includes(dir) && existsSync(dir));
  return common.length ? { ...env, PATH: [...present, ...common].join(delimiter) } : env;
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
