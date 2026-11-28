import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { constants as osConstants, networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  RELAY_PATH,
  type GatewayStatus,
  type KeepAwakeMode,
  type MachineKeepAwake,
  type MachinePower,
} from "@linkshell/wire";
import { getCachedToken, isLoggedIn, loadAuth } from "../auth.js";
import * as daemon from "../utils/daemon.js";
import { stderrStyle, stdoutStyle, type TtyReadable } from "../utils/format.js";

// node:sqlite prints an ExperimentalWarning on load; it is expected here and
// only confuses users. Must run before the host (and node:sqlite) is imported.
export function silenceSqliteWarning(): void {
  const emit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.includes("SQLite")) return;
    return (emit as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

export interface HostConfig {
  /** v2 gateway base URL (ws:// or wss://), or "off". Unset: the official gateway once logged in. */
  gateway?: string;
  /** Set once `linkshell setup` has run here (by itself on the first start, or by hand). */
  setup?: "done";
  /** Idle sleep prevention mode ("smart" default, "always", or "off"). */
  keepAwake?: KeepAwakeMode;
  /** Same-Wi-Fi LAN gateway port configured via `linkshell host --lan`. */
  lanPort?: number;
  [key: string]: unknown;
}

export function parseKeepAwakeOption(raw: string): KeepAwakeMode {
  const mode = raw.trim().toLowerCase();
  if (mode === "smart" || mode === "always" || mode === "off") return mode;
  throw new Error(`Invalid --keep-awake mode "${raw}". Expected smart, always, or off.`);
}

export function parseLanOption(raw: boolean | string): "off" | number {
  if (raw === true) return 8787;
  const trimmed = String(raw).trim().toLowerCase();
  if (trimmed === "off" || trimmed === "false") return "off";
  const port = Number(trimmed);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  throw new Error(`Invalid --lan value "${raw}". Pass a port (e.g. 8787), omit for 8787, or pass "off".`);
}

// Exclude loopback, VPN/mesh tunnels, and container/VM virtual bridges so LAN detection picks the real NIC.
const VIRTUAL_INTERFACE_RE = /^(lo|utun|tun|tap|docker|br-|veth|virbr|podman|cni|flannel|wg|zt|lxc|lxd|incus|vmnet|tailscale|cali|weave|kube)/i;

export function findLanIpv4(interfaces = networkInterfaces()): string | undefined {
  const isPrivateRfc1918 = (ip: string) =>
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  let fallback: string | undefined;
  let virtualFallback: string | undefined;
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    const isVirtual = VIRTUAL_INTERFACE_RE.test(name);
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (!isVirtual && isPrivateRfc1918(addr.address)) return addr.address;
      if (!isVirtual) fallback ??= addr.address;
      else virtualFallback ??= addr.address;
    }
  }
  return fallback ?? virtualFallback;
}

export function configureLanGateway(
  home: string,
  option: "off" | number,
): { gatewayUrl?: string; startedLocalGateway: boolean; port?: number } {
  const current = readHostConfig(home);
  if (option === "off") {
    const next: HostConfig = { ...current };
    if (next.lanPort !== undefined && next.gateway?.startsWith("ws://") && next.gateway.endsWith(`:${next.lanPort}`)) {
      delete next.gateway;
    }
    delete next.lanPort;
    writeHostConfig(home, next);
    delete process.env.LINKSHELL_LAN_PORT;
    return { startedLocalGateway: false };
  }
  const lanIp = findLanIpv4() ?? "127.0.0.1";
  const gatewayUrl = `ws://${lanIp}:${option}`;
  let startedLocalGateway = false;
  if (!daemon.readPid("gateway")) {
    daemon.spawnDaemon("gateway", ["gateway", "--_foreground-gw", "--port", String(option)]);
    startedLocalGateway = true;
  }
  writeHostConfig(home, { ...current, gateway: gatewayUrl, lanPort: option });
  process.env.LINKSHELL_LAN_PORT = String(option);
  return { gatewayUrl, startedLocalGateway, port: option };
}

