#!/usr/bin/env node
import { standaloneBundle } from "./utils/standalone.js";
import { Command, Option } from "commander";
import { runDoctor } from "./commands/doctor.js";
import { runSetup } from "./commands/setup.js";
import { runUpgrade } from "./commands/upgrade.js";
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { version: string };

const bundledApp = standaloneBundle();
if (bundledApp) process.env.LINKSHELL_APP_BUNDLE = bundledApp;
else delete process.env.LINKSHELL_APP_BUNDLE;

const program = new Command();

program
  .name("linkshell")
  .description(
    "Your coding agents and terminals, on your phone. Start with `linkshell setup`.",
  )
  .version(pkg.version);

program
  .command("app", { hidden: process.platform !== "darwin" && process.platform !== "win32" })
  .description(
    process.platform === "win32"
      ? "Open the LinkShell desktop window"
      : "Open the native Mac status app (included with the CLI)",
  )
  .action(async () => { const { openDesktop } = await import("./commands/desktop.js"); await openDesktop(); });

program.command("desktop", { hidden: true })
  .option("--action <action>", "snapshot, start, stop or restart", "snapshot")
  .option("--provider <provider>", "github or google, for --action login-oauth")
  .action(async (options) => { const { runDesktop } = await import("./commands/desktop.js"); await runDesktop(pkg.version, options.action, process.stdin, { provider: options.provider }); });

program.command("desktop-workspace", { hidden: true })
  .requiredOption("--assets <directory>", "Absolute path to the bundled workspace assets")
  .action(async (options) => {
    const { runDesktopWorkspace } = await import("./commands/desktop-workspace.js");
    try {
      await runDesktopWorkspace(options.assets, process.stdin, pkg.version);
      // This owned command has flushed persistent writes and closed its servers. Legacy
      // account/Host probes may still hold sockets; none should outlive the desktop UI.
      process.exit(0);
    }
    catch {
      process.stderr.write("桌面工作台无法启动，请检查安装资源与本地存储后重试。\n");
      process.exitCode = 1;
    }
  });

// ── host ────────────────────────────────────────────────────────────

