import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as daemon from "../utils/daemon.js";
import { stderrStyle, stdoutStyle } from "../utils/format.js";
import { assertHostRuntime, formatDuration, silenceSqliteWarning } from "./host.js";

export interface GatewayHealthz {
  ok: boolean;
  version?: string;
  relay?: number;
  memoryMb?: number;
}

function probeAddress(host: string | undefined, port: number): string {
  const h = host && host !== "0.0.0.0" && host !== "::" ? host : "127.0.0.1";
  return `http://${h.includes(":") ? `[${h}]` : h}:${port}/healthz`;
}

export async function probeGatewayHealthz(port: number, host?: string, timeoutMs = 2_000): Promise<GatewayHealthz | undefined> {
  try {
    const res = await fetch(probeAddress(host, port), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Partial<GatewayHealthz>;
    return {
      ok: body.ok === true,
      version: typeof body.version === "string" ? body.version : undefined,
      relay: typeof body.relay === "number" ? body.relay : undefined,
      memoryMb: typeof body.memoryMb === "number" ? body.memoryMb : undefined,
    };
  } catch {
    return undefined;
  }
}

function tailLogLines(path: string, lines = 8): string[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trimEnd()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-lines);
  } catch {
    return [];
  }
}

/** Runs a gateway in this process until SIGINT/SIGTERM/SIGHUP. */
export async function runGatewayForeground(version: string, port: number, host?: string): Promise<void> {
  // The relay keeps its pairings in node:sqlite, like the host.
  assertHostRuntime();
  silenceSqliteWarning();
  const { startGateway } = await import("@linkshell/gateway");
  const home = daemon.linkshellDir();
  daemon.ensurePrivateDir(home);
  const stopLogRotation = daemon.startPeriodicLogRotation(daemon.getLogFile("gateway"));

  // Pairings live here; keeping this file keeps phones paired.
  const databasePath = join(home, "relay.db");
  const gateway = await startGateway({
    port,
    host,
    databasePath,
    log: (message) => process.stderr.write(`[gateway] ${message}\n`),
    // As for the Docker image: the reverse proxy in front, whose X-Forwarded-For says who is connecting.
    trustedProxies: (process.env.TRUSTED_PROXIES ?? "").split(","),
  });
  daemon.savePid("gateway", process.pid);
  daemon.saveGatewayLaunch(process.pid, gateway.port, host);

  const displayHost = host ?? "0.0.0.0";
  process.stderr.write(`\n  LinkShell Gateway ${version}\n`);
  process.stderr.write(`  Listening on http://${displayHost}:${gateway.port}\n`);
  process.stderr.write(`  PID: ${process.pid}\n`);
  process.stderr.write(`  Pairings: ${databasePath}\n\n`);
  process.stderr.write(`  Computers:    linkshell host --gateway ws://this-server:${gateway.port}\n`);
  process.stderr.write(`  Health check: curl http://${host ?? "127.0.0.1"}:${gateway.port}/healthz\n\n`);

  let shutdownRequested = false;
  const shutdown = async () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    stopLogRotation();
    process.stderr.write("[gateway] shutting down...\n");
    const hardDeadline = setTimeout(() => {
      process.stderr.write("[gateway] shutdown timed out after 10s; forcing exit\n");
      daemon.removePid("gateway");
      process.exit(1);
    }, 10_000);
    hardDeadline.unref();
    try {
      await gateway.close();
    } finally {
      clearTimeout(hardDeadline);
      daemon.removePid("gateway");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());
}

