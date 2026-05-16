import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

export type AgentProvider = "codex" | "claude" | "custom";
export type AgentProtocol = "acp" | "codex-app-server" | "claude-agent-sdk" | "claude-stream-json";
export type AgentFraming = "content-length" | "newline";

const require = createRequire(import.meta.url);

export interface AgentCommandConfig {
  command: string;
  provider: AgentProvider;
  protocol: AgentProtocol;
  framing: AgentFraming;
}

export function resolveCodexAppServerCommands(input: {
  command?: string;
}): AgentCommandConfig[] {
  const explicit = input.command?.trim();
  if (explicit) {
    return [{
      provider: "codex",
      command: explicit,
      protocol: "codex-app-server",
      framing: "newline",
    }];
  }
  return [
    {
      provider: "codex",
      command: "codex app-server proxy",
      protocol: "codex-app-server",
      framing: "newline",
    },
    {
      provider: "codex",
      command: "codex app-server --listen stdio://",
      protocol: "codex-app-server",
      framing: "newline",
    },
  ];
}

export function resolveAgentCommand(input: {
  provider: AgentProvider;
  command?: string;
}): AgentCommandConfig | null {
  const explicit = input.command?.trim();
  if (explicit) {
    const isCodexAppServer = /\bcodex\b/.test(explicit) && /\bapp-server\b/.test(explicit);
    const isClaudeCli = input.provider === "claude" && /\bclaude\b/.test(explicit);
    return {
      provider: input.provider,
      command: explicit,
      protocol: isCodexAppServer ? "codex-app-server" : isClaudeCli ? "claude-stream-json" : "acp",
      framing: isCodexAppServer || isClaudeCli ? "newline" : "content-length",
    };
  }

  if (input.provider === "codex") {
    return resolveCodexAppServerCommands({ command: input.command })[0] ?? null;
  }

  if (input.provider === "claude") {
    if (process.env.LINKSHELL_CLAUDE_PROVIDER !== "stream-json" && hasPackage("@anthropic-ai/claude-agent-sdk")) {
      return {
        provider: "claude",
        command: "claude-agent-sdk",
        protocol: "claude-agent-sdk",
        framing: "newline",
      };
    }
    return {
      provider: "claude",
      command: "claude --print --output-format stream-json --input-format stream-json --verbose --permission-mode bypassPermissions",
      protocol: "claude-stream-json",
      framing: "newline",
    };
  }

  // custom: caller must provide --agent-command
  return null;
}

function hasPackage(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

function resolveBinary(bin: string): string | null {
  // 1. Try which (PATH lookup)
  try {
    const path = execSync(`which ${bin}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (path && existsSync(path)) return path;
  } catch { /* not in PATH */ }

  // 2. Common install locations (daemon may have a stripped PATH)
  const home = homedir();
  const candidates = [
    `${home}/.npm-global/bin/${bin}`,
    `${home}/.local/bin/${bin}`,
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    `${home}/.nvm/versions/node/*/bin/${bin}`,
  ];
  for (const candidate of candidates) {
    // expand glob if present
    if (candidate.includes("*")) {
      try {
        const expanded = execSync(`ls ${candidate} 2>/dev/null`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0];
        if (expanded && existsSync(expanded)) return expanded;
      } catch { continue; }
    } else if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function detectAvailableProviders(): AgentProvider[] {
  const available: AgentProvider[] = [];
  if (resolveBinary("claude")) available.push("claude");
  if (resolveBinary("codex")) available.push("codex");
  return available;
}