export function describePowerAndKeepAwake(
  metrics: { power?: MachinePower; keepAwake?: MachineKeepAwake } | undefined,
): string | undefined {
  if (!metrics?.keepAwake && !metrics?.power) return undefined;
  const parts: string[] = [];
  if (metrics.keepAwake) {
    const { mode, active, reason } = metrics.keepAwake;
    if (mode === "off") {
      parts.push("keep-awake off");
    } else if (active) {
      parts.push(`keep-awake ${mode} (active${reason && reason !== mode ? `: ${reason.replace(/_/g, " ")}` : ""})`);
    } else {
      parts.push(`keep-awake ${mode} (idle)`);
    }
  }
  if (metrics.power) {
    const { onBattery, percent, charging } = metrics.power;
    const pct = typeof percent === "number" ? ` ${Math.round(percent)}%` : "";
    if (onBattery) {
      parts.push(`battery${pct}${charging ? " (charging)" : ""}`);
    } else {
      parts.push(`AC power${pct}`);
    }
  }
  return parts.join(" · ");
}

/** LinkShell's own gateway: an iTool member's computers are reachable there. */
export const OFFICIAL_GATEWAY = "wss://gateway.itool.tech";

/** Whether two gateway addresses name the same one, however they were typed (scheme, trailing slash). */
export function sameGateway(a: string | undefined, b: string): boolean {
  const key = (address: string) => {
    try {
      const url = new URL(address.trim().replace(/^http/i, "ws"));
      if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;
      let path = url.pathname.replace(/\/+$/, "");
      if (path.endsWith(RELAY_PATH)) path = path.slice(0, -RELAY_PATH.length);
      return `${url.origin}${path}`;
    } catch {
      return undefined;
    }
  };
  const value = a === undefined ? undefined : key(a);
  return value !== undefined && value === key(b);
}

/**
 * Where devices reach this computer from outside the LAN: LINKSHELL_GATEWAY,
 * else the saved choice, else the official gateway when logged in.
 */
export function resolveGateway(home: string): string | undefined {
  const chosen = process.env.LINKSHELL_GATEWAY || readHostConfig(home).gateway;
  if (chosen === "off") return undefined;
  // A config.json written by 1.x holds a gateway URL ending in /ws.
  if (chosen) {
    const url = chosen.replace(/\/ws\/?$/, "");
    // An explicit official URL must not keep a logged-out computer on its old account.
    return sameGateway(url, OFFICIAL_GATEWAY) && !isLoggedIn() ? undefined : url;
  }
  return isLoggedIn() ? OFFICIAL_GATEWAY : undefined;
}

function configPath(home: string): string {
  return join(home, "config.json");
}

export function readHostConfig(home: string): HostConfig {
  try {
    return JSON.parse(readFileSync(configPath(home), "utf8")) as HostConfig;
  } catch {
    return {};
  }
}

export function writeHostConfig(home: string, config: HostConfig): void {
  daemon.ensurePrivateDir(home);
  const target = configPath(home);
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    try { chmodSync(target, 0o600); } catch {}
  }
}

