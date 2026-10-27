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
}

export function launchOptions(argv: string[]): LaunchOptions {
  const value = (key: string) => { const index = argv.indexOf(key); return index >= 0 ? argv[index + 1] : undefined; };
  const values = (key: string) => argv.flatMap((arg, index) => arg === key && argv[index + 1] !== undefined ? [argv[index + 1]!] : []);
  return { home: value("--home"), cliNode: value("--cli-node"), cliScript: value("--cli-script"), cliArgs: values("--cli-arg"), cliPath: value("--cli-path"), checkUpdates: argv.includes("--check-updates") };
}

/**
 * Where everything is. In the bundle, `Contents/Resources/app` holds this code; the workspace
 * and the bundled CLI sit beside it, and PATH is never used to pick a standalone runtime. From a
 * checkout (`pnpm --filter @linkshell/desktop start`): the sibling packages' builds.
 */
export class Runtime {
  readonly bundle?: string;
  readonly standalone: boolean;
  readonly workspaceAssets: string;
  private readonly checkout?: string;

  constructor(appPath: string, private readonly launch: LaunchOptions) {
    const contents = resolve(appPath, "../..");
    const bundle = contents.endsWith("/Contents") ? dirname(contents) : undefined;
    this.bundle = bundle?.endsWith(".app") ? bundle : undefined;
    this.standalone = !!this.bundle && existsSync(join(this.bundle, "Contents/Resources/standalone.json"));
    if (this.bundle) this.workspaceAssets = join(this.bundle, "Contents/Resources/Workspace");
    else {
      this.checkout = resolve(appPath, "../..");
      this.workspaceAssets = process.env.LINKSHELL_WORKSPACE_ASSETS ?? join(this.checkout, "apps/web/dist");
    }
  }

  get home(): string { return this.launch.home ?? process.env.LINKSHELL_HOME ?? join(homedir(), ".linkshell"); }

  /** One window per state directory: an app using another home gets its own. */
  get scope(): string { return createHash("sha256").update(this.home).digest("hex"); }

  /** The Swift executable of LinkShell.app: the screen's permissions and the setup window. */
  get helper(): string | undefined {
    if (this.bundle) return join(this.bundle, "Contents/MacOS/LinkShell");
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
    if (this.launch.cliNode && this.launch.cliScript) return spawn(this.launch.cliNode, [...this.launch.cliArgs, this.launch.cliScript, ...args], { env, stdio });
    if (this.checkout) return spawn(process.env.LINKSHELL_DEV_NODE ?? "node", [join(this.checkout, "packages/cli/dist/cli/src/index.js"), ...args], { env, stdio });
    return spawn("/bin/zsh", ["-lc", 'exec linkshell "$@"', "linkshell-desktop", ...args], { env, stdio });
  }
}
