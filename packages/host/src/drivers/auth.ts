import { probeAgent as execFileAsync } from "../process.js";
import type { AgentAuth } from "@linkshell/wire";


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

/** Account presence is informative: a provider can authenticate without a Codex login. */
export function parseCodexAccountStatus(output: unknown): AgentAuth | undefined {
  if (!output || typeof output !== "object") return undefined;
  const { account, requiresOpenaiAuth } = output as { account?: { type?: unknown } | null; requiresOpenaiAuth?: unknown };
  if (account?.type === "amazonBedrock") return { state: "ok", method: "bedrock" };
  // The selected provider wins over any unrelated ChatGPT account still saved on disk.
  if (requiresOpenaiAuth === false) return { state: "ok", method: "provider" };
  switch (account?.type) {
    case "apiKey": return { state: "ok", method: "api_key" };
    case "chatgpt": return { state: "ok", method: "chatgpt" };
    case "chatgptAuthTokens": return { state: "ok", method: "oauth_token" };
    case "personalAccessToken": return { state: "ok", method: "access_token" };
  }
  if (account === null && requiresOpenaiAuth === true) return { state: "unknown" };
  return undefined;
}

/** Fallback for Codex versions without account/read; absence of a login never blocks use. */
export function parseCodexLoginStatus(output: string | undefined): AgentAuth {
  if (!output) return { state: "unknown" };
  const text = output.toLowerCase();
  if (text.includes("not logged in")) {
    // API keys and providers configured by tools such as CC Switch need no ChatGPT login.
    // Let the actual request report missing credentials instead of disabling the clients.
    return { state: "unknown" };
  }
  if (text.includes("logged in")) {
    if (text.includes("chatgpt")) return { state: "ok", method: "chatgpt" };
    if (text.includes("api key")) return { state: "ok", method: "api_key" };
    if (text.includes("access token")) return { state: "ok", method: "access_token" };
    return { state: "ok" };
  }
  return { state: "unknown" };
}
