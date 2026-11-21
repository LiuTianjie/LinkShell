import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { standaloneBundle } from "../utils/standalone.js";

export type ServicePlatform = "darwin" | "linux" | "win32";

export const MACOS_SERVICE_LABEL = "com.bd.linkshell.cli-host";
export const LINUX_SERVICE_UNIT = "linkshell-host.service";
export const WINDOWS_TASK_NAME = "LinkShell Host";
export const WINDOWS_WRAPPER_NAME = "host-service.cmd";

export interface ServiceCommand {
  command: string;
  args: string[];
  ignoreFailure?: boolean;
}

export interface ServiceContextOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  linkshellHome?: string;
  uid?: number;
  xdgConfigHome?: string;
  nodePath?: string;
  execArgv?: string[];
  entryScript?: string;
  gateway?: string;
}

export interface ServiceContext {
  platform: ServicePlatform;
  homeDir: string;
  linkshellHome: string;
  isCustomLinkshellHome: boolean;
  uid?: number;
  xdgConfigHome?: string;
  nodePath: string;
  execArgv: string[];
  entryScript: string;
  pathEnv?: string;
  gateway?: string;
}

export interface InstallServicePlan {
  platform: ServicePlatform;
  serviceName: string;
  filePath: string;
  fileContent: string;
  fileMode: number;
  logPath: string;
  linkshellHome: string;
  commands: ServiceCommand[];
  fallbackCommands?: ServiceCommand[];
}

export interface UninstallServicePlan {
  platform: ServicePlatform;
  serviceName: string;
  filePath: string;
  commands: ServiceCommand[];
  postRemoveCommands?: ServiceCommand[];
  fallbackCommands?: ServiceCommand[];
}

export interface ServiceStatusResult {
  platform: ServicePlatform;
  serviceName: string;
  filePath: string;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  enabled?: boolean;
  pid?: number;
  state: "running" | "stopped" | "not-installed" | "unknown";
  detail?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface ServiceFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, options?: { mode?: number }): void;
  rmSync(path: string, options?: { force?: boolean }): void;
}

export interface ServiceDeps {
  runner?: CommandRunner;
  fs?: ServiceFs;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  stopExistingHost?: (linkshellHome: string) => Promise<boolean>;
}

const DEFAULT_FS: ServiceFs = {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
};

function platformPath(platform: ServicePlatform) {
  return platform === "win32" ? win32 : posix;
}

function normalizePathForCompare(platform: ServicePlatform, targetPath: string): string {
  const pathApi = platformPath(platform);
  const resolved = pathApi.resolve(targetPath);
  const root = pathApi.parse(resolved).root;
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function resolveHomeDir(platform: ServicePlatform, env: NodeJS.ProcessEnv, override?: string): string {
  if (override?.trim()) return override.trim();
  if (platform === "win32") return env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
  return env.HOME?.trim() || homedir();
}

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): ServicePlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  throw new Error(
    `Unsupported platform "${platform}" for OS service management. Supported platforms: macOS (darwin), Linux (linux), Windows (win32).`,
  );
}

