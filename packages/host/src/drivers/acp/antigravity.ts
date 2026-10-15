import { accessSync, constants, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import type { AgentAuth } from "@linkshell/wire";
import { AcpDriver, type AcpAgentSpec } from "./driver.js";

/**
 * Official Google Antigravity ACP distribution metadata (from the ACP Registry:
 * `antigravity-acp/agent.json`).
 */
export const ANTIGRAVITY_ACP_VERSION = "1.4.0";

export interface AntigravityReleaseTarget {
  archiveUrl: string;
  binaryName: string;
  args: string[];
  sha256: string;
}

export const ANTIGRAVITY_ACP_TARGETS: Record<string, AntigravityReleaseTarget> = {
  "darwin-arm64": {
    archiveUrl: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.0-macos-aarch64.zip",
    binaryName: "agy_acp_server.par",
    args: [],
    sha256: "e02a46db4de4fbcc601a666b385fb1956cc67247221303f8a3e1345721dc2ac2",
  },
  "darwin-x64": {
    archiveUrl: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.0-macos-x86_64.zip",
    binaryName: "agy_acp_server.par",
    args: [],
    sha256: "3d841c240014380c0d45184145020ed86c17213e5d7019801d2777a22731969a",
  },
  "linux-x64": {
    archiveUrl: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-x86_64.zip",
    binaryName: "agy_acp_server.par",
    args: ["--uid="],
    sha256: "b64e34ab83b848b7cf75552135a4b606196b45bc0a3f97409964f4b18040e523",
  },
  "linux-arm64": {
    archiveUrl: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.0-linux-aarch64.zip",
    binaryName: "agy_acp_server.par",
    args: ["--uid="],
    sha256: "004bd8f9c88e061923479a50203a1545be398eb4b9a9c8ed181f29a8f1ca45b0",
  },
  "win32-x64": {
    archiveUrl: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-x86_64.zip",
    binaryName: "agy_acp_server.exe",
    args: [],
    sha256: "d62bc2a1ca587849ecce838574523886729be3fb12867d22a666f149401325de",
  },
  "win32-arm64": {
    archiveUrl: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.0-windows-aarch64.zip",
    binaryName: "agy_acp_server.exe",
    args: [],
    sha256: "d62bc2a1ca587849ecce838574523886729be3fb12867d22a666f149401325de",
  },
};

export interface ResolvedAntigravityLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  version: string;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(names: string[], env: NodeJS.ProcessEnv): string | undefined {
  const pathVar = env.PATH ?? process.env.PATH ?? "";
  for (const name of names) {
    if (isAbsolute(name) && isExecutable(name)) return name;
    for (const dir of pathVar.split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function findInManagedToolRoots(roots: string[], binaryName: string): { path: string; version: string } | undefined {
  const targetKey = `${process.platform}-${process.arch}`;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // Check `<root>/<version>/<platform>-<arch>/<binaryName>` and `<root>/<binaryName>`
    const direct = join(root, binaryName);
    if (isExecutable(direct)) return { path: direct, version: ANTIGRAVITY_ACP_VERSION };
    try {
      const versions = readdirSync(root).sort().reverse();
      for (const version of versions) {
        const archCandidate = join(root, version, targetKey, binaryName);
        if (isExecutable(archCandidate)) return { path: archCandidate, version };
        const flatCandidate = join(root, version, binaryName);
        if (isExecutable(flatCandidate)) return { path: flatCandidate, version };
      }
    } catch {
      // ignore unreadable directories
    }
  }
  return undefined;
}

/**
 * Resolves the Antigravity ACP server binary, sibling localharness binary,
 * required environment variables (`AGY_ACP_FORCE_FILE_STORAGE=1`, `PYTHONUNBUFFERED=1`),
 * and platform-specific arguments (`--uid=` on Linux for `.par`).
 */
export function resolveAntigravityLaunch(env: NodeJS.ProcessEnv = process.env): ResolvedAntigravityLaunch | undefined {
  const binaryName = process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
  const harnessName = process.platform === "win32" ? "localharness_external.exe" : "localharness_external";

  const explicitPath = env.LINKSHELL_ANTIGRAVITY_ACP_PATH?.trim() || env.T3CODE_ANTIGRAVITY_ACP_PATH?.trim();
  let binaryPath: string | undefined;
  let version = ANTIGRAVITY_ACP_VERSION;

  if (explicitPath && isExecutable(explicitPath)) {
    binaryPath = explicitPath;
  } else {
    const home = env.HOME || homedir();
    const linkshellHome = env.LINKSHELL_HOME || join(home, ".linkshell");
    const toolRoots = [
      join(linkshellHome, "tools", "antigravity-acp"),
      join(home, ".t3", "tools", "antigravity-acp"),
      ...(process.platform === "darwin"
        ? [
            join(home, "Library", "Application Support", "t3code (Alpha)", "tools", "antigravity-acp"),
            join(home, "Library", "Application Support", "t3code", "tools", "antigravity-acp"),
          ]
        : []),
    ];
    const managed = findInManagedToolRoots(toolRoots, binaryName);
    if (managed) {
      binaryPath = managed.path;
      version = managed.version;
    } else {
      binaryPath = findOnPath(
        process.platform === "win32"
          ? ["agy-acp.exe", "agy_acp_server.exe", "agy-acp", "agy_acp_server.par"]
          : ["agy-acp", "agy_acp_server", "agy_acp_server.par"],
        env,
      );
    }
  }

  if (!binaryPath) return undefined;

  const dir = dirname(binaryPath);
  const siblingHarness = join(dir, harnessName);
  const harnessPath = env.ANTIGRAVITY_HARNESS_PATH?.trim() || (isExecutable(siblingHarness) ? siblingHarness : undefined);

  const dedicatedTmp = join(tmpdir(), "linkshell-antigravity-tmp");
  try {
    mkdirSync(dedicatedTmp, { recursive: true });
  } catch {
    // fallback to system tmpdir if creation fails
  }

  const isPar = basename(binaryPath).endsWith(".par");
  const args = process.platform === "linux" && isPar ? ["--uid="] : [];

  const launchEnv: Record<string, string> = {
    AGY_ACP_FORCE_FILE_STORAGE: env.AGY_ACP_FORCE_FILE_STORAGE ?? "1",
    PYTHONUNBUFFERED: env.PYTHONUNBUFFERED ?? "1",
    TMPDIR: dedicatedTmp,
    TMP: dedicatedTmp,
    TEMP: dedicatedTmp,
    ...(harnessPath ? { ANTIGRAVITY_HARNESS_PATH: harnessPath } : {}),
  };

  return {
    command: binaryPath,
    args,
    env: launchEnv,
    version,
  };
}

const AUTH_URL_PATTERN = /Open the following link to authenticate the ACP server:\s*(https?:\/\/\S+)/i;

export function extractAntigravityAuthUrl(line: string): string | undefined {
  const match = AUTH_URL_PATTERN.exec(line.trim());
  return match?.[1];
}

export async function antigravityAuthStatus(env: NodeJS.ProcessEnv): Promise<AgentAuth> {
  if (env.GEMINI_API_KEY?.trim()) {
    return { state: "ok", method: "gemini-api-key" };
  }
  if (env.GOOGLE_API_KEY?.trim() || (env.GOOGLE_CLOUD_PROJECT?.trim() && env.GOOGLE_CLOUD_LOCATION?.trim())) {
    return { state: "ok", method: "agent-platform" };
  }
  return { state: "unknown" };
}

export function antigravitySpec(): AcpAgentSpec {
  return {
    id: "antigravity",
    label: "Antigravity",
    tier: "remote",
    command: "agy-acp",
    args: [],
    discover: true,
    authStatus: antigravityAuthStatus,
  };
}

/**
 * Specialized ACP driver for Google Antigravity (`agy_acp_server.par` / `agy-acp`).
 * Dynamically resolves the binary + `localharness_external`, sets up `.par` file-storage
 * environment variables, and surfaces stdout Google OAuth links as session/driver notices.
 */
export class AntigravityDriver extends AcpDriver {
  constructor(options: { env?: NodeJS.ProcessEnv; hostVersion: string }) {
    super(antigravitySpec(), options);
  }

  protected override get env(): NodeJS.ProcessEnv {
    const resolved = resolveAntigravityLaunch(this.options.env ?? process.env);
    return {
      ...(this.options.env ?? process.env),
      ...this.spec.env,
      ...resolved?.env,
    };
  }

  protected override async detectVersion(): Promise<string | undefined> {
    const resolved = resolveAntigravityLaunch(this.options.env ?? process.env);
    if (!resolved) return undefined;
    this.spec.command = resolved.command;
    this.spec.args = resolved.args;
    return resolved.version;
  }

  protected override async boot(): Promise<void> {
    const resolved = resolveAntigravityLaunch(this.options.env ?? process.env);
    if (resolved) {
      this.spec.command = resolved.command;
      this.spec.args = resolved.args;
    }
    await super.boot();
  }
}
