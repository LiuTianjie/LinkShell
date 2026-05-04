import { execSync } from "node:child_process";

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

export function detectAvailableProviders(): AgentProvider[] {
  const available: AgentProvider[] = [];
  const bins = [
    ["claude", "claude"] as const,
    ["codex", "codex"] as const,
  ];
  for (const [, bin] of bins) {
    try {
      execSync(`which ${bin}`, { stdio: "ignore" });
      available.push(bin as AgentProvider);
    } catch {
      // not installed
    }
  }
  return available.length > 0 ? available : [];
}