/** The host keeps its state in node:sqlite, unflagged from Node 22.13. */
export function hostRuntimeOk(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

export function assertHostRuntime(): void {
  if (hostRuntimeOk()) return;
  process.stderr.write(
    `\n  LinkShell's host needs Node.js 22.13 or newer (this is ${process.version}).\n` +
      "  Upgrade Node (for example: nvm install 22, or brew upgrade node), then try again.\n\n",
  );
  process.exit(1);
}

async function loadHost() {
  assertHostRuntime();
  silenceSqliteWarning();
  return import("@linkshell/host");
}

/** Runs the host in this process until SIGINT/SIGTERM/SIGHUP. */
export async function runHostForeground(version: string): Promise<void> {
  const host = await loadHost();
  const log = (message: string) => process.stderr.write(`${new Date().toISOString()} ${message}\n`);
  process.on("uncaughtException", (error) => log(`[host] uncaught: ${error.stack ?? error.message}`));
  process.on("unhandledRejection", (reason) =>
    log(`[host] unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`),
  );
  // Started from a terminal (by `linkshell`): use that environment as is.
  // Otherwise (launchd, systemd, a bare process) recover the login shell's.
  const env = process.env.LINKSHELL_ENV_FROM_TERMINAL === "1" ? process.env : await host.resolveLoginShellEnv(undefined, log);
  const adapter = process.env.LINKSHELL_CLAUDE_ADAPTER;
  const devPort = process.env.LINKSHELL_DEV_PORT ? Number(process.env.LINKSHELL_DEV_PORT) : undefined;
  const home = host.defaultHome();
  daemon.ensurePrivateDir(home);
  const stopLogRotation = daemon.startPeriodicLogRotation(daemon.getLogFile("host"));

  let shutdownRequested = false;
  let earlyShutdown = false;
  let requestShutdown: (() => void) | undefined;
  const running = await host.startHost({
    version,
    env,
    log,
    shutdown: () => { if (requestShutdown) requestShutdown(); else earlyShutdown = true; },
    gateway: {
      url: () => resolveGateway(home),
      // The account is LinkShell's, so its token goes to LinkShell's gateway and to no other: a
      // gateway of one's own has no accounts, and would refuse a computer that offered one.
      // Never blocks: the cached token (even expired) goes out at once so a slow Supabase can't
      // stall the gateway handshake; a background refresh keeps it fresh for the next connection.
      token: async () => (sameGateway(resolveGateway(home), OFFICIAL_GATEWAY) ? (getCachedToken() ?? undefined) : undefined),
    },
    tcpPort: devPort,
    claudeCommand: process.env.LINKSHELL_CLAUDE_COMMAND || undefined,
    claudeAdapter: adapter ? { command: adapter, args: [] } : undefined,
  });
  daemon.savePid("host", process.pid);
  daemon.saveHostLaunch(process.pid, running.server.tcpAddress());
  const info = running.machineInfo();
  log(`[host] LinkShell host ${version} listening on ${running.paths.hostSocket}`);
  if (devPort !== undefined) log(`[host] development API on ws://127.0.0.1:${running.server.tcpAddress() ?? devPort} (loopback only)`);
  for (const agent of info.agents) {
    log(
      `[host] ${agent.label}: ${agent.installed ? `v${agent.version ?? "?"}${agent.problem ? ` — ${agent.problem}` : ""}` : "not installed"}`,
    );
  }
  const shutdown = async () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    stopLogRotation();
    log("[host] shutting down");
    const hardDeadline = setTimeout(() => {
      log("[host] shutdown timed out after 10s; forcing exit");
      daemon.removePid("host");
      process.exit(1);
    }, 10_000);
    hardDeadline.unref();
    try {
      await running.stop();
    } finally {
      clearTimeout(hardDeadline);
      daemon.removePid("host");
    }
    process.exit(0);
  };
  requestShutdown = () => void shutdown();
  if (earlyShutdown) requestShutdown();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());
  await new Promise(() => {});
}

/** Starts the host in the background unless one already answers. */
export async function ensureHostRunning(env?: NodeJS.ProcessEnv): Promise<string> {
  const host = await loadHost();
  const { hostSocket } = host.hostPaths();
  if (await host.isHostRunning(hostSocket)) return hostSocket;
  daemon.spawnDaemon("host", ["host", "--_foreground-host"], env);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await host.isHostRunning(hostSocket)) return hostSocket;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`LinkShell host did not start; see ${daemon.getLogFile("host")}`);
}

/** Stops the host cleanly via its OS service manager (systemd/launchd) if supervised, else via daemon PID. */
export async function stopHost(): Promise<{ stopped: boolean; managed: boolean }> {
  try {
    const { stopManagedHostService } = await import("./service.js");
    const outcome = await stopManagedHostService({ linkshellHome: daemon.linkshellDir() });
    if (outcome === "stopped") {
      // Wait briefly for the process to exit and clean up any leftover PID file.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (!daemon.readPid("host")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!daemon.readPid("host")) daemon.removePid("host");
      return { stopped: true, managed: true };
    }
  } catch {
    // Fall back to direct PID signaling if the service manager query failed.
  }
  const stopped = await daemon.stopDaemonAndWait("host");
  return { stopped, managed: false };
}

/** Restarts the host cleanly (service-aware on systemd/launchd; preserves host-launch.json env for daemon mode). */
export async function restartHost(): Promise<{ managed: boolean; socket: string }> {
  const host = await loadHost();
  const { hostSocket } = host.hostPaths();
  try {
    const { restartManagedHostService } = await import("./service.js");
    const outcome = await restartManagedHostService({ linkshellHome: daemon.linkshellDir() });
    if (outcome === "restarted") {
      return { managed: true, socket: hostSocket };
    }
  } catch (error) {
    // If the managed service existed and explicitly failed to restart, surface that failure.
    if (error instanceof Error && /restarted|systemctl|launchctl|schtasks/i.test(error.message)) {
      throw error;
    }
  }

  const pid = daemon.readPid("host");
  const savedEnv = pid ? daemon.readHostLaunch(pid) : {};
  const env = { ...process.env, ...savedEnv };
  if (pid) {
    await daemon.stopDaemonAndWait("host", 30_000, pid);
  }
  const socket = await ensureHostRunning(env);
  return { managed: false, socket };
}

