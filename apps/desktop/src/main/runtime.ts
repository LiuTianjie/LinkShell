import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** What the Swift launcher passed on: `linkshell app` names its exact Node and CLI (Finder's PATH need not hold them). */
export interface LaunchOptions {
  home?: string;
  cliNode?: string;
  cliScript?: string;
  cliArgs: string[];
  cliPath?: string;
  checkUpdates: boolean;
  /** Started at sign-in (Windows' Run entry): stay in the tray until asked for. */
  hidden: boolean;
}

export function launchOptions(argv: string[]): LaunchOptions {
  const value = (key: string) => { const index = argv.indexOf(key); return index >= 0 ? argv[index + 1] : undefined; };
  const values = (key: string) => argv.flatMap((arg, index) => arg === key && argv[index + 1] !== undefined ? [argv[index + 1]!] : []);
  return { home: value("--home"), cliNode: value("--cli-node"), cliScript: value("--cli-script"), cliArgs: values("--cli-arg"), cliPath: value("--cli-path"), checkUpdates: argv.includes("--check-updates"), hidden: argv.includes("--hidden") };
}

/**
 * Where everything is. In the Mac bundle, `Contents/Resources/app` holds this code; the workspace
 * and the bundled CLI sit beside it, and PATH is never used to pick a standalone runtime. On
 * Windows the install folder holds `LinkShell.exe` (this Electron), `resources/app`, `workspace`,
 * `runtime` (node.exe and the CLI) and the screen helper `LinkShell.Screen.exe`. From a checkout
 * (`pnpm --filter @linkshell/desktop start`): the sibling packages' builds.
 */
export class Runtime {
  /** The Mac's LinkShell.app. */
  readonly bundle?: string;
  /** The Windows install folder. */
  readonly folder?: string;
  readonly standalone: boolean;
  readonly workspaceAssets: string;
  private readonly checkout?: string;

  constructor(appPath: string, private readonly launch: LaunchOptions) {
    const contents = resolve(appPath, "../..");
    const bundle = contents.endsWith("/Contents") ? dirname(contents) : undefined;
    this.bundle = bundle?.endsWith(".app") ? bundle : undefined;
    if (!this.bundle && process.platform === "win32" && existsSync(join(contents, "standalone.json")) && existsSync(join(contents, "LinkShell.Screen.exe"))) this.folder = contents;
    this.standalone = this.folder ? true : !!this.bundle && existsSync(join(this.bundle, "Contents/Resources/standalone.json"));
    if (this.bundle) this.workspaceAssets = join(this.bundle, "Contents/Resources/Workspace");
    else if (this.folder) this.workspaceAssets = join(this.folder, "workspace");
    else {
      this.checkout = resolve(appPath, "../..");
      this.workspaceAssets = process.env.LINKSHELL_WORKSPACE_ASSETS ?? join(this.checkout, "apps/web/dist");
    }
  }

  get home(): string { return this.launch.home ?? process.env.LINKSHELL_HOME ?? join(homedir(), ".linkshell"); }

  /** One window per state directory: an app using another home gets its own. */
  get scope(): string { return createHash("sha256").update(this.home).digest("hex"); }

  /** The Swift executable of LinkShell.app (the screen's permissions, the setup window), or Windows' screen helper. */
  get helper(): string | undefined {
    if (this.bundle) return join(this.bundle, "Contents/MacOS/LinkShell");
    if (this.folder) return join(this.folder, "LinkShell.Screen.exe");
    const built = join(this.checkout ?? "", "apps/mac/build/LinkShell.app/Contents/MacOS/LinkShell");
    return existsSync(built) ? built : undefined;
  }

  /** No shell interpolation of paths or user text. A standalone bundle runs only its own Node and CLI. */
  spawnCLI(args: string[]): ChildProcess {
    const env: NodeJS.ProcessEnv = { ...process.env, LINKSHELL_HOME: this.home };
    // Electron's own variables must not turn the bundled Node into another Electron.
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
    if (this.launch.cliPath) env.PATH = this.launch.cliPath;
    const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
    if (this.standalone && this.bundle) {
      env.LINKSHELL_APP_BUNDLE = this.bundle;
      return spawn(join(this.bundle, "Contents/MacOS/node"), [join(this.bundle, "Contents/Resources/runtime/cli/dist/cli/src/index.js"), ...args], { env, stdio });
    }
    if (this.folder) {
      // What linkshell.cmd sets: the CLI finds the install and the host its screen helper.
      env.LINKSHELL_APP_BUNDLE = this.folder;
      env.LINKSHELL_WINDOWS_HELPER = join(this.folder, "LinkShell.Screen.exe");
      return spawn(join(this.folder, "runtime/node.exe"), [join(this.folder, "runtime/cli/dist/cli/src/index.js"), ...args], { env, stdio, windowsHide: true });
    }
    if (this.launch.cliNode && this.launch.cliScript) return spawn(this.launch.cliNode, [...this.launch.cliArgs, this.launch.cliScript, ...args], { env, stdio });
    if (this.checkout) return spawn(process.env.LINKSHELL_DEV_NODE ?? "node", [join(this.checkout, "packages/cli/dist/cli/src/index.js"), ...args], { env, stdio });
    if (process.platform === "win32") throw new Error("请使用 LinkShell 安装包，或从源码目录启动");
    return spawn("/bin/zsh", ["-lc", 'exec linkshell "$@"', "linkshell-desktop", ...args], { env, stdio });
  }
}
