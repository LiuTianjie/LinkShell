import { UsageStatistics } from "./usage.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { GatewayLink } from "./gateway.js";
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
import { createLsaService, type LsaService } from "./lsa/index.js";

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

export function hostPaths(home = defaultHome()): HostPaths {
  let runDir = join(home, "run");
  if (process.platform !== "win32" && Buffer.byteLength(join(runDir, "codex.sock")) > MAX_SOCKET_PATH) {
    // Very long home directories: fall back to a short directory of this user's, one per home.
    const tag = createHash("sha256").update(home).digest("hex").slice(0, 8);
    runDir = join("/tmp", `linkshell-${process.getuid?.() ?? "user"}-${tag}`);
  }
  return {
    home,
    runDir,
    hostSocket: process.platform === "win32" ? windowsPipe(home, "host") : join(runDir, "host.sock"),
    codexSocket: process.platform === "win32" ? windowsPipe(home, "codex") : join(runDir, "codex.sock"),
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
  lsa: LsaService;
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

export async function startHost(options: HostOptions): Promise<RunningHost> {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const paths = hostPaths(options.home);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.runDir, 0o700);
  if (await isHostRunning(paths.hostSocket)) {
    throw new Error(`a LinkShell host is already running (${paths.hostSocket})`);
  }
  // Before any driver starts: an agent an earlier host left can still hold what
  // a new one needs (a session's lock, a socket), besides running on unwatched.
  await reapOrphans(paths.runDir, log);
  const children = openChildRegistry(paths.runDir);

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
  const store = new HostStore(paths.database);
  const terminals = new TerminalManager(env, store);
  const hub = new SessionHub(store, drivers, log, paths.home, {
    settings: acpSettings,
    createDriver: (agent) => remoteDriver(agent, { env, hostVersion: options.version }),
    loginTerminal: async (_agent, launch) => {
      const terminal = terminals.create({ launch, cols: 100, rows: 30 });
      const exited = new Promise<number | null>((resolve) => {
        const stop = terminals.onChange((info, closed) => {
          if (info.id === terminal.id && (closed || info.exitCode !== undefined)) { stop(); resolve(info.exitCode ?? null); }
        });
      });
      return { terminalId: terminal.id, exited };
    },
  });
  await hub.start({ discoveryIntervalMs: options.discoveryIntervalMs });
  try {
    store.runMaintenance();
  } catch (error) {
    log(`[store] startup maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const maintenanceTimer = setInterval(() => {
    try {
      if (hub.activeWorkDemand().sessionActive) return;
      hub.compactIdleSessions();
      store.runMaintenance();
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
    hostVersion: options.version,
    protocol: HOST_PROTOCOL,
    home: homedir(),
    agents: hub.agents(),
    // LINKSHELL_ICE_SERVERS: STUN servers for the direct channel, comma separated ("off": never direct).
    ...(iceServers ? { direct: { iceServers } } : {}),
  });

  let serverRef: HostRpcServer | undefined;
  let lsaRef: LsaService | undefined;
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
  const keepAwake = new KeepAwakeManager({
    home: paths.home,
    signals: () => {
      const work = hub.activeWorkDemand();
      return {
        sessionActive: work.sessionActive,
        goalActive: work.goalActive || (lsaRef ? !lsaRef.isStewardIdle() : false),
        remoteConnected: serverRef?.hasRemoteClients() ?? false,
        screenActive: serverRef?.hasActiveScreen() ?? false,
      };
    },
    spawnAssertion: options.spawnKeepAwakeAssertion ?? defaultTestAssertion,
    log,
  });

  const lsa = createLsaService({
    home: paths.home,
    hub,
    machineId: () => machineId,
    followupPollIntervalMs: 15_000,
    log,
  });
  lsaRef = lsa;

  const liveActivities = new LiveActivityRelay({
    path: join(paths.home, "live-activities.json"),
    hub,
    terminals,
    computerName: () => machineInfo().hostname,
    machineId: () => machineId,
    onWakeup: (notice) => serverRef?.broadcast("liveActivities.wakeup", notice),
    serviceUrl: process.env.LINKSHELL_PUSH_SERVICE_URL,
    log,
  });
  liveActivities.start();
  const access = new AccessControl(paths.home);
  let gateway: GatewayLink | undefined;
  const server = new HostRpcServer({
    hub,
    terminals,
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
        agents: () => hub.agents(),
        events: () => store.usageEvents(),
        remoteStats: (sinceMs, untilMs, agent) => store.remoteStats(sinceMs, untilMs, agent),
      },
    ),
    keepAwake,
    lsa,
    socketPath: paths.hostSocket,
    shutdown: options.shutdown,
    tcpPort: options.tcpPort,
    log,
    liveActivities,
  });
  serverRef = server;
  const stopWorkListener = hub.onWorkChange(() => {
    keepAwake.reconcile();
    server.refreshKeepAwakeMetrics();
  });
  const stopDemandListener = server.onDemandChanged(() => {
    keepAwake.reconcile();
    server.refreshKeepAwakeMetrics();
  });
  await server.start();
  keepAwake.start();
  server.refreshKeepAwakeMetrics();

  let mdns: MdnsAdvertiser | undefined;
  const tcpPort = server.tcpAddress();
  const shouldAdvertiseMdns =
    tcpPort !== undefined &&
    options.mdns !== false &&
    process.env.LINKSHELL_MDNS !== "off" &&
    (options.mdns === true || Boolean(options.spawnMdnsProcess) || !process.env.VITEST);
  if (shouldAdvertiseMdns && tcpPort !== undefined) {
    mdns = new MdnsAdvertiser({
      port: tcpPort,
      machineId,
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
          locked: () => access.enabled,
          serve: (transport) => server.connect(transport),
          // A link that was replaced has nothing more to say.
          onChange: (status) => {
            if (gateway?.url === url) server.broadcast("gateway.changed", status);
          },
          onPaired: (device) => server.broadcast("pairing.done", { device }),
          log,
        })
      : undefined;
    previous?.stop();
    server.setGateway(gateway);
    gateway?.start();
    const status = gateway?.status() ?? { status: "off" as const, devices: [] };
    if (previous) server.broadcast("gateway.changed", status);
    return status;
  };
  server.onGatewayRefresh(syncGateway);
  syncGateway();

  let stopping: Promise<void> | undefined;
  return {
    paths,
    hub,
    server,
    lsa,
    get gateway() {
      return gateway;
    },
    machineInfo,
    stop() {
      stopping ??= (async () => {
        clearInterval(maintenanceTimer);
        stopWorkListener();
        stopDemandListener();
        await mdns?.stop();
        keepAwake.stop();
        gateway?.stop();
        liveActivities.stop();
        await server.stop();
        terminals.stop();
        lsa.close();
        await hub.stop();
        await children.close(log);
        store.close();
      })();
      return stopping;
    },
  };
}