type HostClient = Awaited<ReturnType<Awaited<ReturnType<typeof loadHost>>["connectHost"]>>;

/** Runs `use` against the running host; undefined when there is none. */
export async function withRunningHost<T>(use: (client: HostClient) => Promise<T>): Promise<T | undefined> {
  if (!hostRuntimeOk()) return undefined;
  const host = await loadHost();
  const { hostSocket } = host.hostPaths();
  if (!(await host.isHostRunning(hostSocket))) return undefined;
  const client = await host.connectHost(hostSocket);
  try {
    return await use(client);
  } finally {
    client.close();
  }
}

/**
 * Has the running host apply the current gateway choice and account, then
 * waits (up to `waitMs`) for it to come online or be refused.
 */
export async function refreshGateway(waitMs: number): Promise<GatewayStatus | undefined> {
  return withRunningHost(async (client) => {
    let status: GatewayStatus;
    try {
      status = await client.call("gateway.refresh", {});
    } catch {
      // A host from before 0.6.3 (still running after an upgrade) only reads its gateway at start.
      process.stderr.write("  The running host is older than this CLI. Restart it to apply this (stops running agent turns):\n");
      process.stderr.write("    linkshell host restart\n");
      return client.call("gateway.status", {});
    }
    const deadline = Date.now() + waitMs;
    while (status.status === "connecting" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      status = await client.call("gateway.status", {});
    }
    return status;
  });
}

export function describeGateway(gateway: GatewayStatus): string {
  if (gateway.status === "off") {
    return "off (linkshell login for official gateway, linkshell host --lan, or linkshell host --gateway <url>)";
  }
  const label = gateway.account ? (gateway.account.email ?? loadAuth()?.email ?? gateway.account.userId) : undefined;
  const account = label ? `, account ${label}` : "";
  const problem = gateway.error ? `  ⚠ ${gateway.error.message}` : "";
  return `${gateway.status} ${gateway.url}${account}${problem}`;
}

/**
 * A signed-in member's computer belongs on the official gateway: nobody should have to find
 * a button for it before their phone can see this computer. A gateway of one's own (a URL) is kept;
 * "off" is not. A stopped host is left stopped. True when the host was asked to reconnect.
 */
export async function followAccountGateway(plan: "pro" | "free" | "unknown"): Promise<boolean> {
  if (plan !== "pro" || process.env.LINKSHELL_GATEWAY || !loadAuth()?.userId || !hostRuntimeOk()) return false;
  const home = daemon.linkshellDir();
  const config = readHostConfig(home);
  if (config.gateway && config.gateway !== "off") return false;
  const turnedOff = config.gateway === "off";
  if (turnedOff) {
    delete config.gateway;
    writeHostConfig(home, config);
  }
  const status = await withRunningHost((client) => client.call("gateway.status", {}, 5000)).catch(() => undefined);
  if (!status) return false;
  if (!turnedOff && status.status !== "off" && sameGateway(status.url, OFFICIAL_GATEWAY)) return false;
  await refreshGateway(15_000);
  return true;
}