const hostCmd = program
  .command("host")
  .description("Run the LinkShell host that owns agent sessions")
  .option("--daemon", "Run in background (detached)")
  .option("--dev-port <port>", "Also serve the host API on 127.0.0.1:<port> (local development clients only)")
  .option("--gateway <url>", "Reach this computer through a gateway (saved; 'off' to disable, 'default' for the official one when logged in)")
  .option("--lan [port]", "Reach this computer on same-Wi-Fi LAN (starts local gateway on <port>, default 8787; 'off' to disable)")
  .option("--keep-awake <mode>", "Prevent idle system sleep: 'smart' (default, while active), 'always', or 'off'")
  .option("--_foreground-host", undefined) // internal
  .addOption(new Option("--_upgrade-host").hideHelp())
  .action(async (options) => {
    const {
      runHostForeground,
      ensureHostRunning,
      readHostConfig,
      writeHostConfig,
      assertHostRuntime,
      silenceSqliteWarning,
      withRunningHost,
      refreshGateway,
      describeGateway,
      parseKeepAwakeOption,
      parseLanOption,
      configureLanGateway,
    } = await import("./commands/host.js");
    assertHostRuntime();
    silenceSqliteWarning();
    if (options._upgradeHost) {
      const { upgradeRunningHost } = await import("./commands/upgrade-host.js");
      await upgradeRunningHost(pkg.version);
      return;
    }
    if (options.devPort) process.env.LINKSHELL_DEV_PORT = String(options.devPort);
    const parsedKeepAwake = options.keepAwake !== undefined ? parseKeepAwakeOption(String(options.keepAwake)) : undefined;
    const parsedLan = options.lan !== undefined ? parseLanOption(options.lan) : undefined;
    let gatewayUpdated = Boolean(options.gateway);
    if (options.gateway || parsedKeepAwake !== undefined || parsedLan !== undefined) {
      const { defaultHome } = await import("@linkshell/host");
      const home = defaultHome();
      if (parsedLan !== undefined) {
        const lanResult = configureLanGateway(home, parsedLan);
        gatewayUpdated = true;
        if (lanResult.gatewayUrl) {
          process.stderr.write(`  LAN gateway: ${lanResult.gatewayUrl}${lanResult.startedLocalGateway ? " (started local gateway)" : ""}\n`);
          process.stderr.write("  Pair your phone on the same Wi-Fi with: linkshell pair\n");
        } else {
          process.stderr.write("  LAN mode disabled.\n");
        }
      }
      if (options.gateway) {
        const existing = readHostConfig(home);
        // "off" is remembered, so being logged in doesn't turn the official gateway back on.
        writeHostConfig(home, { ...existing, gateway: options.gateway === "default" ? undefined : options.gateway, lanPort: undefined });
      }
      if (parsedKeepAwake !== undefined) {
        writeHostConfig(home, { ...readHostConfig(home), keepAwake: parsedKeepAwake });
      }
    }
    const running = options._foregroundHost ? undefined : await withRunningHost((client) => client.call("machine.info", {}));
    if (parsedKeepAwake !== undefined && running) {
      await withRunningHost((client) => client.call("machine.keepAwake", { mode: parsedKeepAwake })).catch(() => undefined);
    }
    if (options.daemon && !options._foregroundHost) {
      const socket = await ensureHostRunning();
      const daemon = await import("./utils/daemon.js");
      process.stderr.write(`\n  LinkShell host running (${socket})\n`);
      if (running && running.hostVersion !== pkg.version) {
        process.stderr.write(`  It is still ${running.hostVersion}; this CLI is ${pkg.version}. To update it (stops running agent turns):\n`);
        process.stderr.write("    linkshell host restart\n");
      }
      // A gateway given to a host that was already running applies now.
      if (gatewayUpdated && running) {
        const gateway = await refreshGateway(10_000);
        if (gateway) process.stderr.write(`  Gateway: ${describeGateway(gateway)}\n`);
      }
      process.stderr.write(`  Log:    ${daemon.getLogFile("host")}\n`);
      process.stderr.write("  Status: linkshell host status\n");
      process.stderr.write("  Stop:   linkshell host stop\n");
      // The first start here: the rest of the setup happens now, while someone is at the computer.
      const { offerSetup } = await import("./commands/setup.js");
      if (await offerSetup(pkg.version)) process.exit(process.exitCode ?? 0);
      const { screenAccess, describeScreen, screenReady } = await import("./commands/screen.js");
      const screen = await screenAccess().catch(() => undefined);
      if (screen && (screen === "old" || !screenReady(screen))) process.stderr.write(`  Screen: ${describeScreen(screen)}\n`);
      process.stderr.write("\n");
      return;
    }
    if (running && (gatewayUpdated || parsedKeepAwake !== undefined)) {
      if (gatewayUpdated) {
        const gateway = await refreshGateway(10_000);
        if (gateway) process.stderr.write(`\n  Gateway: ${describeGateway(gateway)}\n\n`);
      } else if (parsedKeepAwake !== undefined) {
        process.stderr.write(`\n  Keep-awake mode set to: ${parsedKeepAwake}\n\n`);
      }
      return;
    }
    await runHostForeground(pkg.version);
  });

hostCmd
  .command("status")
  .description("Show the host, its agents and sessions")
  .option("--json", "Output host status as JSON")
  .action(async (options: { json?: boolean }) => {
    const { printHostStatus } = await import("./commands/host.js");
    await printHostStatus({ json: options.json === true, cliVersion: pkg.version });
  });

hostCmd
  .command("stop")
  .description("Stop the background or service-managed host")
  .action(async () => {
    const { stopHost } = await import("./commands/host.js");
    const result = await stopHost();
    process.stderr.write(
      result.stopped
        ? result.managed
          ? "  LinkShell host service stopped\n"
          : "  LinkShell host stopped\n"
        : "  LinkShell host is not running\n",
    );
  });

hostCmd
  .command("restart")
  .description("Restart the LinkShell host (service-aware; preserves launch settings)")
  .action(async () => {
    const { restartHost, assertHostRuntime, silenceSqliteWarning } = await import("./commands/host.js");
    assertHostRuntime();
    silenceSqliteWarning();
    const result = await restartHost();
    process.stderr.write(
      result.managed
        ? `  LinkShell host service restarted (${result.socket})\n`
        : `  LinkShell host restarted (${result.socket})\n`,
    );
  });

hostCmd
  .command("install-service")
  .description("Install LinkShell host as an OS user service (auto-start on login)")
  .option("--dry-run", "Print the generated service config and commands without applying them")
  .option("--gateway <url>", "Set LINKSHELL_GATEWAY for the service ('off' to disable, 'default' to clear)")
  .action(async (options: { dryRun?: boolean; gateway?: string }, command: Command) => {
    const { runInstallService } = await import("./commands/service.js");
    const merged = command.optsWithGlobals<{ gateway?: string }>();
    await runInstallService({
      dryRun: options.dryRun === true,
      gateway: options.gateway ?? merged.gateway,
    });
  });

hostCmd
  .command("uninstall-service")
  .description("Uninstall the LinkShell host OS user service")
  .option("--dry-run", "Print the file removal and commands without applying them")
  .action(async (options: { dryRun?: boolean }) => {
    const { runUninstallService } = await import("./commands/service.js");
    await runUninstallService({ dryRun: options.dryRun === true });
  });

