import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MachineInfo } from "@linkshell/wire";
import { defaultDrivers } from "./drivers/registry.js";
import type { AgentDriver } from "./drivers/types.js";
import { SessionHub } from "./hub.js";
import { connectHost } from "./rpc/client.js";
import { HostRpcServer } from "./rpc/server.js";
import { GatewayLink } from "./gateway.js";
import { HostStore } from "./store.js";
import { TerminalManager } from "./terminals.js";

/** macOS sun_path is 104 bytes including the terminator. */
const MAX_SOCKET_PATH = 100;

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
  if (join(runDir, "codex.sock").length > MAX_SOCKET_PATH) {
    // Very long home directories: fall back to a short per-user directory.
    runDir = join("/tmp", `linkshell-${process.getuid?.() ?? "user"}`);
  }
  return {
    home,
    runDir,
    hostSocket: join(runDir, "host.sock"),
    codexSocket: join(runDir, "codex.sock"),
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
  codexCommand?: string;
  claudeCommand?: string;
  /** Overrides the bundled Claude ACP adapter. */
  claudeAdapter?: { command: string; args: string[] };
  /** Extra drivers (tests) or a full replacement of the default set. */
  drivers?: (paths: HostPaths) => AgentDriver[];
  tcpPort?: number;
  log?: (message: string) => void;
  /** A v2 gateway to reach this machine through, from anywhere. */
  gateway?: { url: string; token?: () => Promise<string | undefined> | string | undefined; name?: string };
  /** How often to re-list sessions started outside LinkShell; 0 disables. */
  discoveryIntervalMs?: number;
}

export interface RunningHost {
  paths: HostPaths;
  hub: SessionHub;
  server: HostRpcServer;
  gateway?: GatewayLink;
  machineInfo(): MachineInfo;
  stop(): Promise<void>;
}

/** True when another host already answers on the socket. */
export async function isHostRunning(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  try {
    const client = await connectHost(socketPath);
    client.close();
    return true;
  } catch {
    return false;
  }
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

  const machineId = loadMachineId(paths.home);
  const drivers = options.drivers
    ? options.drivers(paths)
    : defaultDrivers({
        env: options.env,
        hostVersion: options.version,
        codexSocket: paths.codexSocket,
        codexCommand: options.codexCommand,
        claudeCommand: options.claudeCommand,
        claudeAdapter: options.claudeAdapter,
      });
  const store = new HostStore(paths.database);
  const hub = new SessionHub(store, drivers, log);
  await hub.start({ discoveryIntervalMs: options.discoveryIntervalMs });

  const machineInfo = (): MachineInfo => ({
    machineId,
    // LINKSHELL_MACHINE_NAME: how this computer is named in the apps (default: its hostname).
    hostname: process.env.LINKSHELL_MACHINE_NAME || hostname(),
    platform: platform(),
    hostVersion: options.version,
    agents: hub.agents(),
  });
  const terminals = new TerminalManager(options.env, store);
  const server = new HostRpcServer({
    hub,
    terminals,
    machineInfo,
    socketPath: paths.hostSocket,
    tcpPort: options.tcpPort,
    log,
  });
  await server.start();

  let gateway: GatewayLink | undefined;
  if (options.gateway) {
    gateway = new GatewayLink({
      url: options.gateway.url,
      home: paths.home,
      token: options.gateway.token,
      name: options.gateway.name,
      serve: (transport) => server.connect(transport),
      onChange: (status) => server.broadcast("gateway.changed", status),
      onPaired: (device) => server.broadcast("pairing.done", { device }),
      log,
    });
    server.setGateway(gateway);
    gateway.start();
  }

  let stopping: Promise<void> | undefined;
  return {
    paths,
    hub,
    server,
    gateway,
    machineInfo,
    stop() {
      stopping ??= (async () => {
        gateway?.stop();
        await server.stop();
        terminals.stop();
        await hub.stop();
        store.close();
      })();
      return stopping;
    },
  };
}
