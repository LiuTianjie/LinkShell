#!/usr/bin/env node
import { Command } from "commander";
import { BridgeSession } from "./runtime/bridge-session.js";
import { resolveProviderConfig } from "./providers.js";
import { loadConfig } from "./config.js";
import { runDoctor } from "./commands/doctor.js";
import { runSetup } from "./commands/setup.js";
import { getLanIp } from "./utils/lan-ip.js";

const config = loadConfig();
const program = new Command();

program
  .name("linkshell")
  .description(
    "Bridge a local Claude/Codex terminal session to a remote gateway",
  )
  .version("0.1.3");

program
  .command("start")
  .description("Start a bridge session")
  .option("--gateway <url>", "Gateway websocket URL (omit to start built-in gateway)", config.gateway)
  .option(
    "--pairing-gateway <url-or-host>",
    "Public HTTP gateway used in QR/deep link output",
    config.pairingGateway,
  )
  .option("--port <port>", "Port for built-in gateway (default: 8787)", "8787")
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
    "--cols <cols>",
    "Initial terminal columns",
    String(config.cols ?? 120),
  )
  .option("--rows <rows>", "Initial terminal rows", String(config.rows ?? 36))
  .option("--verbose", "Enable verbose logging")
  .allowUnknownOption(true)
  .action(async (options, command) => {
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
      // Start built-in gateway
      const { startEmbeddedGateway } = await import("@linkshell/gateway/embedded");
      const port = Number(options.port);
      const gw = await startEmbeddedGateway({
        port,
        logLevel: options.verbose ? "debug" : "warn",
        silent: false,
      });
      embeddedGatewayHandle = gw;
      gatewayUrl = gw.wsUrl;
      gatewayHttpUrl = gw.httpUrl;

      // Auto-detect LAN IP for QR code
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

    const session = new BridgeSession({
      gatewayUrl,
      gatewayHttpUrl,
      pairingGateway,
      sessionId: options.sessionId,
      cols: Number(options.cols),
      rows: Number(options.rows),
      clientName: options.clientName,
      verbose: Boolean(options.verbose),
      providerConfig,
    });

    // Clean up embedded gateway on exit
    if (embeddedGatewayHandle) {
      const cleanup = async () => {
        await embeddedGatewayHandle!.close();
      };
      process.on("SIGINT", () => { cleanup().then(() => process.exit(0)); });
      process.on("SIGTERM", () => { cleanup().then(() => process.exit(0)); });
    }

    await session.start();
  });

program
  .command("gateway")
  .description("Start a standalone gateway server (for deployment on a remote server)")
  .option("--port <port>", "Listen port", "8787")
  .option("--log-level <level>", "Log level: debug | info | warn | error", "info")
  .action(async (options) => {
    const { startEmbeddedGateway } = await import("@linkshell/gateway/embedded");
    const port = Number(options.port);
    const gw = await startEmbeddedGateway({
      port,
      logLevel: options.logLevel,
      silent: false,
    });

    process.stderr.write(`\n  LinkShell Gateway v0.1.0\n`);
    process.stderr.write(`  Listening on http://0.0.0.0:${gw.port}\n`);
    process.stderr.write(`  Log level: ${options.logLevel}\n\n`);
    process.stderr.write(`  Clients connect via: ws://your-server:${gw.port}/ws\n`);
    process.stderr.write(`  Health check: curl http://your-server:${gw.port}/healthz\n\n`);

    const shutdown = async () => {
      process.stderr.write("[gateway] shutting down...\n");
      await gw.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Keep process alive
    await new Promise(() => {});
  });

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

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
