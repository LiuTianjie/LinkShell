import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface LinkShellConfig {
  gateway?: string;
  pairingGateway?: string;
  provider?: "claude" | "codex" | "custom";
  command?: string;
  clientName?: string;
  cols?: number;
  rows?: number;
}

const CONFIG_DIR = join(homedir(), ".linkshell");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function loadConfig(): LinkShellConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as LinkShellConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: LinkShellConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