/** Validates `--gateway` for service installation without persisting side effects during planning. */
export function normalizeGatewayOption(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Invalid --gateway value "". Pass a gateway URL (ws:// or wss://), "off", or "default".');
  }
  const lower = trimmed.toLowerCase();
  if (lower === "default") return undefined;
  if (lower === "off") return "off";
  if (/[\r\n\0]/.test(trimmed)) {
    throw new Error(`Invalid --gateway value "${raw}".`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid --gateway URL "${raw}". Expected ws://, wss://, http://, https://, "off", or "default".`);
  }
  if (!["ws:", "wss:", "http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`Invalid --gateway URL "${raw}". Expected ws://, wss://, http://, or https://.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Gateway URL cannot embed credentials.");
  }
  return trimmed.replace(/\/+$/, "");
}

export function resolveServiceContext(options: ServiceContextOptions = {}): ServiceContext {
  const platform = assertSupportedPlatform(options.platform ?? process.platform);
  const env = options.env ?? process.env;
  const pathApi = platformPath(platform);
  const homeDir = resolveHomeDir(platform, env, options.homeDir);
  const defaultHome = pathApi.join(homeDir, ".linkshell");
  const explicitHome = (options.linkshellHome ?? env.LINKSHELL_HOME)?.trim() || undefined;
  const linkshellHome = explicitHome ? pathApi.resolve(explicitHome) : defaultHome;
  const isCustomLinkshellHome =
    Boolean(explicitHome) &&
    normalizePathForCompare(platform, linkshellHome) !== normalizePathForCompare(platform, defaultHome);

  let uid: number | undefined;
  if (platform === "darwin") {
    uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    if (uid === undefined || !Number.isInteger(uid) || uid < 0) {
      throw new Error("Could not determine the current user UID for launchctl.");
    }
  }

  const rawEntry = options.entryScript ?? process.argv[1];
  if (!rawEntry?.trim()) {
    throw new Error("Could not resolve LinkShell CLI entry script path.");
  }
  // Resolve symlinks only for standalone app bundles; package-manager bin symlinks stay valid across upgrades.
  const entryScript = !options.entryScript && standaloneBundle(rawEntry) ? realpathSync(rawEntry) : pathApi.resolve(rawEntry);
  const execArgv =
    options.execArgv !== undefined
      ? [...options.execArgv]
      : process.execArgv.filter((arg) => !/^--(inspect|debug|prof|cpu-prof|heap-prof)\b/.test(arg));

  return {
    platform,
    homeDir,
    linkshellHome,
    isCustomLinkshellHome,
    uid,
    xdgConfigHome: (options.xdgConfigHome ?? env.XDG_CONFIG_HOME)?.trim() || undefined,
    nodePath: options.nodePath ?? process.execPath,
    execArgv,
    entryScript,
    pathEnv: env.PATH?.trim() || undefined,
    gateway: normalizeGatewayOption(options.gateway),
  };
}

export function serviceNameForPlatform(platform: ServicePlatform): string {
  switch (platform) {
    case "darwin":
      return MACOS_SERVICE_LABEL;
    case "linux":
      return LINUX_SERVICE_UNIT;
    case "win32":
      return WINDOWS_TASK_NAME;
  }
}

export function resolveServiceFilePath(
  ctx: Pick<ServiceContext, "platform" | "homeDir" | "linkshellHome" | "xdgConfigHome">,
): string {
  switch (ctx.platform) {
    case "darwin":
      return posix.join(ctx.homeDir, "Library", "LaunchAgents", `${MACOS_SERVICE_LABEL}.plist`);
    case "linux": {
      const configBase = ctx.xdgConfigHome || posix.join(ctx.homeDir, ".config");
      return posix.join(configBase, "systemd", "user", LINUX_SERVICE_UNIT);
    }
    case "win32":
      return win32.join(ctx.linkshellHome, WINDOWS_WRAPPER_NAME);
  }
}

function hostForegroundArgs(ctx: Pick<ServiceContext, "execArgv" | "entryScript">): string[] {
  return [...ctx.execArgv, ctx.entryScript, "host", "--_foreground-host"];
}

function buildServiceEnvironment(ctx: ServiceContext): Record<string, string> {
  const env: Record<string, string> = {};
  // launchd starts with a minimal PATH unless preserved; resolveLoginShellEnv runs inside the host for agent tools.
  if (ctx.platform === "darwin" && ctx.pathEnv) {
    env.PATH = ctx.pathEnv;
  }
  if (ctx.isCustomLinkshellHome) {
    env.LINKSHELL_HOME = ctx.linkshellHome;
  }
  if (ctx.gateway !== undefined) {
    env.LINKSHELL_GATEWAY = ctx.gateway;
  }
  return env;
}

function sanitizeControlChars(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Service configuration values cannot contain NUL bytes.");
  }
  return value.replace(/[\r\n]/g, "");
}