export async function joinGatewayAfterLogin(plan: "pro" | "free"): Promise<void> {
  const style = stderrStyle();
  const out = (line: string) => process.stderr.write(`  ${line}\n`);
  if (!hostRuntimeOk()) {
    out(`The LinkShell host needs Node.js 22.13 or newer (this is ${process.version}); upgrade Node, then: linkshell host --daemon\n`);
    return;
  }
  const host = await loadHost();
  const chosen = process.env.LINKSHELL_GATEWAY || readHostConfig(host.defaultHome()).gateway;
  if (chosen === "off") {
    out("The gateway is turned off on this computer. To use the official one: linkshell host --gateway default\n");
    return;
  }
  if (!chosen && plan !== "pro") {
    // A running host now gets the gateway's own answer, instead of an old login's.
    await refreshGateway(0);
    out("The official gateway requires an active iTool membership: https://www.itool.tech/pro?from=linkshell");
    out("Invite a friend to earn +14 / +30 days, use same-Wi-Fi LAN (linkshell host --lan), or self-host (linkshell host --gateway <url> && linkshell pair).\n");
    return;
  }
  await ensureHostRunning();
  const gateway = await refreshGateway(15_000);
  const where = chosen ? (gateway?.url ?? chosen) : "the official gateway";
  if (gateway?.status === "online") {
    out(`${style.green("✓")} This computer is online on ${where}.`);
    out(
      gateway.account
        ? "  Open LinkShell on your phone and sign in with the same account: it shows up there, no pairing needed.\n"
        : "  Pair your phone with: linkshell pair\n",
    );
  } else {
    out(`${style.red("✗")} Not connected to ${where}${gateway?.error ? `: ${gateway.error.message}` : " yet"}`);
    out("  Check again with: linkshell host status\n");
  }
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export async function printHostStatus(options: {
  json?: boolean;
  cliVersion?: string;
  includeGatewayServer?: boolean;
} = {}): Promise<void> {
  const host = await loadHost();
  const { hostSocket } = host.hostPaths();
  const logFile = daemon.getLogFile("host");
  const lanIp = findLanIpv4();
  const serviceStatus = await import("./service.js")
    .then(({ getServiceStatus }) => getServiceStatus({ linkshellHome: daemon.linkshellDir() }))
    .catch(() => undefined);

  const gatewayPid = options.includeGatewayServer ? daemon.readPid("gateway") : null;
  const gatewayServer = options.includeGatewayServer
    ? { running: Boolean(gatewayPid), pid: gatewayPid ?? undefined, logFile: daemon.getLogFile("gateway") }
    : undefined;

  if (!(await host.isHostRunning(hostSocket))) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            running: false,
            cliVersion: options.cliVersion,
            hostSocket,
            logFile,
            lanIp,
            service: serviceStatus,
            ...(gatewayServer ? { gatewayServer } : {}),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stderr.write("  LinkShell host is not running. Start it with: linkshell host --daemon\n");
    }
    process.exitCode = 1;
    return;
  }

  const client = await host.connectHost(hostSocket);
  try {
    const style = stdoutStyle();
    const info = await client.call("machine.info", {});
    const { sessions } = await client.call("sessions.list", { limit: 200 });
    const terminalsRes = await client.call("terminals.list", {}, 3000).catch(() => undefined);
    const terminalsCount = terminalsRes?.terminals?.length;
    const gateway = await client.call("gateway.status", {});
    const metrics = await client.call("machine.metrics", {}, 5000).catch(() => undefined);
    const powerLine = describePowerAndKeepAwake(metrics);
    const { describeScreen } = await import("./screen.js");
    const rawScreen = await client
      .call("screen.access", {}, 20_000)
      .catch((error: Error) => (/method not found|unknown method/i.test(error.message) ? ("old" as const) : undefined));
    const screenLine = describeScreen(rawScreen);
    const pid = daemon.readPid("host") ?? serviceStatus?.pid ?? undefined;
    const uptimeSeconds = daemon.readDaemonUptimeSeconds("host", pid);
    const versionMismatch = Boolean(options.cliVersion && info.hostVersion !== options.cliVersion);
    const active = sessions.filter((s) => s.state === "running" || s.state === "waiting");

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            running: true,
            cliVersion: options.cliVersion,
            hostVersion: info.hostVersion,
            versionMismatch,
            hostname: info.hostname,
            hostSocket,
            pid,
            uptimeSeconds,
            lanIp,
            logFile,
            service: serviceStatus,
            agents: info.agents,
            sessions: { total: sessions.length, active: active.length },
            ...(terminalsCount !== undefined ? { terminals: terminalsCount } : {}),
            gateway,
            power: metrics?.power,
            keepAwake: metrics?.keepAwake,
            screen: screenLine,
            ...(gatewayServer ? { gatewayServer } : {}),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const metaParts = [
      pid !== undefined ? `PID ${pid}` : undefined,
      uptimeSeconds !== undefined ? `up ${formatDuration(uptimeSeconds)}` : undefined,
    ].filter(Boolean);
    process.stdout.write(
      `  Host ${info.hostVersion} on ${info.hostname}${metaParts.length ? ` (${metaParts.join(", ")})` : ""}\n`,
    );
    process.stdout.write(`  Socket:   ${hostSocket}\n`);
    if (versionMismatch) {
      process.stdout.write(
        `  ${style.yellow("⚠")} Version mismatch: host is ${info.hostVersion}, CLI is ${options.cliVersion} — run: linkshell host restart\n`,
      );
    }
    if (serviceStatus) {
      const manager =
        serviceStatus.platform === "linux"
          ? "systemd --user"
          : serviceStatus.platform === "darwin"
            ? "launchd"
            : "Task Scheduler";
      if (serviceStatus.installed) {
        const lingerBadge =
          serviceStatus.platform === "linux" && serviceStatus.linger !== undefined
            ? `, linger ${serviceStatus.linger ? style.green("on") : style.yellow("off")}`
            : "";
        process.stdout.write(`  Service:  ${manager} (${serviceStatus.state}${lingerBadge})\n`);
      } else {
        process.stdout.write(`  Service:  background daemon (${style.dim("not installed as OS service")})\n`);
      }
    }
    for (const agent of info.agents) {
      const state = agent.installed ? `v${agent.version ?? "?"}${agent.problem ? `  ⚠ ${agent.problem}` : ""}` : "not installed";
      const auth =
        agent.auth?.state === "ok"
          ? `  login: ${agent.auth.method ?? "ok"}`
          : agent.auth?.state === "missing"
            ? `  ⚠ ${agent.auth.hint ?? "not logged in"}`
            : "";
      process.stdout.write(`  ${agent.label.padEnd(10)} ${agent.tier.padEnd(13)} ${state}${auth}\n`);
    }
    process.stdout.write(
      `  Sessions: ${sessions.length} known, ${active.length} active${terminalsCount !== undefined ? ` · Terminals: ${terminalsCount}` : ""}\n`,
    );
    process.stdout.write(`  Gateway:  ${describeGateway(gateway)}\n`);
    for (const device of gateway.devices) {
      process.stdout.write(`    ${device.online ? style.green("●") : style.dim("○")} ${device.name}  paired ${new Date(device.pairedAt).toLocaleDateString()}\n`);
    }
    if (lanIp) process.stdout.write(`  LAN IP:   ${lanIp}\n`);
    if (powerLine) process.stdout.write(`  Power:    ${powerLine}\n`);
    if (screenLine) process.stdout.write(`  Screen:   ${screenLine}\n`);
    process.stdout.write(`  Log:      ${logFile}\n`);
    if (gatewayServer?.running) {
      process.stdout.write(`  Gateway server: running (PID ${gatewayServer.pid}), log ${gatewayServer.logFile}\n`);
    }
  } finally {
    client.close();
  }
}

interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Computes the exact POSIX shell exit code (128 + signal number) for a signal-terminated child. */
export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const num = (osConstants.signals as Record<string, number | undefined>)[signal];
  return 128 + (typeof num === "number" ? num : 15);
}

function runChild(
  launch: LaunchSpec,
  baseEnv: NodeJS.ProcessEnv,
  onSpawn?: (child: ChildProcess) => void,
): Promise<number> {
  const child = spawn(launch.command, launch.args, {
    stdio: "inherit",
    env: { ...baseEnv, ...launch.env },
  });
  onSpawn?.(child);
  // The terminal delivers Ctrl-C to the whole foreground group; the agent handles it.
  const ignore = () => {};
  const forwardTerm = () => {
    try { child.kill("SIGTERM"); } catch {}
  };
  const forwardHup = () => {
    try { child.kill("SIGHUP"); } catch {}
  };
  process.on("SIGINT", ignore);
  process.on("SIGQUIT", ignore);
  process.on("SIGTERM", forwardTerm);
  process.on("SIGHUP", forwardHup);
  return new Promise<number>((resolve) => {
    const done = (code: number) => {
      process.off("SIGINT", ignore);
      process.off("SIGQUIT", ignore);
      process.off("SIGTERM", forwardTerm);
      process.off("SIGHUP", forwardHup);
      resolve(code);
    };
    child.once("exit", (exitCode, signal) => done(exitCode ?? signalExitCode(signal)));
    child.once("error", (error) => {
      process.stderr.write(`linkshell: could not start ${launch.command}: ${error.message}\n`);
      done(127);
    });
  });
}

