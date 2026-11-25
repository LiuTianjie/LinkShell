import { readMachineHardware } from "./machine-form-factor.js";
import { UsageStatistics } from "./usage.js";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import type { ChildProcess } from "node:child_process";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_ICE_SERVERS, HOST_PROTOCOL, type GatewayStatus, type MachineInfo } from "@linkshell/wire";
import { defaultDrivers, remoteDriver } from "./drivers/registry.js";
import { AcpSettingsStore } from "./acp-settings.js";
import type { AgentDriver } from "./drivers/types.js";
import { SessionHub } from "./hub.js";
import { connectHost } from "./rpc/client.js";
import { AccessControl } from "./access.js";
import { HostRpcServer } from "./rpc/server.js";
import { ensureIdentity, GatewayLink } from "./gateway.js";
import { HostStore } from "./store.js";
import { removeLegacyCopilotHooks } from "./legacy.js";
import { withoutClaudeSession } from "./shell-env.js";
import { TerminalManager } from "./terminals.js";
import { LiveActivityRelay } from "./live-activities.js";
import { isNamedPipe, windowsPipe } from "./local-transport.js";
import { MachineName } from "./machine-name.js";
import { openChildRegistry, reapOrphans } from "./children.js";
import { KeepAwakeManager, type SpawnAssertion } from "./keep-awake.js";
import { MdnsAdvertiser, hostFingerprint } from "./mdns.js";

/** macOS sun_path is 104 bytes including the terminator. */
const MAX_SOCKET_PATH = 100;
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface HostPaths {
  home: string;
  runDir: string;
  hostSocket: string;
  codexSocket: string;
  database: string;
}

/** `~/.linkshell`, or `$LINKSHELL_HOME` (tests, multiple instances). */
export function defaultHome(): string {
  return process.env.LINKSHELL_HOME || join(homedir(), ".linkshell");
}

function usableXdgRuntimeDir(xdg: string | undefined, tag: string): string | undefined {
  const trimmed = xdg?.trim();
  if (!trimmed) return undefined;
  try {
    const stat = lstatSync(trimmed);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
    accessSync(trimmed, fsConstants.W_OK);
  } catch {
    return undefined;
  }
  const candidate = join(trimmed, `linkshell-${tag}`);
  return Buffer.byteLength(join(candidate, "codex.sock")) <= MAX_SOCKET_PATH ? candidate : undefined;
}

export function hostPaths(
  home = defaultHome(),
  options?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; uid?: number },
): HostPaths {
  const targetPlatform = options?.platform ?? process.platform;
  const targetEnv = options?.env ?? process.env;
  const uid = options?.uid ?? process.getuid?.();
  let runDir = join(home, "run");
  if (targetPlatform !== "win32" && Buffer.byteLength(join(runDir, "codex.sock")) > MAX_SOCKET_PATH) {
    // Very long home directories: on Linux prefer `$XDG_RUNTIME_DIR` (survives systemd-tmpfiles-clean)
    // before falling back to `/tmp`, using one short user-scoped directory per home.
    const tag = createHash("sha256").update(home).digest("hex").slice(0, 8);
    runDir =
      (targetPlatform === "linux" ? usableXdgRuntimeDir(targetEnv.XDG_RUNTIME_DIR, tag) : undefined) ??
      join("/tmp", `linkshell-${uid ?? "user"}-${tag}`);
  }
  return {
    home,
    runDir,
    hostSocket: targetPlatform === "win32" ? windowsPipe(home, "host") : join(runDir, "host.sock"),
    codexSocket: targetPlatform === "win32" ? windowsPipe(home, "codex") : join(runDir, "codex.sock"),
    database: join(home, "state.db"),
  };
}

