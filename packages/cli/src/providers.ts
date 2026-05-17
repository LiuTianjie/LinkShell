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

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "cmd.exe";
  }
  return process.env.SHELL ?? "/bin/bash";
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

export function resolveProviderConfig(input: {
  provider?: ProviderName;
  command?: string;
  args: string[];
}): ProviderConfig {
  if (input.provider && input.provider !== "custom") {
    process.stderr.write(
      `[warn] --provider=${input.provider} is no longer supported; falling back to a shell. ` +
        `Launch your CLI manually inside the terminal (e.g. type "${input.provider}").\n`,
    );
  }

  const requested = input.command?.trim();
  const command = requested && requested.length > 0 ? requested : defaultShell();
  const resolved = which(command) ?? command;

  return {
    provider: "custom",
    command: resolved,
    args: input.args,
    env: { ...process.env },
  };
}