hostCmd
  .command("service-status")
  .description("Show the LinkShell host OS user service status")
  .option("--json", "Output service status as JSON")
  .action(async (options: { json?: boolean }) => {
    const { runServiceStatus } = await import("./commands/service.js");
    await runServiceStatus({ json: options.json === true });
  });

// Top-level alias for `linkshell host restart`
program
  .command("restart")
  .description("Restart the LinkShell host (alias for `linkshell host restart`)")
  .action(async () => {
    const { restartHost, assertHostRuntime, silenceSqliteWarning } = await import("./commands/host.js");
    assertHostRuntime();
    silenceSqliteWarning();
    const result = await restartHost();
    process.stderr.write(
      result.managed
        ? `  LinkShell host service restarted (${result.socket})\n`
        : `  LinkShell host restarted (${result.socket})\n`,
    );
  });

// ── logs ────────────────────────────────────────────────────────────

program
  .command("logs")
  .description("View or follow LinkShell host, gateway, or upgrade logs")
  .option("-f, --follow", "Stream new log lines as they are written")
  .option("-n, --lines <count>", "Number of trailing lines to show", "50")
  .option("--service <name>", "Which log to read: host, gateway, or upgrade", "host")
  .option("--journal", "Read from systemd journald on Linux (`journalctl --user`)")
  .action(async (options: { follow?: boolean; lines: string; service: string; journal?: boolean }) => {
    const { runLogs } = await import("./commands/logs.js");
    await runLogs({
      service: options.service,
      lines: Number(options.lines),
      follow: options.follow === true,
      journal: options.journal === true,
    });
  });

program
  .command("pair")
  .description("Pair a phone with this computer through the gateway (shows a QR code)")
  .option("--no-qr", "Print the pairing code and link without rendering a QR code")
  .option("--json", "Output pairing code and link as JSON without waiting")
  .action(async (options: { qr?: boolean; json?: boolean }) => {
    const { runPair } = await import("./commands/pair.js");
    await runPair({
      noQr: options.qr === false,
      json: options.json === true,
    });
  });

const passwordCmd = program
  .command("password")
  .description("Show whether this computer has an access password (other devices enter it before opening this computer)")
  .action(async () => {
    const { runPassword } = await import("./commands/password.js");
    await runPassword("status");
  });

passwordCmd
  .command("set")
  .description("Set or change this computer's access password")
  .action(async () => {
    const { runPassword } = await import("./commands/password.js");
    await runPassword("set");
  });

passwordCmd
  .command("remove")
  .description("Remove this computer's access password")
  .action(async () => {
    const { runPassword } = await import("./commands/password.js");
    await runPassword("remove");
  });

