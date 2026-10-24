import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
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
  type Question,
  type QuestionAnswer,
  type SessionConfigOption,
  type SessionGoal,
  type SessionUpdate,
  type ToolCallContent,
  type ToolDetail,
  type ToolKind,
} from "@linkshell/wire";
import { QUESTION_OPTIONS } from "../../questions.js";
import type { DriverBehavior } from "../behavior.js";
import type { AttachContext, DiscoveredSession, ForkOptions, HistoryItem } from "../types.js";
import { nestUnder } from "../nesting.js";
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

function readHead(filePath: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Watchers, discovery and every RPC resolve the desktop; the answer only changes when the app is installed or moved.
const DESKTOP_CACHE_MS = 5000;
let desktopCache: { key: string; at: number; value: ResolvedAntigravityDesktop } | undefined;

/**
 * Resolves an installed Antigravity Desktop app (`/Applications/Antigravity.app`)
 * and its conversation store (`~/.gemini/antigravity`).
 */
export function resolveAntigravityDesktop(env: NodeJS.ProcessEnv = process.env): ResolvedAntigravityDesktop | undefined {
  if (env.PATH === "" && !env.ANTIGRAVITY_APP_DATA_DIR) return undefined;
  const key = `${env.HOME ?? ""}\n${env.ANTIGRAVITY_APP_DATA_DIR ?? ""}`;
  if (desktopCache && desktopCache.key === key && Date.now() - desktopCache.at < DESKTOP_CACHE_MS) return desktopCache.value;
  const value = resolveAntigravityDesktopUncached(env);
  desktopCache = value ? { key, at: Date.now(), value } : undefined;
  return value;
}

function resolveAntigravityDesktopUncached(env: NodeJS.ProcessEnv): ResolvedAntigravityDesktop | undefined {
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
    const match = /Language server version:\s*([^\s\r\n]+)/i.exec(readHead(logPath, 16 * 1024));
    if (match?.[1]) version = match[1];
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
  error?: string;
  thinking?: string;
  tool_calls?: TranscriptToolCall[];
  media?: TranscriptMedia[];
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
}

/** Used only while the language server can't be asked (GetSlashCommands); mirrors its system commands. */
const ANTIGRAVITY_DESKTOP_COMMANDS = [
  { name: "goal", description: "设定持续目标，让 Antigravity 持续推进直到完成", hint: "<目标描述>" },
  { name: "plan", description: "先制定分步执行计划，再动手实现", hint: "<任务描述>" },
  { name: "boost", description: "深度思考、多视角分析与严格验证模式", hint: "<复杂问题或任务>" },
  { name: "teamwork-preview", description: "启动多 Agent 协作团队共同完成大型项目", hint: "<项目任务>" },
  { name: "grill-me", description: "通过互动提问对齐方案细节与设计决策", hint: "<主题>" },
  { name: "browser", description: "调用浏览器子 Agent 完成网页任务", hint: "<网页任务>" },
  { name: "compact", description: "压缩并总结当前对话上下文以释放窗口空间" },
  { name: "schedule", description: "创建定时任务或后台周期自动化", hint: "<定时指令>" },
  { name: "learn", description: "总结并持久化当前经验与约定供后续会话使用" },
];

/** Chinese descriptions for the language server's system commands; skills keep their own (they are user-authored). */
const SYSTEM_COMMAND_TEXT = new Map(ANTIGRAVITY_DESKTOP_COMMANDS.map((command) => [command.name, command]));

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

function stripStepHeader(text: string): string {
  return text.replace(/^Created At: [^\n]*\n(?:Completed At: [^\n]*\n)?/, "");
}

function toolOutputText(step: TranscriptStep): string {
  const raw = typeof step.content === "string" && step.content.trim() ? step.content : step.error ?? "";
  return stripStepHeader(stripTruncationMarkers(raw)).trim();
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
  // Names carry dots ("Claude Opus 5.5 (High)", "Gemini 3.8 Flash (Low)"): one ends at the sentence's
  // full stop, a dot followed by a space or the line's end. Stopping at the first dot made the match
  // skip ahead to "No need to comment…" and read that as the model.
  const regex = /changed setting `?Model Selection`? from .+? to (.+?)(?:\.(?=\s|$)|<\/USER_SETTINGS_CHANGE>|$)/gim;
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

export interface AskQuestionItem {
  question: string;
  isMultiSelect?: boolean;
  options?: { id: string; text: string }[];
}

export interface PendingDesktopAskQuestion {
  stepIndex: number;
  toolCallId: string;
  title: string;
  questions: AskQuestionItem[];
}

function parseAskQuestionEntries(args: Record<string, unknown>): AskQuestionItem[] {
  const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
  const entries: AskQuestionItem[] = [];
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const question = typeof rec.question === "string" ? rec.question.trim() : "";
    if (!question) continue;
    const isMultiSelect = rec.is_multi_select === true || rec.isMultiSelect === true;
    const rawOpts = Array.isArray(rec.options) ? rec.options : [];
    const options = rawOpts
      .map((opt, idx) => {
        if (typeof opt === "string") return { id: String(idx + 1), text: opt };
        if (opt && typeof opt === "object") {
          const o = opt as Record<string, unknown>;
          const text = typeof o.text === "string" ? o.text : typeof o.label === "string" ? o.label : "";
          const id = typeof o.id === "string" ? o.id : String(idx + 1);
          return text ? { id, text } : undefined;
        }
        return undefined;
      })
      .filter((entry): entry is { id: string; text: string } => Boolean(entry));
    entries.push({
      question,
      ...(isMultiSelect ? { isMultiSelect: true } : {}),
      ...(options.length > 0 ? { options } : {}),
    });
  }
  return entries;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Diffs bigger than this stay out of the event log; the phone shows the file path and summary instead. */
const MAX_DIFF_CHARS = 200_000;

function editContent(name: string, path: string, args: Record<string, unknown>): ToolCallContent[] | undefined {
  const diffs: ToolCallContent[] = [];
  if (name === "write_to_file") {
    const newText = typeof args.CodeContent === "string" ? args.CodeContent : undefined;
    if (newText !== undefined) diffs.push({ type: "diff", path, oldText: null, newText });
  } else if (name === "replace_file_content") {
    const oldText = typeof args.TargetContent === "string" ? args.TargetContent : undefined;
    const newText = typeof args.ReplacementContent === "string" ? args.ReplacementContent : undefined;
    if (oldText !== undefined && newText !== undefined) diffs.push({ type: "diff", path, oldText, newText });
  } else if (name === "multi_replace_file_content") {
    const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [];
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== "object") continue;
      const rec = chunk as Record<string, unknown>;
      if (typeof rec.TargetContent === "string" && typeof rec.ReplacementContent === "string") {
        diffs.push({ type: "diff", path, oldText: rec.TargetContent, newText: rec.ReplacementContent });
      }
    }
  }
  const size = diffs.reduce((total, diff) => total + (diff.type === "diff" ? diff.newText.length + (diff.oldText?.length ?? 0) : 0), 0);
  return diffs.length > 0 && size <= MAX_DIFF_CHARS ? diffs : undefined;
}

/** The sub-agent conversations a tool output names (invoke_subagent answers with their ids). */
function subagentIdsFromOutput(output: string | undefined): string[] {
  if (!output) return [];
  return [...output.matchAll(/"conversationId":\s*"([0-9a-f-]{36})"/gi)].map((match) => match[1]!);
}

/**
 * invoke_subagent can start several sub-agents at once; the call itself carries
 * the first, and each further one gets a call of its own so its work nests apart.
 */
function extraSpawns(call: TranscriptToolCall, toolCallId: string, output: string | undefined): SessionUpdate[] {
  if (call.name !== "invoke_subagent") return [];
  const ids = subagentIdsFromOutput(output);
  const specs = (() => {
    const args = parseToolArgs(call.args);
    return Array.isArray(args.Subagents) ? (args.Subagents as Record<string, unknown>[]) : [];
  })();
  return ids.slice(1).map((nativeSessionId, offset) => {
    const spec = specs[offset + 1] ?? {};
    const role = str(spec.Role);
    return {
      sessionUpdate: "tool_call",
      toolCallId: `${toolCallId}#${offset + 1}`,
      title: role ?? "Sub-agent",
      name: "invoke_subagent",
      kind: "other",
      status: "completed",
      detail: {
        type: "subagent",
        action: "spawn",
        ...(str(spec.Prompt) ? { task: str(spec.Prompt)!.slice(0, 2000) } : {}),
        ...(str(spec.TypeName) ? { agentType: str(spec.TypeName) } : {}),
        ...(role ? { name: role } : {}),
        nativeSessionId,
        canCancel: true,
      },
    } satisfies SessionUpdate;
  });
}

