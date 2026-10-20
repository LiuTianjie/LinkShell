import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const LINKSHELL_DIR = process.env.LINKSHELL_HOME || join(homedir(), ".linkshell");

// Only launch settings, never the shell's credentials or agent API keys.
const HOST_ENV = ["LINKSHELL_GATEWAY", "LINKSHELL_DEV_PORT", "LINKSHELL_MACHINE_NAME", "LINKSHELL_ICE_SERVERS", "LINKSHELL_CLAUDE_COMMAND", "LINKSHELL_CLAUDE_ADAPTER", "LINKSHELL_PUSH_SERVICE_URL"] as const;
const hostLaunchFile = join(LINKSHELL_DIR, "host-launch.json");

export function saveHostLaunch(pid: number, tcpPort?: number): void {
  const env = Object.fromEntries(HOST_ENV.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  if (tcpPort !== undefined) env.LINKSHELL_DEV_PORT = String(tcpPort);
  writeFileSync(hostLaunchFile, `${JSON.stringify({ pid, env, executable: process.execPath, entry: process.argv[1], appBundle: process.env.LINKSHELL_APP_BUNDLE })}\n`, { mode: 0o600 });
}

export function readHostLaunch(pid: number): NodeJS.ProcessEnv {
  try {
    const saved = JSON.parse(readFileSync(hostLaunchFile, "utf8")) as { pid?: number; env?: Record<string, unknown> };
    const env = saved.env;
    if (saved.pid !== pid || !env) return {};
    return Object.fromEntries(HOST_ENV.flatMap((key) => typeof env[key] === "string" ? [[key, env[key]]] : []));
  } catch {
    return {};
  }
}

/** Ownership is recorded by the host itself, and is valid only for that live PID. */
export function readHostOwner(pid: number): string | undefined {
  try {
    const saved = JSON.parse(readFileSync(hostLaunchFile, "utf8")) as { pid?: number; appBundle?: string };
    return saved.pid === pid && typeof saved.appBundle === "string" ? saved.appBundle : undefined;
  } catch { return undefined; }
}

// "bridge" is the 1.x daemon: nothing starts one any more, but `linkshell stop` still ends one left running.
type ServiceName = "gateway" | "bridge" | "host";

function pidFile(service: ServiceName): string {
  return join(LINKSHELL_DIR, `${service}.pid`);
}

function logFile(service: ServiceName): string {
  return join(LINKSHELL_DIR, `${service}.log`);
}

/** 1.x kept a `<service>.json` beside its pid file; removed with it. */
function metadataFile(service: ServiceName): string {
  return join(LINKSHELL_DIR, `${service}.json`);
}

/** ~/.linkshell, or LINKSHELL_HOME. */
export function linkshellDir(): string {
  return LINKSHELL_DIR;
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
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
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
  if (service === "host") { try { unlinkSync(hostLaunchFile); } catch {} }
}

export function getLogFile(service: ServiceName): string {
  return logFile(service);
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Keeps a log from growing forever: a full one becomes `<service>.log.1`, replacing the one before it.
 * Only when a daemon starts, since a running one holds the file open.
 */
export function rotateLog(log: string, maxBytes = MAX_LOG_BYTES): void {
  try {
    if (statSync(log).size > maxBytes) renameSync(log, `${log}.1`);
  } catch {
    // No log yet.
  }
}

export function spawnDaemon(service: ServiceName, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  mkdirSync(LINKSHELL_DIR, { recursive: true });
  const log = logFile(service);
  rotateLog(log);
  const out = openSync(log, "a");
  const err = openSync(log, "a");

  const entryScript = process.argv[1]!;

  const child = spawn(
    process.execPath,
    [...process.execArgv, entryScript, ...args],
    {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, err],
      // The launching terminal's environment is the most faithful one agents can get.
      env: { ...env, LINKSHELL_ENV_FROM_TERMINAL: env.LINKSHELL_APP_BUNDLE ? "0" : "1" },
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

/** The PID file disappears before shutdown finishes; wait for the process, not that file. */
export async function stopDaemonAndWait(service: ServiceName, timeoutMs = 30_000, expectedPid?: number): Promise<boolean> {
  const pid = expectedPid ?? readPid(service);
  if (!pid) return false;
  if (process.platform === "win32" && service === "host") {
    const { connectHost, hostPaths } = await import("@linkshell/host");
    const client = await connectHost(hostPaths(LINKSHELL_DIR).hostSocket);
    try { await client.call("desktop.shutdown", { pid }, 5000); }
    finally { client.close(); }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        if (readPid(service) === null) removePid(service);
        return true;
      }
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`LinkShell ${service} did not stop within ${timeoutMs / 1000}s; see ${getLogFile(service)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
