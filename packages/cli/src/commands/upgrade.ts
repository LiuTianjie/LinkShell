import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { standaloneBundle } from "../utils/standalone.js";
import { linkshellDir } from "../utils/daemon.js";
import { stderrStyle } from "../utils/format.js";
import { withRunningHost } from "./host.js";
import { runUpgradeWorker, type CliCommand } from "./upgrade-worker.js";

export type PackageManager = "brew" | "pnpm" | "yarn" | "volta" | "bun" | "npm";

export interface UpgradeManagerSpec {
  manager: PackageManager;
  label: string;
  command: string;
  args: string[];
}

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** Infers which package manager installed this CLI from the resolved script path. */
export function detectPackageManager(resolvedPath: string): PackageManager {
  const normalized = resolvedPath.replace(/\\/g, "/");
  if (/\/(?:Cellar|opt)\/linkshell\//i.test(normalized)) return "brew";
  if (/\/\.?volta\//i.test(normalized)) return "volta";
  if (/\/\.bun\/|\/bun\/install\/global\//i.test(normalized)) return "bun";
  if (/\/\.?pnpm(?:\/|-global\/)/i.test(normalized)) return "pnpm";
  if (/\/(?:\.yarn|\.config\/yarn|yarn\/global)\//i.test(normalized)) return "yarn";
  return "npm";
}

export function upgradeCommandForManager(manager: PackageManager): UpgradeManagerSpec {
  switch (manager) {
    case "brew":
      return { manager, label: "Homebrew", command: "brew", args: ["upgrade", "linkshell"] };
    case "pnpm":
      return { manager, label: "pnpm", command: "pnpm", args: ["add", "-g", "linkshell-cli@latest"] };
    case "yarn":
      return { manager, label: "Yarn", command: "yarn", args: ["global", "add", "linkshell-cli@latest"] };
    case "volta":
      return { manager, label: "Volta", command: "volta", args: ["install", "linkshell-cli@latest"] };
    case "bun":
      return { manager, label: "Bun", command: "bun", args: ["add", "-g", "linkshell-cli@latest"] };
    case "npm":
      return { manager, label: "npm", command: "npm", args: ["install", "-g", "linkshell-cli@latest"] };
  }
}

function detectCurrentPackageManager(): PackageManager {
  try {
    return detectPackageManager(realpathSync(process.argv[1]!));
  } catch {
    return "npm";
  }
}

function normalizeRegistryUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  return trimmed.replace(/\/+$/, "");
}

function readRegistryFromNpmrc(filePath: string): string | undefined {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      const match = /^registry\s*=\s*(.+)$/i.exec(trimmed);
      if (match?.[1]) {
        const parsed = normalizeRegistryUrl(match[1]);
        if (parsed) return parsed;
      }
    }
  } catch {
    // Missing or unreadable .npmrc; fall through.
  }
  return undefined;
}

/**
 * Resolves the configured npm registry (env, `~/.npmrc`, or `npm config get registry`) so China
 * mirrors and private registries work cleanly without hardcoding registry.npmjs.org.
 */
export function resolveNpmRegistry(options: {
  env?: NodeJS.ProcessEnv;
  npmrcPath?: string;
  exec?: (command: string, args: string[]) => string;
} = {}): string {
  const env = options.env ?? process.env;
  const fromEnv = normalizeRegistryUrl(env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY);
  if (fromEnv) return fromEnv;

  const npmrc = options.npmrcPath ?? env.NPM_CONFIG_USERCONFIG ?? join(homedir(), ".npmrc");
  const fromFile = readRegistryFromNpmrc(npmrc);
  if (fromFile) return fromFile;

  try {
    const raw = options.exec
      ? options.exec("npm", ["config", "get", "registry"])
      : execFileSync("npm", ["config", "get", "registry"], {
          encoding: "utf8",
          timeout: 5_000,
          stdio: ["ignore", "pipe", "ignore"],
        });
    const fromNpm = normalizeRegistryUrl(raw);
    if (fromNpm) return fromNpm;
  } catch {
    // npm may not be installed (e.g. Homebrew or Bun-only system); fall back cleanly.
  }
  return DEFAULT_NPM_REGISTRY;
}

function installedCli(manager: PackageManager): CliCommand {
  const options: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] };
  if (manager === "brew") {
    const prefix = execFileSync("brew", ["--prefix", "linkshell"], options).trim();
    return { command: join(prefix, "bin", "linkshell"), args: [] };
  }
  if (manager === "pnpm") {
    try {
      const root = execFileSync("pnpm", ["root", "-g"], options).trim();
      if (root) return { command: process.execPath, args: [join(root, "linkshell-cli", "dist", "cli", "src", "index.js")] };
    } catch {}
    return { command: "linkshell", args: [] };
  }
  if (manager === "yarn") {
    try {
      const dir = execFileSync("yarn", ["global", "dir"], options).trim();
      if (dir) return { command: process.execPath, args: [join(dir, "node_modules", "linkshell-cli", "dist", "cli", "src", "index.js")] };
    } catch {}
    return { command: "linkshell", args: [] };
  }
  if (manager === "volta" || manager === "bun") {
    return { command: "linkshell", args: [] };
  }
  const root = execFileSync("npm", ["root", "--global"], options).trim();
  return { command: process.execPath, args: [join(root, "linkshell-cli", "dist", "cli", "src", "index.js")] };
}