function mapAntigravityToolCall(
  stepIndex: number,
  callIndex: number,
  call: TranscriptToolCall,
  output?: { text: string; failed: boolean },
  pending = false,
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
  let detail: ToolDetail | undefined;
  let content: ToolCallContent[] | undefined;

  if (name === "run_command") {
    kind = "execute";
    rawInput = {
      command: typeof args.CommandLine === "string" ? args.CommandLine : summary,
      cwd: typeof args.Cwd === "string" ? args.Cwd : undefined,
    };
  } else if (name === "view_file" || name === "view_code_item") {
    kind = "read";
    const path = str(args.AbsolutePath) ?? str(args.File);
    const line = typeof args.StartLine === "number" ? args.StartLine : undefined;
    if (path) {
      rawInput = { file_path: path };
      locations = [{ path, ...(line ? { line } : {}) }];
    }
  } else if (name === "list_dir") {
    kind = "read";
    const path = str(args.DirectoryPath);
    if (path) {
      rawInput = { path };
      locations = [{ path }];
    }
  } else if (name === "grep_search" || name === "find_by_name" || name === "codebase_search") {
    kind = "search";
    const path = str(args.SearchPath) ?? str(args.SearchDirectory) ?? str(args.DirectoryPath);
    rawInput = {
      query: str(args.Query) ?? str(args.Pattern) ?? summary,
      ...(path ? { path } : {}),
    };
    if (path) locations = [{ path }];
  } else if (name === "replace_file_content" || name === "multi_replace_file_content" || name === "write_to_file") {
    kind = "edit";
    const path = typeof args.TargetFile === "string" ? args.TargetFile : undefined;
    const line = typeof args.StartLine === "number" ? args.StartLine : undefined;
    if (path) {
      rawInput = { file_path: path };
      locations = [{ path, ...(line ? { line } : {}) }];
      content = editContent(name, path, args);
    }
  } else if (name === "search_web") {
    kind = "search";
    const query = typeof args.query === "string" ? args.query : summary;
    rawInput = { query };
    detail = { type: "web_search", query };
  } else if (name === "read_url_content") {
    kind = "fetch";
    rawInput = { url: typeof args.Url === "string" ? args.Url : summary };
  } else if (name === "call_mcp_tool" || name === "read_resource" || name === "list_resources") {
    const server = str(args.ServerName) ?? "mcp";
    const tool = str(args.ToolName) ?? (name === "call_mcp_tool" ? "tool" : name);
    rawInput = (args.Arguments && typeof args.Arguments === "object" ? args.Arguments : args) as Record<string, unknown>;
    detail = { type: "mcp", server, tool };
  } else if (name === "invoke_subagent") {
    const first = Array.isArray(args.Subagents) ? (args.Subagents[0] as Record<string, unknown> | undefined) : undefined;
    const nativeSessionId = subagentIdsFromOutput(output?.text)[0];
    detail = {
      type: "subagent",
      action: "spawn",
      ...(str(first?.Prompt) ? { task: str(first?.Prompt)!.slice(0, 2000) } : {}),
      ...(str(first?.TypeName) ? { agentType: str(first?.TypeName) } : {}),
      ...(str(first?.Role) ? { name: str(first?.Role) } : {}),
      ...(nativeSessionId ? { nativeSessionId, canCancel: true } : {}),
    };
  } else if (name === "send_message") {
    const recipient = str(args.Recipient);
    detail = { type: "subagent", action: "message", ...(recipient ? { nativeSessionId: recipient } : {}) };
  } else if (name === "manage_subagents") {
    const action = str(args.Action);
    detail = { type: "subagent", action: action === "list" ? "list" : "stop" };
  } else if (name === "ask_question") {
    const entries = parseAskQuestionEntries(args);
    if (entries.length > 0) {
      detail = {
        type: "question",
        text: entries[0]!.question,
        ...(entries.length > 1 ? { more: entries.length - 1 } : {}),
      };
    }
  }

  const cleanedOutput = output?.text || undefined;

  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: summary,
    name,
    kind,
    status: pending ? "in_progress" : output?.failed ? "failed" : "completed",
    rawInput,
    ...(cleanedOutput ? { rawOutput: { output: cleanedOutput } } : {}),
    ...(content ? { content } : {}),
    ...(locations ? { locations } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** What has to be remembered between reads of a transcript so the next lines are understood the same way. */
export interface TranscriptParseState {
  goal: SessionGoal | null;
  lastModelLabel?: string;
  lastStepIndex?: number;
  /** A reply whose tool calls are still waiting for their outputs (the GENERIC steps that follow). */
  openCalls?: { stepIndex: number; calls: TranscriptToolCall[]; consumed: number };
}

export function newTranscriptParseState(): TranscriptParseState {
  return { goal: null };
}

/**
 * Turns transcript steps into history items, carrying `state` across calls so
 * the transcript can be read a few lines at a time. Tool calls whose outputs
 * haven't been written yet are `in_progress`; their outputs arrive later as
 * `tool_call_update`s.
 */
export function parseTranscriptSteps(
  parsed: { index: number; step: TranscriptStep }[],
  state: TranscriptParseState,
): { items: HistoryItem[]; pendingAskQuestion?: PendingDesktopAskQuestion } {
  const items: HistoryItem[] = [];
  let pendingAskQuestion: PendingDesktopAskQuestion | undefined;
  let lastPlanner = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]!.step.type === "PLANNER_RESPONSE") {
      lastPlanner = i;
      break;
    }
  }

  for (let i = 0; i < parsed.length; i++) {
    const { index: stepIndex, step } = parsed[i]!;
    state.lastStepIndex = stepIndex;
    if (step.type === "GENERIC") {
      const open = state.openCalls;
      if (!open) continue;
      const callIdx = open.consumed;
      const call = open.calls[callIdx];
      open.consumed += 1;
      if (open.consumed >= open.calls.length) state.openCalls = undefined;
      const text = toolOutputText(step);
      if (call) {
        const toolCallId = call.id || `agy:tc:${open.stepIndex}:${callIdx}`;
        // The output is what names a spawned sub-agent's conversation, so its detail is only complete now.
        const settled = mapAntigravityToolCall(open.stepIndex, callIdx, call, { text, failed: step.status === "ERROR" });
        const detail = settled.sessionUpdate === "tool_call" ? settled.detail : undefined;
        items.push({
          itemId: `agy:tc-out:${stepIndex}`,
          updates: [
            {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: step.status === "ERROR" ? "failed" : "completed",
              ...(detail ? { detail } : {}),
              ...(text ? { rawOutput: { output: text } } : {}),
            },
            ...extraSpawns(call, toolCallId, text),
          ],
        });
      }
      continue;
    }
    state.openCalls = undefined;

    if (step.type === "USER_INPUT") {
      if (typeof step.content === "string") {
        const modelLabel = extractModelSelectionFromContent(step.content);
        if (modelLabel) state.lastModelLabel = modelLabel;
      }
      const rawText = typeof step.content === "string" ? cleanAntigravityUserInput(step.content) : "";
      const mediaBlocks = readStepMediaBlocks(step.media);
      let displayText = rawText;
      let goalUpdate: SessionUpdate | undefined;

      if (/^\/goal\s+(?:clear|stop|off|reset|none|cancel)\s*$/i.test(rawText)) {
        state.goal = null;
        goalUpdate = { sessionUpdate: "ls_goal", goal: null };
      } else if (/^\/goal(?:\s+|$)/i.test(rawText) || (typeof step.content === "string" && /\/goal is a \[Slash Command\]:/i.test(step.content))) {
        const objective = rawText.replace(/^\/goal(?:\s+|$)/i, "").trim() || "持续目标";
        displayText = objective;
        state.goal = { objective, status: "active" };
        goalUpdate = { sessionUpdate: "ls_goal", goal: state.goal };
      } else if (state.goal?.status === "complete") {
        state.goal = null;
        goalUpdate = { sessionUpdate: "ls_goal", goal: null };
      }

      if (!displayText && mediaBlocks.length === 0 && !goalUpdate) continue;
      const messageId = `agy:user:${stepIndex}`;
      const updates: SessionUpdate[] = [];
      for (const mediaBlock of mediaBlocks) {
        updates.push({ sessionUpdate: "user_message_chunk", messageId, content: mediaBlock });
      }
      if (displayText) {
        updates.push({ sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text: displayText } });
      }
      if (goalUpdate) updates.push(goalUpdate);
      items.push({ itemId: messageId, updates });
    } else if (step.type === "SYSTEM_MESSAGE") {
      const nextGoal = parseGoalSystemMessage(step.content, state.goal);
      if (nextGoal) {
        state.goal = nextGoal;
        items.push({ itemId: `agy:goal:${stepIndex}`, updates: [{ sessionUpdate: "ls_goal", goal: nextGoal }] });
      }
    } else if (step.type === "CHECKPOINT") {
      // A compaction: the transcript keeps the summary the agent resumes from; the phone shows that it happened.
      const toolCallId = `agy:checkpoint:${stepIndex}`;
      items.push({
        itemId: toolCallId,
        updates: [{ sessionUpdate: "tool_call", toolCallId, title: "上下文已压缩", kind: "think", status: "completed", detail: { type: "compaction" } }],
      });
    } else if (step.type === "ERROR_MESSAGE" || step.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE") {
      const errText = typeof step.content === "string" && step.content.trim()
        ? stripTruncationMarkers(step.content).trim()
        : (step.error ?? "").trim();
      if (errText) {
        items.push({ itemId: `agy:err:${stepIndex}`, updates: [{ sessionUpdate: "ls_error", code: "agent_error", message: errText }] });
      }
    } else if (step.type === "PLANNER_RESPONSE") {
      const updates: SessionUpdate[] = [];
      if (typeof step.thinking === "string") {
        const cleanThought = stripTruncationMarkers(step.thinking).trim();
        if (cleanThought) {
          const thoughtId = `agy:thought:${stepIndex}`;
          updates.push(
            { sessionUpdate: "agent_thought_chunk", messageId: thoughtId, content: { type: "text", text: cleanThought } },
            { sessionUpdate: "ls_message_done", messageId: thoughtId, role: "thought" },
          );
        }
      }

      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      if (calls.length > 0) {
        // The GENERIC steps that follow hold these calls' outputs, in order.
        const outputs: { text: string; failed: boolean }[] = [];
        let lookahead = i + 1;
        while (lookahead < parsed.length && parsed[lookahead]!.step.type === "GENERIC" && outputs.length < calls.length) {
          const output = parsed[lookahead]!.step;
          outputs.push({ text: toolOutputText(output), failed: output.status === "ERROR" });
          lookahead++;
        }
        const atTail = lookahead >= parsed.length;
        calls.forEach((call, callIdx) => {
          const output = outputs[callIdx];
          updates.push(mapAntigravityToolCall(stepIndex, callIdx, call, output, !output && atTail));
          updates.push(...extraSpawns(call, call.id || `agy:tc:${stepIndex}:${callIdx}`, output?.text));
          if (call.name === "ask_question" && !output && atTail) {
            const args = parseToolArgs(call.args);
            const askEntries = parseAskQuestionEntries(args);
            if (askEntries.length > 0) {
              pendingAskQuestion = {
                stepIndex: stepIndex + 1 + callIdx,
                toolCallId: call.id || `agy:tc:${stepIndex}:${callIdx}`,
                title: str(args.toolSummary)?.trim() || str(args.toolAction)?.trim() || "Antigravity 有问题需要你回答",
                questions: askEntries,
              };
            }
          }
        });
        if (outputs.length < calls.length && atTail) {
          state.openCalls = { stepIndex, calls, consumed: outputs.length };
        }
        if (lookahead > i + 1) {
          for (let j = i + 1; j < lookahead; j++) state.lastStepIndex = parsed[j]!.index;
          i = lookahead - 1;
        }
      }

      if (typeof step.content === "string" && step.content.trim()) {
        const { text: cleanText, goalComplete, goalCancelled } = cleanAntigravityAgentContent(step.content);
        if (cleanText) {
          const messageId = `agy:msg:${stepIndex}`;
          updates.push(
            { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: cleanText } },
            { sessionUpdate: "ls_message_done", messageId, role: "agent" },
          );
        }
        if (goalCancelled) {
          state.goal = null;
          updates.push({ sessionUpdate: "ls_goal", goal: null });
        } else if (goalComplete) {
          state.goal = { ...(state.goal ?? { objective: "持续目标" }), status: "complete" };
          updates.push({ sessionUpdate: "ls_goal", goal: state.goal });
        }
      }

      // Each step is a distinct usage record; only the latest supplies context occupancy.
      const input = (step.input_tokens ?? 0) + (step.cache_read_tokens ?? 0);
      if (input > 0 || (step.output_tokens ?? 0) > 0) {
        const timestamp = Date.parse(step.created_at ?? "");
        updates.push({ sessionUpdate: "usage_update",
          usedTokens: i === lastPlanner || (lastPlanner >= 0 && parsed[lastPlanner]!.index === stepIndex) ? input : undefined,
          ...(Number.isFinite(timestamp) ? { accounting: { id: `agy:step:${stepIndex}`, scope: "turn" as const, timestamp, model: state.lastModelLabel } } : {}),
          tokens: { totalTokens: input + (step.output_tokens ?? 0), inputTokens: step.input_tokens ?? 0,
            outputTokens: step.output_tokens ?? 0, cachedReadTokens: step.cache_read_tokens ?? 0 },
        });
      }

      if (updates.length > 0) items.push({ itemId: `agy:step:${stepIndex}`, updates });
    }
  }

  return { items, ...(pendingAskQuestion ? { pendingAskQuestion } : {}) };
}

function parseTranscriptLines(lines: string[], startLine: number): { index: number; step: TranscriptStep }[] {
  const parsed: { index: number; step: TranscriptStep }[] = [];
  lines.forEach((line, offset) => {
    if (!line.trim()) return;
    try {
      const step = JSON.parse(line) as TranscriptStep;
      parsed.push({ index: step.step_index ?? startLine + offset, step });
    } catch {
      // a malformed line can't be recovered; skip it rather than stall every later line
    }
  });
  return parsed;
}

/**
 * Converts an Antigravity Desktop `transcript_full.jsonl` (or `transcript.jsonl`)
 * file into LinkShell's `HistoryItem[]` list, tracking Goal Mode (`ls_goal`),
 * model changes (`<USER_SETTINGS_CHANGE>`), and uploaded media. Lines before
 * `fromLine` only rebuild state.
 */
export function parseAntigravityTranscript(
  transcriptPath: string,
  fromLine = 0,
): {
  items: HistoryItem[];
  nextLine: number;
  lastStepIndex?: number;
  lastModelLabel?: string;
  goal?: SessionGoal | null;
  pendingAskQuestion?: PendingDesktopAskQuestion;
  state: TranscriptParseState;
  /** Byte offset just past the last complete line: where a TranscriptTail picks up. */
  endOffset: number;
} {
  const state = newTranscriptParseState();
  if (!existsSync(transcriptPath)) return { items: [], nextLine: fromLine, state, endOffset: 0 };
  let text: string;
  try {
    text = readFileSync(transcriptPath, "utf8");
  } catch {
    return { items: [], nextLine: fromLine, state, endOffset: 0 };
  }
  // A line still being written has no newline yet: it is read next time, whole.
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const lines = complete.split("\n").filter((line) => line.trim().length > 0);
  const scanLimit = Math.min(fromLine, lines.length);
  parseTranscriptSteps(parseTranscriptLines(lines.slice(0, scanLimit), 0), state);
  const result = parseTranscriptSteps(parseTranscriptLines(lines.slice(scanLimit), scanLimit), state);
  return {
    items: result.items,
    nextLine: lines.length,
    lastStepIndex: state.lastStepIndex,
    lastModelLabel: state.lastModelLabel,
    goal: state.goal,
    ...(result.pendingAskQuestion ? { pendingAskQuestion: result.pendingAskQuestion } : {}),
    state,
    endOffset: Buffer.byteLength(complete, "utf8"),
  };
}

