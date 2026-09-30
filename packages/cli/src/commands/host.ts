import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getValidToken, isLoggedIn } from "../auth.js";
import * as daemon from "../utils/daemon.js";

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

interface HostConfig {
  /** v2 gateway base URL (ws:// or wss://), or "off". Unset: the official gateway once logged in. */
  gateway?: string;
}

/** LinkShell's own gateway: a Pro account's computers are reachable there. */
export const OFFICIAL_GATEWAY = "wss://gateway.itool.tech";

/**
 * Where devices reach this computer from outside the LAN: LINKSHELL_GATEWAY,
 * else the saved choice, else the official gateway when logged in.
 */
export function resolveGateway(home: string): string | undefined {
  const chosen = process.env.LINKSHELL_GATEWAY || readHostConfig(home).gateway;
  if (chosen === "off") return undefined;
  if (chosen) return chosen;
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
  mkdirSync(home, { recursive: true });
  writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** The host keeps its state in node:sqlite, unflagged from Node 22.13. */
export function assertHostRuntime(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) return;
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

/** Runs the host in this process until SIGINT/SIGTERM. */
export async function runHostForeground(version: string): Promise<void> {
  const host = await loadHost();
  const log = (message: string) => process.stderr.write(`${new Date().toISOString()} ${message}\n`);
  process.on("uncaughtException", (error) => log(`[host] uncaught: ${error.stack ?? error.message}`));
  process.on("unhandledRejection", (reason) =>
    log(`[host] unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`),
  );
  // Started from a terminal (by `linkshell`): use that environment as is.
  // Otherwise (launchd, a bare process) recover the login shell's.
  const env = process.env.LINKSHELL_ENV_FROM_TERMINAL === "1" ? process.env : await host.resolveLoginShellEnv();
  const adapter = process.env.LINKSHELL_CLAUDE_ADAPTER;
  const devPort = process.env.LINKSHELL_DEV_PORT ? Number(process.env.LINKSHELL_DEV_PORT) : undefined;
  // Where devices reach this machine from outside the LAN. The account from
  // `linkshell login`, if any, lets that account's devices in without pairing.
  const gatewayUrl = resolveGateway(host.defaultHome());
  const running = await host.startHost({
    version,
    env,
    log,
    gateway: gatewayUrl ? { url: gatewayUrl, token: async () => (await getValidToken()) ?? undefined } : undefined,
    tcpPort: devPort,
    claudeCommand: process.env.LINKSHELL_CLAUDE_COMMAND || undefined,
    claudeAdapter: adapter ? { command: adapter, args: [] } : undefined,
  });
  daemon.savePid("host", process.pid);
  const info = running.machineInfo();
  log(`[host] LinkShell host ${version} listening on ${running.paths.hostSocket}`);
  if (devPort !== undefined) log(`[host] development API on ws://127.0.0.1:${running.server.tcpAddress() ?? devPort} (loopback only)`);
  for (const agent of info.agents) {
    log(
      `[host] ${agent.label}: ${agent.installed ? `v${agent.version ?? "?"}${agent.problem ? ` — ${agent.problem}` : ""}` : "not installed"}`,
    );
  }
  const shutdown = async () => {
    log("[host] shutting down");
    daemon.removePid("host");
    await running.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise(() => {});
}

/** Starts the host in the background unless one already answers. */
export async function ensureHostRunning(): Promise<string> {
  const host = await loadHost();
  const { hostSocket } = host.hostPaths();
  if (await host.isHostRunning(hostSocket)) return hostSocket;
  daemon.spawnDaemon("host", ["host", "--_foreground-host"]);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await host.isHostRunning(hostSocket)) return hostSocket;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`LinkShell host did not start; see ${daemon.getLogFile("host")}`);
}

export async function printHostStatus(): Promise<void> {
  const host = await loadHost();
  const { hostSocket } = host.hostPaths();
  if (!(await host.isHostRunning(hostSocket))) {
    process.stderr.write("  LinkShell host is not running. Start it with: linkshell host --daemon\n");
    process.exitCode = 1;
    return;
  }
  const client = await host.connectHost(hostSocket);
  try {
    const info = await client.call("machine.info", {});
    const { sessions } = await client.call("sessions.list", { limit: 200 });
    process.stdout.write(`  Host ${info.hostVersion} on ${info.hostname} (${hostSocket})\n`);
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
    const active = sessions.filter((s) => s.state === "running" || s.state === "waiting");
    process.stdout.write(`  Sessions: ${sessions.length} known, ${active.length} active\n`);
    const gateway = await client.call("gateway.status", {});
    if (gateway.status === "off") {
      process.stdout.write("  Gateway:  off (linkshell login for the official one, or linkshell host --gateway <url>)\n");
    } else {
      const account = gateway.account ? `, account ${gateway.account.email ?? gateway.account.userId}` : "";
      const problem = gateway.error ? `  ⚠ ${gateway.error.message}` : "";
      process.stdout.write(`  Gateway:  ${gateway.status} ${gateway.url}${account}${problem}\n`);
      for (const device of gateway.devices) {
        process.stdout.write(`    ${device.online ? "●" : "○"} ${device.name}  paired ${new Date(device.pairedAt).toLocaleDateString()}\n`);
      }
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

function runChild(launch: LaunchSpec, onSpawn?: (child: import("node:child_process").ChildProcess) => void): Promise<number> {
  const child = spawn(launch.command, launch.args, {
    stdio: "inherit",
    env: { ...process.env, ...launch.env },
  });
  onSpawn?.(child);
  // The terminal delivers Ctrl-C to the whole foreground group; the agent handles it.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.on("SIGQUIT", ignore);
  return new Promise<number>((resolve) => {
    const done = (code: number) => {
      process.off("SIGINT", ignore);
      process.off("SIGQUIT", ignore);
      resolve(code);
    };
    child.once("exit", (exitCode, signal) => done(exitCode ?? (signal ? 128 + 15 : 1)));
    child.once("error", (error) => {
      process.stderr.write(`linkshell: could not start ${launch.command}: ${error.message}\n`);
      done(127);
    });
  });
}

/** Undo what a killed full-screen TUI may have left on: alt screen, hidden cursor, mouse/paste modes. */
function restoreTerminal(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[0m\r\n");
}

/** Resolves with the first key pressed; "\u0003" for Ctrl-C. */
function waitForKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const raw = stdin.isTTY;
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", (data) => {
      if (raw) stdin.setRawMode(false);
      stdin.pause();
      resolve(data.toString("utf8"));
    });
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
    process.exit(await runChild(launch));
  }

  const sessionId = launch.sessionId;
  let child: import("node:child_process").ChildProcess | undefined;
  let yielded = false;
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
    const code = await runChild(launch, (spawned) => (child = spawned));
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
