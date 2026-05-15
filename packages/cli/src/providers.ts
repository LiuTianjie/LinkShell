import { accessSync, constants, existsSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

export type ProviderName = "shell";

export interface ProviderConfig {
  provider: ProviderName;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type ShellConfig = ProviderConfig;

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

function shellSupportsLoginArg(command: string): boolean {
  const name = basename(command).toLowerCase();
  return ["bash", "zsh", "sh", "fish"].includes(name);
}

export function resolveShellConfig(input: {
  command?: string;
  args?: string[];
} = {}): ShellConfig {
  const configuredShell = input.command ?? process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : undefined);
  const command = configuredShell ?? (process.platform === "win32" ? "cmd.exe" : "sh");
  const resolved = which(command) ?? command;
  const passthrough = input.args ?? [];
  const args = passthrough.length > 0
    ? passthrough
    : shellSupportsLoginArg(resolved)
      ? ["-l"]
      : [];

  return {
    provider: "shell",
    command: resolved,
    args,
    env: { ...process.env },
  };
}

export function resolveProviderConfig(input: {
  provider?: string;
  command?: string;
  args: string[];
}): ProviderConfig {
  if (input.provider && input.provider !== "shell") {
    process.stderr.write(
      `[warn] terminal provider "${input.provider}" is ignored in protocol v2; starting the system shell instead\n`,
    );
  }
  return resolveShellConfig({ command: input.command, args: input.args });
}
