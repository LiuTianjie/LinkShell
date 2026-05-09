import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { TerminalProvider } from "@linkshell/protocol";

export type ProviderName = TerminalProvider;

export interface ProviderConfig {
  provider: ProviderName;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return process.platform === "win32" && existsSync(path);
  }
}

function executableExtensions(bin: string): string[] {
  if (process.platform !== "win32") return [""];
  if (/\.[^\\/]+$/.test(bin)) return [""];
  const pathext = process.env.PATHEXT?.split(";").filter(Boolean) ?? [];
  return ["", ...pathext.map((ext) => ext.toLowerCase()), ...pathext.map((ext) => ext.toUpperCase())];
}

function commandHasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function which(bin: string): string | undefined {
  const command = stripOuterQuotes(bin);
  if (!command) return undefined;
  const extensions = executableExtensions(command);
  if (commandHasPathSeparator(command)) {
    for (const extension of extensions) {
      const candidate = `${command}${extension}`;
      if (canExecute(candidate)) return candidate;
    }
    return undefined;
  }
  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  for (const dir of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      if (canExecute(candidate)) return candidate;
    }
  }
  return undefined;
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

function resolveGeminiProvider(input: {
  command?: string;
  args: string[];
}): ProviderConfig {
  const command = input.command ?? "gemini";
  const resolved = which(command);
  if (!resolved) {
    throw new Error(
      `Gemini CLI not found ("${command}"). Install it with: npm install -g @anthropic-ai/gemini-cli or check https://github.com/anthropics/gemini-cli`,
    );
  }

  if (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY) {
    process.stderr.write(
      "[warn] GOOGLE_API_KEY / GEMINI_API_KEY not set — Gemini may fail to authenticate\n",
    );
  }

  return {
    provider: "gemini",
    command: resolved,
    args: input.args,
    env: { ...process.env },
  };
}

function resolveCopilotProvider(input: {
  command?: string;
  args: string[];
}): ProviderConfig {
  const command = input.command ?? "github-copilot";
  const resolved = which(command);
  if (!resolved) {
    throw new Error(
      `GitHub Copilot CLI not found ("${command}").`,
    );
  }

  return {
    provider: "copilot",
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
    case "gemini":
      return resolveGeminiProvider(input);
    case "copilot":
      return resolveCopilotProvider(input);
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
