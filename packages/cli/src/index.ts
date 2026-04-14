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

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { version: string };

const config = loadConfig();
const program = new Command();

program
  .name("linkshell")
  .description(
    "Bridge a local Claude/Codex terminal session to a remote gateway",
  )
  .version(pkg.version);

// ── start ───────────────────────────────────────────────────────────

program
  .command("start")
  .description("Start a bridge session (with built-in or remote gateway)")
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
    "claude | codex | custom",
    config.provider ?? "claude",
  )
  .option("--command <command>", "Override provider executable", config.command)
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
  .option("--daemon", "Run in background (detached)")
  .option("--verbose", "Enable verbose logging")
  .option("--_foreground-bridge", undefined) // internal
  .allowUnknownOption(true)
  .action(async (options, command) => {
    const daemon = await import("./utils/daemon.js");

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
      if (options.sessionId) childArgs.push("--session-id", options.sessionId);
      // Pass through extra args
      const extra = command.args.filter((v: string) => v !== "--");
      if (extra.length) childArgs.push("--", ...extra);

      const pid = daemon.spawnDaemon("bridge", childArgs);
      process.stderr.write(`\n  LinkShell bridge started in background\n`);
      process.stderr.write(`  PID: ${pid}\n`);
      process.stderr.write(`  Provider: ${options.provider}\n`);
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
    });

    const cleanup = async () => {
      daemon.removePid("bridge");
      if (embeddedGatewayHandle) await embeddedGatewayHandle.close();
    };
    process.on("SIGINT", () => {
      cleanup().then(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      cleanup().then(() => process.exit(0));
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
    const gw = await startEmbeddedGateway({
      port,
      logLevel: options.logLevel,
      silent: false,
    });

    daemon.savePid("gateway", process.pid);

    process.stderr.write(`\n  LinkShell Gateway v0.1.8\n`);
    process.stderr.write(`  Listening on http://0.0.0.0:${gw.port}\n`);
    process.stderr.write(`  PID: ${process.pid}\n`);
    process.stderr.write(`  Log level: ${options.logLevel}\n\n`);
    process.stderr.write(
      `  Clients connect via: ws://your-server:${gw.port}/ws\n`,
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

// ── stop (stops both bridge and gateway) ────────────────────────────

program
  .command("stop")
  .description("Stop all running LinkShell processes")
  .action(async () => {
    const { stopDaemon } = await import("./utils/daemon.js");
    const bridgeStopped = stopDaemon("bridge");
    const gatewayStopped = stopDaemon("gateway");
    if (bridgeStopped) process.stderr.write("  Bridge stopped.\n");
    if (gatewayStopped) process.stderr.write("  Gateway stopped.\n");
    if (!bridgeStopped && !gatewayStopped) {
      process.stderr.write("  No running processes found.\n");
    }
  });

// ── status ──────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show status of all LinkShell processes")
  .action(async () => {
    const { readPid, getLogFile } = await import("./utils/daemon.js");
    const bridgePid = readPid("bridge");
    const gatewayPid = readPid("gateway");

    process.stderr.write("\n");
    if (bridgePid) {
      process.stderr.write(`  Bridge:  running (PID ${bridgePid})\n`);
      process.stderr.write(`           Log: ${getLogFile("bridge")}\n`);
    } else {
      process.stderr.write("  Bridge:  not running\n");
    }
    if (gatewayPid) {
      process.stderr.write(`  Gateway: running (PID ${gatewayPid})\n`);
      process.stderr.write(`           Log: ${getLogFile("gateway")}\n`);
    } else {
      process.stderr.write("  Gateway: not running\n");
    }
    process.stderr.write("\n");
  });

// ── doctor / setup ──────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check your environment and connectivity")
  .option("--gateway <url>", "Gateway URL to test", config.gateway)
  .action(async (options) => {
    await runDoctor(options.gateway);
  });

program
  .command("setup")
  .description("Interactive setup wizard")
  .action(async () => {
    await runSetup();
  });

program
  .command("upgrade")
  .description("Upgrade LinkShell to the latest version")
  .action(async () => {
    await runUpgrade();
  });

program
  .command("login")
  .description("Log in to LinkShell (enables premium gateway)")
  .action(async () => {
    const result = await runLogin();
    if (!result) return;

    if (result.plan !== "pro") {
      process.stderr.write(
        "  Upgrade to Pro for official gateway access: https://itool.tech\n\n",
      );
      return;
    }

    // Pro user — fetch official gateways and offer to connect
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import("./auth.js");
    let gateways: { url: string; name: string; region: string | null }[] = [];
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/linkshell_official_gateways?enabled=eq.true&select=url,name,region`,
        {
          headers: {
            Authorization: `Bearer ${result.accessToken}`,
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
      process.stderr.write("  No official gateways available yet.\n\n");
      return;
    }

    process.stderr.write("  Available gateways:\n\n");
    for (let i = 0; i < gateways.length; i++) {
      const gw = gateways[i]!;
      const label = gw.region ? `${gw.name} (${gw.region})` : gw.name;
      process.stderr.write(`    [${i + 1}] ${label}  ${gw.url}\n`);
    }
    process.stderr.write(`    [0] Skip\n\n`);

    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((res) => {
      rl.question("  Connect to gateway [1]: ", (ans) => {
        rl.close();
        res(ans.trim());
      });
    });

    if (answer === "0") return;

    const idx = (answer === "" ? 1 : Number(answer)) - 1;
    if (idx < 0 || idx >= gateways.length || Number.isNaN(idx)) {
      process.stderr.write("  Invalid choice.\n\n");
      return;
    }

    const chosen = gateways[idx]!;
    const gwWsUrl = chosen.url.replace(/\/$/, "").replace(/^https:/, "wss:").replace(/^http:/, "ws:") + "/ws";

    process.stderr.write(`\n  Connecting to ${chosen.name}...\n`);

    // Start daemon with the chosen gateway
    const daemon = await import("./utils/daemon.js");
    const existingPid = daemon.readPid("bridge");
    if (existingPid) {
      process.stderr.write(
        `  Bridge already running (PID ${existingPid}). Run: linkshell stop\n\n`,
      );
      return;
    }

    const childArgs = [
      "start",
      "--_foreground-bridge",
      "--gateway", gwWsUrl,
      "--provider", config.provider ?? "claude",
      "--client-name", config.clientName ?? "local-cli",
      "--cols", String(config.cols ?? 120),
      "--rows", String(config.rows ?? 36),
    ];

    const pid = daemon.spawnDaemon("bridge", childArgs);
    process.stderr.write(`\n  \x1b[32m✓\x1b[0m Bridge started in background (PID ${pid})\n`);
    process.stderr.write(`    Gateway: ${chosen.name}\n`);
    process.stderr.write(`    Open the LinkShell app on your phone to connect.\n\n`);
    process.stderr.write(`    Stop:   linkshell stop\n`);
    process.stderr.write(`    Status: linkshell status\n`);
    process.stderr.write(`    Logs:   tail -f ${daemon.getLogFile("bridge")}\n\n`);
    process.exit(0);
  });

program
  .command("logout")
  .description("Log out of LinkShell")
  .action(() => {
    runLogout();
  });

program
  .command("list")
  .description("List your sessions on official gateways")
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
      "  Connect: linkshell start --gateway <url> --provider claude\n\n",
    );
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