/**
 * Follows a transcript by byte offset so a long conversation (tens of MB) is
 * never re-read: each poll parses only the lines appended since the last.
 */
export class TranscriptTail {
  private offset: number;
  private remainder = Buffer.alloc(0);

  constructor(
    private path: string,
    readonly state: TranscriptParseState,
    offset: number,
  ) {
    this.offset = offset;
  }

  read(currentPath: string): { items: HistoryItem[]; pendingAskQuestion?: PendingDesktopAskQuestion; changed: boolean } {
    let skipThrough: number | undefined;
    if (currentPath !== this.path) {
      // transcript.jsonl gave way to transcript_full.jsonl: re-read, but only emit what is new.
      this.path = currentPath;
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
      skipThrough = this.state.lastStepIndex;
    }
    let fd: number | undefined;
    let chunk: Buffer;
    try {
      fd = openSync(this.path, "r");
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = 0;
        this.remainder = Buffer.alloc(0);
        skipThrough = this.state.lastStepIndex;
      }
      if (size === this.offset) return { items: [], changed: false };
      chunk = Buffer.alloc(size - this.offset);
      const read = readSync(fd, chunk, 0, chunk.length, this.offset);
      chunk = chunk.subarray(0, read);
      this.offset += read;
    } catch {
      return { items: [], changed: false };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const data = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const end = data.lastIndexOf(0x0a) + 1;
    this.remainder = Buffer.from(data.subarray(end));
    if (end === 0) return { items: [], changed: true };
    let steps = parseTranscriptLines(data.subarray(0, end).toString("utf8").split("\n"), 0);
    if (skipThrough !== undefined) steps = steps.filter((entry) => entry.index > skipThrough!);
    const result = parseTranscriptSteps(steps, this.state);
    return { ...result, changed: true };
  }
}

interface LanguageServerConnection {
  httpPort: number;
  csrfToken: string;
}

// Every watcher tick and every send needs the connection; finding it spawns `ps`, so it is kept while it answers.
const LS_CACHE_MS = 15_000;
let lsCache: { logPath: string; at: number; conn: LanguageServerConnection } | undefined;
let lsLookup: Promise<LanguageServerConnection | undefined> | undefined;

/** Whether the desktop app's language server was found running within the last minute. */
function languageServerSeen(): boolean {
  return Boolean(lsCache && Date.now() - lsCache.at < 60_000);
}

