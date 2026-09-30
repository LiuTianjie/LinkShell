import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentAuth } from "@linkshell/wire";

const execFileAsync = promisify(execFile);

/** Runs an agent's own status command; never reads credential stores itself. */
export async function runStatusCommand(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { env, timeout: 15_000 });
    return `${stdout}\n${stderr}`.trim();
  } catch (error) {
    // Some CLIs exit non-zero when logged out but still print the status.
    const output = error as { stdout?: string; stderr?: string };
    const text = `${output.stdout ?? ""}\n${output.stderr ?? ""}`.trim();
    return text || undefined;
  }
}

/** `claude auth status --json`. */
export function parseClaudeAuthStatus(output: string | undefined): AgentAuth {
  if (!output) return { state: "unknown" };
  let parsed: { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown };
  try {
    parsed = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)) as typeof parsed;
  } catch {
    return { state: "unknown" };
  }
  if (parsed.loggedIn !== true) {
    return {
      state: "missing",
      hint: "Claude 未登录：在电脑终端运行 claude /login，或设置 ANTHROPIC_API_KEY",
    };
  }
  const provider = typeof parsed.apiProvider === "string" ? parsed.apiProvider : undefined;
  const method = typeof parsed.authMethod === "string" ? parsed.authMethod : undefined;
  return { state: "ok", method: provider && provider !== "firstParty" ? provider : method };
}

/** `codex login status`. */
export function parseCodexLoginStatus(output: string | undefined): AgentAuth {
  if (!output) return { state: "unknown" };
  const text = output.toLowerCase();
  if (text.includes("not logged in")) {
    return { state: "missing", hint: "Codex 未登录：在电脑终端运行 codex login" };
  }
  if (text.includes("logged in")) {
    if (text.includes("chatgpt")) return { state: "ok", method: "chatgpt" };
    if (text.includes("api key")) return { state: "ok", method: "api_key" };
    if (text.includes("access token")) return { state: "ok", method: "access_token" };
    return { state: "ok" };
  }
  return { state: "unknown" };
}
