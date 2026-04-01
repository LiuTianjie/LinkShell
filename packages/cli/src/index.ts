#!/usr/bin/env node
import { Command } from "commander";
import { BridgeSession } from "./runtime/bridge-session.js";
import { resolveProviderConfig } from "./providers.js";
import { loadConfig } from "./config.js";
import { runDoctor } from "./commands/doctor.js";
import { runSetup } from "./commands/setup.js";

const config = loadConfig();
const program = new Command();

program
  .name("linkshell")
  .description(
    "Bridge a local Claude/Codex terminal session to a remote gateway",
  )
  .version("0.1.0");

program
  .command("start")
  .description("Start a bridge session")
  .option("--gateway <url>", "Gateway websocket URL", config.gateway)
  .option(
    "--pairing-gateway <url-or-host>",
    "Public HTTP gateway used in QR/deep link output",
    config.pairingGateway,
  )
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
    if (!options.gateway) {
      process.stderr.write(
        "Error: --gateway is required. Run `linkshell setup` to configure a default.\n",
      );
      process.exit(1);
    }

    const passthroughArgs = command.args.filter(
      (value: string) => value !== "--",
    );
    const providerConfig = resolveProviderConfig({
      provider: options.provider,
      command: options.command,
      args: passthroughArgs,
    });

    const gatewayHttpUrl = options.gateway
      .replace(/\/ws\/?$/, "")
      .replace(/^wss:/, "https:")
      .replace(/^ws:/, "http:");

    const session = new BridgeSession({
      gatewayUrl: options.gateway,
      gatewayHttpUrl,
      pairingGateway: options.pairingGateway,
      sessionId: options.sessionId,
      cols: Number(options.cols),
      rows: Number(options.rows),
      clientName: options.clientName,
      verbose: Boolean(options.verbose),
      providerConfig,
    });

    await session.start();
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