function loadMachineId(home: string): string {
  const path = join(home, "machine.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { machineId?: unknown };
    if (typeof parsed.machineId === "string" && parsed.machineId) return parsed.machineId;
  } catch {
    // Missing or unreadable: mint a new identity below.
  }
  const machineId = randomUUID();
  writeFileSync(path, `${JSON.stringify({ machineId, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  return machineId;
}

export interface HostOptions {
  home?: string;
  version: string;
  /** Environment agents run with — should be the user's login-shell environment. */
  env?: NodeJS.ProcessEnv;
  /**
   * STUN servers for the direct channel (bulk streams peer to peer instead of
   * through the gateway). Default: `LINKSHELL_ICE_SERVERS`, or a built-in
   * list. `false`: no direct channel. An empty list still connects devices
   * on the same network.
   */
  iceServers?: string[] | false;
  codexCommand?: string;
  claudeCommand?: string;
  /** Overrides the bundled Claude ACP adapter. */
  claudeAdapter?: { command: string; args: string[] };
  /** Extra drivers (tests) or a full replacement of the default set. */
  drivers?: (paths: HostPaths) => AgentDriver[];
  tcpPort?: number;
  /** Same-Wi-Fi LAN gateway port to advertise over mDNS (`linkshell host --lan`). */
  lanPort?: number;
  log?: (message: string) => void;
  shutdown?: () => void;
  /**
   * A v2 gateway to reach this machine through, from anywhere. A function is
   * asked again on `gateway.refresh`, so the choice can change while running.
   */
  gateway?: {
    url: string | (() => string | undefined);
    token?: () => Promise<string | undefined> | string | undefined;
    name?: string;
  };
  /** How often to re-list sessions started outside LinkShell; 0 disables. */
  discoveryIntervalMs?: number;
  /** Whether to advertise `_linkshell._tcp` over LAN mDNS when `tcpPort` is active. */
  mdns?: boolean;
  spawnMdnsProcess?: (command: string, args: string[]) => ChildProcess;
  spawnKeepAwakeAssertion?: SpawnAssertion;
}

export interface RunningHost {
  paths: HostPaths;
  hub: SessionHub;
  server: HostRpcServer;
  /** The current gateway connection; it can change on `gateway.refresh`. */
  readonly gateway?: GatewayLink;
  machineInfo(): MachineInfo;
  stop(): Promise<void>;
}

/** True when another host already answers on the socket. */
export async function isHostRunning(socketPath: string): Promise<boolean> {
  if (!isNamedPipe(socketPath) && !existsSync(socketPath)) return false;
  try {
    const client = await connectHost(socketPath);
    client.close();
    return true;
  } catch {
    return false;
  }
}

function iceServersFromEnv(value: string | undefined): string[] | false {
  if (value === undefined) return DEFAULT_ICE_SERVERS;
  if (value.trim().toLowerCase() === "off") return false;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export interface HostLockDeps {
  platform?: NodeJS.Platform;
  /** True only when `host.sock` was confirmed reachable; otherwise non-LinkShell Linux PIDs are reclaimed. */
  socketReachable?: boolean;
  killZero?: (pid: number) => void;
  /** Returns raw `/proc/<pid>/cmdline` text, `null` when missing (`ENOENT`), or `undefined` if unreadable. */
  readProcCmdline?: (pid: number) => string | null | undefined;
}

/** True when a Linux `/proc/<pid>/cmdline` belongs to a LinkShell host invocation. */
export function isLinkShellHostCmdline(raw: string): boolean {
  const normalized = raw.replace(/\0+/g, " ").trim();
  if (!normalized) return false;
  return /(?:^|[\s/\\_-])linkshell(?:[\s/\\._-]|$)/i.test(normalized);
}

function defaultReadProcCmdline(pid: number): string | null | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return undefined;
  }
}

function isLockOwnerAlive(pid: number, deps?: HostLockDeps): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  const killZero = deps?.killZero ?? ((target: number) => process.kill(target, 0));
  try {
    killZero(pid);
  } catch {
    // Both ESRCH (gone) and EPERM (another user's recycled PID after reboot/container restart)
    // mean this PID is NOT our LinkShell host.
    return false;
  }
  const targetPlatform = deps?.platform ?? process.platform;
  if (targetPlatform === "linux") {
    const readCmdline = deps?.readProcCmdline ?? defaultReadProcCmdline;
    const cmdline = readCmdline(pid);
    if (cmdline === null) return false;
    if (typeof cmdline === "string" && cmdline.replace(/\0+/g, "").trim().length > 0) {
      if (isLinkShellHostCmdline(cmdline)) return true;
      return deps?.socketReachable === true;
    }
  }
  return true;
}

function readConfiguredLanPort(home: string, optionPort?: number): number | undefined {
  const parsePort = (value: unknown): number | undefined => {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
  };
  const fromOption = parsePort(optionPort);
  if (fromOption !== undefined) return fromOption;
  const fromEnv = parsePort(process.env.LINKSHELL_LAN_PORT);
  if (fromEnv !== undefined) return fromEnv;
  try {
    const parsed = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { lanPort?: unknown };
    return parsePort(parsed.lanPort);
  } catch {
    return undefined;
  }
}

/**
 * Verifies `runDir` is a real directory owned by the current user (never a
 * symlink in `/tmp`) before setting `0700` permissions or placing sockets/locks inside.
 */
export function ensureSecureRunDir(runDir: string, currentUid = process.getuid?.()): void {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(runDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing insecure run directory (${runDir}): not a real directory`);
  }
  if (process.platform !== "win32" && currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`refusing insecure run directory (${runDir}): owned by uid ${stat.uid}`);
  }
  if (process.platform !== "win32") {
    chmodSync(runDir, 0o700);
  }
}