const devicesCmd = program
  .command("devices")
  .description("List the phones paired with this computer")
  .option("--json", "Output paired devices as JSON")
  .action(async (options: { json?: boolean }) => {
    const { withRunningHost, assertHostRuntime } = await import("./commands/host.js");
    assertHostRuntime();
    const gateway = await withRunningHost((client) => client.call("gateway.status", {}));
    if (!gateway) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ running: false, devices: [] }, null, 2)}\n`);
      } else {
        process.stderr.write("  LinkShell host is not running. Start it with: linkshell host --daemon\n");
      }
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ running: true, devices: gateway.devices }, null, 2)}\n`);
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
  .option("--host <addr>", "Bind address (e.g. 127.0.0.1 when behind Nginx/Caddy reverse proxy)")
  .option("--daemon", "Run in background (detached)")
  .option("--_foreground-gw", undefined) // internal
  .action(async (options: { port: string; host?: string; daemon?: boolean; _foregroundGw?: boolean }) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid --port value "${options.port}". Expected 1-65535.`);
    }
    if (options.daemon && !options._foregroundGw) {
      const { startGatewayDaemon } = await import("./commands/gateway.js");
      await startGatewayDaemon(port, options.host);
      return;
    }
    const { runGatewayForeground } = await import("./commands/gateway.js");
    await runGatewayForeground(pkg.version, port, options.host);
  });

gatewayCmd
  .command("stop")
  .description("Stop the background or service-managed gateway")
  .action(async () => {
    const { stopGateway } = await import("./commands/gateway.js");
    const result = await stopGateway();
    if (result.stopped) {
      process.stderr.write(result.managed ? "  Gateway service stopped.\n" : "  Gateway stopped.\n");
    } else {
      process.stderr.write("  No running gateway found.\n");
    }
  });

gatewayCmd
  .command("status")
  .description("Check if the gateway is running and probe /healthz")
  .option("--json", "Output gateway status as JSON")
  .option("--port <port>", "Override port to probe")
  .option("--host <addr>", "Override host address to probe")
  .action(async (options: { json?: boolean; port?: string; host?: string }) => {
    const { printGatewayStatus } = await import("./commands/gateway.js");
    await printGatewayStatus({
      json: options.json === true,
      port: options.port ? Number(options.port) : undefined,
      host: options.host,
    });
  });

gatewayCmd
  .command("install-service")
  .description("Install LinkShell gateway as an OS user service (Linux systemd --user / macOS launchd)")
  .option("--dry-run", "Print the generated service config and commands without applying them")
  .option("--port <port>", "Listen port", "8787")
  .option("--host <addr>", "Bind address (e.g. 127.0.0.1)")
  .action(async (options: { dryRun?: boolean; port: string; host?: string }) => {
    const { runInstallGatewayService } = await import("./commands/service.js");
    await runInstallGatewayService({
      dryRun: options.dryRun === true,
      port: Number(options.port),
      host: options.host,
    });
  });

gatewayCmd
  .command("uninstall-service")
  .description("Uninstall the LinkShell gateway OS user service")
  .option("--dry-run", "Print the file removal and commands without applying them")
  .action(async (options: { dryRun?: boolean }) => {
    const { runUninstallGatewayService } = await import("./commands/service.js");
    await runUninstallGatewayService({ dryRun: options.dryRun === true });
  });

// ── screen ──────────────────────────────────────────────────────────

program
  .command("screen")
  .description("Set this computer up for watching and controlling its screen from the phone (macOS permissions; Linux X11/Wayland capture & input)")
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
  .description("Stop all running LinkShell processes (service-aware)")
  .action(async () => {
    const { stopDaemon } = await import("./utils/daemon.js");
    const { stopHost } = await import("./commands/host.js");
    const { stopGateway } = await import("./commands/gateway.js");
    const hostResult = await stopHost();
    // A bridge left running by a 1.x install: nothing else here can end it.
    const bridgeStopped = stopDaemon("bridge");
    const gatewayResult = await stopGateway();
    if (hostResult.stopped) process.stderr.write(hostResult.managed ? "  Host service stopped.\n" : "  Host stopped.\n");
    if (bridgeStopped) process.stderr.write("  1.x bridge stopped.\n");
    if (gatewayResult.stopped) process.stderr.write(gatewayResult.managed ? "  Gateway service stopped.\n" : "  Gateway server stopped.\n");
    if (!hostResult.stopped && !bridgeStopped && !gatewayResult.stopped) {
      process.stderr.write("  No running processes found.\n");
    }
  });

// ── status ──────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show the host, its gateway connection, and anything else LinkShell runs here")
  .option("--json", "Output status as JSON")
  .action(async (options: { json?: boolean }) => {
    const { printHostStatus, assertHostRuntime } = await import("./commands/host.js");
    assertHostRuntime();
    if (!options.json) process.stdout.write("\n");
    await printHostStatus({ json: options.json === true, cliVersion: pkg.version, includeGatewayServer: true });
    if (!options.json) process.stdout.write("\n");
  });

// ── doctor / setup ──────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check that this computer is ready: Node, SQLite, PTY, agents, permissions, the host and its gateway")
  .option("--gateway <url>", "Also check that this gateway answers")
  .option("--json", "Output diagnostics as JSON")
  .action(async (options: { gateway?: string; json?: boolean }) => {
    await runDoctor(pkg.version, options.gateway, { json: options.json === true });
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
  .description("Upgrade LinkShell and automatically restart an outdated host")
  .option("--check", "Check CLI and running host versions without making changes")
  .action(async (options: { check?: boolean }) => {
    await runUpgrade(pkg.version, { check: options.check === true });
  });

program
  .command("login")
  .description("Log in to LinkShell (official gateway, no pairing needed; supports SSH/headless)")
  .option("--email [address]", "Sign in directly with email and password (no browser needed)")
  .option("--password-stdin", "Read account password from stdin (use with --email <address>)")
  .option("--no-browser", "Print the sign-in URL without launching a local browser")
  .action(async (options: { email?: string | boolean; passwordStdin?: boolean; browser?: boolean }) => {
    const result = await runLogin({
      email: options.email,
      passwordStdin: options.passwordStdin === true,
      noBrowser: options.browser === false,
    });
    if (!result) {
      process.exitCode = 1;
      return;
    }

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
  .command("completion <shell>")
  .description("Generate shell completion script (bash, zsh, or fish)")
  .action(async (shell: string) => {
    const { runCompletion } = await import("./commands/completion.js");
    try {
      runCompletion(shell);
    } catch (error) {
      process.stderr.write(`  ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
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
