import * as readline from "node:readline";
import { hostname } from "node:os";
import { loadConfig, saveConfig, getConfigPath } from "../config.js";
import type { LinkShellConfig } from "../config.js";

function ask(
  rl: readline.Interface,
  question: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function choose(
  rl: readline.Interface,
  question: string,
  options: string[],
  defaultIdx = 0,
): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`  ${question}\n`);
    for (let i = 0; i < options.length; i++) {
      const marker = i === defaultIdx ? "\x1b[36m>\x1b[0m" : " ";
      process.stdout.write(`  ${marker} ${i + 1}. ${options[i]}\n`);
    }
    rl.question(`  Choice (${defaultIdx + 1}): `, (answer) => {
      const idx = Number(answer.trim()) - 1;
      resolve(options[idx >= 0 && idx < options.length ? idx : defaultIdx]!);
    });
  });
}

export async function runSetup(): Promise<void> {
  const existing = loadConfig();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  process.stdout.write("\n  LinkShell Setup\n\n");
  process.stdout.write(
    "  Tip: leave Gateway URL empty to use the built-in gateway (recommended for LAN use).\n\n",
  );

  const gateway = await ask(rl, "Gateway URL (leave empty for built-in)", "");

  const provider = (await choose(
    rl,
    "Default provider:",
    ["claude", "codex", "custom"],
    ["claude", "codex", "custom"].indexOf(existing.provider ?? "claude"),
  )) as LinkShellConfig["provider"];

  let command: string | undefined;
  if (provider === "custom") {
    command = await ask(rl, "Custom command", existing.command ?? "bash");
  }

  const clientName = await ask(
    rl,
    "Client name",
    existing.clientName ?? hostname(),
  );
  const hostnameName = await ask(
    rl,
    "Hostname (display name for your machine)",
    existing.hostname ?? hostname(),
  );

  rl.close();

  const config: LinkShellConfig = {
    gateway: gateway || undefined,
    provider,
    command,
    clientName,
    hostname: hostnameName || undefined,
  };

  saveConfig(config);

  process.stdout.write(
    `\n  \x1b[32mConfig saved to ${getConfigPath()}\x1b[0m\n\n`,
  );
  process.stdout.write("  Next steps:\n");
  process.stdout.write("    linkshell doctor    — verify your setup\n");
  process.stdout.write("    linkshell start     — start a bridge session\n\n");
}
