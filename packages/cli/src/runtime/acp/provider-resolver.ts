import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

import type { KnownAgentProvider } from "./agent-process-discovery.js";

export type AgentProvider = string;
export type { KnownAgentProvider };
export type AgentProtocol = "acp" | "codex-app-server" | "claude-agent-sdk" | "claude-stream-json";
export type AgentFraming = "content-length" | "newline";

const require = createRequire(import.meta.url);

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
    const isClaudeCli = input.provider === "claude" && /\bclaude\b/.test(explicit);
    return {
      provider: input.provider,
      command: explicit,
      protocol: isCodexAppServer ? "codex-app-server" : isClaudeCli ? "claude-stream-json" : "acp",
      // Gemini --acp, cursor-agent acp, and other ACP CLIs speak NDJSON, not LSP Content-Length.
      framing: "newline",
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

  if (input.provider === "gemini") {
    return {
      provider: "gemini",
      command: "gemini --acp",
      protocol: "acp",
      framing: "newline",
    };
  }

  if (input.provider === "cursor") {
    return {
      provider: "cursor",
      command: "cursor-agent acp",
      protocol: "acp",
      framing: "newline",
    };
  }

  if (input.provider === "grok") {
    return {
      provider: "grok",
      command: "grok agent stdio",
      protocol: "acp",
      framing: "newline",
    };
  }

  // copilot / opencode / kimi / custom: PTY-only unless caller passes --agent-command
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

const INSTALL_BINARIES: Array<{ provider: KnownAgentProvider; binaries: string[] }> = [
  { provider: "claude", binaries: ["claude"] },
  { provider: "codex", binaries: ["codex"] },
  { provider: "gemini", binaries: ["gemini"] },
  { provider: "copilot", binaries: ["copilot"] },
  { provider: "opencode", binaries: ["opencode", "opencode-ai"] },
  { provider: "cursor", binaries: ["cursor-agent"] },
  { provider: "grok", binaries: ["grok"] },
  { provider: "kimi", binaries: ["kimi"] },
];

export function detectAvailableProviders(): AgentProvider[] {
  const available: AgentProvider[] = [];
  for (const entry of INSTALL_BINARIES) {
    if (entry.binaries.some((bin) => resolveBinary(bin))) available.push(entry.provider);
  }
  return available;
}

