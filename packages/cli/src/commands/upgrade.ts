import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { standaloneBundle } from "../utils/standalone.js";
import { linkshellDir } from "../utils/daemon.js";
import { runUpgradeWorker, type CliCommand } from "./upgrade-worker.js";

function isBrewInstall(): boolean {
  try {
    // A separate Homebrew installation must not change how this CLI upgrades.
    return realpathSync(process.argv[1]!).includes(`${sep}Cellar${sep}linkshell${sep}`);
  } catch {
    return false;
  }
}

function installedCli(brew: boolean): CliCommand {
  const options: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] };
  if (brew) {
    const prefix = execFileSync("brew", ["--prefix", "linkshell"], options).trim();
    return { command: join(prefix, "bin", "linkshell"), args: [] };
  }
  const root = execFileSync("npm", ["root", "--global"], options).trim();
  return { command: process.execPath, args: [join(root, "linkshell-cli", "dist", "cli", "src", "index.js")] };
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/linkshell-cli/latest", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

export async function runUpgrade(current: string): Promise<void> {
  const app = standaloneBundle();
  if (app) {
    execFileSync("/usr/bin/open", ["-n", "-a", app, "--args", "--dashboard", "--check-updates", "--home", linkshellDir()]);
    process.stderr.write("  已打开 LinkShell 软件更新；App、内置 CLI 和 Host 将一起更新。\n");
    return;
  }

  process.stderr.write(`\n  Current version: ${current}\n  Checking for updates...\n\n`);
  const latest = await fetchLatestVersion();
  if (!latest) {
    process.stderr.write("  \x1b[31m✗\x1b[0m Could not reach npm registry.\n\n");
    process.exitCode = 1;
    return;
  }

  let cli: CliCommand = { command: process.execPath, args: [...process.execArgv, process.argv[1]!] };
  if (latest !== current) {
    const brew = isBrewInstall();
    const manager = brew ? "brew" : "npm";
    const args = brew ? ["upgrade", "linkshell"] : ["install", "-g", "linkshell-cli@latest"];
    process.stderr.write(`  New version available: ${current} → \x1b[32m${latest}\x1b[0m\n  Upgrading via ${brew ? "Homebrew" : "npm"}...\n`);
    try {
      execFileSync(manager, args, { stdio: "inherit", timeout: 120_000 });
      cli = installedCli(brew);
    } catch (error) {
      process.stderr.write(`\n  \x1b[31m✗\x1b[0m Upgrade failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.stderr.write(`  Retry with: ${manager} ${args.join(" ")}\n\n`);
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
    process.stderr.write(`\n  \x1b[32m✓\x1b[0m LinkShell ${latest} is ready.\n\n`);
  } catch (error) {
    process.stderr.write(`\n  \x1b[31m✗\x1b[0m Could not finish the host update: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("  Check linkshell host status, then run linkshell upgrade again to retry.\n\n");
    process.exitCode = 1;
  }
}