function escapeXml(value: string): string {
  return sanitizeControlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatSystemdPathOrValue(value: string): string {
  return sanitizeControlChars(value).replace(/%/g, "%%");
}

function formatSystemdExecArg(arg: string): string {
  const escaped = sanitizeControlChars(arg)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, "$$");
  return arg === "" || /[\s"'\\$%;]/.test(arg) ? `"${escaped}"` : escaped;
}

function formatSystemdEnvAssignment(key: string, value: string): string {
  const escaped = sanitizeControlChars(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%");
  return `Environment="${key}=${escaped}"`;
}

function escapeBatchValue(value: string): string {
  return sanitizeControlChars(value).replace(/%/g, "%%");
}

function formatBatchArg(arg: string): string {
  const escaped = escapeBatchValue(arg).replace(/"/g, '\\"');
  return arg === "" || /[\s"&^|<>()%!]/.test(arg) ? `"${escaped}"` : escaped;
}

export function buildLaunchdPlist(ctx: ServiceContext): string {
  const programArgs = [ctx.nodePath, ...hostForegroundArgs(ctx)];
  const logPath = posix.join(ctx.linkshellHome, "host.log");
  const env = buildServiceEnvironment(ctx);
  const envEntries = Object.entries(env);

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(MACOS_SERVICE_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...programArgs.map((arg) => `    <string>${escapeXml(arg)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(ctx.homeDir)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(logPath)}</string>`,
  ];

  if (envEntries.length > 0) {
    lines.push("  <key>EnvironmentVariables</key>", "  <dict>");
    for (const [key, value] of envEntries) {
      lines.push(`    <key>${escapeXml(key)}</key>`, `    <string>${escapeXml(value)}</string>`);
    }
    lines.push("  </dict>");
  }

  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

export function buildSystemdUnit(ctx: ServiceContext): string {
  const execParts = [ctx.nodePath, ...hostForegroundArgs(ctx)].map(formatSystemdExecArg);
  const logPath = posix.join(ctx.linkshellHome, "host.log");
  const envEntries = Object.entries(buildServiceEnvironment(ctx));

  const lines: string[] = [
    "[Unit]",
    "Description=LinkShell Host",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${formatSystemdPathOrValue(ctx.homeDir)}`,
    `ExecStart=${execParts.join(" ")}`,
    "Restart=on-failure",
    "RestartSec=3",
    `StandardOutput=append:${formatSystemdPathOrValue(logPath)}`,
    `StandardError=append:${formatSystemdPathOrValue(logPath)}`,
    ...envEntries.map(([key, value]) => formatSystemdEnvAssignment(key, value)),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];

  return lines.join("\n");
}

export function buildWindowsWrapperCmd(ctx: ServiceContext): string {
  const logPath = win32.join(ctx.linkshellHome, "host.log");
  const envEntries = Object.entries(buildServiceEnvironment(ctx));
  const commandParts = [ctx.nodePath, ...hostForegroundArgs(ctx)].map(formatBatchArg);

  const lines: string[] = [
    "@echo off",
    "setlocal",
    ...envEntries.map(([key, value]) => `set "${key}=${escapeBatchValue(value)}"`),
    `${commandParts.join(" ")} >> "${escapeBatchValue(logPath)}" 2>&1`,
    "",
  ];

  return lines.join("\r\n");
}

export function planInstallService(options: ServiceContextOptions = {}): InstallServicePlan {
  const ctx = resolveServiceContext(options);
  const pathApi = platformPath(ctx.platform);
  const filePath = resolveServiceFilePath(ctx);
  const logPath = pathApi.join(ctx.linkshellHome, "host.log");

  if (ctx.platform === "darwin") {
    const domain = `gui/${ctx.uid}`;
    return {
      platform: "darwin",
      serviceName: MACOS_SERVICE_LABEL,
      filePath,
      fileContent: buildLaunchdPlist(ctx),
      fileMode: 0o644,
      logPath,
      linkshellHome: ctx.linkshellHome,
      commands: [
        { command: "launchctl", args: ["bootout", `${domain}/${MACOS_SERVICE_LABEL}`], ignoreFailure: true },
        { command: "launchctl", args: ["bootstrap", domain, filePath] },
      ],
      fallbackCommands: [
        { command: "launchctl", args: ["unload", "-w", filePath], ignoreFailure: true },
        { command: "launchctl", args: ["load", "-w", filePath] },
      ],
    };
  }

  if (ctx.platform === "linux") {
    return {
      platform: "linux",
      serviceName: LINUX_SERVICE_UNIT,
      filePath,
      fileContent: buildSystemdUnit(ctx),
      fileMode: 0o644,
      logPath,
      linkshellHome: ctx.linkshellHome,
      commands: [
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { command: "systemctl", args: ["--user", "enable", "--now", LINUX_SERVICE_UNIT] },
      ],
    };
  }

  return {
    platform: "win32",
    serviceName: WINDOWS_TASK_NAME,
    filePath,
    fileContent: buildWindowsWrapperCmd(ctx),
    fileMode: 0o755,
    logPath,
    linkshellHome: ctx.linkshellHome,
    commands: [
      {
        command: "schtasks",
        args: ["/Create", "/F", "/TN", WINDOWS_TASK_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", `"${filePath}"`],
      },
      { command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] },
    ],
  };
}

export function planUninstallService(options: ServiceContextOptions = {}): UninstallServicePlan {
  const ctx = resolveServiceContext(options);
  const filePath = resolveServiceFilePath(ctx);

  if (ctx.platform === "darwin") {
    return {
      platform: "darwin",
      serviceName: MACOS_SERVICE_LABEL,
      filePath,
      commands: [{ command: "launchctl", args: ["bootout", `gui/${ctx.uid}/${MACOS_SERVICE_LABEL}`], ignoreFailure: true }],
      fallbackCommands: [{ command: "launchctl", args: ["unload", "-w", filePath], ignoreFailure: true }],
    };
  }

  if (ctx.platform === "linux") {
    return {
      platform: "linux",
      serviceName: LINUX_SERVICE_UNIT,
      filePath,
      commands: [{ command: "systemctl", args: ["--user", "disable", "--now", LINUX_SERVICE_UNIT], ignoreFailure: true }],
      postRemoveCommands: [{ command: "systemctl", args: ["--user", "daemon-reload"], ignoreFailure: true }],
    };
  }

  return {
    platform: "win32",
    serviceName: WINDOWS_TASK_NAME,
    filePath,
    commands: [
      { command: "schtasks", args: ["/End", "/TN", WINDOWS_TASK_NAME], ignoreFailure: true },
      { command: "schtasks", args: ["/Delete", "/F", "/TN", WINDOWS_TASK_NAME], ignoreFailure: true },
    ],
  };
}

function quoteDisplayArg(arg: string): string {
  return arg === "" || /[\s"'\\]/.test(arg) ? `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : arg;
}

export function formatCommand(cmd: ServiceCommand): string {
  return [cmd.command, ...cmd.args].map(quoteDisplayArg).join(" ");
}

export function formatInstallDryRun(plan: InstallServicePlan): string {
  const lines = [
    "",
    "  Dry run — no files written and no commands executed.",
    "",
    `  Service:     ${plan.serviceName}`,
    `  Target file: ${plan.filePath}`,
    `  Log file:    ${plan.logPath}`,
    "",
    "  Generated config:",
    ...plan.fileContent.trimEnd().split(/\r?\n/).map((line) => `  ${line}`),
    "",
    "  Commands to run:",
    ...plan.commands.map((cmd) => `    ${formatCommand(cmd)}${cmd.ignoreFailure ? "  (ignore if not loaded)" : ""}`),
    "",
  ];
  return lines.join("\n");
}

export function formatUninstallDryRun(plan: UninstallServicePlan): string {
  const lines = [
    "",
    "  Dry run — no files removed and no commands executed.",
    "",
    `  Service:          ${plan.serviceName}`,
    `  File to remove:   ${plan.filePath}`,
    "",
    "  Commands to run:",
    ...plan.commands.map((cmd) => `    ${formatCommand(cmd)}${cmd.ignoreFailure ? "  (ignore if not loaded)" : ""}`),
    ...(plan.postRemoveCommands ?? []).map(
      (cmd) => `    ${formatCommand(cmd)}${cmd.ignoreFailure ? "  (ignore if not loaded)" : ""}`,
    ),
    "",
  ];
  return lines.join("\n");
}

const defaultRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
        return;
      }
      const code = typeof (error as NodeJS.ErrnoException & { status?: unknown }).code === "number"
        ? Number((error as NodeJS.ErrnoException & { status?: number }).code)
        : typeof (error as { status?: unknown }).status === "number"
          ? Number((error as { status?: number }).status)
          : 1;
      resolve({
        exitCode: code,
        stdout: stdout ?? "",
        stderr: stderr ?? error.message,
        error,
      });
    });
  });

function isLegacyLaunchctlUnsupported(result: CommandResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`;
  return /unrecognized subcommand|unknown subcommand|not supported|usage:\s*launchctl/i.test(combined);
}

function formatCommandFailure(cmd: ServiceCommand, result: CommandResult): string {
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" — ");
  const base = `${formatCommand(cmd)} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`;
  if (cmd.command === "launchctl" && /input\/output error/i.test(detail)) {
    return `${base} — ensure you are running inside an active macOS user GUI session`;
  }
  return base;
}

async function runServiceCommand(runner: CommandRunner, cmd: ServiceCommand): Promise<CommandResult> {
  const result = await runner(cmd.command, cmd.args);
  if (result.exitCode !== 0 && !cmd.ignoreFailure) {
    throw new Error(formatCommandFailure(cmd, result));
  }
  return result;
}

async function stopHostByPidFile(
  linkshellHome: string,
  platform: ServicePlatform,
  fsImpl: ServiceFs,
): Promise<boolean> {
  const pidFile = platformPath(platform).join(linkshellHome, "host.pid");
  if (!fsImpl.existsSync(pidFile)) return false;

  const pid = Number(fsImpl.readFileSync(pidFile, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // Import lazily so module load never caches LINKSHELL_HOME before tests or callers set it.
  const daemon = await import("../utils/daemon.js");
  if (normalizePathForCompare(platform, linkshellHome) === normalizePathForCompare(platform, daemon.linkshellDir())) {
    return daemon.stopDaemonAndWait("host", 15_000, pid);
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        fsImpl.rmSync(pidFile, { force: true });
        return true;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Existing LinkShell host (PID ${pid}) did not stop within 10s.`);
}

export async function runInstallService(
  options: ServiceContextOptions & { dryRun?: boolean } = {},
  deps: ServiceDeps = {},
): Promise<InstallServicePlan> {
  const plan = planInstallService(options);
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  if (options.dryRun) {
    stdout(formatInstallDryRun(plan));
    return plan;
  }

  const fsImpl = deps.fs ?? DEFAULT_FS;
  const runner = deps.runner ?? defaultRunner;
  const stopExisting = deps.stopExistingHost ?? ((home: string) => stopHostByPidFile(home, plan.platform, fsImpl));
  const pathApi = platformPath(plan.platform);

  let wasSystemdActive = false;
  if (plan.platform === "darwin") {
    const bootout = await runner(plan.commands[0]!.command, plan.commands[0]!.args);
    if (bootout.exitCode !== 0 && isLegacyLaunchctlUnsupported(bootout) && plan.fallbackCommands?.[0]) {
      await runner(plan.fallbackCommands[0].command, plan.fallbackCommands[0].args);
    }
    await stopExisting(plan.linkshellHome);
  } else if (plan.platform === "linux") {
    const activeProbe = await runner("systemctl", ["--user", "is-active", LINUX_SERVICE_UNIT]);
    wasSystemdActive = activeProbe.exitCode === 0 && activeProbe.stdout.trim() === "active";
  }

  fsImpl.mkdirSync(pathApi.dirname(plan.filePath), { recursive: true });
  fsImpl.mkdirSync(plan.linkshellHome, { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(plan.filePath, plan.fileContent, { mode: plan.fileMode });

  if (plan.platform === "darwin") {
    const bootstrapCmd = plan.commands[1]!;
    const bootstrapRes = await runner(bootstrapCmd.command, bootstrapCmd.args);
    if (bootstrapRes.exitCode !== 0) {
      if (isLegacyLaunchctlUnsupported(bootstrapRes) && plan.fallbackCommands) {
        for (const cmd of plan.fallbackCommands) {
          await runServiceCommand(runner, cmd);
        }
      } else {
        throw new Error(formatCommandFailure(bootstrapCmd, bootstrapRes));
      }
    }
  } else if (plan.platform === "linux") {
    await runServiceCommand(runner, plan.commands[0]!);
    if (!wasSystemdActive) {
      await stopExisting(plan.linkshellHome);
    }
    await runServiceCommand(runner, plan.commands[1]!);
    if (wasSystemdActive) {
      await runServiceCommand(runner, { command: "systemctl", args: ["--user", "restart", LINUX_SERVICE_UNIT] });
    }
  } else {
    await stopExisting(plan.linkshellHome);
    for (const cmd of plan.commands) {
      await runServiceCommand(runner, cmd);
    }
  }

  stdout(
    [
      "",
      `  \x1b[32m✓\x1b[0m Installed LinkShell host service (${plan.serviceName})`,
      `    File:   ${plan.filePath}`,
      `    Log:    ${plan.logPath}`,
      `    Status: linkshell host service-status`,
      `    Remove: linkshell host uninstall-service`,
      "",
    ].join("\n"),
  );
  return plan;
}

export async function runUninstallService(
  options: ServiceContextOptions & { dryRun?: boolean } = {},
  deps: ServiceDeps = {},
): Promise<UninstallServicePlan> {
  const plan = planUninstallService(options);
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  if (options.dryRun) {
    stdout(formatUninstallDryRun(plan));
    return plan;
  }

  const fsImpl = deps.fs ?? DEFAULT_FS;
  const runner = deps.runner ?? defaultRunner;
  const hadFile = fsImpl.existsSync(plan.filePath);

  for (const cmd of plan.commands) {
    const res = await runServiceCommand(runner, cmd);
    if (
      plan.platform === "darwin" &&
      cmd.args[0] === "bootout" &&
      res.exitCode !== 0 &&
      isLegacyLaunchctlUnsupported(res) &&
      plan.fallbackCommands?.[0]
    ) {
      await runServiceCommand(runner, plan.fallbackCommands[0]);
    }
  }

  fsImpl.rmSync(plan.filePath, { force: true });

  for (const cmd of plan.postRemoveCommands ?? []) {
    await runServiceCommand(runner, cmd);
  }

  stdout(
    hadFile
      ? `\n  \x1b[32m✓\x1b[0m Uninstalled LinkShell host service (${plan.serviceName})\n\n`
      : `\n  LinkShell host service (${plan.serviceName}) is already uninstalled.\n\n`,
  );
  return plan;
}

export function parseMacServiceStatus(
  installed: boolean,
  result: CommandResult,
  filePath: string,
  isLegacyList = false,
): ServiceStatusResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode === 0) {
    if (isLegacyList) {
      const pidMatch = /"PID"\s*=\s*(\d+)\s*;/.exec(result.stdout);
      const pid = pidMatch?.[1] ? Number(pidMatch[1]) : undefined;
      const running = pid !== undefined;
      return {
        platform: "darwin",
        serviceName: MACOS_SERVICE_LABEL,
        filePath,
        installed,
        loaded: true,
        running,
        enabled: true,
        ...(pid !== undefined ? { pid } : {}),
        state: running ? "running" : "stopped",
      };
    }

    const stateMatch = /^\s*state\s*=\s*(.+)$/im.exec(result.stdout);
    const stateLabel = stateMatch?.[1]?.trim().toLowerCase();
    const pidMatch = /^\s*pid\s*=\s*(\d+)$/im.exec(result.stdout);
    const pid = pidMatch?.[1] ? Number(pidMatch[1]) : undefined;
    const running = stateLabel === "running" || (pid !== undefined && stateLabel !== "not running");
    const lastExitMatch = /^\s*last exit code\s*=\s*(.+)$/im.exec(result.stdout);
    const detail = !running && stateLabel ? `${stateLabel}${lastExitMatch?.[1] ? ` (last exit: ${lastExitMatch[1].trim()})` : ""}` : undefined;

    return {
      platform: "darwin",
      serviceName: MACOS_SERVICE_LABEL,
      filePath,
      installed,
      loaded: true,
      running,
      enabled: true,
      ...(pid !== undefined ? { pid } : {}),
      state: running ? "running" : "stopped",
      ...(detail ? { detail } : {}),
    };
  }

  if (/could not find service|service not found/i.test(combined) || result.exitCode === 113) {
    return {
      platform: "darwin",
      serviceName: MACOS_SERVICE_LABEL,
      filePath,
      installed,
      loaded: false,
      running: false,
      state: installed ? "stopped" : "not-installed",
      ...(installed ? { detail: "plist exists, service not currently loaded" } : {}),
    };
  }

  return {
    platform: "darwin",
    serviceName: MACOS_SERVICE_LABEL,
    filePath,
    installed,
    loaded: false,
    running: false,
    state: installed ? "unknown" : "not-installed",
    detail: combined.trim() || `launchctl exited with code ${result.exitCode}`,
  };
}

export function parseLinuxServiceStatus(
  installed: boolean,
  isActiveResult: CommandResult,
  statusResult: CommandResult,
  filePath: string,
): ServiceStatusResult {
  const activeText = isActiveResult.stdout.trim().toLowerCase();
  const statusText = statusResult.stdout;
  const statusErr = `${statusResult.stderr}\n${isActiveResult.stderr}`.trim();

  if (/failed to connect to bus|not been booted with systemd/i.test(`${statusText}\n${statusErr}`)) {
    return {
      platform: "linux",
      serviceName: LINUX_SERVICE_UNIT,
      filePath,
      installed,
      loaded: false,
      running: false,
      state: installed ? "unknown" : "not-installed",
      detail: statusErr || "systemd user session unavailable",
    };
  }

  const loadedMatch = /^\s*Loaded:\s*loaded\s*\([^;]+;\s*([^;)]+)/im.exec(statusText);
  const notFound = /^\s*Loaded:\s*not-found\b/im.test(statusText) || /could not be found/i.test(statusErr);
  const loaded = Boolean(loadedMatch) || (!notFound && (activeText === "active" || activeText === "activating" || activeText === "failed"));
  const enabledState = loadedMatch?.[1]?.trim().toLowerCase();
  const enabled = enabledState ? enabledState === "enabled" : undefined;

  const pidMatch = /^\s*Main PID:\s*(\d+)/im.exec(statusText);
  const pid = pidMatch?.[1] ? Number(pidMatch[1]) : undefined;
  const running = activeText === "active" || /^\s*Active:\s*active\s*\(running\)/im.test(statusText);

  if (!installed && !loaded && !running) {
    return {
      platform: "linux",
      serviceName: LINUX_SERVICE_UNIT,
      filePath,
      installed: false,
      loaded: false,
      running: false,
      state: "not-installed",
    };
  }

  const activeLine = /^\s*Active:\s*(.+)$/im.exec(statusText)?.[1]?.trim();
  return {
    platform: "linux",
    serviceName: LINUX_SERVICE_UNIT,
    filePath,
    installed,
    loaded,
    running,
    ...(enabled !== undefined ? { enabled } : {}),
    ...(pid !== undefined ? { pid } : {}),
    state: running ? "running" : "stopped",
    ...(!running && (activeText || activeLine) ? { detail: activeLine || activeText } : {}),
  };
}

export function parseWindowsServiceStatus(
  wrapperExists: boolean,
  queryResult: CommandResult,
  filePath: string,
): ServiceStatusResult {
  const combined = `${queryResult.stdout}\n${queryResult.stderr}`.trim();
  if (queryResult.exitCode === 0) {
    const statusMatch = /^\s*(?:Status|状态)\s*:\s*(.+)$/im.exec(queryResult.stdout);
    const rawStatus = statusMatch?.[1]?.trim();
    const lower = rawStatus?.toLowerCase() ?? "";
    const running = lower === "running" || rawStatus === "正在运行";
    const disabled = lower === "disabled" || rawStatus === "已禁用";
    const detail = !wrapperExists
      ? "scheduled task exists, wrapper script missing"
      : !running && rawStatus
        ? rawStatus
        : undefined;

    return {
      platform: "win32",
      serviceName: WINDOWS_TASK_NAME,
      filePath,
      installed: true,
      loaded: true,
      running,
      enabled: !disabled,
      state: running ? "running" : "stopped",
      ...(detail ? { detail } : {}),
    };
  }

  if (/cannot find|does not exist|找不到/i.test(combined)) {
    return {
      platform: "win32",
      serviceName: WINDOWS_TASK_NAME,
      filePath,
      installed: wrapperExists,
      loaded: false,
      running: false,
      state: wrapperExists ? "stopped" : "not-installed",
      ...(wrapperExists ? { detail: "wrapper script exists, scheduled task not registered" } : {}),
    };
  }

  return {
    platform: "win32",
    serviceName: WINDOWS_TASK_NAME,
    filePath,
    installed: wrapperExists,
    loaded: false,
    running: false,
    state: wrapperExists ? "unknown" : "not-installed",
    detail: combined || `schtasks exited with code ${queryResult.exitCode}`,
  };
}

export function formatServiceStatus(status: ServiceStatusResult): string {
  const dot = status.running ? "\x1b[32m●\x1b[0m" : "\x1b[2m○\x1b[0m";
  const stateLine = `${dot} ${status.state}${status.pid !== undefined ? ` (PID ${status.pid})` : ""}${status.detail ? ` — ${status.detail}` : ""}`;
  const lines = [
    "",
    `  Service:   ${status.serviceName}`,
    `  State:     ${stateLine}`,
    `  Installed: ${status.installed ? `yes (${status.filePath})` : `no (${status.filePath})`}`,
    `  Loaded:    ${status.loaded ? "yes" : "no"}`,
    ...(status.enabled !== undefined ? [`  Enabled:   ${status.enabled ? "yes" : "no"}`] : []),
    "",
  ];
  return lines.join("\n");
}

export async function getServiceStatus(
  options: ServiceContextOptions = {},
  deps: ServiceDeps = {},
): Promise<ServiceStatusResult> {
  const ctx = resolveServiceContext(options);
  const filePath = resolveServiceFilePath(ctx);
  const fsImpl = deps.fs ?? DEFAULT_FS;
  const runner = deps.runner ?? defaultRunner;
  const installed = fsImpl.existsSync(filePath);

  if (ctx.platform === "darwin") {
    const result = await runner("launchctl", ["print", `gui/${ctx.uid}/${MACOS_SERVICE_LABEL}`]);
    if (result.exitCode !== 0 && isLegacyLaunchctlUnsupported(result)) {
      const legacy = await runner("launchctl", ["list", MACOS_SERVICE_LABEL]);
      return parseMacServiceStatus(installed, legacy, filePath, true);
    }
    return parseMacServiceStatus(installed, result, filePath);
  }

  if (ctx.platform === "linux") {
    const [isActiveResult, statusResult] = await Promise.all([
      runner("systemctl", ["--user", "is-active", LINUX_SERVICE_UNIT]),
      runner("systemctl", ["--user", "status", LINUX_SERVICE_UNIT, "--no-pager"]),
    ]);
    return parseLinuxServiceStatus(installed, isActiveResult, statusResult, filePath);
  }

  const queryResult = await runner("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME, "/V", "/FO", "LIST"]);
  return parseWindowsServiceStatus(installed, queryResult, filePath);
}

export async function runServiceStatus(
  options: ServiceContextOptions & { json?: boolean } = {},
  deps: ServiceDeps = {},
): Promise<ServiceStatusResult> {
  const status = await getServiceStatus(options, deps);
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  stdout(options.json ? `${JSON.stringify(status, null, 2)}\n` : formatServiceStatus(status));
  return status;
}
