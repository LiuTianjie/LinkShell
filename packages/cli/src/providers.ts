import { execSync } from "node:child_process";

export type ProviderName = "claude" | "codex" | "custom";

export interface ProviderConfig {
  provider: ProviderName;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function which(bin: string): string | undefined {
  try {
    return execSync(`which ${bin}`, { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveClaudeProvider(input: {
  command?: string;
  args: string[];
}): ProviderConfig {
  const command = input.command ?? "claude";
  const resolved = which(command);
  if (!resolved) {
    throw new Error(
      `Claude CLI not found ("${command}"). Install it with: npm install -g @anthropic-ai/claude-code`,
    );
  }

  // Claude starts an interactive REPL by default — that's exactly what we want in the PTY.
  // Pass through any extra args the user provided.
  return {
    provider: "claude",
    command: resolved,
    args: input.args,
    env: { ...process.env },
  };
}

function resolveCodexProvider(input: {
  command?: string;
  args: string[];
}): ProviderConfig {
  const command = input.command ?? "codex";
  const resolved = which(command);
  if (!resolved) {
    throw new Error(
      `Codex CLI not found ("${command}"). Install it with: npm install -g @openai/codex`,
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    process.stderr.write(
      "[warn] OPENAI_API_KEY not set — Codex may fail to authenticate\n",
    );
  }

  return {
    provider: "codex",
    command: resolved,
    args: input.args,
    env: { ...process.env },
  };
}

export function resolveProviderConfig(input: {
  provider: ProviderName;
  command?: string;
  args: string[];
}): ProviderConfig {
  switch (input.provider) {
    case "claude":
      return resolveClaudeProvider(input);
    case "codex":
      return resolveCodexProvider(input);
    case "custom": {
      if (!input.command) {
        throw new Error("custom provider requires --command");
      }
      const resolved = which(input.command);
      return {
        provider: "custom",
        command: resolved ?? input.command,
        args: input.args,
        env: { ...process.env },
      };
    }
  }
}
