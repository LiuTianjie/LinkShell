import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export interface MachineIdentity {
  machineId: string;
  hostname: string;
  createdAt: string;
}

const LINKSHELL_DIR = ".linkshell";
const MACHINE_FILE = "machine.json";

function machineFilePath(homeDir = homedir()): string {
  return join(homeDir, LINKSHELL_DIR, MACHINE_FILE);
}

function parseMachineIdentity(raw: string): MachineIdentity | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MachineIdentity>;
    if (
      typeof parsed.machineId === "string" &&
      parsed.machineId.trim() &&
      typeof parsed.hostname === "string" &&
      parsed.hostname.trim() &&
      typeof parsed.createdAt === "string" &&
      parsed.createdAt.trim()
    ) {
      return {
        machineId: parsed.machineId,
        hostname: parsed.hostname,
        createdAt: parsed.createdAt,
      };
    }
  } catch {
    // Ignore malformed machine files and recreate below.
  }
  return null;
}

export function loadOrCreateMachineIdentity(homeDir = homedir()): MachineIdentity {
  const filePath = machineFilePath(homeDir);
  if (existsSync(filePath)) {
    const existing = parseMachineIdentity(readFileSync(filePath, "utf8"));
    if (existing) return existing;
  }

  const identity: MachineIdentity = {
    machineId: randomUUID(),
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(join(homeDir, LINKSHELL_DIR), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return identity;
}

