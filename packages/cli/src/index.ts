#!/usr/bin/env node
import { Command } from "commander";
import { BridgeSession } from "./runtime/bridge-session.js";
import { resolveProviderConfig } from "./providers.js";
import { loadConfig } from "./config.js";
import { runDoctor } from "./commands/doctor.js";
import { runSetup } from "./commands/setup.js";
import { runUpgrade } from "./commands/upgrade.js";
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { getLanIp } from "./utils/lan-ip.js";
import { shouldKeepAwake } from "./utils/keep-awake.js";

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { version: string };

// Locate the bundled web-dashboard SPA and point the (embedded) gateway's
// static server at it via WEB_DIST — BEFORE any gateway module is imported,
// because static-web.ts freezes WEB_DIST at module-load time. This is what lets
// the in-app WebView render for LAN / self-hosted users whose CLI runs its own
// embedded gateway (the cloud image bundles web separately). A user-set
// WEB_DIST always wins. Probed across published-package, monorepo-compiled, and
// dev (tsx) layouts; the first candidate containing index.html is used.
if (!process.env.WEB_DIST) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../../web"), // published npm package root, and packages/cli/web (compiled)
    resolve(here, "../../../apps/web-dashboard/dist"), // dev: tsx src/index.ts in the monorepo
  ];
  for (const dir of candidates) {
    try {
      if (existsSync(resolve(dir, "index.html")) && statSync(dir).isDirectory()) {
        process.env.WEB_DIST = dir;
        break;
      }
    } catch {
      // ignore and try the next candidate
    }
  }
}


const config = loadConfig();
const program = new Command();

program
  .name("linkshell")
  .description(
    "Your coding agents and terminals, on your phone. Start with `linkshell setup`.",
  )
  .version(pkg.version);

// ── host (v2 session daemon) ────────────────────────────────────────

const hostCmd = program
  .command("host")
  .description("Run the LinkShell host that owns agent sessions (v2)")
  .option("--daemon", "Run in background (detached)")
  .option("--dev-port <port>", "Also serve the host API on 127.0.0.1:<port> (local development clients only)")
  .option("--gateway <url>", "Reach this computer through a v2 gateway (saved; 'off' to disable, 'default' for the official one when logged in)")
  .option("--_foreground-host", undefined) // internal
  .action(async (options) => {
    const { runHostForeground, ensureHostRunning, readHostConfig, writeHostConfig, assertHostRuntime, silenceSqliteWarning, withRunningHost, refreshGateway, describeGateway } =
      await import("./commands/host.js");
    assertHostRuntime();
    silenceSqliteWarning();
    if (options.devPort) process.env.LINKSHELL_DEV_PORT = String(options.devPort);
    if (options.gateway) {
      const { defaultHome } = await import("@linkshell/host");
      const home = defaultHome();
      // "off" is remembered, so being logged in doesn't turn the official gateway back on.
      writeHostConfig(home, { ...readHostConfig(home), gateway: options.gateway === "default" ? undefined : options.gateway });
    }
    const running = options._foregroundHost ? undefined : await withRunningHost((client) => client.call("machine.info", {}));
    if (options.daemon && !options._foregroundHost) {
      const socket = await ensureHostRunning();
      const daemon = await import("./utils/daemon.js");
      process.stderr.write(`\n  LinkShell host running (${socket})\n`);
      if (running && running.hostVersion !== pkg.version) {
        process.stderr.write(`  It is still ${running.hostVersion}; this CLI is ${pkg.version}. To update it (stops running agent turns):\n`);
        process.stderr.write(`    linkshell host stop && linkshell host --daemon\n`);
      }
      // A gateway given to a host that was already running applies now.
      if (options.gateway && running) {
        const gateway = await refreshGateway(10_000);
        if (gateway) process.stderr.write(`  Gateway: ${describeGateway(gateway)}\n`);
      }
      process.stderr.write(`  Log:    ${daemon.getLogFile("host")}\n`);
      process.stderr.write(`  Status: linkshell host status\n`);
      process.stderr.write(`  Stop:   linkshell host stop\n`);
      // The first start here: the rest of the setup happens now, while someone is at the computer.
      const { offerSetup } = await import("./commands/setup.js");
      if (await offerSetup(pkg.version)) process.exit(process.exitCode ?? 0);
      const { screenAccess, describeScreen, screenReady } = await import("./commands/screen.js");
      const screen = await screenAccess().catch(() => undefined);
      if (screen && (screen === "old" || !screenReady(screen))) process.stderr.write(`  Screen: ${describeScreen(screen)}\n`);
      process.stderr.write("\n");
      return;
    }
    if (running && options.gateway) {
      const gateway = await refreshGateway(10_000);
      if (gateway) process.stderr.write(`\n  Gateway: ${describeGateway(gateway)}\n\n`);
      return;
    }
    await runHostForeground(pkg.version);
  });

