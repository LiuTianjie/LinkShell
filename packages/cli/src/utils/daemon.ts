import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, uptime } from "node:os";
import { execFileSync, spawn } from "node:child_process";

const LINKSHELL_DIR = process.env.LINKSHELL_HOME || join(homedir(), ".linkshell");

// Only launch settings, never the shell's credentials or agent API keys.
const HOST_ENV = [
  "LINKSHELL_GATEWAY",
  "LINKSHELL_DEV_PORT",
  "LINKSHELL_MACHINE_NAME",
  "LINKSHELL_ICE_SERVERS",
  "LINKSHELL_CLAUDE_COMMAND",
  "LINKSHELL_CLAUDE_ADAPTER",
  "LINKSHELL_PUSH_SERVICE_URL",
] as const;
const hostLaunchFile = join(LINKSHELL_DIR, "host-launch.json");
const gatewayLaunchFile = join(LINKSHELL_DIR, "gateway-launch.json");

/** Creates a private state directory (0700) and tightens existing permissions on multi-user POSIX systems. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch {}
  }
}

function tightenFileMode(filePath: string, mode = 0o600): void {
  if (process.platform !== "win32") {
    try { chmodSync(filePath, mode); } catch {}
  }
}

export function saveHostLaunch(pid: number, tcpPort?: number): void {
  ensurePrivateDir(LINKSHELL_DIR);
  const env = Object.fromEntries(HOST_ENV.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  if (tcpPort !== undefined) env.LINKSHELL_DEV_PORT = String(tcpPort);
  writeFileSync(
    hostLaunchFile,
    `${JSON.stringify({ pid, env, executable: process.execPath, entry: process.argv[1], appBundle: process.env.LINKSHELL_APP_BUNDLE })}\n`,
    { mode: 0o600 },
  );
  tightenFileMode(hostLaunchFile, 0o600);
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

export function saveGatewayLaunch(pid: number, port: number, host?: string): void {
  ensurePrivateDir(LINKSHELL_DIR);
  writeFileSync(
    gatewayLaunchFile,
    `${JSON.stringify({ pid, port, ...(host ? { host } : {}) })}\n`,
    { mode: 0o600 },
  );
  tightenFileMode(gatewayLaunchFile, 0o600);
}

export function readGatewayLaunch(pid?: number): { pid?: number; port?: number; host?: string } | undefined {
  try {
    const saved = JSON.parse(readFileSync(gatewayLaunchFile, "utf8")) as { pid?: unknown; port?: unknown; host?: unknown };
    if (pid !== undefined && saved.pid !== pid) return undefined;
    return {
      pid: typeof saved.pid === "number" ? saved.pid : undefined,
      port: typeof saved.port === "number" ? saved.port : undefined,
      host: typeof saved.host === "string" && saved.host ? saved.host : undefined,
    };
  } catch {
    return undefined;
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
export type ServiceName = "gateway" | "bridge" | "host";

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
  ensurePrivateDir(LINKSHELL_DIR);
  const file = pidFile(service);
  writeFileSync(file, String(pid), { encoding: "utf8", mode: 0o600 });
  tightenFileMode(file, 0o600);
}

/** Parses Linux `/proc/<pid>/cmdline` NUL-delimited argv bytes into a space-joined command string. */
export function parseProcCmdline(raw: Buffer | string): string {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  return text
    .split("\0")
    .filter((part) => part.length > 0)
    .join(" ")
    .trim();
}

/**
 * Extracts the single-letter process state from Linux `/proc/<pid>/stat` (e.g. "S", "R", "Z").
 * Uses `lastIndexOf(")")` because the process `comm` field can contain spaces and parentheses.
 */
export function parseProcStatState(raw: string): string | undefined {
  const closeParen = raw.lastIndexOf(")");
  if (closeParen < 0) return undefined;
  const rest = raw.slice(closeParen + 1).trim();
  const state = rest.split(/\s+/)[0];
  return state && state.length === 1 ? state : undefined;
}

function defaultReadProcFile(path: string): Buffer {
  return readFileSync(path);
}

/**
 * Reads a process's full command line without spawning a subprocess on Linux (immune to BusyBox/Alpine `ps`
 * differences and column truncation); falls back to `ps` on macOS/BSD.
 */
