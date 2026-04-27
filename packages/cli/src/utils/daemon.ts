import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const LINKSHELL_DIR = join(homedir(), ".linkshell");

type ServiceName = "gateway" | "bridge";

export interface ServiceMetadata {
  keepAwake?: boolean;
  startedAt?: number;
}

function pidFile(service: ServiceName): string {
  return join(LINKSHELL_DIR, `${service}.pid`);
}

function logFile(service: ServiceName): string {
  return join(LINKSHELL_DIR, `${service}.log`);
}

function metadataFile(service: ServiceName): string {
  return join(LINKSHELL_DIR, `${service}.json`);
}

export function savePid(service: ServiceName, pid: number): void {
  mkdirSync(LINKSHELL_DIR, { recursive: true });
  writeFileSync(pidFile(service), String(pid), "utf8");
}

export function readPid(service: ServiceName): number | null {
  try {
    const file = pidFile(service);
    if (!existsSync(file)) return null;
    const pid = Number(readFileSync(file, "utf8").trim());
    if (!pid || isNaN(pid)) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      removePid(service);
      return null;
    }
  } catch {
    return null;
  }
}

export function removePid(service: ServiceName): void {
  try { unlinkSync(pidFile(service)); } catch {}
  try { unlinkSync(metadataFile(service)); } catch {}
}

export function getLogFile(service: ServiceName): string {
  return logFile(service);
}

export function getPidFile(service: ServiceName): string {
  return pidFile(service);
}

export function saveMetadata(
  service: ServiceName,
  metadata: ServiceMetadata,
): void {
  mkdirSync(LINKSHELL_DIR, { recursive: true });
  writeFileSync(metadataFile(service), JSON.stringify(metadata), "utf8");
}

export function readMetadata(service: ServiceName): ServiceMetadata | null {
  try {
    const file = metadataFile(service);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as ServiceMetadata;
  } catch {
    return null;
  }
}

export function spawnDaemon(service: ServiceName, args: string[]): number {
  mkdirSync(LINKSHELL_DIR, { recursive: true });
  const log = logFile(service);
  const out = openSync(log, "a");
  const err = openSync(log, "a");

  const entryScript = process.argv[1]!;

  const child = spawn(
    process.execPath,
    [...process.execArgv, entryScript, ...args],
    {
      detached: true,
      stdio: ["ignore", out, err],
      env: process.env,
    },
  );

  child.unref();
  const pid = child.pid!;
  savePid(service, pid);
  return pid;
}

export function stopDaemon(service: ServiceName): boolean {
  const pid = readPid(service);
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
    removePid(service);
    return true;
  } catch {
    removePid(service);
    return false;
  }
}
