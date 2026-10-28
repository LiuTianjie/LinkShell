import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Which API a Claude talks to is in its environment, and the Claude that has a
// session open on the computer may have been given one the host never sees: the
// desktop app injects the provider chosen in its own settings, a terminal may
// export a relay, a switcher may have edited settings.json since. A device
// continuing that session should reach the same API, wherever that is.

/** Variables that decide where Claude sends its requests and with what credentials. */
const ROUTING_NAMES = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "AWS_REGION",
  "AWS_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLOUD_ML_REGION",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "API_TIMEOUT_MS",
  // What "opus" or "sonnet" means is the provider's to say: a relay may serve
  // only the ids it was configured with.
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_MYTHOS_MODEL",
  "ANTHROPIC_DEFAULT_MYTHOS_MODEL_NAME",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

/**
 * Set by a host that hands Claude its provider: Claude then takes the API from
 * its environment over settings.json's `env`, which otherwise wins. Mirrored
 * only as the holder has it, so the device's Claude resolves its API the same way.
 */
const MANAGED = "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST";

/** Proxies follow the API they belong to, but alone don't make a different one. */
const DECIDES = [...ROUTING_NAMES.filter((name) => !/proxy/i.test(name)), MANAGED];

export type ClaudeRouting = Record<string, string>;

/**
 * The environment to give a Claude continuing a session `holder` has open, so
 * it reaches the same API: the holder's routing variables, and empty values for
 * the ones the host has and the holder doesn't (Claude treats empty as unset).
 * Undefined when there's nothing to follow: the holder routes as the host
 * already would, or it is signed in to a Claude account, whose token the
 * desktop app renews (a copy would expire) and the host's Claude has its own of.
 */
export function routingFrom(holder: NodeJS.ProcessEnv, own: NodeJS.ProcessEnv): ClaudeRouting | undefined {
  if (holder.CLAUDE_CODE_OAUTH_TOKEN && !holder.ANTHROPIC_AUTH_TOKEN && !holder.ANTHROPIC_API_KEY) return undefined;
  if (DECIDES.every((name) => (holder[name] ?? "") === (own[name] ?? ""))) return undefined;
  const routing: ClaudeRouting = {};
  for (const name of [...ROUTING_NAMES, MANAGED]) {
    const value = holder[name] ?? (own[name] ? "" : undefined);
    if (value !== undefined) routing[name] = value;
  }
  return routing;
}

/** A process's environment, where the system lets another process of the same user read it. */
export async function processEnv(pid: number): Promise<NodeJS.ProcessEnv | undefined> {
  try {
    if (process.platform === "linux") return parseEnviron(await readFile(`/proc/${pid}/environ`, "utf8"));
    if (process.platform !== "darwin") return undefined;
    // -E appends the environment to the command line, one space between entries.
    const [plain, full] = await Promise.all([
      execFileAsync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }),
      execFileAsync("/bin/ps", ["-wwE", "-o", "command=", "-p", String(pid)], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }),
    ]);
    return parsePsEnvironment(plain.stdout.trimEnd(), full.stdout.trimEnd());
  } catch {
    return undefined;
  }
}

export function parseEnviron(raw: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const entry of raw.split("\0")) {
    const index = entry.indexOf("=");
    if (index > 0) env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return env;
}

/**
 * `ps -E` output with the command line taken off. Entries are joined by single
 * spaces and values may hold spaces too, so a word starts a new entry only when
 * it looks like NAME=; anything else belongs to the value before it.
 */
export function parsePsEnvironment(command: string, withEnvironment: string): NodeJS.ProcessEnv | undefined {
  if (!withEnvironment.startsWith(command)) return undefined;
  const rest = withEnvironment.slice(command.length).replace(/^ /, "");
  // macOS shows nothing after the command for a process it protects.
  if (!rest) return undefined;
  const env: NodeJS.ProcessEnv = {};
  let name: string | undefined;
  for (const word of rest.split(" ")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word);
    if (match) {
      name = match[1]!;
      env[name] = match[2]!;
    } else if (name) {
      env[name] += ` ${word}`;
    }
  }
  return env;
}