function parseLockPid(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) {
      return parsed.pid;
    }
  } catch {
    const num = Number(trimmed);
    if (Number.isSafeInteger(num) && num > 0) return num;
  }
  return undefined;
}

/**
 * Acquires an exclusive `O_CREAT | O_EXCL` startup lockfile in `runDir`,
 * reclaiming stale locks left by crashed processes so concurrent `startHost()`
 * invocations cannot race into `reapOrphans()` or `hub.start()`.
 */
export function acquireHostLock(lockPath: string, deps?: HostLockDeps): () => void {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown; pid?: unknown };
          if (current.token === token || (current.token === undefined && current.pid === process.pid)) {
            rmSync(lockPath, { force: true });
          }
        } catch {
          // Lockfile was already cleaned up with runDir.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existingPid: number | undefined;
      let fresh = false;
      try {
        existingPid = parseLockPid(readFileSync(lockPath, "utf8"));
        fresh = Date.now() - statSync(lockPath).mtimeMs < 5000;
      } catch {
        existingPid = undefined;
      }
      if (existingPid !== undefined && isLockOwnerAlive(existingPid, deps)) {
        throw new Error(`a LinkShell host is already running (${lockPath}, pid ${existingPid})`, { cause: error });
      }
      if (existingPid === undefined && fresh) {
        throw new Error(`a LinkShell host is already starting (${lockPath})`, { cause: error });
      }
      if (attempt === 0) {
        rmSync(lockPath, { force: true });
        continue;
      }
      throw new Error(`a LinkShell host lock is contended (${lockPath})`, { cause: error });
    }
  }
  throw new Error(`failed to acquire host lock (${lockPath})`);
}

