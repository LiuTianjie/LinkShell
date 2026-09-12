import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Host-side agent process discovery, modeled on Open Island's
 * ActiveAgentProcessDiscovery: `ps` is the authoritative "is it alive?"
 * signal. We classify well-known CLIs (Claude, Codex, Gemini, Copilot,
 * OpenCode, Cursor Agent, Kimi) and ignore LinkShell's own control-plane
 * subprocesses (codex app-server, Claude stream-json / SDK).
 *
 * This does not invent a remote conversation protocol for those agents.
 * Live processes become visible conversations; prompting still requires
 * an official adapter (Codex app-server / Claude stream-json or SDK).
 */

export const KNOWN_AGENT_PROVIDERS = [
  "codex",
  "claude",
  "gemini",
  "copilot",
  "opencode",
  "cursor",
  "kimi",
  "custom",
] as const;

export type KnownAgentProvider = (typeof KNOWN_AGENT_PROVIDERS)[number];

export const PROTOCOL_AGENT_PROVIDERS = new Set<string>(["codex", "claude", "gemini", "cursor"]);

export interface AgentProcessSnapshot {
  provider: string;
  pid: string;
  command: string;
  tty?: string;
  cwd?: string;
  sessionId?: string;
  parentPid?: string;
}

export interface RunningProcess {
  pid: string;
  parentPid: string;
  tty?: string;
  command: string;
}

export type ProcessCommandRunner = (executable: string, args: string[]) => string | undefined;

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

export function agentProviderLabel(provider: string): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "copilot":
      return "Copilot";
    case "opencode":
      return "OpenCode";
    case "cursor":
      return "Cursor";
    case "kimi":
      return "Kimi";
    case "custom":
      return "Custom";
    default:
      return provider;
  }
}

export function isProtocolAgentProvider(provider: string): boolean {
  return PROTOCOL_AGENT_PROVIDERS.has(provider);
}

export function firstCommandToken(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? "";
}

export function commandBinaryName(command: string): string {
  const token = firstCommandToken(command);
  const parts = token.split(/[/\\]/);
  return (parts[parts.length - 1] ?? token).toLowerCase();
}

/** LinkShell-owned control planes must not appear as user sessions. */
export function isControlPlaneCommand(command: string): boolean {
  const lowered = command.toLowerCase();
  if (/\bapp-server\b/.test(lowered)) return true;
  if (lowered.includes("claude-agent-sdk")) return true;
  if (lowered.includes("stream-json") && (lowered.includes("--print") || lowered.includes("--output-format"))) {
    return true;
  }
  if (/\b--acp\b/.test(lowered)) return true;
  if (commandBinaryName(command) === "cursor-agent" && /\sacp(\s|$)/.test(lowered)) return true;
  return false;
}

export function classifyAgentCommand(command: string): string | undefined {
  if (!command.trim() || isControlPlaneCommand(command)) return undefined;
  const lowered = command.toLowerCase();
  const first = firstCommandToken(lowered);
  const binary = commandBinaryName(command);

  if (binary === "codex" || first.endsWith("/codex") || lowered.includes("/codex/codex")) return "codex";
  if (binary === "claude" || first.endsWith("/claude") || lowered.includes("/.local/bin/claude")) return "claude";
  if (binary === "cursor-agent" || first.endsWith("/cursor-agent")) return "cursor";
  if (isOpenCodeCommand(lowered, first)) return "opencode";
  if (
    binary === "gemini" ||
    first.endsWith("/gemini") ||
    lowered.includes("/bin/gemini") ||
    lowered.includes("/google/gemini-cli") ||
    lowered.includes("@google/gemini-cli")
  ) {
    return "gemini";
  }
  if (binary === "kimi" && (first === "kimi" || first.endsWith("/kimi"))) return "kimi";
  if (binary === "copilot" || first.endsWith("/copilot")) return "copilot";
  return undefined;
}

function isOpenCodeCommand(lowered: string, first: string): boolean {
  if (
    first === "opencode" ||
    first === "opencode-ai" ||
    first.endsWith("/opencode") ||
    first.endsWith("/opencode-ai")
  ) {
    return true;
  }
  if (!lowered.includes("opencode")) return false;

  const isPackageRunner =
    first === "npx" || first.endsWith("/npx") ||
    first === "pnpx" || first.endsWith("/pnpx") ||
    first === "bunx" || first.endsWith("/bunx") ||
    ((first === "npm" || first.endsWith("/npm")) && (lowered.includes(" exec ") || lowered.includes(" run "))) ||
    ((first === "pnpm" || first.endsWith("/pnpm")) && (lowered.includes(" dlx ") || lowered.includes(" exec ") || lowered.includes(" run "))) ||
    first === "yarn" || first.endsWith("/yarn");

  if (isPackageRunner) {
    const tokens = lowered.split(/\s+/);
    const packageIndex = tokens.findIndex((token) => {
      if (token.startsWith("@opencode-ai/")) return true;
      const base = token.startsWith("@") ? token : (token.split("@")[0] ?? token);
      return base === "opencode" || base === "opencode-ai";
    });
    if (packageIndex >= 0) {
      const installLike = new Set(["install", "i", "add", "remove", "rm", "uninstall", "update", "upgrade", "up", "unlink"]);
      const isInstall = tokens.slice(0, packageIndex).some((token) => installLike.has(token));
      if (!isInstall) return true;
    }
  }

  const isNode = first === "node" || first.endsWith("/node") || first === "bun" || first.endsWith("/bun");
  if (
    isNode && (
      lowered.includes("/opencode-ai/") ||
      lowered.includes("/@opencode-ai/") ||
      lowered.includes("/node_modules/opencode/") ||
      lowered.includes("/node_modules/opencode-ai/") ||
      lowered.includes("/node_modules/@opencode-ai/") ||
      /\/\.bin\/opencode(-ai)?(\s|$)/.test(lowered)
    )
  ) {
    return true;
  }
  return false;
}

