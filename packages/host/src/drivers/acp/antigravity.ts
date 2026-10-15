import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  RpcError,
  type AgentAuth,
  type ContentBlock,
  type GoalChange,
  type SessionConfigOption,
  type SessionGoal,
  type SessionUpdate,
  type ToolKind,
} from "@linkshell/wire";
import type { AttachContext, DiscoveredSession, HistoryItem } from "../types.js";
import { AcpDriver, type AcpAgentSpec } from "./driver.js";

const execFileAsync = promisify(execFile);

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

export interface ResolvedAntigravityDesktop {
  dataDir: string;
  languageServerPath?: string;
  logPath?: string;
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

/**
 * Resolves an installed Antigravity Desktop app (`/Applications/Antigravity.app`)
 * and its conversation store (`~/.gemini/antigravity`).
 */
export function resolveAntigravityDesktop(env: NodeJS.ProcessEnv = process.env): ResolvedAntigravityDesktop | undefined {
  if (env.PATH === "" && !env.ANTIGRAVITY_APP_DATA_DIR) return undefined;
  const home = env.HOME || homedir();
  const dataCandidates = [
    env.ANTIGRAVITY_APP_DATA_DIR?.trim(),
    join(home, ".gemini", "antigravity"),
    join(home, ".gemini", "antigravity-ide"),
  ].filter((entry): entry is string => Boolean(entry));
  const dataDir = dataCandidates.find((dir) => existsSync(join(dir, "conversation_summaries.db")) || existsSync(join(dir, "brain")));

  const lsCandidates =
    process.platform === "darwin"
      ? [
          "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
          join(home, "Applications", "Antigravity.app", "Contents", "Resources", "bin", "language_server"),
        ]
      : [];
  const languageServerPath = lsCandidates.find((candidate) => isExecutable(candidate));
  if (!dataDir && !languageServerPath) return undefined;

  const logCandidates =
    process.platform === "darwin"
      ? [join(home, "Library", "Logs", "Antigravity", "language_server.log")]
      : [join(home, ".config", "Antigravity", "logs", "language_server.log")];
  const logPath = logCandidates.find((candidate) => existsSync(candidate));

  let version = "desktop";
  if (logPath) {
    try {
      const head = readFileSync(logPath, "utf8").slice(0, 2048);
      const match = /Language server version:\s*([^\s\r\n]+)/i.exec(head);
      if (match?.[1]) version = match[1];
    } catch {
      // ignore unreadable log
    }
  }
  if (version === "desktop" && process.platform === "darwin") {
    try {
      const plist = readFileSync("/Applications/Antigravity.app/Contents/Info.plist", "utf8");
      const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
      if (match?.[1]) version = match[1].trim();
    } catch {
      // ignore unreadable plist
    }
  }

  return {
    dataDir: dataDir ?? join(home, ".gemini", "antigravity"),
    languageServerPath,
    logPath,
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

// ── Antigravity Desktop transcript & language_server helpers ──────────

interface TranscriptToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

interface TranscriptMedia {
  mime_type?: string;
  mimeType?: string;
  uri?: string;
  inline_data?: string;
  inlineData?: string;
}

interface TranscriptStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: TranscriptToolCall[];
  media?: TranscriptMedia[];
}

const ANTIGRAVITY_DESKTOP_COMMANDS = [
  { name: "goal", description: "设定持续目标，让 Antigravity 持续推进直到完成", hint: "<目标描述>" },
  { name: "plan", description: "先制定分步执行计划，再动手实现", hint: "<任务描述>" },
  { name: "boost", description: "深度思考、多视角分析与严格验证模式", hint: "<复杂问题或任务>" },
  { name: "teamwork-preview", description: "启动多 Agent 协作团队共同完成大型项目", hint: "<项目任务>" },
  { name: "grill-me", description: "通过互动提问对齐方案细节与设计决策", hint: "<主题>" },
  { name: "compact", description: "压缩并总结当前对话上下文以释放窗口空间" },
  { name: "schedule", description: "创建定时任务或后台周期自动化", hint: "<定时指令>" },
  { name: "learn", description: "总结并持久化当前经验与约定供后续会话使用" },
];

function unquoteArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    trimmed === "true" ||
    trimmed === "false" ||
    /^-?\d+(?:\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function parseToolArgs(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    result[k] = unquoteArg(v);
  }
  return result;
}

function stripTruncationMarkers(text: string): string {
  return text.replace(/\n?\.\.\.\s*<truncated\s+\d+\s+bytes>\s*\.\.\.\n?/gi, "\n").replace(/<truncated\s+\d+\s+bytes>/gi, "");
}

export function cleanAntigravityUserInput(content: string): string {
  const closedMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  if (closedMatch) return stripTruncationMarkers(closedMatch[1]!).trim();
  const openMatch = /<USER_REQUEST>\s*([\s\S]*?)(?:<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|CONTEXT_SUMMARY|EPILOGUE|GOAL_MODE|PLAN|TEAMWORK|BOOST)>|$)/i.exec(content);
  if (openMatch) return stripTruncationMarkers(openMatch[1]!).trim();
  return stripTruncationMarkers(
    content.replace(
      /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|CONTEXT_SUMMARY|EPILOGUE|GOAL_MODE|PLAN|TEAMWORK|BOOST|GOAL)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE|CONTEXT_SUMMARY|EPILOGUE|GOAL_MODE|PLAN|TEAMWORK|BOOST|GOAL)>/gi,
      "",
    ),
  )
    .replace(/<!--\s*GOAL_(?:COMPLETE|CANCELLED)\s*-->/gi, "")
    .trim();
}

export function cleanAntigravityAgentContent(content: string): {
  text: string;
  goalComplete: boolean;
  goalCancelled: boolean;
} {
  const goalComplete = /<!--\s*GOAL_COMPLETE\s*-->/i.test(content);
  const goalCancelled = /<!--\s*GOAL_CANCELLED\s*-->/i.test(content);
  const text = stripTruncationMarkers(content)
    .replace(/<!--\s*GOAL_(?:COMPLETE|CANCELLED)\s*-->/gi, "")
    .replace(
      /<(?:SYSTEM_MESSAGE|EPILOGUE|GOAL_MODE|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/(?:SYSTEM_MESSAGE|EPILOGUE|GOAL_MODE|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/gi,
      "",
    )
    .trim();
  return { text, goalComplete, goalCancelled };
}

function extractModelSelectionFromContent(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const regex = /changed setting `?Model Selection`? from .*? to ([^\r\n.<]+?)(?:\.(?:\s|$)|<\/USER_SETTINGS_CHANGE>|\r|\n|$)/gi;
  let last: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate && candidate.toLowerCase() !== "none") {
      last = candidate;
    }
  }
  return last;
}

