import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

export type AgentProvider = "codex" | "claude" | "custom";
export type AgentProtocol = "acp" | "codex-app-server";
export type AgentFraming = "content-length" | "newline";

export interface AgentCommandConfig {
  command: string;
  provider: AgentProvider;
  protocol: AgentProtocol;
  framing: AgentFraming;
}

export function resolveAgentCommand(input: {
  provider: AgentProvider;
  command?: string;
}): AgentCommandConfig | null {
  const explicit = input.command?.trim();
  if (explicit) {
    const isCodexAppServer = /\bcodex\b/.test(explicit) && /\bapp-server\b/.test(explicit);
    return {
      provider: input.provider,
      command: explicit,
      protocol: isCodexAppServer ? "codex-app-server" : "acp",
      framing: isCodexAppServer ? "newline" : "content-length",
    };
  }

  if (input.provider === "codex") {
    return {
      provider: "codex",
      command: "codex app-server --listen stdio://",
      protocol: "codex-app-server",
      framing: "newline",
    };
  }

  if (input.provider === "claude") {
    return {
      provider: "claude",
      command: "claude --acp",
      protocol: "acp",
      framing: "content-length",
    };
  }

  // custom: caller must provide --agent-command
  return null;
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