export function parsePsOutput(output: string): RunningProcess[] {
  const processes: RunningProcess[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = parts[0]!;
    const parentPid = parts[1]!;
    const ttyRaw = parts[2]!;
    const command = parts.slice(3).join(" ").trim();
    if (!command) continue;
    processes.push({
      pid,
      parentPid,
      tty: normalizeTty(ttyRaw),
      command,
    });
  }
  return processes;
}

function normalizeTty(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "??") return undefined;
  return trimmed.startsWith("/dev/") ? trimmed : `/dev/${trimmed}`;
}

export function sessionIdFromCommand(command: string): string | undefined {
  const tokens = command.split(/\s+/);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--resume" || token === "-r" || token === "--session-id") {
      const next = tokens[index + 1];
      const match = next?.match(UUID_RE);
      if (match) return match[0].toLowerCase();
    }
    if (token.startsWith("--resume=") || token.startsWith("--session-id=")) {
      const match = token.split("=", 2)[1]?.match(UUID_RE);
      if (match) return match[0].toLowerCase();
    }
  }
  return undefined;
}

export function liveConversationId(snapshot: Pick<AgentProcessSnapshot, "provider" | "pid" | "sessionId">): string {
  if (snapshot.sessionId) return `agent-live-${snapshot.provider}-${snapshot.sessionId}`;
  return `agent-live-${snapshot.provider}-${snapshot.pid}`;
}

export function isLiveConversationId(conversationId: string): boolean {
  return conversationId.startsWith("agent-live-");
}

export function discoverAgentProcesses(input?: {
  run?: ProcessCommandRunner;
  processes?: RunningProcess[];
  includeCwd?: boolean;
}): AgentProcessSnapshot[] {
  const run = input?.run ?? defaultCommandRunner;
  const processes = input?.processes ?? parsePsOutput(run("/bin/ps", ["-Ao", "pid=,ppid=,tty=,command="]) ?? "");
  const snapshots: AgentProcessSnapshot[] = [];
  const claimed = new Set<string>();

  for (const process of processes) {
    const provider = classifyAgentCommand(process.command);
    if (!provider) continue;
    // Open Island lets OpenCode through without a TTY (IDE terminals).
    if (!process.tty && provider !== "opencode") continue;

    const sessionId = sessionIdFromCommand(process.command);
    const claimKey = sessionId ? `${provider}:${sessionId}` : `${provider}:${process.tty ?? process.pid}`;
    if (claimed.has(claimKey)) continue;
    claimed.add(claimKey);

    snapshots.push({
      provider,
      pid: process.pid,
      command: process.command,
      tty: process.tty,
      // lsof is useful but too expensive for the 3s live poll — it stalls the
      // PTY/WebSocket loop. Callers that need cwd pass includeCwd.
      cwd: input?.includeCwd ? cwdFromLsof(run, process.pid) : undefined,
      sessionId,
      parentPid: process.parentPid,
    });
  }
  return snapshots;
}

/** Non-blocking `ps` scan for the live poll. Never calls lsof. */
export async function discoverAgentProcessesAsync(): Promise<AgentProcessSnapshot[]> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-Ao", "pid=,ppid=,tty=,command="], {
      encoding: "utf8",
      timeout: 800,
      maxBuffer: 2 * 1024 * 1024,
    });
    return discoverAgentProcesses({ processes: parsePsOutput(stdout) });
  } catch {
    return [];
  }
}

function cwdFromLsof(run: ProcessCommandRunner, pid: string): string | undefined {
  const output = run("/usr/sbin/lsof", ["-a", "-p", pid, "-Fn"]);
  if (!output) return undefined;
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== "fcwd") continue;
    const next = lines[index + 1] ?? "";
    if (next.startsWith("n/") ) return next.slice(1);
  }
  return undefined;
}

function defaultCommandRunner(executable: string, args: string[]): string | undefined {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      timeout: 800,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}