function parseGoalDurationSeconds(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  let total = 0;
  let matched = false;
  const hours = /(\d+)\s*h/i.exec(raw);
  const mins = /(\d+)\s*m/i.exec(raw);
  const secs = /(\d+)\s*s/i.exec(raw);
  if (hours?.[1]) {
    total += Number(hours[1]) * 3600;
    matched = true;
  }
  if (mins?.[1]) {
    total += Number(mins[1]) * 60;
    matched = true;
  }
  if (secs?.[1]) {
    total += Number(secs[1]);
    matched = true;
  }
  return matched ? total : undefined;
}

function parseGoalSystemMessage(
  content: string | undefined,
  previousGoal: SessionGoal | null,
): SessionGoal | undefined {
  if (!content || !/Stop hook blocked termination:\s*You are still working toward the user's goal/i.test(content)) {
    return undefined;
  }
  const iterMatch = /Continuation:\s*#(\d+)/i.exec(content);
  const timeMatch = /Time spent so far:\s*([^\r\n]+)/i.exec(content);
  const origMatch = /Original request:\s*([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/i.exec(content);
  const rawObjective = origMatch?.[1]?.trim().replace(/^\/goal(?:\s+|$)/i, "").trim();
  const objective = rawObjective || previousGoal?.objective || "持续目标";
  const iterations = iterMatch?.[1] ? Number(iterMatch[1]) : previousGoal?.iterations;
  const timeUsedSeconds = parseGoalDurationSeconds(timeMatch?.[1]) ?? previousGoal?.timeUsedSeconds;
  return {
    objective,
    status: "active",
    ...(iterations !== undefined ? { iterations } : {}),
    ...(timeUsedSeconds !== undefined ? { timeUsedSeconds } : {}),
  };
}

function readStepMediaBlocks(media: TranscriptMedia[] | undefined): ContentBlock[] {
  if (!Array.isArray(media) || media.length === 0) return [];
  const blocks: ContentBlock[] = [];
  for (const entry of media) {
    const mimeType = entry.mime_type || entry.mimeType || "image/png";
    const inline = entry.inline_data || entry.inlineData;
    if (typeof inline === "string" && inline.length > 0) {
      blocks.push({ type: "image", mimeType, data: inline });
      continue;
    }
    const rawUri = entry.uri;
    if (typeof rawUri === "string" && rawUri.length > 0) {
      const filePath = rawUri.startsWith("file://") ? fileURLToPath(rawUri) : rawUri;
      try {
        if (existsSync(filePath)) {
          const stat = statSync(filePath);
          if (stat.isFile() && stat.size > 0 && stat.size <= 15 * 1024 * 1024) {
            const data = readFileSync(filePath).toString("base64");
            blocks.push({ type: "image", mimeType, data });
          }
        }
      } catch {
        // ignore unreadable media file
      }
    }
  }
  return blocks;
}

function mapAntigravityToolCall(
  stepIndex: number,
  callIndex: number,
  call: TranscriptToolCall,
  outputText?: string,
): SessionUpdate {
  const name = call.name ?? "tool";
  const args = parseToolArgs(call.args);
  const summary =
    (typeof args.toolSummary === "string" && args.toolSummary.trim()) ||
    (typeof args.toolAction === "string" && args.toolAction.trim()) ||
    name;
  const toolCallId = call.id || `agy:tc:${stepIndex}:${callIndex}`;

  let kind: ToolKind = "other";
  let rawInput: Record<string, unknown> = args;
  let locations: { path: string; line?: number }[] | undefined;

  if (name === "run_command") {
    kind = "execute";
    rawInput = {
      command: typeof args.CommandLine === "string" ? args.CommandLine : summary,
      cwd: typeof args.Cwd === "string" ? args.Cwd : undefined,
    };
  } else if (name === "view_file") {
    kind = "read";
    const path = typeof args.AbsolutePath === "string" ? args.AbsolutePath : undefined;
    const line = typeof args.StartLine === "number" ? args.StartLine : undefined;
    if (path) {
      rawInput = { file_path: path };
      locations = [{ path, ...(line ? { line } : {}) }];
    }
  } else if (name === "replace_file_content" || name === "multi_replace_file_content" || name === "write_to_file") {
    kind = "edit";
    const path = typeof args.TargetFile === "string" ? args.TargetFile : undefined;
    const line = typeof args.StartLine === "number" ? args.StartLine : undefined;
    if (path) {
      rawInput = { file_path: path };
      locations = [{ path, ...(line ? { line } : {}) }];
    }
  } else if (name === "search_web") {
    kind = "search";
    rawInput = { query: typeof args.query === "string" ? args.query : summary };
  } else if (name === "read_url_content") {
    kind = "fetch";
    rawInput = { url: typeof args.Url === "string" ? args.Url : summary };
  }

  const cleanedOutput = outputText ? stripTruncationMarkers(outputText) : undefined;

  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: summary,
    name,
    kind,
    status: "completed",
    rawInput,
    ...(cleanedOutput ? { rawOutput: { output: cleanedOutput } } : {}),
    ...(locations ? { locations } : {}),
  };
}

/**
 * Converts an Antigravity Desktop `transcript_full.jsonl` (or `transcript.jsonl`)
 * file into LinkShell's `HistoryItem[]` list, tracking Goal Mode (`ls_goal`),
 * model changes (`<USER_SETTINGS_CHANGE>`), and uploaded media.
 */
export function parseAntigravityTranscript(
  transcriptPath: string,
  fromLine = 0,
): {
  items: HistoryItem[];
  nextLine: number;
  lastModelLabel?: string;
  goal?: SessionGoal | null;
} {
  if (!existsSync(transcriptPath)) return { items: [], nextLine: fromLine };
  let lines: string[];
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return { items: [], nextLine: fromLine };
  }

  let activeGoal: SessionGoal | null = null;
  let lastModelLabel: string | undefined;

  // Scan lines prior to `fromLine` so incremental parsing retains active goal & model state.
  const scanLimit = Math.min(fromLine, lines.length);
  for (let i = 0; i < scanLimit; i++) {
    try {
      const step = JSON.parse(lines[i]!) as TranscriptStep;
      if (step.type === "USER_INPUT" && typeof step.content === "string") {
        const modelLabel = extractModelSelectionFromContent(step.content);
        if (modelLabel) lastModelLabel = modelLabel;
        const rawText = cleanAntigravityUserInput(step.content);
        if (/^\/goal\s+(?:clear|stop|off|reset|none|cancel)\s*$/i.test(rawText)) {
          activeGoal = null;
        } else if (/^\/goal(?:\s+|$)/i.test(rawText) || /\/goal is a \[Slash Command\]:/i.test(step.content)) {
          const objective = rawText.replace(/^\/goal(?:\s+|$)/i, "").trim() || "持续目标";
          activeGoal = { objective, status: "active" };
        } else if (activeGoal?.status === "complete") {
          activeGoal = null;
        }
      } else if (step.type === "SYSTEM_MESSAGE") {
        const nextGoal = parseGoalSystemMessage(step.content, activeGoal);
        if (nextGoal) activeGoal = nextGoal;
      } else if (step.type === "PLANNER_RESPONSE" && typeof step.content === "string") {
        const { goalComplete, goalCancelled } = cleanAntigravityAgentContent(step.content);
        if (goalCancelled) {
          activeGoal = null;
        } else if (goalComplete) {
          activeGoal = { ...(activeGoal ?? { objective: "持续目标" }), status: "complete" };
        }
      }
    } catch {
      // ignore malformed historical line
    }
  }

  if (fromLine >= lines.length) return { items: [], nextLine: lines.length, lastModelLabel, goal: activeGoal };

  const parsed: { index: number; step: TranscriptStep }[] = [];
  for (let i = fromLine; i < lines.length; i++) {
    try {
      const step = JSON.parse(lines[i]!) as TranscriptStep;
      parsed.push({ index: step.step_index ?? i, step });
    } catch {
      // skip partial trailing JSON line
      return { items: [], nextLine: i, lastModelLabel, goal: activeGoal };
    }
  }

  const items: HistoryItem[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const { index: stepIndex, step } = parsed[i]!;
    if (step.type === "USER_INPUT") {
      if (typeof step.content === "string") {
        const modelLabel = extractModelSelectionFromContent(step.content);
        if (modelLabel) lastModelLabel = modelLabel;
      }
      const rawText = typeof step.content === "string" ? cleanAntigravityUserInput(step.content) : "";
      const mediaBlocks = readStepMediaBlocks(step.media);
      let displayText = rawText;
      let goalUpdate: SessionUpdate | undefined;

      if (/^\/goal\s+(?:clear|stop|off|reset|none|cancel)\s*$/i.test(rawText)) {
        activeGoal = null;
        goalUpdate = { sessionUpdate: "ls_goal", goal: null };
      } else if (/^\/goal(?:\s+|$)/i.test(rawText) || (typeof step.content === "string" && /\/goal is a \[Slash Command\]:/i.test(step.content))) {
        const objective = rawText.replace(/^\/goal(?:\s+|$)/i, "").trim() || "持续目标";
        displayText = objective;
        activeGoal = { objective, status: "active" };
        goalUpdate = { sessionUpdate: "ls_goal", goal: activeGoal };
      } else if (activeGoal?.status === "complete") {
        activeGoal = null;
        goalUpdate = { sessionUpdate: "ls_goal", goal: null };
      }

      if (!displayText && mediaBlocks.length === 0 && !goalUpdate) continue;
      const messageId = `agy:user:${stepIndex}`;
      const updates: SessionUpdate[] = [];
      for (const mediaBlock of mediaBlocks) {
        updates.push({
          sessionUpdate: "user_message_chunk",
          messageId,
          content: mediaBlock,
        });
      }
      if (displayText) {
        updates.push({
          sessionUpdate: "user_message_chunk",
          messageId,
          content: { type: "text", text: displayText },
        });
      }
      if (goalUpdate) {
        updates.push(goalUpdate);
      }
      items.push({
        itemId: messageId,
        updates,
      });
    } else if (step.type === "SYSTEM_MESSAGE") {
      const nextGoal = parseGoalSystemMessage(step.content, activeGoal);
      if (nextGoal) {
        activeGoal = nextGoal;
        items.push({
          itemId: `agy:goal:${stepIndex}`,
          updates: [{ sessionUpdate: "ls_goal", goal: activeGoal }],
        });
      }
    } else if (step.type === "PLANNER_RESPONSE") {
      const updates: SessionUpdate[] = [];
      if (typeof step.thinking === "string") {
        const cleanThought = stripTruncationMarkers(step.thinking).trim();
        if (cleanThought) {
          const thoughtId = `agy:thought:${stepIndex}`;
          updates.push(
            {
              sessionUpdate: "agent_thought_chunk",
              messageId: thoughtId,
              content: { type: "text", text: cleanThought },
            },
            {
              sessionUpdate: "ls_message_done",
              messageId: thoughtId,
              role: "thought",
            },
          );
        }
      }

      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      if (calls.length > 0) {
        // Subsequent GENERIC steps hold the outputs of these tool calls in order.
        const outputs: string[] = [];
        let lookahead = i + 1;
        while (lookahead < parsed.length && parsed[lookahead]!.step.type === "GENERIC" && outputs.length < calls.length) {
          outputs.push(typeof parsed[lookahead]!.step.content === "string" ? parsed[lookahead]!.step.content! : "");
          lookahead++;
        }
        calls.forEach((call, callIdx) => {
          updates.push(mapAntigravityToolCall(stepIndex, callIdx, call, outputs[callIdx]));
        });
      }

      if (typeof step.content === "string" && step.content.trim()) {
        const { text: cleanText, goalComplete, goalCancelled } = cleanAntigravityAgentContent(step.content);
        if (cleanText) {
          const messageId = `agy:msg:${stepIndex}`;
          updates.push(
            {
              sessionUpdate: "agent_message_chunk",
              messageId,
              content: { type: "text", text: cleanText },
            },
            {
              sessionUpdate: "ls_message_done",
              messageId,
              role: "agent",
            },
          );
        }
        if (goalCancelled) {
          activeGoal = null;
          updates.push({ sessionUpdate: "ls_goal", goal: null });
        } else if (goalComplete) {
          activeGoal = { ...(activeGoal ?? { objective: "持续目标" }), status: "complete" };
          updates.push({ sessionUpdate: "ls_goal", goal: activeGoal });
        }
      }

      if (updates.length > 0) {
        items.push({
          itemId: `agy:step:${stepIndex}`,
          updates,
        });
      }
    }
  }

  return { items, nextLine: lines.length, lastModelLabel, goal: activeGoal };
}