/** Spawns the gateway daemon and verifies `/healthz` responds within 5s (fails fast on EADDRINUSE). */
export async function startGatewayDaemon(port: number, host?: string): Promise<boolean> {
  const style = stderrStyle();
  const existingPid = daemon.readPid("gateway");
  if (existingPid) {
    process.stderr.write(`  Gateway already running (PID ${existingPid})\n`);
    process.stderr.write("  Run: linkshell gateway stop\n\n");
    return true;
  }

  const args = ["gateway", "--_foreground-gw", "--port", String(port), ...(host ? ["--host", host] : [])];
  const pid = daemon.spawnDaemon("gateway", args);
  const logFile = daemon.getLogFile("gateway");

  const deadline = Date.now() + 5_000;
  let health: GatewayHealthz | undefined;
  while (Date.now() < deadline) {
    health = await probeGatewayHealthz(port, host, 800);
    if (health?.ok) break;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (!health?.ok) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (!alive) daemon.removePid("gateway");
    process.stderr.write(`\n  ${style.red("✗")} Gateway failed to start on ${host ?? "0.0.0.0"}:${port}\n`);
    const tail = tailLogLines(logFile, 6);
    for (const line of tail) {
      process.stderr.write(`    ${line}\n`);
    }
    process.stderr.write(`  See log: ${logFile}\n\n`);
    process.exitCode = 1;
    return false;
  }

  process.stderr.write(`\n  ${style.green("✓")} LinkShell Gateway started in background\n`);
  process.stderr.write(`  PID:    ${pid}\n`);
  process.stderr.write(`  Listen: http://${host ?? "0.0.0.0"}:${port}\n`);
  process.stderr.write(`  Log:    ${logFile}\n\n`);
  process.stderr.write("  Stop:   linkshell gateway stop\n");
  process.stderr.write("  Status: linkshell gateway status\n");
  process.stderr.write("  Logs:   linkshell logs --service gateway -f\n\n");
  return true;
}

/** Stops the gateway via its user service if supervised, otherwise via daemon PID. */
export async function stopGateway(): Promise<{ stopped: boolean; managed: boolean }> {
  try {
    const { stopManagedGatewayService } = await import("./service.js");
    const outcome = await stopManagedGatewayService({ linkshellHome: daemon.linkshellDir() });
    if (outcome === "stopped") {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (!daemon.readPid("gateway")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!daemon.readPid("gateway")) daemon.removePid("gateway");
      return { stopped: true, managed: true };
    }
  } catch {}
  const stopped = await daemon.stopDaemonAndWait("gateway");
  return { stopped, managed: false };
}

/** Prints gateway status to stdout, verifying PID identity and probing `/healthz`. */
export async function printGatewayStatus(options: { json?: boolean; port?: number; host?: string } = {}): Promise<void> {
  const style = stdoutStyle();
  const logFile = daemon.getLogFile("gateway");
  const pid = daemon.readPid("gateway");
  const serviceStatus = await import("./service.js")
    .then(({ getGatewayServiceStatus }) => getGatewayServiceStatus({ linkshellHome: daemon.linkshellDir() }))
    .catch(() => undefined);

  const effectivePid = pid ?? (serviceStatus?.running ? serviceStatus.pid : undefined);
  const launch = daemon.readGatewayLaunch(effectivePid ?? undefined);
  const port = options.port ?? launch?.port ?? 8787;
  const host = options.host ?? launch?.host;
  const health = effectivePid ? await probeGatewayHealthz(port, host, 2_000) : undefined;
  const running = Boolean(effectivePid) || Boolean(health?.ok);
  const uptimeSeconds = effectivePid ? daemon.readDaemonUptimeSeconds("gateway", effectivePid) : undefined;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          running,
          pid: effectivePid,
          host: host ?? "0.0.0.0",
          port,
          uptimeSeconds,
          health,
          service: serviceStatus,
          logFile,
        },
        null,
        2,
      )}\n`,
    );
    if (!running) process.exitCode = 1;
    return;
  }

  if (!running) {
    process.stdout.write("  Gateway is not running.\n");
    process.exitCode = 1;
    return;
  }

  const meta = [
    effectivePid ? `PID ${effectivePid}` : undefined,
    uptimeSeconds !== undefined ? `up ${formatDuration(uptimeSeconds)}` : undefined,
  ].filter(Boolean);
  process.stdout.write(`\n  ${style.green("●")} Gateway is running${meta.length ? ` (${meta.join(", ")})` : ""}\n`);
  process.stdout.write(`  Listen:  http://${host ?? "0.0.0.0"}:${port}\n`);
  if (health) {
    const details = [
      health.version ? `v${health.version}` : undefined,
      health.relay !== undefined ? `${health.relay} connected peer(s)` : undefined,
      health.memoryMb !== undefined ? `${health.memoryMb} MB RSS` : undefined,
    ].filter(Boolean);
    if (details.length > 0) process.stdout.write(`  Health:  ${details.join(" · ")}\n`);
  }
  if (serviceStatus?.installed) {
    const lingerBadge =
      serviceStatus.platform === "linux" && serviceStatus.linger !== undefined
        ? `, linger ${serviceStatus.linger ? "on" : "off"}`
        : "";
    process.stdout.write(`  Service: ${serviceStatus.serviceName} (${serviceStatus.state}${lingerBadge})\n`);
  }
  process.stdout.write(`  Log:     ${logFile}\n\n`);
}