export function readProcessCommandLine(
  pid: number,
  options: {
    platform?: NodeJS.Platform;
    readProcFile?: (path: string) => Buffer | string;
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return undefined;

  if (platform === "linux") {
    const readProc = options.readProcFile ?? defaultReadProcFile;
    try {
      const statRaw = readProc(`/proc/${pid}/stat`);
      const state = parseProcStatState(Buffer.isBuffer(statRaw) ? statRaw.toString("utf8") : statRaw);
      // Zombies (Z) and dead processes (X) still answer kill(pid, 0) but are no longer running.
      if (state === "Z" || state === "X") return undefined;
    } catch {
      // Fall through to cmdline check; if procfs isn't mounted, fall back to ps below.
    }
    try {
      const cmdline = parseProcCmdline(readProc(`/proc/${pid}/cmdline`));
      return cmdline || undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" && !options.readProcFile && existsSync("/proc/self")) {
        return undefined;
      }
      if (options.readProcFile) return undefined;
    }
  }

  try {
    const stdout = execFileSync("ps", ["-p", String(pid), "-ww", "-o", "command="], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function matchesServiceProcess(service: ServiceName, commandLine: string, savedEntry?: string): boolean {
  const cmd = commandLine.trim();
  if (!cmd) return false;
  if (savedEntry && cmd.includes(savedEntry)) return true;
  const lower = cmd.toLowerCase();
  if (service === "host") {
    return cmd.includes("--_foreground-host") || (lower.includes("linkshell") && /\bhost\b/.test(lower));
  }
  if (service === "gateway") {
    return cmd.includes("--_foreground-gw") || (lower.includes("linkshell") && /\bgateway\b/.test(lower));
  }
  return lower.includes("linkshell") || /\bbridge\b/.test(lower);
}

function readSavedHostEntry(pid: number): string | undefined {
  try {
    const saved = JSON.parse(readFileSync(hostLaunchFile, "utf8")) as { pid?: unknown; entry?: unknown };
    return saved.pid === pid && typeof saved.entry === "string" && saved.entry ? saved.entry : undefined;
  } catch {
    return undefined;
  }
}

export function verifyDaemonIdentity(
  service: ServiceName,
  pid: number,
  options: {
    platform?: NodeJS.Platform;
    readProcFile?: (path: string) => Buffer | string;
    savedEntry?: string;
  } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return true;
  const cmdline = readProcessCommandLine(pid, options);
  if (!cmdline) return false;
  const savedEntry = options.savedEntry ?? (service === "host" ? readSavedHostEntry(pid) : undefined);
  return matchesServiceProcess(service, cmdline, savedEntry);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      const state = parseProcStatState(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (state === "Z" || state === "X") return false;
    } catch {
      // Ignore transient proc read errors.
    }
  }
  return true;
}

export function readPid(service: ServiceName): number | null {
  try {
    const file = pidFile(service);
    if (!existsSync(file)) return null;
    const pid = Number(readFileSync(file, "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    // Written before the computer last started (a logoff or power cut left it): whatever runs under
    // that pid now is some other process, and believing it would keep the host from being started.
    if (statSync(file).mtimeMs < Date.now() - uptime() * 1000 - 60_000) {
      removePid(service);
      return null;
    }
    if (!isProcessAlive(pid)) {
      removePid(service);
      return null;
    }
    if (!verifyDaemonIdentity(service, pid)) {
      removePid(service);
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

export function removePid(service: ServiceName): void {
  try { unlinkSync(pidFile(service)); } catch {}
  try { unlinkSync(metadataFile(service)); } catch {}
  if (service === "host") { try { unlinkSync(hostLaunchFile); } catch {} }
  if (service === "gateway") { try { unlinkSync(gatewayLaunchFile); } catch {} }
}

function cleanupForcedArtifacts(service: ServiceName): void {
  removePid(service);
  if (service === "host") {
    try { unlinkSync(join(LINKSHELL_DIR, "run", "host.lock")); } catch {}
    if (process.platform !== "win32") {
      try { unlinkSync(join(LINKSHELL_DIR, "run", "host.sock")); } catch {}
    }
  }
}

/** Estimates daemon uptime in seconds from the PID/launch file mtime (or /proc on Linux). */
export function readDaemonUptimeSeconds(service: ServiceName, pid?: number | null): number | undefined {
  if (process.platform === "linux" && pid && pid > 0) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen > 0) {
        const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
        // Field 22 in /proc/pid/stat is starttime in clock ticks; index 19 after comm+state.
        const startTicks = Number(fields[19]);
        const sysUptimeSec = Number(readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0]);
        // Standard Linux USER_HZ is 100.
        if (Number.isFinite(startTicks) && Number.isFinite(sysUptimeSec) && startTicks > 0) {
          const seconds = Math.floor(sysUptimeSec - startTicks / 100);
          if (seconds >= 0) return seconds;
        }
      }
    } catch {
      // Fall back to pid file mtime.
    }
  }
  for (const candidate of [pidFile(service), service === "host" ? hostLaunchFile : gatewayLaunchFile]) {
    try {
      if (existsSync(candidate)) {
        const seconds = Math.floor((Date.now() - statSync(candidate).mtimeMs) / 1000);
        if (seconds >= 0) return seconds;
      }
    } catch {}
  }
  return undefined;
}

export function getLogFile(service: ServiceName): string {
  return logFile(service);
}

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_LOG_FILES = 3;

function shiftRotatedLogs(log: string, maxFiles: number): void {
  const keep = Math.max(1, Math.floor(maxFiles));
  for (let i = keep - 1; i >= 1; i -= 1) {
    const src = `${log}.${i}`;
    const dst = `${log}.${i + 1}`;
    try {
      if (existsSync(src)) renameSync(src, dst);
    } catch {}
  }
}

/**
 * Keeps a log from growing forever: shifts `<log>.1..N` and moves a full log to `<log>.1`.
 * Used on daemon start before opening the file.
 */
export function rotateLog(log: string, maxBytes = MAX_LOG_BYTES, maxFiles = MAX_LOG_FILES): void {
  try {
    if (statSync(log).size > maxBytes) {
      shiftRotatedLogs(log, maxFiles);
      renameSync(log, `${log}.1`);
      tightenFileMode(`${log}.1`, 0o600);
    }
  } catch {
    // No log yet.
  }
}

/**
 * Copy-and-truncate rotation safe for long-running foreground/systemd daemons whose stdout/stderr
 * already hold an O_APPEND descriptor to the log file.
 */
export function copyTruncateLog(log: string, maxBytes = MAX_LOG_BYTES, maxFiles = MAX_LOG_FILES): boolean {
  try {
    if (statSync(log).size <= maxBytes) return false;
    shiftRotatedLogs(log, maxFiles);
    copyFileSync(log, `${log}.1`);
    tightenFileMode(`${log}.1`, 0o600);
    truncateSync(log, 0);
    return true;
  } catch {
    return false;
  }
}

/** Periodically caps log growth for 24/7 foreground and systemd-supervised daemons. */
export function startPeriodicLogRotation(
  log: string,
  options: { maxBytes?: number; maxFiles?: number; intervalMs?: number } = {},
): () => void {
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  const maxFiles = options.maxFiles ?? MAX_LOG_FILES;
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  copyTruncateLog(log, maxBytes, maxFiles);
  const timer = setInterval(() => {
    copyTruncateLog(log, maxBytes, maxFiles);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function spawnDaemon(service: ServiceName, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  ensurePrivateDir(LINKSHELL_DIR);
  const log = logFile(service);
  rotateLog(log);
  const out = openSync(log, "a", 0o600);
  const err = openSync(log, "a", 0o600);
  if (process.platform !== "win32") {
    try { fchmodSync(out, 0o600); } catch {}
  }
  try {
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
  } finally {
    try { closeSync(out); } catch {}
    try { closeSync(err); } catch {}
  }
}

export function stopDaemon(service: ServiceName): boolean {
  const pid = readPid(service);
  if (!pid) return false;
  if (!verifyDaemonIdentity(service, pid)) {
    removePid(service);
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    removePid(service);
    return true;
  } catch {
    removePid(service);
    return false;
  }
}

async function waitForProcessExit(pid: number, deadlineMs: number): Promise<boolean> {
  for (;;) {
    if (!isProcessAlive(pid)) return true;
    if (Date.now() >= deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Stops a daemon and waits for the process itself to exit.
 * Verifies process identity before signaling; escalates to SIGKILL and cleans stale artifacts if
 * the daemon ignores SIGTERM past the graceful timeout (unless `forceKill: false`).
 */
export async function stopDaemonAndWait(
  service: ServiceName,
  timeoutMs = 30_000,
  expectedPid?: number,
  options: { forceKill?: boolean } = {},
): Promise<boolean> {
  const pid = expectedPid ?? readPid(service);
  if (!pid) return false;
  if (!verifyDaemonIdentity(service, pid)) {
    // Never signal an unrelated process if a PID was recycled.
    try {
      const filePid = Number(readFileSync(pidFile(service), "utf8").trim());
      if (filePid === pid) removePid(service);
    } catch {}
    return false;
  }

  if (process.platform === "win32" && service === "host") {
    const { connectHost, hostPaths } = await import("@linkshell/host");
    const client = await connectHost(hostPaths(LINKSHELL_DIR).hostSocket);
    try { await client.call("desktop.shutdown", { pid }, 5000); }
    finally { client.close(); }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        if (readPid(service) === null) removePid(service);
        return true;
      }
      throw error;
    }
  }

  if (await waitForProcessExit(pid, Date.now() + timeoutMs)) {
    if (readPid(service) === null) removePid(service);
    return true;
  }

  if (options.forceKill === false || process.platform === "win32") {
    throw new Error(`LinkShell ${service} did not stop within ${timeoutMs / 1000}s; see ${getLogFile(service)}`);
  }

  // Graceful shutdown hung: escalate to SIGKILL and sweep stale PID/lock artifacts.
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }

  if (await waitForProcessExit(pid, Date.now() + 3_000)) {
    cleanupForcedArtifacts(service);
    return true;
  }

  throw new Error(`LinkShell ${service} did not stop within ${timeoutMs / 1000}s even after SIGKILL; see ${getLogFile(service)}`);
}