interface LanguageServerConnection {
  httpPort: number;
  csrfToken: string;
}

async function findRunningLanguageServer(desktop: ResolvedAntigravityDesktop | undefined): Promise<LanguageServerConnection | undefined> {
  if (!desktop?.logPath || !existsSync(desktop.logPath)) return undefined;
  let httpPort: number | undefined;
  try {
    const head = readFileSync(desktop.logPath, "utf8").slice(0, 4096);
    const match = /listening on \w+ port at (\d+) for HTTP\b/i.exec(head);
    if (match?.[1]) httpPort = Number(match[1]);
  } catch {
    return undefined;
  }
  if (!httpPort) return undefined;

  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "args="], { timeout: 3000 });
    for (const line of stdout.split("\n")) {
      if (!line.includes("language_server") || !line.includes("--csrf_token")) continue;
      const tokenMatch = /--csrf_token[=\s]+([^\s]+)/.exec(line);
      if (tokenMatch?.[1]) {
        return { httpPort, csrfToken: tokenMatch[1] };
      }
    }
  } catch {
    // ignore ps errors
  }
  return undefined;
}

async function callLanguageServer<T = Record<string, unknown>>(
  conn: LanguageServerConnection,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${conn.httpPort}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-codeium-csrf-token": conn.csrfToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Antigravity Desktop RPC ${method} failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

function parseWorkspaceCwd(workspaceUrisJson: string | undefined, fallbackCwd: string): string {
  if (!workspaceUrisJson) return fallbackCwd;
  try {
    const uris = JSON.parse(workspaceUrisJson) as unknown;
    if (Array.isArray(uris) && typeof uris[0] === "string") {
      const first = uris[0];
      if (first.startsWith("file://")) return fileURLToPath(first);
      if (isAbsolute(first)) return first;
    }
  } catch {
    // ignore invalid JSON
  }
  return fallbackCwd;
}

function resolveDesktopTranscriptPath(dataDir: string, nativeId: string): string {
  const logsDir = join(dataDir, "brain", nativeId, ".system_generated", "logs");
  const fullPath = join(logsDir, "transcript_full.jsonl");
  if (existsSync(fullPath)) return fullPath;
  return join(logsDir, "transcript.jsonl");
}

function extForMimeType(mimeType: string): string {
  const sub = mimeType.split("/")[1]?.toLowerCase() ?? "png";
  if (sub === "jpeg" || sub === "jpg") return "jpg";
  if (sub === "webp") return "webp";
  if (sub === "gif") return "gif";
  return "png";
}

interface DesktopWatcher {
  timer: ReturnType<typeof setInterval>;
  nextLine: number;
  lastSize: number;
  running: boolean;
  detached: boolean;
  selectedModel?: string;
  lastModelLabel?: string;
  goal?: SessionGoal | null;
  pendingClientMessages: { clientMessageId: string; text: string }[];
}

/**
 * Specialized driver for Google Antigravity:
 * - Drives `agy_acp_server.par` / `agy-acp` over ACP when installed.
 * - Also discovers and interacts with Antigravity Desktop (`/Applications/Antigravity.app`,
 *   `~/.gemini/antigravity/conversation_summaries.db`, `brain/<id>/.system_generated/logs/transcript_full.jsonl`,
 *   and its local `language_server` Connect-RPC service) so users with only the Desktop app
 *   get full session visibility, history, Goal Mode, image messaging, and model selection.
 */
export class AntigravityDriver extends AcpDriver {
  private desktopMode = false;
  private desktopSummaryTimer?: ReturnType<typeof setInterval>;
  private readonly desktopSessionStates = new Map<string, "running" | "idle">();
  private readonly desktopWatchers = new Map<string, DesktopWatcher>();
  private desktopModelsCache?: { value: string; name: string; description?: string }[];
  private desktopDefaultModel?: string;

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

  override async authStatus(): Promise<AgentAuth> {
    const base = await super.authStatus();
    if (base.state !== "unknown") return base;
    const desktop = resolveAntigravityDesktop(this.options.env ?? process.env);
    if (desktop && (existsSync(join(desktop.dataDir, "antigravity_state.pbtxt")) || existsSync(join(desktop.dataDir, "conversation_summaries.db")))) {
      return { state: "ok", method: "antigravity-desktop" };
    }
    return base;
  }

  protected override async detectVersion(): Promise<string | undefined> {
    const env = this.options.env ?? process.env;
    const resolved = resolveAntigravityLaunch(env);
    if (resolved) {
      this.desktopMode = false;
      this.spec.command = resolved.command;
      this.spec.args = resolved.args;
      return resolved.version;
    }
    const desktop = resolveAntigravityDesktop(env);
    if (desktop) {
      this.desktopMode = true;
      return desktop.version;
    }
    return undefined;
  }

  protected override async boot(): Promise<void> {
    const env = this.options.env ?? process.env;
    const resolved = resolveAntigravityLaunch(env);
    if (resolved) {
      this.desktopMode = false;
      this.spec.command = resolved.command;
      this.spec.args = resolved.args;
      await super.boot();
      return;
    }
    const desktop = resolveAntigravityDesktop(env);
    if (desktop) {
      this.desktopMode = true;
      this.capabilityState = {
        ...this.capabilityState,
        images: true,
        models: true,
      };
      this.current = { installed: true, version: desktop.version };
      if (!this.desktopSummaryTimer) {
        this.desktopSummaryTimer = setInterval(() => {
          for (const s of this.listDesktopSessions(30)) {
            const nextState = s.state === "running" ? "running" : "idle";
            const prev = this.desktopSessionStates.get(s.nativeId);
            this.desktopSessionStates.set(s.nativeId, nextState);
            if (prev !== undefined && prev !== nextState) {
              if (nextState === "running") {
                this.host?.update(this.id, s.nativeId, { sessionUpdate: "ls_turn", state: "started" });
              } else {
                this.host?.update(this.id, s.nativeId, { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
              }
              this.host?.update(this.id, s.nativeId, {
                sessionUpdate: "ls_status",
                state: nextState,
                turnActive: nextState === "running",
              });
            }
          }
        }, 3000);
        this.desktopSummaryTimer.unref?.();
      }
      return;
    }
    await super.boot();
  }

  override async stop(): Promise<void> {
    if (this.desktopSummaryTimer) {
      clearInterval(this.desktopSummaryTimer);
      this.desktopSummaryTimer = undefined;
    }
    for (const watcher of this.desktopWatchers.values()) clearInterval(watcher.timer);
    this.desktopWatchers.clear();
    await super.stop();
  }

  private transcriptPathFor(nativeId: string): string | undefined {
    const desktop = resolveAntigravityDesktop(this.options.env ?? process.env);
    if (!desktop) return undefined;
    return resolveDesktopTranscriptPath(desktop.dataDir, nativeId);
  }

  private desktopAliasesFor(nativeId: string): Map<string, string> {
    try {
      const raw = this.host?.state(this.id, nativeId).get("agy-desktop-aliases");
      if (!raw) return new Map();
      return new Map(JSON.parse(raw) as [string, string][]);
    } catch {
      return new Map();
    }
  }

  private saveDesktopAliases(nativeId: string, aliases: Map<string, string>): void {
    try {
      this.host?.state(this.id, nativeId).set("agy-desktop-aliases", JSON.stringify([...aliases]));
    } catch {
      // ignore state write errors
    }
  }

  private isConversationRunningInDesktop(nativeId: string, statusCol?: string): boolean {
    const desktop = resolveAntigravityDesktop(this.options.env ?? process.env);
    if (!desktop) return false;
    const lockPath = join(desktop.dataDir, "presence", `${nativeId}.lock`);
    if (!existsSync(lockPath)) return false;
    let status = statusCol;
    if (status === undefined) {
      const dbPath = join(desktop.dataDir, "conversation_summaries.db");
      if (existsSync(dbPath)) {
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(dbPath, { readOnly: true });
          const row = db
            .prepare("SELECT status FROM conversation_summaries WHERE conversation_id = ?")
            .get(nativeId) as { status?: string } | undefined;
          status = row?.status;
        } catch {
          // ignore
        } finally {
          try {
            db?.close();
          } catch {
            // ignore
          }
        }
      }
    }
    return status === "CASCADE_RUN_STATUS_RUNNING";
  }

  private listDesktopSessions(limit: number): DiscoveredSession[] {
    const desktop = resolveAntigravityDesktop(this.options.env ?? process.env);
    if (!desktop) return [];
    const dbPath = join(desktop.dataDir, "conversation_summaries.db");
    const home = (this.options.env ?? process.env).HOME || homedir();
    const results: DiscoveredSession[] = [];

    if (existsSync(dbPath)) {
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const rows = db
          .prepare(
            `SELECT conversation_id, title, last_modified_time, workspace_uris, status, parent_conversation_id, killed
             FROM conversation_summaries
             WHERE (parent_conversation_id = '' OR parent_conversation_id IS NULL) AND killed = 0
             ORDER BY last_modified_time DESC
             LIMIT ?`,
          )
          .all(limit) as {
          conversation_id: string;
          title: string;
          last_modified_time: string;
          workspace_uris: string;
          status: string;
        }[];

        for (const row of rows) {
          if (!row.conversation_id) continue;
          const cwd = parseWorkspaceCwd(row.workspace_uris, home);
          const updatedAt = Date.parse(row.last_modified_time) || Date.now();
          let title = row.title?.trim() || undefined;
          let model: string | undefined;
          const transcriptPath = resolveDesktopTranscriptPath(desktop.dataDir, row.conversation_id);
          if (!title && existsSync(transcriptPath)) {
            const parsed = parseAntigravityTranscript(transcriptPath, 0);
            model = parsed.lastModelLabel;
            const firstUser = parsed.items.find((entry) => entry.updates.some((u) => u.sessionUpdate === "user_message_chunk"));
            const chunk = firstUser?.updates.find((u) => u.sessionUpdate === "user_message_chunk" && u.content.type === "text");
            if (chunk?.sessionUpdate === "user_message_chunk" && chunk.content.type === "text") {
              title = chunk.content.text.split("\n")[0]?.slice(0, 100).trim() || undefined;
            }
          }
          const running = this.isConversationRunningInDesktop(row.conversation_id, row.status);
          const state = running ? "running" : "idle";
          if (!this.desktopSessionStates.has(row.conversation_id)) {
            this.desktopSessionStates.set(row.conversation_id, state);
          }
          results.push({
            nativeId: row.conversation_id,
            cwd,
            title,
            ...(model ? { model } : {}),
            createdAt: updatedAt,
            updatedAt,
            state,
          });
        }
      } catch {
        // fallback to brain directory scan below if sqlite table is locked or unreadable
      } finally {
        try {
          db?.close();
        } catch {
          // ignore close errors
        }
      }
    }

    if (results.length === 0 && existsSync(join(desktop.dataDir, "brain"))) {
      try {
        const dirs = readdirSync(join(desktop.dataDir, "brain"));
        for (const id of dirs) {
          const transcriptPath = resolveDesktopTranscriptPath(desktop.dataDir, id);
          if (!existsSync(transcriptPath)) continue;
          const stat = statSync(transcriptPath);
          const parsed = parseAntigravityTranscript(transcriptPath, 0);
          const firstUser = parsed.items.find((entry) => entry.updates.some((u) => u.sessionUpdate === "user_message_chunk"));
          const chunk = firstUser?.updates.find((u) => u.sessionUpdate === "user_message_chunk" && u.content.type === "text");
          const title =
            chunk?.sessionUpdate === "user_message_chunk" && chunk.content.type === "text"
              ? chunk.content.text.split("\n")[0]?.slice(0, 100).trim()
              : undefined;
          results.push({
            nativeId: id,
            cwd: home,
            title,
            ...(parsed.lastModelLabel ? { model: parsed.lastModelLabel } : {}),
            createdAt: stat.mtimeMs,
            updatedAt: stat.mtimeMs,
            state: "idle",
          });
          if (results.length >= limit) break;
        }
      } catch {
        // ignore unreadable brain dir
      }
    }

    return results;
  }

  override async listSessions(limit: number): Promise<DiscoveredSession[]> {
    const acpSessions = !this.desktopMode && this.connection?.alive ? await super.listSessions(limit).catch(() => []) : [];
    const desktopSessions = this.listDesktopSessions(limit);
    const merged = new Map<string, DiscoveredSession>();
    for (const session of [...acpSessions, ...desktopSessions]) {
      if (!merged.has(session.nativeId)) merged.set(session.nativeId, session);
    }
    return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  private async loadDesktopModels(): Promise<{ value: string; name: string; description?: string }[]> {
    if (this.desktopModelsCache?.length) return this.desktopModelsCache;
    const desktop = resolveAntigravityDesktop(this.options.env ?? process.env);
    const conn = await findRunningLanguageServer(desktop);
    if (!conn) return [];
    try {
      const data = await callLanguageServer<{
        clientModelConfigs?: {
          label?: string;
          modelOrAlias?: { model?: string; alias?: string };
          tagTitle?: string;
          isRecommended?: boolean;
        }[];
        clientModelSorts?: {
          name?: string;
          groups?: { modelLabels?: string[] }[];
        }[];
        defaultOverrideModelConfig?: {
          modelOrAlias?: { model?: string; alias?: string };
        };
      }>(conn, "GetCascadeModelConfigData", {});

      const defaultOverride =
        data.defaultOverrideModelConfig?.modelOrAlias?.model ??
        data.defaultOverrideModelConfig?.modelOrAlias?.alias;
      if (defaultOverride) this.desktopDefaultModel = defaultOverride;

      const sortOrder = new Map<string, number>();
      const sortedLabels = data.clientModelSorts?.[0]?.groups?.flatMap((g) => g.modelLabels ?? []) ?? [];
      sortedLabels.forEach((label, idx) => {
        if (!sortOrder.has(label)) sortOrder.set(label, idx);
      });

      const models = (data.clientModelConfigs ?? [])
        .map((entry) => {
          const value = entry.modelOrAlias?.model ?? entry.modelOrAlias?.alias;
          const name = entry.label?.trim();
          if (!value || !name) return undefined;
          return {
            value,
            name,
            ...(entry.tagTitle ? { description: entry.tagTitle } : {}),
          };
        })
        .filter((entry): entry is { value: string; name: string; description?: string } => Boolean(entry));

      if (sortOrder.size > 0) {
        models.sort((a, b) => {
          const rankA = sortOrder.get(a.name) ?? 9999;
          const rankB = sortOrder.get(b.name) ?? 9999;
          return rankA - rankB;
        });
      }

      if (models.length > 0) this.desktopModelsCache = models;
      return models;
    } catch {
      return [];
    }
  }

  private async resolveSessionModel(
    nativeId: string,
    models: { value: string; name: string; description?: string }[],
    explicitModel?: string,
  ): Promise<{ value: string; name: string; description?: string }> {
    const matchByValueOrName = (candidate: string | undefined) => {
      if (!candidate) return undefined;
      return models.find((m) => m.value === candidate || m.name === candidate);
    };

    const watcher = this.desktopWatchers.get(nativeId);
    const persistedSelected = this.host?.state(this.id, nativeId).get("agy-selected-model");
    const chosen =
      matchByValueOrName(explicitModel) ??
      matchByValueOrName(watcher?.selectedModel) ??
      matchByValueOrName(persistedSelected) ??
      matchByValueOrName(watcher?.lastModelLabel);
    if (chosen) return chosen;

    const desktop = resolveAntigravityDesktop(this.options.env ?? process.env);
    const conn = await findRunningLanguageServer(desktop);
    if (conn) {
      try {
        const meta = await callLanguageServer<{
          generatorMetadata?: {
            plannerConfig?: {
              planModel?: string;
              requestedModel?: { model?: string; alias?: string };
            };
            chatModel?: { model?: string };
          }[];
        }>(conn, "GetCascadeTrajectoryGeneratorMetadata", { cascadeId: nativeId });
        const entries = meta.generatorMetadata ?? [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i]!;
          const candidate =
            entry.plannerConfig?.requestedModel?.model ??
            entry.plannerConfig?.requestedModel?.alias ??
            entry.plannerConfig?.planModel ??
            entry.chatModel?.model;
          const found = matchByValueOrName(candidate);
          if (found) return found;
        }
      } catch {
        // ignore metadata RPC failure
      }
    }

    const fromDefault = matchByValueOrName(this.desktopDefaultModel);
    if (fromDefault) return fromDefault;

    if (desktop && existsSync(join(desktop.dataDir, "antigravity_state.pbtxt"))) {
      try {
        const stateText = readFileSync(join(desktop.dataDir, "antigravity_state.pbtxt"), "utf8");
        const match = /last_selected_agent_model:\s*(\S+)/.exec(stateText);
        const found = matchByValueOrName(match?.[1]);
        if (found) return found;
      } catch {
        // ignore
      }
    }

    return models[0]!;
  }

  private async resolvePlanModelEnum(
    conn: LanguageServerConnection,
    nativeId: string,
    explicitModel?: string,
  ): Promise<string> {
    const models = await this.loadDesktopModels();
    if (models.length > 0) {
      const matched = await this.resolveSessionModel(nativeId, models, explicitModel);
      if (matched?.value) return matched.value;
    }
    if (explicitModel?.startsWith("MODEL_")) return explicitModel;
    if (nativeId) {
      try {
        const meta = await callLanguageServer<{
          generatorMetadata?: {
            plannerConfig?: {
              planModel?: string;
              requestedModel?: { model?: string };
            };
            chatModel?: { model?: string };
          }[];
        }>(conn, "GetCascadeTrajectoryGeneratorMetadata", { cascadeId: nativeId });
        const entries = meta.generatorMetadata ?? [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i]!;
          const candidate =
            entry.plannerConfig?.planModel ??
            entry.plannerConfig?.requestedModel?.model ??
            entry.chatModel?.model;
          if (candidate?.startsWith("MODEL_")) return candidate;
        }
      } catch {
        // ignore metadata RPC failure
      }
    }
    if (this.desktopDefaultModel?.startsWith("MODEL_")) return this.desktopDefaultModel;
    return "MODEL_PLACEHOLDER_M418";
  }

  private async emitDesktopConfig(nativeId: string, selectedModel?: string): Promise<void> {
    this.host?.update(this.id, nativeId, {
      sessionUpdate: "available_commands_update",
      availableCommands: ANTIGRAVITY_DESKTOP_COMMANDS,
    });
    const models = await this.loadDesktopModels();
    if (models.length === 0) return;
    const matched = await this.resolveSessionModel(nativeId, models, selectedModel);
    const options: SessionConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        current: matched.value,
        values: models,
      },
    ];
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_config", options });
    this.host?.update(this.id, nativeId, { sessionUpdate: "session_info_update", model: matched.name });
  }

  private startWatchingDesktopTranscript(
    nativeId: string,
    initialLine: number,
    initialMeta?: { lastModelLabel?: string; goal?: SessionGoal | null },
  ): DesktopWatcher {
    const existing = this.desktopWatchers.get(nativeId);
    if (existing) clearInterval(existing.timer);

    const activePath = this.transcriptPathFor(nativeId);
    const lastSize = activePath && existsSync(activePath) ? statSync(activePath).size : 0;
    const initialRunning = this.isConversationRunningInDesktop(nativeId);
    this.desktopSessionStates.set(nativeId, initialRunning ? "running" : "idle");

    const watcher: DesktopWatcher = {
      nextLine: initialLine,
      lastSize,
      running: initialRunning,
      detached: false,
      selectedModel: existing?.selectedModel ?? this.host?.state(this.id, nativeId).get("agy-selected-model") ?? undefined,
      lastModelLabel: initialMeta?.lastModelLabel ?? existing?.lastModelLabel,
      goal: initialMeta?.goal !== undefined ? initialMeta.goal : existing?.goal,
      pendingClientMessages: existing?.pendingClientMessages ?? [],
      timer: setInterval(() => {
        const currentPath = this.transcriptPathFor(nativeId);
        if (currentPath && existsSync(currentPath)) {
          try {
            const stat = statSync(currentPath);
            if (stat.size !== watcher.lastSize) {
              watcher.lastSize = stat.size;
              const parsed = parseAntigravityTranscript(currentPath, watcher.nextLine);
              watcher.nextLine = parsed.nextLine;
              if (parsed.lastModelLabel && parsed.lastModelLabel !== watcher.lastModelLabel) {
                watcher.lastModelLabel = parsed.lastModelLabel;
                watcher.selectedModel = parsed.lastModelLabel;
                this.host?.state(this.id, nativeId).set("agy-selected-model", parsed.lastModelLabel);
                void this.emitDesktopConfig(nativeId, parsed.lastModelLabel);
              }
              if (parsed.goal !== undefined) {
                watcher.goal = parsed.goal;
              }
              for (const item of parsed.items) {
                if (item.itemId.startsWith("agy:user:") && watcher.pendingClientMessages.length > 0) {
                  const pending = watcher.pendingClientMessages.shift()!;
                  const aliases = this.desktopAliasesFor(nativeId);
                  aliases.set(item.itemId, `local-${pending.clientMessageId}`);
                  this.saveDesktopAliases(nativeId, aliases);
                  // Emit only non-user_message_chunk updates (such as ls_goal) since the user message was already echoed with local-${clientMessageId}.
                  const nonUserUpdates = item.updates.filter((u) => u.sessionUpdate !== "user_message_chunk");
                  for (const update of nonUserUpdates) {
                    this.host?.update(this.id, nativeId, update);
                  }
                  continue;
                }
                item.updates.forEach((update, idx) => {
                  this.host?.update(this.id, nativeId, update, idx === item.updates.length - 1 ? item.itemId : undefined);
                });
              }
            }
          } catch {
            // ignore stat/read errors
          }
        }
        const nowRunning = this.isConversationRunningInDesktop(nativeId);
        if (nowRunning !== watcher.running) {
          watcher.running = nowRunning;
          this.desktopSessionStates.set(nativeId, nowRunning ? "running" : "idle");
          if (nowRunning) {
            this.host?.update(this.id, nativeId, { sessionUpdate: "ls_turn", state: "started" });
            this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: "running", turnActive: true });
          } else {
            this.host?.update(this.id, nativeId, { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
            this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: "idle", turnActive: false });
            if (watcher.detached) {
              clearInterval(watcher.timer);
              this.desktopWatchers.delete(nativeId);
            }
          }
        }
      }, 1500),
    };
    watcher.timer.unref?.();
    this.desktopWatchers.set(nativeId, watcher);
    return watcher;
  }

  override async attach(nativeId: string, context: AttachContext): Promise<HistoryItem[]> {
    const transcriptPath = this.transcriptPathFor(nativeId);
    if (this.desktopMode || (transcriptPath && existsSync(transcriptPath))) {
      await this.ensureStarted();
      const parsed = transcriptPath ? parseAntigravityTranscript(transcriptPath, 0) : { items: [], nextLine: 0 };
      const aliases = this.desktopAliasesFor(nativeId);
      const items = parsed.items.map((item) => {
        const aliasedId = aliases.get(item.itemId);
        return aliasedId ? { ...item, itemId: aliasedId } : item;
      });
      this.startWatchingDesktopTranscript(nativeId, parsed.nextLine, {
        lastModelLabel: parsed.lastModelLabel,
        goal: parsed.goal,
      });
      const running = this.isConversationRunningInDesktop(nativeId);
      this.desktopSessionStates.set(nativeId, running ? "running" : "idle");
      if (!running) {
        this.host?.update(this.id, nativeId, { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
      }
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: running ? "running" : "idle", turnActive: running });
      if (parsed.goal !== undefined) {
        this.host?.update(this.id, nativeId, { sessionUpdate: "ls_goal", goal: parsed.goal });
      }
      void this.emitDesktopConfig(nativeId, this.desktopWatchers.get(nativeId)?.selectedModel);
      return items;
    }
    return super.attach(nativeId, context);
  }

  override async detach(nativeId: string): Promise<void> {
    const watcher = this.desktopWatchers.get(nativeId);
    if (watcher) {
      if (watcher.running) {
        // Keep watching until the active turn completes so turn end and final messages are recorded.
        watcher.detached = true;
      } else {
        clearInterval(watcher.timer);
        this.desktopWatchers.delete(nativeId);
      }
    }
    await super.detach(nativeId);
  }

  override async createSession(options: { cwd: string; model?: string }): Promise<DiscoveredSession> {
    if (!this.desktopMode) return super.createSession(options);
    await this.ensureStarted();
    const desktop = resolveAntigravityDesktop(this.options.env ?? process.env);
    const conn = await findRunningLanguageServer(desktop);
    if (!conn) {
      throw RpcError.app("agent_unavailable", "请先在电脑上打开 Antigravity 桌面端应用");
    }
    const requestedModel = await this.resolvePlanModelEnum(conn, "", options.model);
    const response = await callLanguageServer<{ cascadeId?: string }>(conn, "StartCascade", {
      source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
      workspaceUris: [pathToFileURL(options.cwd).href],
      requestedModel,
    });
    const nativeId = response.cascadeId;
    if (!nativeId) throw RpcError.app("agent_unavailable", "Antigravity 未返回新会话 ID");
    const watcher = this.startWatchingDesktopTranscript(nativeId, 0);
    const selectedModel = options.model ?? requestedModel;
    watcher.selectedModel = selectedModel;
    this.host?.state(this.id, nativeId).set("agy-selected-model", selectedModel);
    void this.emitDesktopConfig(nativeId, selectedModel);
    const now = Date.now();
    return { nativeId, cwd: options.cwd, createdAt: now, updatedAt: now, state: "idle" };
  }

  async goal(nativeId: string, change: GoalChange): Promise<SessionGoal | null> {
    if (!this.desktopMode && !this.desktopWatchers.has(nativeId)) {
      throw RpcError.app("not_supported", "这个 Agent 通过 /goal 命令管理目标");
    }
    const watcher = this.desktopWatchers.get(nativeId);
    if (change.action === "get") {
      return watcher?.goal ?? null;
    }
    if (change.action === "clear") {
      if (watcher) watcher.goal = null;
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_goal", goal: null });
      return null;
    }
    if (change.action === "set") {
      const nextGoal: SessionGoal = { objective: change.objective, status: "active" };
      if (watcher) watcher.goal = nextGoal;
      await this.prompt(nativeId, [{ type: "text", text: `/goal ${change.objective}` }], `goal-${Date.now()}`);
      return nextGoal;
    }
    return watcher?.goal ?? null;
  }

  override async prompt(
    nativeId: string,
    content: ContentBlock[],
    clientMessageId: string,
    context?: string,
  ): Promise<"started" | "steered" | "queued"> {
    const transcriptPath = this.transcriptPathFor(nativeId);
    if (!this.desktopMode && !(transcriptPath && existsSync(transcriptPath))) {
      return super.prompt(nativeId, content, clientMessageId, context);
    }
    const desktop = resolveAntigravityDesktop(this.options.env ?? process.env);
    const conn = await findRunningLanguageServer(desktop);
    if (!conn) {
      throw RpcError.app("agent_unavailable", "请先在电脑上打开 Antigravity 桌面端应用，再发送消息");
    }
    const text = content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    const imageBlocks = content.filter((block): block is Extract<ContentBlock, { type: "image" }> => block.type === "image");
    if (!text && imageBlocks.length === 0) throw RpcError.app("invalid_params", "nothing to send");

    if (/^\/goal\s+(?:clear|stop|off|reset|none|cancel)\s*$/i.test(text) && imageBlocks.length === 0) {
      const watcher = this.desktopWatchers.get(nativeId);
      if (watcher) watcher.goal = null;
      this.host?.update(this.id, nativeId, {
        sessionUpdate: "user_message_chunk",
        messageId: `local-${clientMessageId}`,
        content: { type: "text", text },
      });
      this.host?.update(
        this.id,
        nativeId,
        { sessionUpdate: "ls_message_done", messageId: `local-${clientMessageId}`, role: "user" },
        `local-${clientMessageId}`,
      );
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_goal", goal: null });
      return "started";
    }

    let watcher = this.desktopWatchers.get(nativeId);
    if (!watcher) {
      const parsed = transcriptPath ? parseAntigravityTranscript(transcriptPath, 0) : undefined;
      watcher = this.startWatchingDesktopTranscript(nativeId, parsed?.nextLine ?? 0, parsed);
    }

    // Echo user message with `local-${clientMessageId}` so the mobile client's optimistic bubble is confirmed in-place.
    watcher.pendingClientMessages.push({ clientMessageId, text });
    const displayBlocks: ContentBlock[] = content.map((block) => {
      if (block.type === "text" && /^\/goal(?:\s+|$)/i.test(block.text.trim())) {
        const cleaned = block.text.trim().replace(/^\/goal(?:\s+|$)/i, "").trim() || block.text;
        return { type: "text", text: cleaned };
      }
      return block;
    });
    for (const block of displayBlocks) {
      this.host?.update(this.id, nativeId, {
        sessionUpdate: "user_message_chunk",
        messageId: `local-${clientMessageId}`,
        content: block,
      });
    }
    this.host?.update(
      this.id,
      nativeId,
      { sessionUpdate: "ls_message_done", messageId: `local-${clientMessageId}`, role: "user" },
      `local-${clientMessageId}`,
    );

    if (/^\/goal(?:\s+|$)/i.test(text)) {
      const objective = text.replace(/^\/goal(?:\s+|$)/i, "").trim() || "持续目标";
      const nextGoal: SessionGoal = { objective, status: "active" };
      watcher.goal = nextGoal;
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_goal", goal: nextGoal });
    } else if (watcher.goal?.status === "complete") {
      watcher.goal = null;
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_goal", goal: null });
    }

    const media: { mimeType: string; inlineData: string; uri?: string }[] = [];
    if (imageBlocks.length > 0 && desktop) {
      const uploadDir = join(desktop.dataDir, "brain", nativeId, ".user_uploaded");
      try {
        mkdirSync(uploadDir, { recursive: true });
      } catch {
        // ignore mkdir error
      }
      for (const img of imageBlocks) {
        if (!img.data) continue;
        const ext = extForMimeType(img.mimeType);
        const fileName = `media_${Date.now()}_${randomBytes(4).toString("hex")}.${ext}`;
        const filePath = join(uploadDir, fileName);
        let savedUri: string | undefined;
        try {
          writeFileSync(filePath, Buffer.from(img.data, "base64"));
          savedUri = filePath;
        } catch {
          // fallback to inlineData only
        }
        media.push({
          mimeType: img.mimeType,
          inlineData: img.data,
          ...(savedUri ? { uri: savedUri } : {}),
        });
      }
    }

    const fullText = context ? (text ? `${context}\n\n${text}` : context) : text;
    const planModel = await this.resolvePlanModelEnum(conn, nativeId, watcher.selectedModel);

    watcher.running = true;
    this.desktopSessionStates.set(nativeId, "running");
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_turn", state: "started" });
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: "running", turnActive: true });

    await callLanguageServer(conn, "SendUserCascadeMessage", {
      cascadeId: nativeId,
      items: [{ text: fullText || "请查看附图" }],
      ...(media.length > 0 ? { media } : {}),
      cascadeConfig: {
        plannerConfig: {
          supportsLatexRendering: true,
          toolConfig: {
            runCommand: {
              autoCommandConfig: {
                autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER",
              },
            },
            notifyUser: {},
          },
          planModel,
          useAiCredits: false,
        },
        executorConfig: {
          useCoreDirect: true,
        },
        conversationHistoryConfig: {},
      },
      customAgentSpec: {
        builtinAgent: {
          defaultAgent: {
            isGoogle: false,
            isInteractive: true,
            surface: "AGENT_SURFACE_HUB",
          },
        },
      },
    });

    return "started";
  }

  override async cancel(nativeId: string): Promise<void> {
    if (this.desktopMode || this.desktopWatchers.has(nativeId)) {
      const desktop = resolveAntigravityDesktop(this.options.env ?? process.env);
      const conn = await findRunningLanguageServer(desktop);
      if (conn) {
        await callLanguageServer(conn, "CancelCascadeInvocation", {
          cascadeId: nativeId,
          killBackgroundTasks: false,
        }).catch(() => {});
      }
      const watcher = this.desktopWatchers.get(nativeId);
      if (watcher) watcher.running = false;
      this.desktopSessionStates.set(nativeId, "idle");
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_turn", state: "ended", stopReason: "cancelled" });
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: "idle", turnActive: false });
      return;
    }
    await super.cancel(nativeId);
  }

  override async setConfig(nativeId: string, optionId: string, value: string): Promise<void> {
    if (this.desktopMode || this.desktopWatchers.has(nativeId)) {
      if (optionId !== "model") throw RpcError.app("not_supported", `Antigravity 暂不支持设置 ${optionId}`);
      const watcher = this.desktopWatchers.get(nativeId);
      if (watcher) watcher.selectedModel = value;
      this.host?.state(this.id, nativeId).set("agy-selected-model", value);
      await this.emitDesktopConfig(nativeId, value);
      return;
    }
    await super.setConfig(nativeId, optionId, value);
  }
}