export async function startHost(options: HostOptions): Promise<RunningHost> {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const paths = hostPaths(options.home);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(paths.home, 0o700);
  }
  ensureSecureRunDir(paths.runDir);
  if (await isHostRunning(paths.hostSocket)) {
    throw new Error(`a LinkShell host is already running (${paths.hostSocket})`);
  }
  const releaseHostLock = acquireHostLock(join(paths.runDir, "host.lock"), { socketReachable: false });

  let children: ReturnType<typeof openChildRegistry> | undefined;
  let store: HostStore | undefined;
  let terminals: TerminalManager | undefined;
  let hub: SessionHub | undefined;
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let keepAwake: KeepAwakeManager | undefined;
  let liveActivities: LiveActivityRelay | undefined;
  let server: HostRpcServer | undefined;
  let stopWorkListener: (() => void) | undefined;
  let stopDemandListener: (() => void) | undefined;
  let mdns: MdnsAdvertiser | undefined;
  let gateway: GatewayLink | undefined;

  try {
    if (await isHostRunning(paths.hostSocket)) {
      throw new Error(`a LinkShell host is already running (${paths.hostSocket})`);
    }
    // Before any driver starts: an agent an earlier host left can still hold what
    // a new one needs (a session's lock, a socket), besides running on unwatched.
    await reapOrphans(paths.runDir, log);
    children = openChildRegistry(paths.runDir);

    const machineId = loadMachineId(paths.home);
    const machineName = new MachineName(paths.home, options.gateway?.name ?? (process.env.LINKSHELL_MACHINE_NAME || hostname()).replace(/\.local$/, ""));
    // Agents and terminals start clean even when LinkShell ran inside a Claude Code session.
    const env = withoutClaudeSession(options.env ?? process.env);
    const acpSettings = new AcpSettingsStore(join(paths.home, "acp.json"));
    if (!options.drivers) removeLegacyCopilotHooks(join(homedir(), ".copilot", "hooks"), log);
    const drivers = options.drivers
      ? options.drivers(paths)
      : defaultDrivers({
          agents: acpSettings.agents(),
          env,
          hostVersion: options.version,
          codexSocket: paths.codexSocket,
          codexCommand: options.codexCommand,
          claudeCommand: options.claudeCommand,
          claudeAdapter: options.claudeAdapter,
        });
    const hostStore = new HostStore(paths.database);
    store = hostStore;
    const terminalManager = new TerminalManager(env, hostStore);
    terminals = terminalManager;
    const sessionHub = new SessionHub(hostStore, drivers, log, paths.home, {
      settings: acpSettings,
      createDriver: (agent) => remoteDriver(agent, { env, hostVersion: options.version }),
      loginTerminal: async (_agent, launch) => {
        const terminal = terminalManager.create({ launch, cols: 100, rows: 30 });
        const exited = new Promise<number | null>((resolve) => {
          const stop = terminalManager.onChange((info, closed) => {
            if (info.id === terminal.id && (closed || info.exitCode !== undefined)) { stop(); resolve(info.exitCode ?? null); }
          });
        });
        return { terminalId: terminal.id, exited };
      },
    });
    hub = sessionHub;
    const [hardware] = await Promise.all([readMachineHardware(), sessionHub.start({ discoveryIntervalMs: options.discoveryIntervalMs })]);
    try {
      hostStore.runMaintenance();
    } catch (error) {
      log(`[store] startup maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    maintenanceTimer = setInterval(() => {
      try {
        const idle = !sessionHub.activeWorkDemand().sessionActive;
        if (idle) sessionHub.compactIdleSessions();
        // Always checkpoint WAL (PASSIVE while active) and prune external blobs even during long sessions.
        hostStore.runMaintenance(Date.now(), { idle });
      } catch (error) {
        log(`[store] periodic maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, MAINTENANCE_INTERVAL_MS);
    maintenanceTimer.unref?.();

    const iceServers = options.iceServers ?? iceServersFromEnv(process.env.LINKSHELL_ICE_SERVERS);
    const machineInfo = (): MachineInfo => ({
      machineId,
      hostname: machineName.value,
      naming: machineName.info(),
      platform: platform(),
      ...hardware,
      hostVersion: options.version,
      protocol: HOST_PROTOCOL,
      home: homedir(),
      agents: sessionHub.agents(),
      // LINKSHELL_ICE_SERVERS: STUN servers for the direct channel, comma separated ("off": never direct).
      ...(iceServers ? { direct: { iceServers } } : {}),
    });

    let serverRef: HostRpcServer | undefined;
    const defaultTestAssertion: SpawnAssertion | undefined = process.env.VITEST
      ? () => {
          let alive = true;
          return {
            get alive() {
              return alive;
            },
            release() {
              alive = false;
            },
          };
        }
      : undefined;
    const keepAwakeManager = new KeepAwakeManager({
      home: paths.home,
      signals: () => {
        const work = sessionHub.activeWorkDemand();
        return {
          sessionActive: work.sessionActive,
          goalActive: work.goalActive,
          remoteConnected: serverRef?.hasRemoteClients() ?? false,
          screenActive: serverRef?.hasActiveScreen() ?? false,
        };
      },
      spawnAssertion: options.spawnKeepAwakeAssertion ?? defaultTestAssertion,
      log,
    });
    keepAwake = keepAwakeManager;

    const liveActivityRelay = new LiveActivityRelay({
      path: join(paths.home, "live-activities.json"),
      hub: sessionHub,
      terminals: terminalManager,
      computerName: () => machineInfo().hostname,
      machineId: () => machineId,
      onWakeup: (notice) => serverRef?.broadcast("liveActivities.wakeup", notice),
      serviceUrl: process.env.LINKSHELL_PUSH_SERVICE_URL,
      log,
    });
    liveActivities = liveActivityRelay;
    liveActivityRelay.start();
    const access = new AccessControl(paths.home);
    const rpcServer = new HostRpcServer({
      hub: sessionHub,
      terminals: terminalManager,
      machineInfo,
      renameMachine: (name) => {
        machineName.set(name);
        void gateway?.rename(machineName.value);
        return machineInfo();
      },
      access,
      // The gateway shows a lock on this computer from its next sign-in.
      onAccessChanged: () => gateway?.reauthenticate(),
      usage: new UsageStatistics(
        { codex: env.CODEX_HOME || join(homedir(), ".codex"), claude: env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude") },
        {
          agents: () => sessionHub.agents(),
          events: () => hostStore.usageEvents(),
          remoteStats: (sinceMs, untilMs, agent) => hostStore.remoteStats(sinceMs, untilMs, agent),
        },
      ),
      keepAwake: keepAwakeManager,
      socketPath: paths.hostSocket,
      runDir: paths.runDir,
      shutdown: options.shutdown,
      tcpPort: options.tcpPort,
      log,
      liveActivities: liveActivityRelay,
    });
    server = rpcServer;
    serverRef = rpcServer;
    stopWorkListener = sessionHub.onWorkChange(() => {
      keepAwakeManager.reconcile();
      rpcServer.refreshKeepAwakeMetrics();
    });
    stopDemandListener = rpcServer.onDemandChanged(() => {
      keepAwakeManager.reconcile();
      rpcServer.refreshKeepAwakeMetrics();
    });
    await rpcServer.start();
    keepAwakeManager.start();
    rpcServer.refreshKeepAwakeMetrics();

    const tcpPort = rpcServer.tcpAddress();
    const configuredLanPort = readConfiguredLanPort(paths.home, options.lanPort);
    const mdnsPort = tcpPort !== undefined && !rpcServer.isTcpLoopbackOnly() ? tcpPort : configuredLanPort;
    const shouldAdvertiseMdns =
      mdnsPort !== undefined &&
      options.mdns !== false &&
      process.env.LINKSHELL_MDNS !== "off" &&
      (options.mdns === true || Boolean(options.spawnMdnsProcess) || !process.env.VITEST);
    if (shouldAdvertiseMdns && mdnsPort !== undefined) {
      // Ensure identity.json exists before computing the mDNS fingerprint so first-boot LAN
      // discovery matches the real gateway identity instead of falling back to machineId.
      ensureIdentity(paths.home);
      mdns = new MdnsAdvertiser({
        port: mdnsPort,
        hostPort: mdnsPort,
        machineId,
        machineName: machineName.value,
        fingerprint: hostFingerprint(paths.home, machineId),
        protocolVersion: HOST_PROTOCOL,
        spawnProcess: options.spawnMdnsProcess,
        log,
      });
      mdns.start();
    }

    const chosen = options.gateway;
    /** Follows the gateway choice: connects, moves or disconnects; an unchanged one signs in again. */
    const syncGateway = (): GatewayStatus => {
      const url = typeof chosen?.url === "function" ? chosen.url() : chosen?.url;
      if (gateway && gateway.url === url) {
        gateway.reauthenticate();
        return gateway.status();
      }
      const previous = gateway;
      gateway = url
        ? new GatewayLink({
            url,
            home: paths.home,
            token: chosen?.token,
            name: machineName.value,
            namingConfigured: machineName.info().configured,
            formFactor: hardware.formFactor,
            locked: () => access.enabled,
            serve: (transport) => rpcServer.connect(transport),
            // A link that was replaced has nothing more to say.
            onChange: (status) => {
              if (gateway?.url === url) rpcServer.broadcast("gateway.changed", status);
            },
            onPaired: (device) => rpcServer.broadcast("pairing.done", { device }),
            log,
          })
        : undefined;
      previous?.stop();
      rpcServer.setGateway(gateway);
      gateway?.start();
      const status = gateway?.status() ?? { status: "off" as const, devices: [] };
      if (previous) rpcServer.broadcast("gateway.changed", status);
      return status;
    };
    rpcServer.onGatewayRefresh(syncGateway);
    syncGateway();

    const activeChildren = children;
    let stopping: Promise<void> | undefined;
    return {
      paths,
      hub: sessionHub,
      server: rpcServer,
      get gateway() {
        return gateway;
      },
      machineInfo,
      stop() {
        stopping ??= (async () => {
          if (maintenanceTimer) clearInterval(maintenanceTimer);
          stopWorkListener?.();
          stopDemandListener?.();
          await mdns?.stop();
          keepAwakeManager.stop();
          gateway?.stop();
          liveActivityRelay.stop();
          await rpcServer.stop();
          await sessionHub.stop();
          terminalManager.stop();
          await activeChildren.close(log);
          hostStore.close();
          releaseHostLock();
        })();
        return stopping;
      },
    };
  } catch (error) {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    stopWorkListener?.();
    stopDemandListener?.();
    await mdns?.stop().catch(() => {});
    keepAwake?.stop();
    gateway?.stop();
    liveActivities?.stop();
    await server?.stop().catch(() => {});
    await hub?.stop().catch(() => {});
    terminals?.stop();
    await children?.close(log).catch(() => {});
    store?.close();
    releaseHostLock();
    throw error;
  }
}