export async function fetchLatestVersion(registry = resolveNpmRegistry()): Promise<string | null> {
  try {
    const res = await fetch(`${registry}/linkshell-cli/latest`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

function isPermissionError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message} ${String((error as { stderr?: unknown }).stderr ?? "")}`
      : String(error);
  return /\bEACCES\b|\bEPERM\b|permission denied/i.test(text);
}

export async function runUpgrade(current: string, options: { check?: boolean } = {}): Promise<void> {
  const style = stderrStyle();
  const app = standaloneBundle();
  if (app && !options.check) {
    if (process.platform === "win32") {
      process.stderr.write("  Windows 桌面版请通过新版安装包一起更新 App、CLI 和 Host：\n  https://github.com/LiuTianjie/LinkShell/releases\n");
      return;
    }
    execFileSync("/usr/bin/open", ["-n", "-a", app, "--args", "--dashboard", "--check-updates", "--home", linkshellDir()]);
    process.stderr.write("  已打开 LinkShell 软件更新；App、内置 CLI 和 Host 将一起更新。\n");
    return;
  }

  const registry = resolveNpmRegistry();
  process.stderr.write(`\n  Current version: ${current}\n  Checking for updates...\n\n`);
  const latest = await fetchLatestVersion(registry);
  if (!latest) {
    process.stderr.write(`  ${style.red("✗")} Could not reach npm registry (${registry}).\n\n`);
    process.exitCode = 1;
    return;
  }

  if (options.check) {
    const runningHost = await withRunningHost((client) => client.call("machine.info", {}, 3000)).catch(() => undefined);
    const cliOutdated = latest !== current;
    const hostOutdated = Boolean(runningHost && runningHost.hostVersion !== current);
    process.stderr.write(`  CLI version:    ${current}${cliOutdated ? ` → ${style.green(latest)} available` : ` (${style.green("up to date")})`}\n`);
    process.stderr.write(`  Latest version: ${latest} (${registry})\n`);
    if (runningHost) {
      process.stderr.write(
        `  Running host:   ${runningHost.hostVersion}${hostOutdated ? ` (${style.yellow(`outdated; CLI is ${current}`)})` : ` (${style.green("matches CLI")})`}\n`,
      );
    } else {
      process.stderr.write("  Running host:   stopped\n");
    }
    if (cliOutdated) {
      process.stderr.write("\n  Run `linkshell upgrade` to install the latest release.\n\n");
    } else if (hostOutdated) {
      process.stderr.write("\n  Run `linkshell host restart` (or `linkshell upgrade`) to update the running host.\n\n");
    } else {
      process.stderr.write("\n");
    }
    return;
  }

  let cli: CliCommand = { command: process.execPath, args: [...process.execArgv, process.argv[1]!] };
  if (latest !== current) {
    const manager = detectCurrentPackageManager();
    const spec = upgradeCommandForManager(manager);
    process.stderr.write(`  New version available: ${current} → ${style.green(latest)}\n  Upgrading via ${spec.label}...\n`);
    try {
      execFileSync(spec.command, spec.args, { stdio: "inherit", timeout: 120_000 });
      cli = installedCli(manager);
    } catch (error) {
      process.stderr.write(`\n  ${style.red("✗")} Upgrade failed: ${error instanceof Error ? error.message : String(error)}\n`);
      if (isPermissionError(error)) {
        process.stderr.write("  Global install directory is not writable by this user.\n");
        if (manager === "npm") {
          process.stderr.write("  Option 1 (recommended, no sudo): mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && npm install -g linkshell-cli@latest\n");
          process.stderr.write("  Option 2: sudo npm install -g linkshell-cli@latest\n\n");
        } else {
          process.stderr.write(`  Retry with appropriate permissions: ${spec.command} ${spec.args.join(" ")}\n\n`);
        }
      } else {
        process.stderr.write(`  Retry with: ${spec.command} ${spec.args.join(" ")}\n\n`);
      }
      process.exitCode = 1;
      return;
    }
  } else {
    process.stderr.write(`  CLI is already on the latest version (${current}). Checking the host...\n`);
  }

  try {
    const installed = execFileSync(cli.command, [...cli.args, "--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    if (installed !== latest) throw new Error(`Expected CLI ${latest}, but the installed command reports ${installed}. The running host was left alone.`);
    // npm replaces files; Homebrew can remove the old Cellar directory. Only
    // the newly installed CLI can safely launch the new host without cached code.
    process.stderr.write(await runUpgradeWorker(cli));
    process.stderr.write(`\n  ${style.green("✓")} LinkShell ${latest} is ready.\n\n`);
  } catch (error) {
    process.stderr.write(`\n  ${style.red("✗")} Could not finish the host update: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("  Check linkshell host status, then run linkshell upgrade again to retry.\n\n");
    process.exitCode = 1;
  }
}
