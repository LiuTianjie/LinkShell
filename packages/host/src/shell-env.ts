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