hostCmd
  .command("status")
  .description("Show the host, its agents and sessions")
  .action(async () => {
    const { printHostStatus } = await import("./commands/host.js");
    await printHostStatus();
  });

hostCmd
  .command("stop")
  .description("Stop the background host")
  .action(async () => {
    const daemon = await import("./utils/daemon.js");
    process.stderr.write(daemon.stopDaemon("host") ? "  LinkShell host stopped\n" : "  LinkShell host is not running\n");
  });

program
  .command("pair")
  .description("Pair a phone with this computer through the gateway (shows a QR code)")
  .action(async () => {
    const { runPair } = await import("./commands/pair.js");
    await runPair();
  });

const devicesCmd = program
  .command("devices")
  .description("List the phones paired with this computer")
  .action(async () => {
    const { withRunningHost, assertHostRuntime } = await import("./commands/host.js");
    assertHostRuntime();
    const gateway = await withRunningHost((client) => client.call("gateway.status", {}));
    if (!gateway) {
      process.stderr.write("  LinkShell host is not running. Start it with: linkshell host --daemon\n");
      process.exitCode = 1;
      return;
    }
    if (gateway.devices.length === 0) {
      process.stdout.write("  No paired devices. (Devices signed in to your account don't need pairing.)\n");
      return;
    }
    for (const device of gateway.devices) {
      const paired = new Date(device.pairedAt).toLocaleDateString();
      process.stdout.write(`  ${device.online ? "●" : "○"} ${device.name}  paired ${paired}  ${device.id.slice(0, 8)}\n`);
    }
    process.stdout.write("\n  Remove one with: linkshell devices remove <name or id>\n");
  });

devicesCmd
  .command("remove <device>")
  .description("Unpair a phone: it can no longer reach this computer")
  .action(async (wanted: string) => {
    const { withRunningHost, assertHostRuntime } = await import("./commands/host.js");
    assertHostRuntime();
    const result = await withRunningHost(async (client) => {
      const { devices } = await client.call("gateway.status", {});
      const matches = devices.filter((device) => device.id.startsWith(wanted) || device.name.toLowerCase() === wanted.toLowerCase());
      if (matches.length !== 1) return { matches };
      await client.call("devices.revoke", { deviceId: matches[0]!.id });
      return { removed: matches[0]! };
    });
    if (!result) {
      process.stderr.write("  LinkShell host is not running. Start it with: linkshell host --daemon\n");
      process.exitCode = 1;
    } else if (result.removed) {
      process.stdout.write(`  Unpaired ${result.removed.name}.\n`);
    } else {
      process.stderr.write(
        result.matches.length === 0
          ? `  No paired device named "${wanted}". See: linkshell devices\n`
          : `  "${wanted}" matches ${result.matches.length} devices; use the id shown by: linkshell devices\n`,
      );
      process.exitCode = 1;
    }
  });

// `linkshell codex …` / `linkshell claude …` start the agent's own TUI attached
// to the host, so the session is live here and on every paired device.
// All arguments go to the agent.
for (const [agent, description] of [
  ["codex", "Start Codex attached to the LinkShell host (arguments pass through)"],
  ["claude", "Start Claude Code with phone handoff (arguments pass through)"],
] as const) {
  program
    .command(agent)
    .description(description)
    .argument("[args...]")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (args: string[]) => {
      const { runAgentShim } = await import("./commands/host.js");
      await runAgentShim(agent, args ?? []);
    });
}

// ── start ───────────────────────────────────────────────────────────

