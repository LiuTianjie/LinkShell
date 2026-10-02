#!/usr/bin/env node
import { Command } from "commander";
import { runDoctor } from "./commands/doctor.js";
import { runSetup } from "./commands/setup.js";
import { runUpgrade } from "./commands/upgrade.js";
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { version: string };

const program = new Command();

program
  .name("linkshell")
  .description(
    "Your coding agents and terminals, on your phone. Start with `linkshell setup`.",
  )
  .version(pkg.version);

// ── host ────────────────────────────────────────────────────────────

const hostCmd = program
  .command("host")
  .description("Run the LinkShell host that owns agent sessions")
  .option("--daemon", "Run in background (detached)")
  .option("--dev-port <port>", "Also serve the host API on 127.0.0.1:<port> (local development clients only)")
  .option("--gateway <url>", "Reach this computer through a gateway (saved; 'off' to disable, 'default' for the official one when logged in)")
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

// ── gateway ─────────────────────────────────────────────────────────

const gatewayCmd = program
  .command("gateway")
  .description("Run a gateway of your own: it relays encrypted frames between your computers and phones, and brokers pairing")
  .option("--port <port>", "Listen port", "8787")
  .option("--daemon", "Run in background (detached)")
  .option("--_foreground-gw", undefined) // internal
  .action(async (options) => {
    if (options.daemon && !options._foregroundGw) {
      const daemon = await import("./utils/daemon.js");
      const existingPid = daemon.readPid("gateway");
      if (existingPid) {
        process.stderr.write(`  Gateway already running (PID ${existingPid})\n`);
        process.stderr.write(`  Run: linkshell gateway stop\n\n`);
        return;
      }
      const pid = daemon.spawnDaemon("gateway", ["gateway", "--_foreground-gw", "--port", String(options.port)]);
      process.stderr.write(`\n  LinkShell Gateway started in background\n`);
      process.stderr.write(`  PID: ${pid}\n`);
      process.stderr.write(`  Port: ${options.port}\n`);
      process.stderr.write(`  Log: ${daemon.getLogFile("gateway")}\n\n`);
      process.stderr.write(`  Stop:   linkshell gateway stop\n`);
      process.stderr.write(`  Status: linkshell gateway status\n`);
      process.stderr.write(`  Logs:   tail -f ${daemon.getLogFile("gateway")}\n\n`);
      return;
    }
    const { runGatewayForeground } = await import("./commands/gateway.js");
    await runGatewayForeground(pkg.version, Number(options.port));
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

// ── stop (the host and the gateway server) ──────────────────────────

program
  .command("stop")
  .description("Stop all running LinkShell processes")
  .action(async () => {
    const { stopDaemon } = await import("./utils/daemon.js");
    const hostStopped = stopDaemon("host");
    // A bridge left running by a 1.x install: nothing else here can end it.
    const bridgeStopped = stopDaemon("bridge");
    const gatewayStopped = stopDaemon("gateway");
    if (hostStopped) process.stderr.write("  Host stopped.\n");
    if (bridgeStopped) process.stderr.write("  1.x bridge stopped.\n");
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
    const { readPid, getLogFile } = await import("./utils/daemon.js");
    const { printHostStatus, assertHostRuntime } = await import("./commands/host.js");
    assertHostRuntime();
    process.stdout.write("\n");
    await printHostStatus();
    const gatewayPid = readPid("gateway");
    if (gatewayPid) process.stdout.write(`  Gateway server: running (PID ${gatewayPid}), log ${getLogFile("gateway")}\n`);
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