/** Undo what a killed full-screen TUI may have left on: alt screen, cursor, paste, mouse, focus reporting, Kitty keyboard protocol. */
export function restoreTerminal(stdout: { isTTY?: boolean; write: (chunk: string) => unknown } = process.stdout): void {
  if (!stdout.isTTY) return;
  stdout.write("\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[<u\x1b[0m\r\n");
}

/** True when a stdin chunk contains only terminal focus-in (`\x1b[I`) / focus-out (`\x1b[O`) reports. */
export function isTerminalFocusSequence(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return text.length > 0 && /^(?:\x1b\[[IO])+$/.test(text);
}

/**
 * Resolves with the first real key pressed; ignores terminal focus-in/out sequences so switching
 * tmux panes never accidentally reclaims a phone session, and resolves cleanly on EOF / SIGTERM / SIGHUP.
 */
export function waitForKey(stdin: TtyReadable = process.stdin as TtyReadable): Promise<string> {
  return new Promise((resolve) => {
    const raw = stdin.isTTY === true;
    let settled = false;
    if (raw) {
      try { stdin.setRawMode?.(true); } catch {}
    }
    stdin.resume();

    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.off("end", onEof);
      stdin.off("close", onEof);
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onHup);
      if (raw) {
        try { stdin.setRawMode?.(false); } catch {}
      }
      stdin.pause();
      resolve(value);
    };

    const onData = (data: Buffer | string) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (isTerminalFocusSequence(text)) return;
      finish(text);
    };
    const onEof = () => finish("\u0003");
    const onTerm = () => finish("\u0003");
    const onHup = () => finish("\u0003");

    stdin.on("data", onData);
    stdin.once("end", onEof);
    stdin.once("close", onEof);
    process.once("SIGTERM", onTerm);
    process.once("SIGHUP", onHup);
  });
}

/**
 * `linkshell <agent> [args…]`: starts the agent's native UI attached to the
 * host, so the same session is live on the desktop and on every paired device.
 *
 * For handoff agents (Claude) the terminal stays the session's desktop seat:
 * when a device takes over, the TUI exits and the terminal shows the remote
 * progress; any key brings the session back to the TUI.
 */
export async function runAgentShim(agent: string, args: string[]): Promise<void> {
  const host = await loadHost();
  const socket = await ensureHostRunning();
  const client = await host.connectHost(socket);
  // Run from inside a Claude Code session, the agent must not become its child.
  const env = host.withoutClaudeSession(process.env);
  let launch: LaunchSpec & { sessionId?: string };
  try {
    launch = await client.call("desktop.launch", { agent, args, cwd: process.cwd() });
  } catch (error) {
    client.close();
    process.stderr.write(`linkshell: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  if (!launch.sessionId) {
    // Multi-client agents (Codex): the TUI simply joins the shared server.
    client.close();
    process.exit(await runChild(launch, env));
  }

  const sessionId = launch.sessionId;
  let child: ChildProcess | undefined;
  let yielded: boolean;
  let showingRemote = false;
  client.on("desktop.yield", ({ sessionId: target }) => {
    if (target !== sessionId) return;
    yielded = true;
    child?.kill("SIGTERM");
  });
  client.on("desktop.remoteActivity", ({ sessionId: target, line }) => {
    if (target === sessionId && showingRemote) process.stdout.write(`${line}\n`);
  });

  for (;;) {
    yielded = false;
    const code = await runChild(launch, env, (spawned) => (child = spawned));
    if (!yielded) {
      // The user quit the TUI: the session stays available on every device.
      client.close();
      process.exit(code);
    }
    await client.call("desktop.yielded", { sessionId }).catch(() => {});
    restoreTerminal();
    process.stdout.write(
      [
        "─".repeat(48),
        "📱 已由手机接管，会话在手机上继续",
        "   按任意键收回到电脑 · Ctrl-C 退出（会话留在手机上）",
        "─".repeat(48),
        "",
      ].join("\n"),
    );
    showingRemote = true;
    const key = await waitForKey();
    showingRemote = false;
    if (key === "\u0003") {
      client.close();
      process.exit(0);
    }
    process.stdout.write("↩︎ 正在收回到电脑…\n");
    try {
      const spec = await client.call("desktop.reclaim", { sessionId });
      launch = { ...spec, sessionId };
    } catch (error) {
      process.stderr.write(`linkshell: 收回失败：${error instanceof Error ? error.message : String(error)}\n`);
      client.close();
      process.exit(1);
    }
  }
}