program
  .command("start")
  .description("Start a v1 bridge session (for the v1 app; with built-in or remote gateway)")
  .option(
    "--gateway <url>",
    "Gateway websocket URL (omit to start built-in gateway)",
    config.gateway ?? undefined,
  )
  .option(
    "--pairing-gateway <url-or-host>",
    "Public HTTP gateway used in QR/deep link output",
    config.pairingGateway,
  )
  .option("--port <port>", "Port for built-in gateway", "8787")
  .option("--session-id <id>", "Session identifier (auto-created if omitted)")
  .option(
    "--provider <provider>",
    "(deprecated — always custom; launch your CLI manually inside the shell)",
    "custom",
  )
  .option(
    "--command <command>",
    "Shell or CLI to spawn in the PTY (default: $SHELL)",
    config.command,
  )
  .option(
    "--client-name <name>",
    "Display name for this CLI",
    config.clientName ?? "local-cli",
  )
  .option(
    "--hostname <name>",
    "Override hostname sent to gateway",
    config.hostname,
  )
  .option(
    "--cols <cols>",
    "Initial terminal columns",
    String(config.cols ?? 120),
  )
  .option("--rows <rows>", "Initial terminal rows", String(config.rows ?? 36))
  .option("--screen", "Enable screen sharing capability")
  .option("--no-keep-awake", "Disable macOS keep-awake while bridge is running")
  .option("--agent-ui", "Enable ACP Agent Workspace channel", true)
  .option("--no-agent-ui", "Disable ACP Agent Workspace channel")
  .option(
    "--agent-provider <provider>",
    "Agent GUI provider: codex | claude | custom",
  )
  .option(
    "--agent-command <command>",
    "ACP agent command (required for claude/custom, optional for codex)",
  )
  .option("--daemon", "Run in background (detached)")
  .option("--verbose", "Enable verbose logging")
  .option("--_foreground-bridge", undefined) // internal
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (options, command) => {
    const daemon = await import("./utils/daemon.js");
    const keepAwake = shouldKeepAwake(options.keepAwake);

    // Daemon mode: spawn detached child and exit
    if (options.daemon && !options._foregroundBridge) {
      const existingPid = daemon.readPid("bridge");
      if (existingPid) {
        process.stderr.write(`  Bridge already running (PID ${existingPid})\n`);
        process.stderr.write(`  Run: linkshell stop\n\n`);
        return;
      }

      // Rebuild args for the child, replacing --daemon with --_foreground-bridge
      const childArgs = ["start", "--_foreground-bridge"];
      if (options.gateway) childArgs.push("--gateway", options.gateway);
      if (options.pairingGateway)
        childArgs.push("--pairing-gateway", options.pairingGateway);
      childArgs.push("--port", String(options.port));
      childArgs.push("--provider", options.provider);
      if (options.command) childArgs.push("--command", options.command);
      childArgs.push("--client-name", options.clientName);
      if (options.hostname) childArgs.push("--hostname", options.hostname);
      childArgs.push("--cols", String(options.cols));
      childArgs.push("--rows", String(options.rows));
      if (options.verbose) childArgs.push("--verbose");
      if (options.screen) childArgs.push("--screen");
      if (!keepAwake) childArgs.push("--no-keep-awake");
      if (options.agentUi) childArgs.push("--agent-ui");
      if (options.agentProvider)
        childArgs.push("--agent-provider", options.agentProvider);
      if (options.agentCommand)
        childArgs.push("--agent-command", options.agentCommand);
      if (options.sessionId) childArgs.push("--session-id", options.sessionId);
      // Pass through extra args
      const extra = command.args.filter((v: string) => v !== "--");
      if (extra.length) childArgs.push("--", ...extra);

      const pid = daemon.spawnDaemon("bridge", childArgs);
      daemon.saveMetadata("bridge", { keepAwake, startedAt: Date.now() });
      process.stderr.write(`\n  LinkShell bridge started in background\n`);
      process.stderr.write(`  PID: ${pid}\n`);
      process.stderr.write(`  Provider: ${options.provider}\n`);
      process.stderr.write(
        `  Keep awake: ${keepAwake ? "enabled (use --no-keep-awake to disable)" : "disabled"}\n`,
      );
      process.stderr.write(`  Log: ${daemon.getLogFile("bridge")}\n\n`);
      process.stderr.write(`  Stop:   linkshell stop\n`);
      process.stderr.write(`  Status: linkshell status\n`);
      process.stderr.write(
        `  Logs:   tail -f ${daemon.getLogFile("bridge")}\n\n`,
      );
      return;
    }

    // Foreground mode
    const passthroughArgs = command.args.filter(
      (value: string) => value !== "--",
    );
    const providerConfig = resolveProviderConfig({
      provider: options.provider,
      command: options.command,
      args: passthroughArgs,
    });

    let gatewayUrl = options.gateway as string | undefined;
    let gatewayHttpUrl: string;
    let pairingGateway = options.pairingGateway as string | undefined;
    let embeddedGatewayHandle: { close: () => Promise<void> } | undefined;

    if (!gatewayUrl) {
      const { startEmbeddedGateway } =
        await import("@linkshell/gateway/embedded");
      const port = Number(options.port);
      const gw = await startEmbeddedGateway({
        port,
        logLevel: options.verbose ? "debug" : "warn",
        silent: false,
      });
      embeddedGatewayHandle = gw;
      gatewayUrl = gw.wsUrl;
      gatewayHttpUrl = gw.httpUrl;

      const lanIp = getLanIp();
      if (!pairingGateway && lanIp !== "127.0.0.1") {
        pairingGateway = `http://${lanIp}:${gw.port}`;
      }

      process.stderr.write(`\n  Built-in gateway started on port ${gw.port}\n`);
      if (pairingGateway) {
        process.stderr.write(`  LAN address: ${pairingGateway}\n`);
      }
      process.stderr.write("\n");
    } else {
      gatewayHttpUrl = gatewayUrl
        .replace(/\/ws\/?$/, "")
        .replace(/^wss:/, "https:")
        .replace(/^ws:/, "http:");
    }

    // Save PID for status/stop
    daemon.savePid("bridge", process.pid);
    daemon.saveMetadata("bridge", { keepAwake, startedAt: Date.now() });

    // Load auth token if logged in
    let authToken: string | undefined;
    try {
      const { getValidToken } = await import("./auth.js");
      authToken = (await getValidToken()) ?? undefined;
    } catch {}

    const session = new BridgeSession({
      gatewayUrl,
      gatewayHttpUrl,
      pairingGateway,
      sessionId: options.sessionId,
      cols: Number(options.cols),
      rows: Number(options.rows),
      clientName: options.clientName,
      hostname: options.hostname,
      verbose: Boolean(options.verbose),
      screen: Boolean(options.screen),
      providerConfig,
      authToken,
      keepAwake,
      agentUi: Boolean(options.agentUi),
      agentProvider: options.agentProvider,
      agentCommand: options.agentCommand,
    });

    const cleanup = async () => {
      session.stop(0);
      daemon.removePid("bridge");
      if (embeddedGatewayHandle) await embeddedGatewayHandle.close();
    };

    // When all PTYs exit naturally (not via a signal), the session closes its
    // own socket but the embedded gateway loop and stale PID file would linger.
    // Run the same process-level cleanup and then exit.
    session.setOnAllTerminalsExited(async () => {
      daemon.removePid("bridge");
      if (embeddedGatewayHandle) await embeddedGatewayHandle.close();
      process.exit(process.exitCode ?? 0);
    });

    process.on("SIGINT", () => {
      cleanup().then(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      cleanup().then(() => process.exit(0));
    });

    // Global crash handlers: never die silently. In daemon mode keep the bridge
    // alive (it has its own gateway reconnect logic); stderr is redirected to the
    // daemon log file so the trace is recoverable.
    const isDaemonChild = Boolean(options._foregroundBridge);
    process.on("uncaughtException", (err) => {
      process.stderr.write(
        `[bridge] uncaught exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      if (!isDaemonChild) {
        cleanup().then(() => process.exit(1));
      }
    });
    process.on("unhandledRejection", (reason) => {
      process.stderr.write(
        `[bridge] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`,
      );
    });

    await session.start();
  });

// ── gateway ─────────────────────────────────────────────────────────

const gatewayCmd = program
  .command("gateway")
  .description("Manage the standalone gateway server")
  .option("--port <port>", "Listen port", "8787")
  .option(
    "--log-level <level>",
    "Log level: debug | info | warn | error",
    "info",
  )
  .option("--daemon", "Run in background (detached)")
  .option("--_foreground-gw", undefined) // internal
  .action(async (options) => {
    const daemon = await import("./utils/daemon.js");

    if (options.daemon && !options._foregroundGw) {
      const existingPid = daemon.readPid("gateway");
      if (existingPid) {
        process.stderr.write(
          `  Gateway already running (PID ${existingPid})\n`,
        );
        process.stderr.write(`  Run: linkshell gateway stop\n\n`);
        return;
      }
      const pid = daemon.spawnDaemon("gateway", [
        "gateway",
        "--_foreground-gw",
        "--port",
        String(options.port),
        "--log-level",
        options.logLevel,
      ]);
      process.stderr.write(`\n  LinkShell Gateway started in background\n`);
      process.stderr.write(`  PID: ${pid}\n`);
      process.stderr.write(`  Port: ${options.port}\n`);
      process.stderr.write(`  Log: ${daemon.getLogFile("gateway")}\n\n`);
      process.stderr.write(`  Stop:   linkshell gateway stop\n`);
      process.stderr.write(`  Status: linkshell gateway status\n`);
      process.stderr.write(
        `  Logs:   tail -f ${daemon.getLogFile("gateway")}\n\n`,
      );
      return;
    }

    // Foreground mode
    const { startEmbeddedGateway } =
      await import("@linkshell/gateway/embedded");
    const port = Number(options.port);
    const { join } = await import("node:path");
    (await import("./commands/host.js")).silenceSqliteWarning();
    const gw = await startEmbeddedGateway({
      port,
      logLevel: options.logLevel,
      silent: false,
      // v2 pairings live here; keep this file to keep phones paired.
      relayDataPath: join(daemon.linkshellDir(), "relay.db"),
    });

    daemon.savePid("gateway", process.pid);

    process.stderr.write(`\n  LinkShell Gateway ${pkg.version}\n`);
    process.stderr.write(`  Listening on http://0.0.0.0:${gw.port}\n`);
    process.stderr.write(`  PID: ${process.pid}\n`);
    process.stderr.write(`  Log level: ${options.logLevel}\n\n`);
    process.stderr.write(`  Computers (v2):  linkshell host --gateway ws://this-server:${gw.port}\n`);
    process.stderr.write(
      `  v1 clients:      ws://this-server:${gw.port}/ws\n`,
    );
    process.stderr.write(
      `  Health check: curl http://your-server:${gw.port}/healthz\n\n`,
    );

    const shutdown = async () => {
      process.stderr.write("[gateway] shutting down...\n");
      daemon.removePid("gateway");
      await gw.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await new Promise(() => {});
  });

gatewayCmd
  .command("stop")
  .description("Stop the background gateway")
  .action(async () => {
    const { stopDaemon } = await import("./utils/daemon.js");
    if (stopDaemon("gateway")) {
      process.stderr.write("  Gateway stopped.\n");
    } else {
      process.stderr.write("  No running gateway found.\n");
    }
  });

gatewayCmd
  .command("status")
  .description("Check if the gateway is running")
  .action(async () => {
    const { readPid, getLogFile } = await import("./utils/daemon.js");
    const pid = readPid("gateway");
    if (pid) {
      process.stderr.write(`\n  Gateway is running\n`);
      process.stderr.write(`  PID: ${pid}\n`);
      process.stderr.write(`  Log: ${getLogFile("gateway")}\n\n`);
    } else {
      process.stderr.write("  Gateway is not running.\n");
    }
  });

// ── screen ──────────────────────────────────────────────────────────

program
  .command("screen")
  .description("Set this computer up for watching and controlling its screen from the phone (the two macOS permissions; on Linux, ffmpeg)")
  .option("--check", "Only say what is and isn't ready")
  .action(async (options) => {
    const { runScreenSetup } = await import("./commands/screen.js");
    const { silenceSqliteWarning } = await import("./commands/host.js");
    silenceSqliteWarning();
    await runScreenSetup({ check: options.check === true });
  });

// ── stop (stops both bridge and gateway) ────────────────────────────

program
  .command("stop")
  .description("Stop all running LinkShell processes")
  .action(async () => {
    const { stopDaemon } = await import("./utils/daemon.js");
    const hostStopped = stopDaemon("host");
    const bridgeStopped = stopDaemon("bridge");
    const gatewayStopped = stopDaemon("gateway");
    if (hostStopped) process.stderr.write("  Host stopped.\n");
    if (bridgeStopped) process.stderr.write("  v1 bridge stopped.\n");
    if (gatewayStopped) process.stderr.write("  Gateway server stopped.\n");
    if (!hostStopped && !bridgeStopped && !gatewayStopped) {
      process.stderr.write("  No running processes found.\n");
    }
  });

// ── status ──────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show the host, its gateway connection, and anything else LinkShell runs here")
  .action(async () => {
    const { readPid, getLogFile, readMetadata } = await import("./utils/daemon.js");
    const { printHostStatus, assertHostRuntime } = await import("./commands/host.js");
    assertHostRuntime();
    process.stdout.write("\n");
    await printHostStatus();
    const gatewayPid = readPid("gateway");
    if (gatewayPid) process.stdout.write(`  Gateway server: running (PID ${gatewayPid}), log ${getLogFile("gateway")}\n`);
    const bridgePid = readPid("bridge");
    if (bridgePid) {
      const keepAwake = readMetadata("bridge")?.keepAwake ? ", keeps this computer awake" : "";
      process.stdout.write(`  v1 bridge: running (PID ${bridgePid}${keepAwake}), log ${getLogFile("bridge")}\n`);
    }
    process.stdout.write("\n");
  });

// ── doctor / setup ──────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check that this computer is ready: Node, agents, the host and its gateway")
  .option("--gateway <url>", "Also check that this gateway answers")
  .action(async (options) => {
    await runDoctor(pkg.version, options.gateway);
  });

program
  .command("setup")
  .description("Set this computer up, once: the host, the screen's permissions, and your phone")
  .action(async () => {
    await runSetup(pkg.version);
    process.exit(process.exitCode ?? 0);
  });

program
  .command("upgrade")
  .description("Upgrade LinkShell to the latest version")
  .action(async () => {
    await runUpgrade();
  });

program
  .command("login")
  .description("Log in to LinkShell (Pro: the official gateway, no pairing needed)")
  .action(async () => {
    const result = await runLogin();
    if (!result) return;

    const { joinGatewayAfterLogin } = await import("./commands/host.js");
    await joinGatewayAfterLogin(result.plan);
    process.exit(0);
  });

program
  .command("logout")
  .description("Log out of LinkShell")
  .action(async () => {
    await runLogout();
  });

program
  .command("list")
  .description("List your v1 sessions on official gateways")
  .action(async () => {
    const { getValidToken, loadAuth, SUPABASE_URL, SUPABASE_ANON_KEY } =
      await import("./auth.js");
    const token = await getValidToken();
    if (!token) {
      process.stderr.write(
        "\n  Not logged in. Run: linkshell login\n\n",
      );
      return;
    }

    const auth = loadAuth();
    process.stderr.write(`\n  Logged in as ${auth?.email || auth?.userId || "unknown"}\n\n`);

    // Fetch official gateways
    let gateways: { url: string; name: string; region: string | null }[] = [];
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/linkshell_official_gateways?enabled=eq.true&select=url,name,region`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: SUPABASE_ANON_KEY,
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.ok) {
        gateways = (await res.json()) as typeof gateways;
      }
    } catch {}

    if (gateways.length === 0) {
      process.stderr.write("  No official gateways available.\n\n");
      return;
    }

    process.stderr.write("  Official Gateways:\n\n");

    for (const gw of gateways) {
      const label = gw.region ? `${gw.name} (${gw.region})` : gw.name;
      // Fetch user's sessions on this gateway
      let sessions: {
        id: string;
        provider: string | null;
        projectName: string | null;
        hasHost: boolean;
        lastActivity: number;
      }[] = [];
      try {
        const res = await fetch(`${gw.url}/sessions/mine`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          const body = (await res.json()) as { sessions: typeof sessions };
          sessions = body.sessions;
        }
      } catch {}

      process.stderr.write(`  \x1b[32m✓\x1b[0m ${label}\n`);
      const wsUrl = gw.url.replace(/\/$/, "").replace(/^https:/, "wss:").replace(/^http:/, "ws:") + "/ws";
      process.stderr.write(`    ${wsUrl}\n`);

      if (sessions.length === 0) {
        process.stderr.write("    (no active sessions)\n\n");
      } else {
        for (const s of sessions) {
          const ago = Math.round((Date.now() - s.lastActivity) / 60_000);
          const agoStr = ago < 1 ? "just now" : `${ago}m ago`;
          const info = [s.provider, s.projectName].filter(Boolean).join(" · ");
          const hostIcon = s.hasHost ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
          process.stderr.write(
            `    └ ${hostIcon} ${s.id.slice(0, 8)} — ${info || "unknown"} · ${agoStr}\n`,
          );
        }
        process.stderr.write("\n");
      }
    }

    process.stderr.write(
      "  Connect: linkshell start --gateway <url>\n\n",
    );
  });

// `linkshell` by itself, on a computer where nothing has been set up yet: the setup, rather than a page of help.
program.action(async () => {
  const { setupDone } = await import("./commands/setup.js");
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true || (await setupDone())) return program.help();
  await runSetup(pkg.version);
  process.exit(process.exitCode ?? 0);
});

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