async function lsAnswers(conn: LanguageServerConnection): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${conn.httpPort}/exa.language_server_pb.LanguageServerService/GetStatus`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-codeium-csrf-token": conn.csrfToken },
      body: "{}",
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function findRunningLanguageServer(desktop: ResolvedAntigravityDesktop | undefined): Promise<LanguageServerConnection | undefined> {
  if (!desktop?.logPath || !existsSync(desktop.logPath)) return undefined;
  const logPath = desktop.logPath;
  if (lsCache && lsCache.logPath === logPath && Date.now() - lsCache.at < LS_CACHE_MS) return lsCache.conn;
  lsLookup ??= lookupLanguageServer(desktop, logPath).finally(() => {
    lsLookup = undefined;
  });
  return lsLookup;
}

async function lookupLanguageServer(desktop: ResolvedAntigravityDesktop, logPath: string): Promise<LanguageServerConnection | undefined> {
  // The log starts over with each launch; if it was appended to instead, the latest launch's port is the last one.
  const ports = [...readHead(logPath, 64 * 1024).matchAll(/listening on \w+ port at (\d+) for HTTP\b/gi)].map((match) => Number(match[1]));
  const httpPort = ports.at(-1);
  if (!httpPort) {
    lsCache = undefined;
    return undefined;
  }
  const tokens: string[] = [];
  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "args="], { timeout: 3000 });
    const lines = stdout.split("\n").filter((line) => line.includes("language_server") && line.includes("--csrf_token"));
    // Another Antigravity product (the IDE) runs its own language_server: the desktop app's binary goes first.
    const own = (line: string) => (desktop.languageServerPath && line.includes(desktop.languageServerPath) ? 1 : 0);
    lines.sort((a, b) => own(b) - own(a));
    for (const line of lines) {
      const token = /--csrf_token[=\s]+([^\s]+)/.exec(line)?.[1];
      if (token && !tokens.includes(token)) tokens.push(token);
    }
  } catch {
    // ps unavailable: nothing to authenticate with
  }
  for (const csrfToken of tokens) {
    const conn = { httpPort, csrfToken };
    if (tokens.length === 1 || (await lsAnswers(conn))) {
      lsCache = { logPath, at: Date.now(), conn };
      return conn;
    }
  }
  lsCache = undefined;
  return undefined;
}

async function callLanguageServer<T = Record<string, unknown>>(
  conn: LanguageServerConnection,
  method: string,
  body: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${conn.httpPort}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-codeium-csrf-token": conn.csrfToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // The app quit or restarted on another port: look it up again next time.
    lsCache = undefined;
    throw RpcError.app("agent_unavailable", `连不上 Antigravity 桌面端（${error instanceof Error ? error.message : String(error)}），请确认电脑上的 Antigravity 已打开`);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) lsCache = undefined;
    const text = await response.text().catch(() => "");
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { message?: string }).message?.slice(0, 300) || message;
    } catch {
      // not a Connect error body
    }
    throw new Error(`Antigravity 桌面端接口 ${method} 调用失败（${response.status}）：${message}`);
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

interface DesktopPendingQuestionAction {
  kind: "question";
  requestId: string;
  toolCallId: string;
  stepIndex: number;
  trajectoryId?: string;
  title: string;
  questions: AskQuestionItem[];
}

interface DesktopPendingPermissionAction {
  kind: "permission";
  requestId: string;
  toolCallId: string;
  stepIndex: number;
  trajectoryId: string;
  title: string;
  interactionType: "runCommand" | "filePermission" | "permission" | "mcp" | "openBrowserUrl" | "readUrlContent" | "approvalInteraction";
  proposedCommandLine?: string;
  absolutePathUri?: string;
}

type DesktopPendingAction = DesktopPendingQuestionAction | DesktopPendingPermissionAction;

interface DesktopWatcher {
  timer: ReturnType<typeof setInterval>;
  tail: TranscriptTail;
  lastStepIndex: number;
  running: boolean;
  detached: boolean;
  pollingInteractions: boolean;
  trajectoryId?: string;
  pendingAction?: DesktopPendingAction;
  /** An ask_question at the end of the transcript that has no answer yet (kept until later lines arrive). */
  transcriptPending?: PendingDesktopAskQuestion;
  resolvedStepIndices: Set<number>;
  selectedModel?: string;
  lastModelLabel?: string;
  goal?: SessionGoal | null;
  pendingClientMessages: { clientMessageId: string; text: string }[];
  /** When the phone last started a turn, until the desktop is first seen running it. */
  sentAt?: number;
  /** Sub-agent conversations (and theirs) whose work is shown under the call that spawned them. */
  children: Map<string, ChildFollow>;
}

interface ChildFollow {
  id: string;
  /** The spawning call, as the parent session knows it (already namespaced for a nested sub-agent). */
  parentToolCallId: string;
  /** Prepended to the sub-agent's message and tool call ids: every conversation numbers its own steps from 0. */
  prefix: string;
  depth: number;
  /** Unset until the sub-agent's transcript exists; then read from its start. */
  tail?: TranscriptTail;
  running: boolean;
}

/** Teamwork orchestrators spawn workers that spawn reviewers; deeper than this is not followed. */
const MAX_SUBAGENT_DEPTH = 4;

function namespaced(update: SessionUpdate, prefix: string): SessionUpdate {
  const next = { ...update } as SessionUpdate & { messageId?: string; toolCallId?: string };
  if (typeof next.messageId === "string") next.messageId = `${prefix}${next.messageId}`;
  if (typeof next.toolCallId === "string") next.toolCallId = `${prefix}${next.toolCallId}`;
  return next;
}

/** The sub-agents a conversation's items start: their conversation and the call (in `prefix`'s id space) that started each. */
function spawnsIn(items: HistoryItem[], prefix: string): { childId: string; toolCallId: string }[] {
  const found: { childId: string; toolCallId: string }[] = [];
  for (const item of items) {
    for (const update of item.updates) {
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") continue;
      const detail = update.detail;
      if (detail?.type !== "subagent" || (detail.action ?? "spawn") !== "spawn" || !detail.nativeSessionId) continue;
      found.push({ childId: detail.nativeSessionId, toolCallId: `${prefix}${update.toolCallId}` });
    }
  }
  return found;
}

interface CascadeTrajectoryStepPayload {
  type?: string;
  status?: string;
  metadata?: {
    sourceTrajectoryStepInfo?: {
      trajectoryId?: string;
      stepIndex?: number;
      cascadeId?: string;
    };
    toolCall?: {
      id?: string;
      name?: string;
      argumentsJson?: string;
    };
  };
  askQuestion?: {
    questions?: unknown[];
    userResponse?: unknown;
  };
  runCommand?: {
    commandLine?: string;
    proposedCommandLine?: string;
    cwd?: string;
  };
  requestedInteraction?: {
    askQuestion?: Record<string, unknown>;
    runCommand?: { proposedCommandLine?: string; commandLine?: string };
    filePermission?: { absolutePathUri?: string; blockReason?: string };
    permission?: Record<string, unknown>;
    mcp?: Record<string, unknown>;
    openBrowserUrl?: { url?: string };
    readUrlContent?: { url?: string };
    approvalInteraction?: Record<string, unknown>;
  };
  completedInteractions?: unknown[];
}

interface DesktopRow {
  id: string;
  title: string;
  lastModified: number;
  workspaceUris: string;
  status: string;
  parent: string;
  killed: boolean;
}

interface DesktopSlashCommand {
  name: string;
  description: string;
  type?: string;
  info: Record<string, unknown>;
}

/** What the desktop app last chose for a conversation, read back from the language server. */
interface GeneratorInfo {
  model?: string;
  autoExecutionPolicy?: string;
  useAiCredits?: boolean;
}

const RUNNING_STATUSES = new Set(["CASCADE_RUN_STATUS_RUNNING", "CASCADE_RUN_STATUS_BUSY", "CASCADE_RUN_STATUS_CANCELING"]);
const GOAL_STOP = /^\/goal\s+(?:clear|stop|off|reset|none|cancel)\s*$/i;
const SLASH = /^\/([A-Za-z0-9_.:-]+)(?:\s+([\s\S]*))?$/;

function firstUserTitle(transcriptPath: string): string | undefined {
  // Only the head: the first request is near the top and transcripts grow to tens of MB.
  for (const line of readHead(transcriptPath, 256 * 1024).split("\n")) {
    if (!line.includes("USER_INPUT")) continue;
    try {
      const step = JSON.parse(line) as TranscriptStep;
      if (step.type !== "USER_INPUT" || typeof step.content !== "string") continue;
      const title = cleanAntigravityUserInput(step.content).split("\n")[0]?.slice(0, 100).trim();
      if (title) return title;
    } catch {
      // a line cut off by the head limit
    }
  }
  return undefined;
}

/**
 * Specialized driver for Google Antigravity:
 * - Drives `agy_acp_server.par` / `agy-acp` over ACP when installed.
 * - Also discovers and interacts with Antigravity Desktop (`/Applications/Antigravity.app`,
 *   `~/.gemini/antigravity/conversation_summaries.db`, `brain/<id>/.system_generated/logs/transcript_full.jsonl`,
 *   and its local `language_server` Connect-RPC service) so users with only the Desktop app
 *   get full session visibility, history, Goal Mode, slash commands and skills, image messaging,
 *   user questions/permissions, model selection, steering, fork, rename, archive and delete.
 */
export class AntigravityDriver extends AcpDriver {
  private desktopMode = false;
  private desktopSummaryTimer?: ReturnType<typeof setInterval>;
  /** The state last reported to the host for each desktop conversation. */
  private readonly desktopSessionStates = new Map<string, "running" | "waiting" | "idle">();
  private readonly desktopWatchers = new Map<string, DesktopWatcher>();
  /** Conversations a device has open: their watchers outlive the turn. */
  private readonly watchedSessions = new Set<string>();
  private desktopModelsCache?: { at: number; models: { value: string; name: string; description?: string }[] };
  private desktopDefaultModel?: string;
  private desktopRowsCache?: { at: number; rows: Map<string, DesktopRow> };
  private readonly slashCache = new Map<string, { at: number; commands: DesktopSlashCommand[] }>();
  private readonly generatorCache = new Map<string, { at: number; info: Promise<GeneratorInfo> }>();
  private archivedCache?: { at: number; ids: string[] };
  private readonly untitledCache = new Map<string, { mtimeMs: number; title?: string }>();

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

  /**
   * The desktop app takes messages mid-turn (its message_delivery hook hands them
   * to the running turn), forks at any reply, and its transcript is the history.
   */
  override get behavior(): DriverBehavior {
    if (!this.desktopMode) return super.behavior;
    return {
      desktop: this.spec.tier,
      history: "native-snapshot",
      turnCompletion: "native-events",
      busyInput: "concurrent-prompt",
      fork: "native-turn",
      detach: "local-only",
    };
  }

  private desktop(): ResolvedAntigravityDesktop | undefined {
    return resolveAntigravityDesktop(this.options.env ?? process.env);
  }

  private async languageServer(): Promise<LanguageServerConnection | undefined> {
    return findRunningLanguageServer(this.desktop());
  }

  private async requireConnection(action = "继续"): Promise<LanguageServerConnection> {
    const conn = await this.languageServer();
    if (!conn) throw RpcError.app("agent_unavailable", `请先在电脑上打开 Antigravity 桌面端应用，再${action}`);
    return conn;
  }

  private isDesktopSession(nativeId: string): boolean {
    if (this.desktopMode || this.desktopWatchers.has(nativeId)) return true;
    const transcriptPath = this.transcriptPathFor(nativeId);
    return Boolean(transcriptPath && existsSync(transcriptPath));
  }

  /** Every conversation row, read at most every two seconds however many watchers ask. */
  private desktopRows(): Map<string, DesktopRow> | undefined {
    if (this.desktopRowsCache && Date.now() - this.desktopRowsCache.at < 2000) return this.desktopRowsCache.rows;
    const desktop = this.desktop();
    if (!desktop) return undefined;
    const dbPath = join(desktop.dataDir, "conversation_summaries.db");
    if (!existsSync(dbPath)) return undefined;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare(`SELECT conversation_id, title, last_modified_time, workspace_uris, status, parent_conversation_id, killed FROM conversation_summaries`)
        .all() as { conversation_id: string; title: string | null; last_modified_time: string; workspace_uris: string; status: string | null; parent_conversation_id: string | null; killed: number }[];
      const map = new Map<string, DesktopRow>();
      for (const row of rows) {
        if (!row.conversation_id) continue;
        map.set(row.conversation_id, {
          id: row.conversation_id,
          title: row.title?.trim() ?? "",
          lastModified: Date.parse(row.last_modified_time) || 0,
          workspaceUris: row.workspace_uris,
          status: row.status ?? "",
          parent: row.parent_conversation_id ?? "",
          killed: Boolean(row.killed),
        });
      }
      this.desktopRowsCache = { at: Date.now(), rows: map };
      return map;
    } catch {
      // locked or mid-migration: keep the last good read
      return this.desktopRowsCache?.rows;
    } finally {
      try {
        db?.close();
      } catch {
        // ignore close errors
      }
    }
  }

  override sessionExists(nativeId: string, _cwd: string): boolean {
    const desktop = this.desktop();
    if (!desktop) return true;
    if (this.desktopWatchers.has(nativeId)) return true;
    const brainDir = join(desktop.dataDir, "brain", nativeId);
    const row = this.desktopRows()?.get(nativeId);
    if (row) return !row.killed && existsSync(brainDir);
    return existsSync(brainDir);
  }

  override async authStatus(): Promise<AgentAuth> {
    const base = await super.authStatus();
    if (base.state !== "unknown") return base;
    const desktop = this.desktop();
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

  /**
   * Reports conversations that started or stopped on the desktop. A running one
   * is followed (attached), and from then on its watcher reports its turns.
   */
  private syncDesktopSummaries(): void {
    // Keeps languageServerSeen() current (cached: a lookup at most every 15 s).
    void this.languageServer();
    for (const s of this.listDesktopSessions(30)) {
      const watcher = this.desktopWatchers.get(s.nativeId);
      const next: "running" | "waiting" | "idle" = s.state === "running" || s.state === "waiting" ? s.state : "idle";
      const prev = this.desktopSessionStates.get(s.nativeId);
      if (prev === next) continue;
      this.desktopSessionStates.set(s.nativeId, next);
      // The first look only records where things stand; an idle conversation has nothing to say.
      if (prev === undefined && next === "idle") continue;
      this.host?.sessionSeen(this.id, { ...s, state: next });
      if (watcher) continue;
      if (next !== "idle") {
        void this.host?.follow(this.id, s.nativeId).catch(() => {});
      } else {
        this.host?.update(this.id, s.nativeId, { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
        this.host?.update(this.id, s.nativeId, { sessionUpdate: "ls_status", state: "idle", turnActive: false });
      }
    }
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
        permissions: true,
        images: true,
        models: true,
      };
      this.current = { installed: true, version: desktop.version };
      if (!this.desktopSummaryTimer) {
        this.desktopSummaryTimer = setInterval(() => {
          this.syncDesktopSummaries();
        }, 2500);
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

  watched(nativeId: string, open: boolean): void {
    if (open) {
      this.watchedSessions.add(nativeId);
      return;
    }
    this.watchedSessions.delete(nativeId);
    // The last device left an idle conversation: stop polling it until it runs or is opened again.
    const watcher = this.desktopWatchers.get(nativeId);
    if (watcher && !watcher.running && !watcher.pendingAction) {
      this.stopWatching(nativeId);
      this.host?.detached(this.id, nativeId);
    }
  }

  private transcriptPathFor(nativeId: string): string | undefined {
    const desktop = this.desktop();
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

  private isConversationRunningInDesktop(nativeId: string): boolean {
    const desktop = this.desktop();
    if (!desktop) return false;
    // With the app closed nothing runs, whatever status it saved last. (presence/<id>.lock only means a window
    // shows the conversation: sub-agents and conversations started from the phone never get one.)
    if (!languageServerSeen()) return false;
    const status = this.desktopRows()?.get(nativeId)?.status;
    if (status) return RUNNING_STATUSES.has(status);
    // No saved status yet (a brand-new conversation): a transcript still being written is a running one.
    const transcriptPath = resolveDesktopTranscriptPath(desktop.dataDir, nativeId);
    try {
      const ageMs = Date.now() - statSync(transcriptPath).mtimeMs;
      return ageMs >= 0 && ageMs < 15_000;
    } catch {
      return false;
    }
  }

  private untitledTitle(nativeId: string, transcriptPath: string): string | undefined {
    try {
      const mtimeMs = statSync(transcriptPath).mtimeMs;
      const cached = this.untitledCache.get(nativeId);
      if (cached && (cached.title || cached.mtimeMs === mtimeMs)) return cached.title;
      const title = firstUserTitle(transcriptPath);
      this.untitledCache.set(nativeId, { mtimeMs, title });
      return title;
    } catch {
      return undefined;
    }
  }

  private listDesktopSessions(limit: number): DiscoveredSession[] {
    const desktop = this.desktop();
    if (!desktop) return [];
    const home = (this.options.env ?? process.env).HOME || homedir();
    const results: DiscoveredSession[] = [];
    const rows = this.desktopRows();

    if (rows) {
      // Sub-agent conversations nest under their parent's tool calls rather than listing on their own.
      const top = [...rows.values()]
        .filter((row) => !row.parent && !row.killed)
        .sort((a, b) => b.lastModified - a.lastModified);
      for (const row of top) {
        if (results.length >= limit) break;
        const brainDir = join(desktop.dataDir, "brain", row.id);
        if (!existsSync(brainDir) && !this.desktopWatchers.has(row.id)) continue;
        const cwd = parseWorkspaceCwd(row.workspaceUris, home);
        const updatedAt = row.lastModified || Date.now();
        const title = row.title || this.untitledTitle(row.id, resolveDesktopTranscriptPath(desktop.dataDir, row.id));
        const watcher = this.desktopWatchers.get(row.id);
        // A followed conversation's watcher knows best (it also covers a turn the phone just started).
        const state: DiscoveredSession["state"] = watcher
          ? watcher.pendingAction ? "waiting" : watcher.running ? "running" : "idle"
          : this.isConversationRunningInDesktop(row.id)
            ? "running"
            : "idle";
        results.push({
          nativeId: row.id,
          cwd,
          ...(title ? { title } : {}),
          ...(watcher?.lastModelLabel ? { model: watcher.lastModelLabel } : {}),
          createdAt: updatedAt,
          updatedAt,
          state,
        });
      }
      return results;
    }

    if (existsSync(join(desktop.dataDir, "brain"))) {
      try {
        const entries: { id: string; path: string; mtimeMs: number }[] = [];
        for (const id of readdirSync(join(desktop.dataDir, "brain"))) {
          const transcriptPath = resolveDesktopTranscriptPath(desktop.dataDir, id);
          if (!existsSync(transcriptPath)) continue;
          entries.push({ id, path: transcriptPath, mtimeMs: statSync(transcriptPath).mtimeMs });
        }
        entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const entry of entries.slice(0, limit)) {
          const title = this.untitledTitle(entry.id, entry.path);
          results.push({
            nativeId: entry.id,
            cwd: home,
            ...(title ? { title } : {}),
            createdAt: entry.mtimeMs,
            updatedAt: entry.mtimeMs,
            state: this.isConversationRunningInDesktop(entry.id) ? "running" : "idle",
          });
        }
      } catch {
        // ignore unreadable brain dir
      }
    }

    return results;
  }

  override async listSessions(limit: number): Promise<DiscoveredSession[]> {
    const acpSessions = !this.desktopMode && this.connection?.alive ? await super.listSessions(limit).catch(() => []) : [];
    await this.languageServer();
    const desktopSessions = this.listDesktopSessions(limit);
    const merged = new Map<string, DiscoveredSession>();
    for (const session of [...acpSessions, ...desktopSessions]) {
      if (!merged.has(session.nativeId)) merged.set(session.nativeId, session);
    }
    const sorted = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    for (const session of sorted) {
      // Running on the desktop before anyone opened it: follow it so its turn shows live.
      if ((session.state === "running" || session.state === "waiting") && !this.desktopWatchers.has(session.nativeId)) {
        void this.host?.follow(this.id, session.nativeId).catch(() => {});
      }
    }
    return sorted;
  }

  async archivedSessions(): Promise<string[]> {
    if (!this.desktopMode) return [];
    if (this.archivedCache && Date.now() - this.archivedCache.at < 30_000) return this.archivedCache.ids;
    const conn = await this.languageServer();
    if (!conn) return this.archivedCache?.ids ?? [];
    try {
      const data = await callLanguageServer<{ trajectorySummaries?: Record<string, { annotations?: { archived?: boolean } }> }>(conn, "GetAllCascadeTrajectories", {});
      const ids = Object.entries(data.trajectorySummaries ?? {})
        .filter(([, summary]) => summary.annotations?.archived === true)
        .map(([id]) => id);
      this.archivedCache = { at: Date.now(), ids };
      return ids;
    } catch {
      return this.archivedCache?.ids ?? [];
    }
  }

  private async loadDesktopModels(): Promise<{ value: string; name: string; description?: string }[]> {
    // New models ship with app updates; a running host picks them up within ten minutes.
    if (this.desktopModelsCache?.models.length && Date.now() - this.desktopModelsCache.at < 10 * 60_000) return this.desktopModelsCache.models;
    const conn = await this.languageServer();
    if (!conn) return this.desktopModelsCache?.models ?? [];
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

      if (models.length > 0) this.desktopModelsCache = { at: Date.now(), models };
      return models;
    } catch {
      return this.desktopModelsCache?.models ?? [];
    }
  }

  /**
   * The model and command auto-run policy the desktop app last used for a
   * conversation (or, for a new one, for the latest conversation): sending from
   * the phone must not quietly change either.
   */
  private generatorInfo(conn: LanguageServerConnection, nativeId: string): Promise<GeneratorInfo> {
    const sourceId = nativeId || this.latestConversationId();
    if (!sourceId) return Promise.resolve({});
    const cached = this.generatorCache.get(sourceId);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.info;
    // The metadata holds every generation's full config (MBs for a long conversation): one request at a time per conversation.
    const info = this.fetchGeneratorInfo(conn, sourceId);
    this.generatorCache.set(sourceId, { at: Date.now(), info });
    return info;
  }

  private async fetchGeneratorInfo(conn: LanguageServerConnection, sourceId: string): Promise<GeneratorInfo> {
    try {
      const meta = await callLanguageServer<{
        generatorMetadata?: {
          plannerConfig?: {
            planModel?: string;
            requestedModel?: { model?: string; alias?: string };
            useAiCredits?: boolean;
            toolConfig?: { runCommand?: { autoCommandConfig?: { autoExecutionPolicy?: string } } };
          };
          chatModel?: { model?: string };
        }[];
      }>(conn, "GetCascadeTrajectoryGeneratorMetadata", { cascadeId: sourceId }, 20_000);
      const entries = meta.generatorMetadata ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const planner = entries[i]!.plannerConfig;
        if (!planner) continue;
        return {
          model: planner.requestedModel?.model ?? planner.requestedModel?.alias ?? planner.planModel ?? entries[i]!.chatModel?.model,
          autoExecutionPolicy: planner.toolConfig?.runCommand?.autoCommandConfig?.autoExecutionPolicy,
          ...(typeof planner.useAiCredits === "boolean" ? { useAiCredits: planner.useAiCredits } : {}),
        };
      }
    } catch {
      // metadata unavailable: the language server's defaults apply
    }
    return {};
  }

  /** A conversation the desktop hasn't generated in yet takes the settings the user last used anywhere. */
  private async inheritedSettings(conn: LanguageServerConnection, nativeId: string): Promise<GeneratorInfo> {
    const own = await this.generatorInfo(conn, nativeId);
    if (own.autoExecutionPolicy) return own;
    const latest = this.latestConversationId(nativeId);
    const fallback = latest ? await this.generatorInfo(conn, latest) : {};
    return {
      model: own.model ?? fallback.model,
      autoExecutionPolicy: fallback.autoExecutionPolicy,
      useAiCredits: own.useAiCredits ?? fallback.useAiCredits,
    };
  }

  private latestConversationId(exclude?: string): string | undefined {
    const rows = this.desktopRows();
    if (!rows) return undefined;
    let latest: DesktopRow | undefined;
    for (const row of rows.values()) {
      if (row.parent || row.killed || row.id === exclude) continue;
      if (!latest || row.lastModified > latest.lastModified) latest = row;
    }
    return latest?.id;
  }

  private async resolveSessionModel(
    nativeId: string,
    models: { value: string; name: string; description?: string }[],
    explicitModel?: string,
  ): Promise<{ value: string; name: string; description?: string } | undefined> {
    const matchByValueOrName = (candidate: string | undefined) => {
      if (!candidate) return undefined;
      return models.find((m) => m.value === candidate || m.name === candidate);
    };

    const watcher = this.desktopWatchers.get(nativeId);
    const persistedSelected = nativeId ? this.host?.state(this.id, nativeId).get("agy-selected-model") : undefined;
    const chosen =
      matchByValueOrName(explicitModel) ??
      matchByValueOrName(watcher?.selectedModel) ??
      matchByValueOrName(watcher?.lastModelLabel) ??
      matchByValueOrName(persistedSelected);
    if (chosen) return chosen;

    const conn = nativeId ? await this.languageServer() : undefined;
    if (conn) {
      const found = matchByValueOrName((await this.generatorInfo(conn, nativeId)).model);
      if (found) return found;
    }

    // The model the user last picked in the app comes before the server's default.
    const desktop = this.desktop();
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

    const fromDefault = matchByValueOrName(this.desktopDefaultModel);
    if (fromDefault) return fromDefault;

    return models[0];
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
    const fromMetadata = (await this.generatorInfo(conn, nativeId)).model;
    if (fromMetadata?.startsWith("MODEL_")) return fromMetadata;
    if (this.desktopDefaultModel?.startsWith("MODEL_")) return this.desktopDefaultModel;
    const desktop = this.desktop();
    try {
      const stateText = desktop ? readFileSync(join(desktop.dataDir, "antigravity_state.pbtxt"), "utf8") : "";
      const lastSelected = /last_selected_agent_model:\s*(MODEL_\S+)/.exec(stateText)?.[1];
      if (lastSelected) return lastSelected;
    } catch {
      // no saved selection
    }
    throw RpcError.app("agent_unavailable", "没能确定 Antigravity 要用的模型，请在电脑上的 Antigravity 里选一次模型后重试");
  }

  /** The system commands and skills the desktop offers for this conversation (its workspace adds skills). */
  private async slashCommands(conn: LanguageServerConnection, nativeId: string, planModel: string): Promise<DesktopSlashCommand[]> {
    const key = nativeId || "";
    const cached = this.slashCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.commands;
    try {
      const data = await callLanguageServer<{
        commands?: { info?: Record<string, unknown>; title?: string; description?: string }[];
      }>(conn, "GetSlashCommands", {
        ...(nativeId ? { cascadeId: nativeId } : {}),
        cascadeConfig: { plannerConfig: { planModel } },
      });
      const commands = (data.commands ?? []).flatMap((entry): DesktopSlashCommand[] => {
        const info = entry.info;
        const name = typeof info?.name === "string" ? info.name : undefined;
        if (!info || !name) return [];
        return [{ name, description: entry.description ?? "", type: typeof info.type === "string" ? info.type : undefined, info }];
      });
      if (commands.length > 0) this.slashCache.set(key, { at: Date.now(), commands });
      return commands;
    } catch {
      return cached?.commands ?? [];
    }
  }

  private async emitDesktopConfig(nativeId: string, selectedModel?: string): Promise<void> {
    const models = await this.loadDesktopModels();
    const conn = await this.languageServer();
    let commands: { name: string; description: string; hint?: string }[] = ANTIGRAVITY_DESKTOP_COMMANDS;
    let matched: { value: string; name: string } | undefined;
    if (models.length > 0) matched = await this.resolveSessionModel(nativeId, models, selectedModel);
    if (conn && matched) {
      const live = await this.slashCommands(conn, nativeId, matched.value);
      if (live.length > 0) {
        commands = live.map((command) => {
          const known = SYSTEM_COMMAND_TEXT.get(command.name);
          const description = known?.description ?? command.description.split("\n")[0]!.slice(0, 160);
          return { name: command.name, description: description || command.name, ...(known && "hint" in known && known.hint ? { hint: known.hint } : {}) };
        });
      }
    }
    this.host?.update(this.id, nativeId, { sessionUpdate: "available_commands_update", availableCommands: commands });
    if (!matched) return;
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

  private emitDesktopPendingAction(nativeId: string, watcher: DesktopWatcher, action: DesktopPendingAction): void {
    watcher.pendingAction = action;
    this.desktopSessionStates.set(nativeId, "waiting");
    if (action.kind === "question") {
      const questions: Question[] = action.questions.map((q, idx) => ({
        id: `q_${idx}`,
        text: q.question,
        kind: q.options?.length ? (q.isMultiSelect ? "choices" : "choice") : "text",
        ...(q.options?.length
          ? {
              options: q.options.map((o) => ({ value: o.id, label: o.text })),
              other: true,
            }
          : {}),
      }));
      this.host?.update(this.id, nativeId, {
        sessionUpdate: "ls_permission",
        requestId: action.requestId,
        toolCallId: action.toolCallId,
        title: action.title,
        options: QUESTION_OPTIONS,
        questions,
      });
    } else {
      this.host?.update(this.id, nativeId, {
        sessionUpdate: "ls_permission",
        requestId: action.requestId,
        toolCallId: action.toolCallId,
        title: action.title,
        ...(action.proposedCommandLine ? { detail: action.proposedCommandLine } : {}),
        tool: {
          title: action.title,
          kind: action.interactionType === "runCommand" ? "execute" : action.interactionType === "filePermission" ? "edit" : "other",
          ...(action.proposedCommandLine ? { rawInput: { command: action.proposedCommandLine } } : {}),
          ...(action.absolutePathUri ? { locations: [{ path: action.absolutePathUri }] } : {}),
        },
        options: [
          { optionId: "allow", name: "允许", kind: "allow_once" },
          { optionId: "reject", name: "拒绝", kind: "reject_once" },
        ],
      });
    }
    this.host?.update(this.id, nativeId, {
      sessionUpdate: "ls_status",
      state: "waiting",
      turnActive: true,
    });
  }

  private clearDesktopPendingAction(
    nativeId: string,
    watcher: DesktopWatcher,
    resolution?: { optionId?: string; answers?: QuestionAnswer[] },
  ): void {
    const prev = watcher.pendingAction;
    if (!prev) return;
    watcher.pendingAction = undefined;
    watcher.resolvedStepIndices.add(prev.stepIndex);
    this.host?.update(this.id, nativeId, {
      sessionUpdate: "ls_permission_resolved",
      requestId: prev.requestId,
      ...(resolution?.optionId ? { optionId: resolution.optionId } : {}),
      ...(resolution?.answers ? { answers: resolution.answers } : {}),
    });
    const nowRunning = this.isConversationRunningInDesktop(nativeId);
    const nextState = nowRunning ? "running" : "idle";
    this.desktopSessionStates.set(nativeId, nextState);
    this.host?.update(this.id, nativeId, {
      sessionUpdate: "ls_status",
      state: nextState,
      turnActive: nowRunning,
    });
  }

  private async pollDesktopInteractions(nativeId: string, watcher: DesktopWatcher): Promise<void> {
    if (watcher.pollingInteractions) return;
    watcher.pollingInteractions = true;
    const transcriptPendingQuestion = watcher.transcriptPending;
    try {
      const conn = await this.languageServer();
      let foundAction: DesktopPendingAction | undefined;
      const observedStepIndices = new Set<number>();

      if (conn) {
        // Steps carry their full content (~20 KB each): ask only for the newest few, where a waiting one would be.
        const stepOffset = Math.max(0, watcher.lastStepIndex - 4);
        try {
          const resp = await callLanguageServer<{ steps?: CascadeTrajectoryStepPayload[] }>(
            conn,
            "GetCascadeTrajectorySteps",
            { cascadeId: nativeId, stepOffset },
          );
          const steps = resp.steps ?? [];
          for (let idx = 0; idx < steps.length; idx++) {
            const step = steps[idx]!;
            const info = step.metadata?.sourceTrajectoryStepInfo;
            if (info?.trajectoryId) watcher.trajectoryId = info.trajectoryId;
            const stepIndex = info?.stepIndex ?? stepOffset + idx;
            observedStepIndices.add(stepIndex);
            if (watcher.resolvedStepIndices.has(stepIndex)) continue;

            const isWaiting =
              step.status === "CORTEX_STEP_STATUS_WAITING" ||
              step.status === "CORTEX_STEP_STATUS_PENDING" ||
              (step.type === "CORTEX_STEP_TYPE_ASK_QUESTION" &&
                step.status !== "CORTEX_STEP_STATUS_DONE" &&
                step.status !== "CORTEX_STEP_STATUS_CANCELED" &&
                step.status !== "CORTEX_STEP_STATUS_ERROR" &&
                !step.askQuestion?.userResponse &&
                !(Array.isArray(step.completedInteractions) && step.completedInteractions.length > 0));

            if (!isWaiting) continue;

            if (step.type === "CORTEX_STEP_TYPE_ASK_QUESTION" || step.requestedInteraction?.askQuestion) {
              const rawQuestions =
                step.askQuestion?.questions ??
                (step.requestedInteraction?.askQuestion as { questions?: unknown[] } | undefined)?.questions;
              const askEntries = parseAskQuestionEntries({ questions: rawQuestions });
              const questions = askEntries.length > 0 ? askEntries : transcriptPendingQuestion?.questions ?? [];
              if (questions.length > 0) {
                foundAction = {
                  kind: "question",
                  requestId: `agy-ask:${nativeId}:${stepIndex}`,
                  toolCallId:
                    step.metadata?.toolCall?.id ||
                    transcriptPendingQuestion?.toolCallId ||
                    `agy:tc:${Math.max(0, stepIndex - 1)}:0`,
                  stepIndex,
                  trajectoryId: info?.trajectoryId ?? watcher.trajectoryId,
                  title: transcriptPendingQuestion?.title || questions[0]!.question.slice(0, 80) || "Antigravity 有问题需要你回答",
                  questions,
                };
              }
            } else if (step.requestedInteraction && (info?.trajectoryId || watcher.trajectoryId)) {
              const req = step.requestedInteraction;
              const trajectoryId = (info?.trajectoryId ?? watcher.trajectoryId)!;
              const toolCallId = step.metadata?.toolCall?.id || `agy:perm:${stepIndex}`;
              const base = { kind: "permission" as const, requestId: `agy-perm:${nativeId}:${stepIndex}`, toolCallId, stepIndex, trajectoryId };
              if (req.runCommand) {
                const cmd = req.runCommand.proposedCommandLine || req.runCommand.commandLine || step.runCommand?.commandLine || "";
                foundAction = { ...base, title: cmd ? `确认执行命令：${cmd}` : "确认执行命令", interactionType: "runCommand", proposedCommandLine: cmd };
              } else if (req.filePermission) {
                const pathUri = req.filePermission.absolutePathUri || "";
                foundAction = { ...base, title: pathUri ? `允许访问文件：${pathUri}` : "允许访问文件", interactionType: "filePermission", absolutePathUri: pathUri };
              } else if (req.mcp) {
                foundAction = { ...base, title: "允许执行 MCP 工具调用", interactionType: "mcp" };
              } else if (req.openBrowserUrl) {
                foundAction = { ...base, title: req.openBrowserUrl.url ? `允许打开链接：${req.openBrowserUrl.url}` : "允许打开浏览器链接", interactionType: "openBrowserUrl" };
              } else if (req.readUrlContent) {
                foundAction = { ...base, title: req.readUrlContent.url ? `允许读取网页：${req.readUrlContent.url}` : "允许读取网页内容", interactionType: "readUrlContent" };
              } else if (req.approvalInteraction) {
                foundAction = { ...base, title: "需要你的确认以继续执行", interactionType: "approvalInteraction" };
              } else if (req.permission) {
                foundAction = { ...base, title: "需要你的权限确认", interactionType: "permission" };
              }
            }
          }
        } catch {
          // ignore GetCascadeTrajectorySteps failure and fall back to transcript question detection below
        }
      }

      // A transcript can end with ask_question after the native step was canceled.
      // Only use that fallback when the live response did not contain its step.
      if (!foundAction && transcriptPendingQuestion && !observedStepIndices.has(transcriptPendingQuestion.stepIndex) && !watcher.resolvedStepIndices.has(transcriptPendingQuestion.stepIndex)) {
        foundAction = {
          kind: "question",
          requestId: `agy-ask:${nativeId}:${transcriptPendingQuestion.stepIndex}`,
          toolCallId: transcriptPendingQuestion.toolCallId,
          stepIndex: transcriptPendingQuestion.stepIndex,
          trajectoryId: watcher.trajectoryId,
          title: transcriptPendingQuestion.title,
          questions: transcriptPendingQuestion.questions,
        };
      }

      if (foundAction) {
        if (watcher.pendingAction?.requestId !== foundAction.requestId) {
          if (watcher.pendingAction) {
            this.clearDesktopPendingAction(nativeId, watcher);
          }
          this.emitDesktopPendingAction(nativeId, watcher, foundAction);
        } else if (foundAction.trajectoryId && !watcher.pendingAction.trajectoryId) {
          watcher.pendingAction.trajectoryId = foundAction.trajectoryId;
        }
      } else if (watcher.pendingAction) {
        // Answered on the desktop, or the turn was stopped there.
        this.clearDesktopPendingAction(nativeId, watcher);
      }
    } finally {
      watcher.pollingInteractions = false;
    }
  }

  private emitTranscriptItems(nativeId: string, watcher: DesktopWatcher, items: HistoryItem[]): void {
    for (const item of items) {
      if (item.itemId.startsWith("agy:user:") && watcher.pendingClientMessages.length > 0) {
        const pending = watcher.pendingClientMessages.shift()!;
        const aliases = this.desktopAliasesFor(nativeId);
        aliases.set(item.itemId, `local-${pending.clientMessageId}`);
        this.saveDesktopAliases(nativeId, aliases);
        // The phone already shows this message (echoed as local-<clientMessageId>); only what came with it (ls_goal) is new.
        for (const update of item.updates.filter((u) => u.sessionUpdate !== "user_message_chunk")) {
          this.host?.update(this.id, nativeId, update);
        }
        continue;
      }
      item.updates.forEach((update, idx) => {
        this.host?.update(this.id, nativeId, update, idx === item.updates.length - 1 ? item.itemId : undefined);
      });
    }
  }

  /** A sub-agent's items as the parent session carries them: nested under the spawning call, with ids of their own. */
  private nestChildItems(items: HistoryItem[], follow: ChildFollow): HistoryItem[] {
    return items.flatMap((item) => {
      const updates = item.updates.flatMap((update) => nestUnder(namespaced(update, follow.prefix), follow.parentToolCallId) ?? []);
      return updates.length > 0 ? [{ itemId: `sub:${follow.parentToolCallId}:${item.itemId}`, updates }] : [];
    });
  }

  private childTurn(follow: ChildFollow, running: boolean): HistoryItem {
    return {
      // Keyed by where the sub-agent's transcript stood, so attaching again doesn't record the same start or end twice.
      itemId: `sub:${follow.parentToolCallId}:turn:${running ? "started" : "ended"}:${follow.tail?.state.lastStepIndex ?? -1}`,
      updates: [{ sessionUpdate: "ls_turn", state: running ? "started" : "ended", ...(running ? {} : { stopReason: "end_turn" as const }), parentToolCallId: follow.parentToolCallId }],
    };
  }

  /**
   * Starts following the sub-agents `items` spawned. With `collect`, what each
   * has done so far is added there (history, or a sub-agent just seen live);
   * without, only what it does from now on is shown.
   */
  private followChildren(watcher: DesktopWatcher, items: HistoryItem[], prefix: string, depth: number, collect?: HistoryItem[]): void {
    if (depth >= MAX_SUBAGENT_DEPTH) return;
    for (const spawn of spawnsIn(items, prefix)) {
      if (watcher.children.has(spawn.childId)) continue;
      const follow: ChildFollow = {
        id: spawn.childId,
        parentToolCallId: spawn.toolCallId,
        prefix: `${spawn.childId.slice(0, 8)}/`,
        depth: depth + 1,
        running: false,
      };
      watcher.children.set(spawn.childId, follow);
      const path = this.transcriptPathFor(spawn.childId);
      if (!path || !existsSync(path)) continue;
      const parsed = parseAntigravityTranscript(path, 0);
      follow.tail = new TranscriptTail(path, parsed.state, parsed.endOffset);
      follow.running = this.isConversationRunningInDesktop(spawn.childId);
      if (collect) {
        collect.push(...this.nestChildItems(parsed.items, follow), this.childTurn(follow, follow.running));
      }
      this.followChildren(watcher, parsed.items, follow.prefix, follow.depth, collect);
    }
  }

  /** New work from every followed sub-agent, and when each starts or stops. */
  private tickChildren(nativeId: string, watcher: DesktopWatcher): void {
    for (const follow of [...watcher.children.values()]) {
      const path = this.transcriptPathFor(follow.id);
      const out: HistoryItem[] = [];
      if (path && existsSync(path)) {
        // A sub-agent whose transcript appeared after its spawn was seen: everything in it is new.
        follow.tail ??= new TranscriptTail(path, newTranscriptParseState(), 0);
        try {
          const read = follow.tail.read(path);
          if (read.items.length > 0) {
            out.push(...this.nestChildItems(read.items, follow));
            this.followChildren(watcher, read.items, follow.prefix, follow.depth, out);
          }
        } catch {
          // ignore unreadable sub-agent transcript
        }
      }
      const running = this.isConversationRunningInDesktop(follow.id);
      if (running !== follow.running) {
        follow.running = running;
        out.push(this.childTurn(follow, running));
      }
      for (const item of out) {
        item.updates.forEach((update, idx) => {
          this.host?.update(this.id, nativeId, update, idx === item.updates.length - 1 ? item.itemId : undefined);
        });
      }
    }
  }

  private stopWatching(nativeId: string): void {
    const watcher = this.desktopWatchers.get(nativeId);
    if (!watcher) return;
    clearInterval(watcher.timer);
    this.desktopWatchers.delete(nativeId);
  }

  private startWatchingDesktopTranscript(
    nativeId: string,
    initial?: {
      path: string;
      state: TranscriptParseState;
      offset: number;
      pendingAskQuestion?: PendingDesktopAskQuestion;
    },
  ): DesktopWatcher {
    const existing = this.desktopWatchers.get(nativeId);
    if (existing) clearInterval(existing.timer);

    const path = initial?.path ?? this.transcriptPathFor(nativeId) ?? "";
    const state = initial?.state ?? newTranscriptParseState();
    const initialRunning = this.isConversationRunningInDesktop(nativeId);

    const watcher: DesktopWatcher = {
      tail: new TranscriptTail(path, state, initial?.offset ?? 0),
      lastStepIndex: state.lastStepIndex ?? existing?.lastStepIndex ?? 0,
      running: initialRunning,
      detached: false,
      pollingInteractions: false,
      trajectoryId: existing?.trajectoryId,
      pendingAction: existing?.pendingAction,
      transcriptPending: initial?.pendingAskQuestion,
      resolvedStepIndices: existing?.resolvedStepIndices ?? new Set<number>(),
      selectedModel: existing?.selectedModel ?? this.host?.state(this.id, nativeId).get("agy-selected-model") ?? undefined,
      lastModelLabel: state.lastModelLabel ?? existing?.lastModelLabel,
      goal: initial ? state.goal : existing?.goal,
      pendingClientMessages: existing?.pendingClientMessages ?? [],
      children: new Map(),
      timer: setInterval(() => this.tickWatcher(nativeId, watcher), 1500),
    };
    watcher.timer.unref?.();
    this.desktopWatchers.set(nativeId, watcher);
    this.desktopSessionStates.set(nativeId, watcher.pendingAction ? "waiting" : initialRunning ? "running" : "idle");
    if (initialRunning || watcher.transcriptPending) void this.pollDesktopInteractions(nativeId, watcher);
    return watcher;
  }

  private tickWatcher(nativeId: string, watcher: DesktopWatcher): void {
    void this.languageServer();
    let transcriptChanged = false;
    const currentPath = this.transcriptPathFor(nativeId);
    if (currentPath && existsSync(currentPath)) {
      try {
        const read = watcher.tail.read(currentPath);
        transcriptChanged = read.changed;
        const state = watcher.tail.state;
        if (state.lastStepIndex !== undefined) watcher.lastStepIndex = state.lastStepIndex;
        if (read.items.length > 0) {
          watcher.transcriptPending = read.pendingAskQuestion;
          watcher.goal = state.goal;
          if (state.lastModelLabel && state.lastModelLabel !== watcher.lastModelLabel) {
            watcher.lastModelLabel = state.lastModelLabel;
            watcher.selectedModel = state.lastModelLabel;
            this.host?.state(this.id, nativeId).set("agy-selected-model", state.lastModelLabel);
            void this.emitDesktopConfig(nativeId, state.lastModelLabel).catch(() => {});
          }
          this.emitTranscriptItems(nativeId, watcher, read.items);
          const spawned: HistoryItem[] = [];
          this.followChildren(watcher, read.items, "", 0, spawned);
          this.emitTranscriptItems(nativeId, watcher, spawned);
        }
      } catch {
        // ignore stat/read errors
      }
    }
    this.tickChildren(nativeId, watcher);
    let nowRunning = this.isConversationRunningInDesktop(nativeId);
    if (nowRunning) {
      watcher.sentAt = undefined;
    } else if (watcher.sentAt && Date.now() - watcher.sentAt < 15_000) {
      // Sent from the phone a moment ago: the desktop records the run a little later, so this isn't the end of it.
      nowRunning = true;
    }
    if (nowRunning || watcher.pendingAction || transcriptChanged || watcher.transcriptPending) {
      void this.pollDesktopInteractions(nativeId, watcher);
    }
    if (nowRunning === watcher.running) return;
    watcher.running = nowRunning;
    const nextState = watcher.pendingAction ? "waiting" : nowRunning ? "running" : "idle";
    this.desktopSessionStates.set(nativeId, nextState);
    if (nowRunning) {
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_turn", state: "started" });
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: nextState, turnActive: true });
      return;
    }
    if (watcher.pendingAction) return;
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
    this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: "idle", turnActive: false });
    // Followed only for its turn and nobody is looking: let go, and attach again on next use.
    if (watcher.detached || !this.watchedSessions.has(nativeId)) {
      this.stopWatching(nativeId);
      this.host?.detached(this.id, nativeId);
    }
  }

  override async attach(nativeId: string, context: AttachContext): Promise<HistoryItem[]> {
    const transcriptPath = this.transcriptPathFor(nativeId);
    if (this.desktopMode || (transcriptPath && existsSync(transcriptPath))) {
      await this.ensureStarted();
      const parsed = transcriptPath ? parseAntigravityTranscript(transcriptPath, 0) : undefined;
      const aliases = this.desktopAliasesFor(nativeId);
      const items = (parsed?.items ?? []).map((item) => {
        const aliasedId = aliases.get(item.itemId);
        return aliasedId ? { ...item, itemId: aliasedId } : item;
      });
      const watcher = this.startWatchingDesktopTranscript(
        nativeId,
        parsed && transcriptPath
          ? { path: transcriptPath, state: parsed.state, offset: parsed.endOffset, pendingAskQuestion: parsed.pendingAskQuestion }
          : undefined,
      );
      // Sub-agents' work so far, after the parent's (whose spawning calls it nests under).
      const childItems: HistoryItem[] = [];
      this.followChildren(watcher, parsed?.items ?? [], "", 0, childItems);
      items.push(...childItems);
      const running = watcher.running;
      const state = watcher.pendingAction ? "waiting" : running ? "running" : "idle";
      this.desktopSessionStates.set(nativeId, state);
      if (state === "idle") {
        this.host?.update(this.id, nativeId, { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
      }
      this.host?.update(this.id, nativeId, {
        sessionUpdate: "ls_status",
        state,
        turnActive: state === "running" || state === "waiting",
      });
      if (parsed?.goal !== undefined) {
        this.host?.update(this.id, nativeId, { sessionUpdate: "ls_goal", goal: parsed.goal });
      }
      void this.emitDesktopConfig(nativeId, watcher.selectedModel).catch(() => {});
      return items;
    }
    return super.attach(nativeId, context);
  }

  override async detach(nativeId: string): Promise<void> {
    const watcher = this.desktopWatchers.get(nativeId);
    if (watcher) {
      if (watcher.running || watcher.pendingAction) {
        // Keep watching until the active turn completes so turn end, pending questions, and final messages are recorded.
        watcher.detached = true;
      } else {
        this.stopWatching(nativeId);
      }
    }
    await super.detach(nativeId);
  }

  private async resolveDesktopTrajectory(
    conn: LanguageServerConnection,
    nativeId: string,
    watcher: DesktopWatcher,
    fallbackStepIndex: number,
  ): Promise<{ trajectoryId: string; stepIndex: number }> {
    let trajectoryId = watcher.pendingAction?.trajectoryId ?? watcher.trajectoryId;
    let stepIndex = fallbackStepIndex;
    if (!trajectoryId) {
      const resp = await callLanguageServer<{ steps?: CascadeTrajectoryStepPayload[] }>(
        conn,
        "GetCascadeTrajectorySteps",
        { cascadeId: nativeId, stepOffset: Math.max(0, watcher.lastStepIndex - 10) },
      );
      for (let idx = 0; idx < (resp.steps ?? []).length; idx++) {
        const s = resp.steps![idx]!;
        const info = s.metadata?.sourceTrajectoryStepInfo;
        if (info?.trajectoryId) trajectoryId = info.trajectoryId;
        if (s.type === "CORTEX_STEP_TYPE_ASK_QUESTION" && info?.stepIndex !== undefined) {
          stepIndex = info.stepIndex;
        }
      }
    }
    if (!trajectoryId) {
      throw RpcError.app("agent_unavailable", "未能定位当前 Antigravity 交互轨迹，请在桌面端确认");
    }
    return { trajectoryId, stepIndex };
  }

  override async answerQuestion(
    nativeId: string,
    requestId: string,
    answers: QuestionAnswer[],
  ): Promise<void> {
    const watcher = this.desktopWatchers.get(nativeId);
    if (watcher?.pendingAction?.kind === "question" && watcher.pendingAction.requestId === requestId) {
      const pending = watcher.pendingAction;
      const conn = await this.requireConnection("回答");
      const { trajectoryId, stepIndex } = await this.resolveDesktopTrajectory(conn, nativeId, watcher, pending.stepIndex);
      const responses = pending.questions.map((q, idx) => {
        const qId = `q_${idx}`;
        const ans = answers.find((a) => a.id === qId) ?? answers[idx];
        const opts = q.options ?? [];
        const chosenValues = (ans?.values ?? []).map((v) => v.trim()).filter(Boolean);
        const selectedOptionIds: string[] = [];
        const writeInParts: string[] = [];
        for (const val of chosenValues) {
          const matchedOpt = opts.find((o) => o.id === val || o.text === val);
          if (matchedOpt) {
            selectedOptionIds.push(matchedOpt.id);
          } else {
            writeInParts.push(val);
          }
        }
        if (ans?.other?.trim()) {
          writeInParts.push(ans.other.trim());
        }
        const writeInResponse = writeInParts.join("\n");
        const skipped = selectedOptionIds.length === 0 && !writeInResponse;
        return {
          question: q.question,
          isMultiSelect: Boolean(q.isMultiSelect),
          options: opts.map((o) => ({ id: o.id, text: o.text })),
          selectedOptionIds,
          ...(writeInResponse ? { writeInResponse } : {}),
          skipped,
        };
      });

      await callLanguageServer(conn, "HandleCascadeUserInteraction", {
        cascadeId: nativeId,
        interaction: {
          trajectoryId,
          stepIndex,
          askQuestion: {
            cancelled: false,
            responses,
          },
        },
      });
      this.clearDesktopPendingAction(nativeId, watcher, { answers });
      return;
    }
    await super.answerQuestion(nativeId, requestId, answers);
  }

  override async respondPermission(
    nativeId: string,
    requestId: string,
    optionId: string,
  ): Promise<void> {
    const watcher = this.desktopWatchers.get(nativeId);
    if (watcher?.pendingAction && watcher.pendingAction.requestId === requestId) {
      const pending = watcher.pendingAction;
      const conn = await this.requireConnection("确认");
      if (pending.kind === "question") {
        const { trajectoryId, stepIndex } = await this.resolveDesktopTrajectory(conn, nativeId, watcher, pending.stepIndex);
        const cancelled = optionId === "cancel";
        const responses = pending.questions.map((q) => ({
          question: q.question,
          isMultiSelect: Boolean(q.isMultiSelect),
          options: (q.options ?? []).map((o) => ({ id: o.id, text: o.text })),
          selectedOptionIds: [],
          skipped: true,
        }));
        await callLanguageServer(conn, "HandleCascadeUserInteraction", {
          cascadeId: nativeId,
          interaction: {
            trajectoryId,
            stepIndex,
            askQuestion: {
              cancelled,
              responses,
            },
          },
        });
        this.clearDesktopPendingAction(nativeId, watcher, { optionId });
        return;
      }

      const allow = optionId !== "reject" && optionId !== "cancel";
      const interactionPayload: Record<string, unknown> = {
        trajectoryId: pending.trajectoryId,
        stepIndex: pending.stepIndex,
      };
      if (pending.interactionType === "runCommand") {
        interactionPayload.runCommand = {
          confirm: allow,
          proposedCommandLine: pending.proposedCommandLine ?? "",
          submittedCommandLine: pending.proposedCommandLine ?? "",
        };
      } else if (pending.interactionType === "filePermission") {
        interactionPayload.filePermission = {
          allow,
          ...(pending.absolutePathUri ? { absolutePathUri: pending.absolutePathUri } : {}),
        };
      } else if (pending.interactionType === "permission") {
        interactionPayload.permission = { allow };
      } else {
        interactionPayload[pending.interactionType] = { confirm: allow };
      }

      await callLanguageServer(conn, "HandleCascadeUserInteraction", {
        cascadeId: nativeId,
        interaction: interactionPayload,
      });
      this.clearDesktopPendingAction(nativeId, watcher, { optionId });
      return;
    }
    await super.respondPermission(nativeId, requestId, optionId);
  }

  override async createSession(options: { cwd: string; model?: string }): Promise<DiscoveredSession> {
    if (!this.desktopMode) return super.createSession(options);
    await this.ensureStarted();
    const conn = await this.requireConnection("新建会话");
    const requestedModel = await this.resolvePlanModelEnum(conn, "", options.model);
    const response = await callLanguageServer<{ cascadeId?: string }>(conn, "StartCascade", {
      source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
      workspaceUris: [pathToFileURL(options.cwd).href],
      requestedModel,
    });
    const nativeId = response.cascadeId;
    if (!nativeId) throw RpcError.app("agent_unavailable", "Antigravity 未返回新会话 ID");
    const watcher = this.startWatchingDesktopTranscript(nativeId);
    const selectedModel = options.model ?? requestedModel;
    watcher.selectedModel = selectedModel;
    this.host?.state(this.id, nativeId).set("agy-selected-model", selectedModel);
    void this.emitDesktopConfig(nativeId, selectedModel).catch(() => {});
    const now = Date.now();
    return { nativeId, cwd: options.cwd, createdAt: now, updatedAt: now, state: "idle" };
  }

  /** The transcript step an item of ours came from (the phone's own messages are aliased to theirs). */
  private stepOfItem(nativeId: string, itemId: string): number {
    let id = itemId;
    if (id.startsWith("local-")) id = [...this.desktopAliasesFor(nativeId)].find(([, alias]) => alias === itemId)?.[0] ?? id;
    const match = /^agy:[a-z-]+:(\d+)/.exec(id);
    if (!match) throw RpcError.app("not_supported", "Antigravity 只能从它自己记录的消息处分叉");
    return Number(match[1]);
  }

  /**
   * The step a fork ends at: the end of the turn holding `upTo` (or of the
   * whole conversation). Antigravity forks only at a turn's last step, right
   * before the next user message; the trajectory (not the transcript, which
   * skips some steps) says which that is.
   */
  private async forkStepFor(conn: LanguageServerConnection, nativeId: string, upTo?: { itemId: string }): Promise<number> {
    const from = upTo ? this.stepOfItem(nativeId, upTo.itemId) : undefined;
    const transcriptPath = this.transcriptPathFor(nativeId);
    const lastKnown = this.desktopWatchers.get(nativeId)?.lastStepIndex
      ?? (transcriptPath && existsSync(transcriptPath) ? parseAntigravityTranscript(transcriptPath, 0).lastStepIndex : undefined)
      ?? 0;
    const resp = await callLanguageServer<{ steps?: CascadeTrajectoryStepPayload[] }>(
      conn,
      "GetCascadeTrajectorySteps",
      { cascadeId: nativeId, stepOffset: from ?? Math.max(0, lastKnown - 4) },
      30_000,
    );
    const base = from ?? Math.max(0, lastKnown - 4);
    const steps = (resp.steps ?? []).map((step, idx) => ({
      index: step.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? base + idx,
      user: step.type === "CORTEX_STEP_TYPE_USER_INPUT",
    }));
    const nextUser = from === undefined ? undefined : steps.find((step) => step.user && step.index > from);
    const end = nextUser ? steps.filter((step) => step.index < nextUser.index).at(-1) : steps.at(-1);
    if (!end || end.user) throw RpcError.app("not_supported", "这条消息之后还没有回复，无法从这里分叉");
    return end.index;
  }

  override async fork(nativeId: string, options: ForkOptions): Promise<DiscoveredSession> {
    if (!this.isDesktopSession(nativeId)) return super.fork(nativeId, options);
    // A fork into a worktree is made by replaying the conversation into a new session there.
    if (options.cwd !== options.sourceCwd) throw RpcError.app("not_supported", "Antigravity 的原生分叉只能留在同一目录");
    const conn = await this.requireConnection("分叉");
    if (!options.upTo && (this.desktopWatchers.get(nativeId)?.running || this.isConversationRunningInDesktop(nativeId))) {
      throw RpcError.app("busy", "这个会话正在运行：等这一轮结束再分叉");
    }
    const forkAtStepIndex = await this.forkStepFor(conn, nativeId, options.upTo);
    let response: { newCascadeId?: string };
    try {
      response = await callLanguageServer<{ newCascadeId?: string }>(conn, "ForkConversation", { sourceCascadeId: nativeId, forkAtStepIndex });
    } catch (error) {
      throw RpcError.app("not_supported", error instanceof Error ? error.message : String(error));
    }
    if (!response.newCascadeId) throw RpcError.app("not_supported", "Antigravity 未返回分叉后的会话 ID");
    const now = Date.now();
    return { nativeId: response.newCascadeId, cwd: options.cwd, createdAt: now, updatedAt: now, state: "idle" };
  }

  async rename(nativeId: string, title: string): Promise<void> {
    if (!this.isDesktopSession(nativeId)) return;
    const conn = await this.requireConnection("改名");
    await callLanguageServer(conn, "UpdateConversationAnnotations", { cascadeId: nativeId, annotations: { title }, mergeAnnotations: true });
    this.desktopRowsCache = undefined;
  }

  async archive(nativeId: string, archived: boolean): Promise<void> {
    if (!this.isDesktopSession(nativeId)) return;
    const conn = await this.languageServer();
    // Archiving still holds in LinkShell when the app is closed; the desktop catches up next time.
    if (!conn) return;
    await callLanguageServer(conn, "UpdateConversationAnnotations", { cascadeId: nativeId, annotations: { archived }, mergeAnnotations: true }).catch(() => {});
    this.archivedCache = undefined;
  }

  override async delete(nativeId: string): Promise<void> {
    if (!this.isDesktopSession(nativeId)) return super.delete(nativeId);
    const conn = await this.requireConnection("删除");
    await callLanguageServer(conn, "DeleteCascadeTrajectory", { cascadeId: nativeId });
    this.stopWatching(nativeId);
    this.desktopSessionStates.delete(nativeId);
    this.desktopRowsCache = undefined;
  }

  async goal(nativeId: string, change: GoalChange): Promise<SessionGoal | null> {
    if (!this.isDesktopSession(nativeId)) {
      throw RpcError.app("not_supported", "这个 Agent 通过 /goal 命令管理目标");
    }
    const watcher = this.desktopWatchers.get(nativeId);
    if (change.action === "get") {
      return watcher?.goal ?? null;
    }
    if (change.action === "clear") {
      await this.prompt(nativeId, [{ type: "text", text: "/goal clear" }], `goal-${Date.now()}`);
      return null;
    }
    if (change.action === "set") {
      const nextGoal: SessionGoal = { objective: change.objective, status: "active" };
      await this.prompt(nativeId, [{ type: "text", text: `/goal ${change.objective}` }], `goal-${Date.now()}`);
      return nextGoal;
    }
    return watcher?.goal ?? null;
  }

  private echoDesktopMessage(nativeId: string, clientMessageId: string, blocks: ContentBlock[]): void {
    for (const block of blocks) {
      this.host?.update(this.id, nativeId, { sessionUpdate: "user_message_chunk", messageId: `local-${clientMessageId}`, content: block });
    }
    this.host?.update(
      this.id,
      nativeId,
      { sessionUpdate: "ls_message_done", messageId: `local-${clientMessageId}`, role: "user" },
      `local-${clientMessageId}`,
    );
  }

  override async prompt(
    nativeId: string,
    content: ContentBlock[],
    clientMessageId: string,
    context?: string,
  ): Promise<"started" | "steered" | "queued"> {
    if (!this.isDesktopSession(nativeId)) {
      return super.prompt(nativeId, content, clientMessageId, context);
    }
    const desktop = this.desktop();
    const conn = await this.requireConnection("发送消息");
    let text = content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    const imageBlocks = content.filter((block): block is Extract<ContentBlock, { type: "image" }> => block.type === "image");
    if (!text && imageBlocks.length === 0) throw RpcError.app("invalid_params", "nothing to send");

    let watcher = this.desktopWatchers.get(nativeId);
    if (!watcher) {
      const transcriptPath = this.transcriptPathFor(nativeId);
      const parsed = transcriptPath && existsSync(transcriptPath) ? parseAntigravityTranscript(transcriptPath, 0) : undefined;
      watcher = this.startWatchingDesktopTranscript(
        nativeId,
        parsed && transcriptPath ? { path: transcriptPath, state: parsed.state, offset: parsed.endOffset, pendingAskQuestion: parsed.pendingAskQuestion } : undefined,
      );
      this.followChildren(watcher, parsed?.items ?? [], "", 0);
    }

    let displayBlocks: ContentBlock[] = content;
    if (GOAL_STOP.test(text) && imageBlocks.length === 0) {
      const hadGoal = watcher.goal?.status === "active";
      watcher.goal = null;
      if (!hadGoal) {
        // Nothing for the agent to stop: only the phone's record changes.
        this.echoDesktopMessage(nativeId, clientMessageId, content);
        this.host?.update(this.id, nativeId, { sessionUpdate: "ls_goal", goal: null });
        return "started";
      }
      // The goal is enforced by the agent's stop hook: only the agent can end it (with <!-- GOAL_CANCELLED -->).
      text = "请停止并取消当前的 /goal 目标。";
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_goal", goal: null });
    } else if (/^\/goal(?:\s+|$)/i.test(text)) {
      const objective = text.replace(/^\/goal(?:\s+|$)/i, "").trim() || "持续目标";
      watcher.goal = { objective, status: "active" };
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_goal", goal: watcher.goal });
      displayBlocks = content.map((block) =>
        block.type === "text" && /^\/goal(?:\s+|$)/i.test(block.text.trim()) ? { type: "text", text: objective } : block,
      );
    } else if (watcher.goal?.status === "complete") {
      watcher.goal = null;
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_goal", goal: null });
    }

    const media: { mimeType: string; inlineData: string; thumbnail: string; uri?: string }[] = [];
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
          thumbnail: img.data,
          ...(savedUri ? { uri: savedUri } : {}),
        });
      }
    }

    const planModel = await this.resolvePlanModelEnum(conn, nativeId, watcher.selectedModel);
    const inherited = await this.inheritedSettings(conn, nativeId);

    // A known command goes as the desktop sends it (a slash-command item), so the agent gets its instructions.
    const items: Record<string, unknown>[] = [];
    if (context) items.push({ text: `${context}\n\n` });
    const slash = SLASH.exec(text);
    const command = slash ? (await this.slashCommands(conn, nativeId, planModel)).find((entry) => entry.name === slash[1]) : undefined;
    if (command) {
      items.push({ item: { slashCommand: { info: command.info } } });
      const rest = slash?.[2]?.trim();
      if (rest) items.push({ text: ` ${rest}` });
    } else if (text) {
      items.push({ text });
    } else {
      items.push({ text: "请查看附图" });
    }

    watcher.pendingClientMessages.push({ clientMessageId, text });
    this.echoDesktopMessage(nativeId, clientMessageId, displayBlocks);

    const steering = watcher.running || this.isConversationRunningInDesktop(nativeId);
    if (!steering) {
      watcher.sentAt = Date.now();
      this.desktopRowsCache = undefined;
      watcher.running = true;
      this.desktopSessionStates.set(nativeId, "running");
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_turn", state: "started" });
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: "running", turnActive: true });
    }

    try {
      await callLanguageServer(conn, "SendUserCascadeMessage", {
        cascadeId: nativeId,
        items,
        ...(media.length > 0 ? { media } : {}),
        cascadeConfig: {
          plannerConfig: {
            supportsLatexRendering: true,
            ...(inherited.autoExecutionPolicy
              ? { toolConfig: { runCommand: { autoCommandConfig: { autoExecutionPolicy: inherited.autoExecutionPolicy } } } }
              : {}),
            planModel,
            useAiCredits: inherited.useAiCredits ?? false,
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
    } catch (error) {
      const pendingIdx = watcher.pendingClientMessages.findIndex((p) => p.clientMessageId === clientMessageId);
      if (pendingIdx >= 0) watcher.pendingClientMessages.splice(pendingIdx, 1);
      this.host?.update(this.id, nativeId, {
        sessionUpdate: "ls_error",
        code: "send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      if (!steering) {
        watcher.sentAt = undefined;
        watcher.running = false;
        this.desktopSessionStates.set(nativeId, "idle");
        this.host?.update(this.id, nativeId, { sessionUpdate: "ls_turn", state: "ended", stopReason: "error" });
        this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: "idle", turnActive: false });
      }
      throw error;
    }

    return steering ? "steered" : "started";
  }

  override async cancelSubagent(nativeId: string, childId: string): Promise<void> {
    if (!this.isDesktopSession(nativeId)) return super.cancelSubagent(nativeId, childId);
    // Only a conversation this one spawned (directly or through its sub-agents) may be stopped from here.
    const rows = this.desktopRows();
    let parent = rows?.get(childId)?.parent;
    for (let depth = 0; parent && parent !== nativeId && depth < 8; depth++) parent = rows?.get(parent)?.parent;
    if (parent !== nativeId) throw RpcError.app("not_supported", "这个子代理不属于当前会话");
    const conn = await this.requireConnection("停止子代理");
    await callLanguageServer(conn, "CancelCascadeInvocation", { cascadeId: childId, killBackgroundTasks: false });
  }

  override async cancel(nativeId: string): Promise<void> {
    if (this.isDesktopSession(nativeId)) {
      const conn = await this.languageServer();
      if (conn) {
        await callLanguageServer(conn, "CancelCascadeInvocation", {
          cascadeId: nativeId,
          killBackgroundTasks: false,
        }).catch(() => {});
      }
      const watcher = this.desktopWatchers.get(nativeId);
      if (watcher) {
        if (watcher.pendingAction) {
          this.clearDesktopPendingAction(nativeId, watcher, { optionId: "cancel" });
        }
        watcher.sentAt = undefined;
        watcher.running = false;
      }
      this.desktopSessionStates.set(nativeId, "idle");
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_turn", state: "ended", stopReason: "cancelled" });
      this.host?.update(this.id, nativeId, { sessionUpdate: "ls_status", state: "idle", turnActive: false });
      return;
    }
    await super.cancel(nativeId);
  }

  override async setConfig(nativeId: string, optionId: string, value: string): Promise<void> {
    if (this.isDesktopSession(nativeId)) {
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
