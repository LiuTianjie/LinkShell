import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import {
  createEnvelope,
  parseTypedPayload,
  type Envelope,
} from "@linkshell/protocol";
import { AcpClient } from "./acp-client.js";
import { ClaudeSdkClient } from "./claude-sdk-client.js";
import { ClaudeStreamJsonClient } from "./claude-stream-json-client.js";
import type { AgentProtocol, AgentProvider } from "./provider-resolver.js";
import { resolveAgentCommand } from "./provider-resolver.js";

type AgentStatus = "unavailable" | "idle" | "running" | "waiting_permission" | "error";
type AgentPermissionMode = "read_only" | "workspace_write" | "full_access";
type AgentCollaborationMode = "default" | "plan";
type AgentCommandExecutionKind = "prompt" | "native" | "local_ui";
type AgentCommandSource = "built_in" | "custom" | "project" | "user" | "linkshell";

interface AgentContentBlock {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

interface AgentToolCall {
  id: string;
  name: string;
  input?: string;
  output?: string;
  createdAt?: number;
  status: "pending" | "running" | "completed" | "failed";
}

interface AgentPlanStep {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

interface AgentPermission {
  requestId: string;
  toolName?: string;
  toolInput?: string;
  context?: string;
  options: { id: string; label: string; kind: "allow" | "deny" | "other" }[];
}

type AgentTimelineKind =
  | "chat"
  | "thinking"
  | "tool_activity"
  | "command_execution"
  | "file_change"
  | "subagent_action"
  | "plan"
  | "user_input_prompt"
  | "review"
  | "context_compaction";

interface AgentFileChangeEntry {
  path: string;
  kind?: string;
  added?: number;
  removed?: number;
}

interface AgentFileChange {
  entries: AgentFileChangeEntry[];
  diff?: string;
  summary?: string;
  changeSetId?: string;
  status?: AgentToolCall["status"];
}

interface AgentCommandExecution {
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number | null;
  status?: AgentToolCall["status"];
}

interface AgentStructuredInputOption {
  id: string;
  label: string;
  description?: string;
}

interface AgentStructuredInputQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  selectionLimit?: number;
  options?: AgentStructuredInputOption[];
}

interface AgentStructuredInput {
  requestId: string;
  questions: AgentStructuredInputQuestion[];
}

interface AgentSubagentRef {
  threadId: string;
  agentId?: string;
  nickname?: string;
  role?: string;
  model?: string;
  prompt?: string;
}

interface AgentSubagentState {
  threadId: string;
  status: string;
  message?: string;
}

interface AgentSubagentAction {
  tool: string;
  status: string;
  prompt?: string;
  model?: string;
  receiverThreadIds: string[];
  receiverAgents: AgentSubagentRef[];
  agentStates: Record<string, AgentSubagentState>;
}

interface AgentCommandDescriptor {
  id: string;
  name: string;
  title: string;
  description?: string;
  provider?: AgentProvider;
  source: AgentCommandSource;
  category?: string;
  argsMode: "none" | "optional" | "required" | "raw";
  requiresIdle?: boolean;
  destructive?: boolean;
  disabledReason?: string;
  executionKind: AgentCommandExecutionKind;
}

interface AgentModeDescriptor {
  id: string;
  title: string;
  description?: string;
}

interface AgentConversationUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  totalCostUsd?: number;
  updatedAt?: number;
}

interface AgentConversation {
  id: string;
  agentSessionId?: string;
  provider: AgentProvider;
  cwd: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: AgentPermissionMode;
  collaborationMode?: AgentCollaborationMode;
  status: AgentStatus;
  archived: boolean;
  lastMessagePreview?: string;
  lastActivityAt: number;
  createdAt: number;
  usage?: AgentConversationUsage;
}

interface AgentTimelineItem {
  id: string;
  conversationId: string;
  type: "message" | "tool_call" | "plan" | "permission" | "status" | "error";
  kind?: AgentTimelineKind;
  turnId?: string;
  itemId?: string;
  role?: "user" | "assistant" | "system";
  content?: AgentContentBlock[];
  text?: string;
  toolCall?: AgentToolCall;
  commandExecution?: AgentCommandExecution;
  fileChange?: AgentFileChange;
  subagent?: AgentSubagentAction;
  structuredInput?: AgentStructuredInput;
  plan?: AgentPlanStep[];
  permission?: AgentPermission;
  status?: AgentStatus;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
  isStreaming?: boolean;
}

interface PendingPermissionWaiter {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingStructuredInputWaiter {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  source?: string;
  input: AgentStructuredInput;
}

const PERMISSION_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMELINE_ITEMS = 200;

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAgentSessionIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

export function makeAgentV2RemoteConversationId(
  provider: AgentProvider,
  agentSessionId: string,
): string {
  return `agent-remote-${provider}-${normalizeAgentSessionIdSegment(agentSessionId)}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value ? value as Record<string, unknown> : undefined;
}

function firstString(value: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const next = value[key];
    if (typeof next === "string" && next.length > 0) return next;
  }
  return undefined;
}

function normalizedIdentifier(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[_\-\s/]+/g, "");
}

function firstNumber(value: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const next = value[key];
    if (typeof next === "number" && Number.isFinite(next)) return next;
  }
  return undefined;
}

// Best-effort context-window size (tokens) for a model id, used as the "% used"
// denominator only when the provider doesn't report it directly. Conservative
// on purpose: returns undefined for anything we can't confidently map, so the
// UI shows a raw token count instead of a misleading percentage. Claude omits
// context_window in result.usage, so this fallback is what gives Claude a meter.
function contextWindowForModel(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("claude")) {
    // 1M-context variants are tagged (e.g. "claude-opus-4-8[1m]"); else 200k.
    return /\b1m\b|\[1m\]|-1m/.test(m) ? 1_000_000 : 200_000;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function arrayFromKeys(value: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const next = value[key];
    if (Array.isArray(next)) return next;
  }
  return [];
}

function extractItem(value: unknown): Record<string, unknown> | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  return asRecord(raw.item) ?? raw;
}

function extractTurn(value: unknown): Record<string, unknown> | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  return asRecord(raw.turn) ?? raw;
}

function stringifyDefined(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return stringify(value);
}

function appendCapped(current: string | undefined, delta: string, maxLength: number): string {
  const next = `${current ?? ""}${delta}`;
  if (next.length <= maxLength) return next;
  return next.slice(next.length - maxLength);
}

function decodeBase64(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function normalizeToolStatus(value: unknown, completedFallback = false): AgentToolCall["status"] {
  if (value === "completed" || value === "succeeded" || value === "success" || value === "applied") {
    return "completed";
  }
  if (value === "failed" || value === "error" || value === "declined" || value === "cancelled") {
    return "failed";
  }
  if (value === "pending" || value === "queued") return "pending";
  if (value === "running" || value === "inProgress" || value === "executing") return "running";
  return completedFallback ? "completed" : "running";
}

function normalizePlanStatus(value: unknown): AgentPlanStep["status"] {
  if (value === "completed" || value === "done") return "completed";
  if (value === "inProgress" || value === "running" || value === "active") return "in_progress";
  return "pending";
}

function agentStatusFromThreadStatus(value: unknown): AgentStatus | undefined {
  const raw = asRecord(value);
  const status = typeof value === "string"
    ? value
    : firstString(raw, ["status", "state", "phase", "type"]) ??
      firstString(asRecord(raw?.status), ["status", "state", "phase", "type"]);
  const normalized = normalizedIdentifier(status);
  if (!normalized) return undefined;
  if (["active", "running", "inprogress", "busy", "working", "streaming"].includes(normalized)) {
    return "running";
  }
  if (["idle", "ready", "completed", "complete", "done", "finished"].includes(normalized)) {
    return "idle";
  }
  if (["waitingpermission", "waitingforpermission", "requirespermission", "needspermission"].includes(normalized)) {
    return "waiting_permission";
  }
  if (["error", "failed", "systemerror", "fatal"].includes(normalized)) {
    return "error";
  }
  return undefined;
}

function nameFromToolMethod(method: string): string {
  if (method.includes("commandExecution")) return "命令";
  if (method.includes("fileChange")) return "文件修改";
  if (method.includes("mcpToolCall")) return "MCP 工具";
  return "工具";
}

function isToolItemType(itemType: string | undefined): boolean {
  const normalized = normalizedIdentifier(itemType);
  return (
    normalized === "commandexecution" ||
    normalized === "filechange" ||
    normalized === "diff" ||
    normalized === "toolcall" ||
    normalized === "mcptoolcall" ||
    normalized === "dynamictoolcall"
  );
}

function toolNameFromItem(item: Record<string, unknown>): string | undefined {
  const itemType = firstString(item, ["type"]);
  const normalized = normalizedIdentifier(itemType);
  if (normalized === "commandexecution") return "命令";
  if (normalized === "filechange" || normalized === "diff") return "文件修改";
  if (normalized === "toolcall") return firstString(item, ["toolName", "tool", "name", "title"]) ?? "工具";
  if (normalized === "mcptoolcall") {
    const server = firstString(item, ["server"]);
    const tool = firstString(item, ["tool", "toolName", "name"]);
    return [server, tool].filter(Boolean).join(" · ") || "MCP 工具";
  }
  if (normalized === "dynamictoolcall") {
    const namespace = firstString(item, ["namespace"]);
    const tool = firstString(item, ["tool", "toolName", "name"]);
    return [namespace, tool].filter(Boolean).join(" · ") || "工具";
  }
  return firstString(item, ["toolName", "tool", "name", "title"]);
}

function summarizeFileChanges(changes: unknown[]): string | undefined {
  const lines = changes
    .map((change) => {
      const raw = asRecord(change);
      if (!raw) return undefined;
      const path =
        firstString(raw, ["path", "file", "filePath", "absolutePath", "relativePath"]) ??
        firstString(asRecord(raw.update), ["path", "file", "filePath"]);
      const kind = firstString(raw, ["kind", "type", "operation", "action"]);
      return [kind, path].filter(Boolean).join(" ") || path;
    })
    .filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.slice(0, 8).join("\n") : undefined;
}

function fileChangeEntriesFromItem(item: Record<string, unknown>): AgentFileChangeEntry[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const entries: AgentFileChangeEntry[] = [];
  for (const change of changes) {
    const raw = asRecord(change);
    if (!raw) continue;
    const path =
      firstString(raw, ["path", "file", "filePath", "absolutePath", "relativePath"]) ??
      firstString(asRecord(raw.update), ["path", "file", "filePath"]);
    if (!path) continue;
    const totals = asRecord(raw.totals) ?? asRecord(raw.diffStats) ?? asRecord(raw.stats);
    const entry: AgentFileChangeEntry = { path };
    const kind = firstString(raw, ["kind", "type", "operation", "action"]);
    const added = firstNumber(raw, ["added", "additions"]) ?? firstNumber(totals, ["added", "additions"]);
    const removed = firstNumber(raw, ["removed", "deletions"]) ?? firstNumber(totals, ["removed", "deletions"]);
    if (kind) entry.kind = kind;
    if (added !== undefined) entry.added = added;
    if (removed !== undefined) entry.removed = removed;
    entries.push(entry);
  }
  const directPath = firstString(item, ["path", "file", "filePath", "absolutePath", "relativePath"]);
  if (entries.length === 0 && directPath) {
    const entry: AgentFileChangeEntry = { path: directPath };
    const kind = firstString(item, ["kind", "type", "operation", "action"]);
    if (kind) entry.kind = kind;
    return [entry];
  }
  return entries;
}

function commandExecutionFromItem(
  item: Record<string, unknown>,
  status: AgentToolCall["status"],
  output?: string,
): AgentCommandExecution | undefined {
  const command = firstString(item, ["command"]);
  const cwd = firstString(item, ["cwd"]);
  const exitCode = firstNumber(item, ["exitCode", "code"]);
  if (!command && !cwd && !output && exitCode === undefined) return undefined;
  return { command, cwd, output, exitCode: exitCode ?? undefined, status };
}

function fileChangeFromItem(
  item: Record<string, unknown>,
  status: AgentToolCall["status"],
  diff?: string,
): AgentFileChange | undefined {
  const entries = fileChangeEntriesFromItem(item);
  const summary = summarizeFileChanges(Array.isArray(item.changes) ? item.changes : []);
  const changeSetId = firstString(item, ["changeSetId", "changesetId", "patchId"]);
  if (entries.length === 0 && !diff && !summary && !changeSetId) return undefined;
  return { entries, diff, summary, changeSetId, status };
}

function commandExecutionFromTool(toolCall: AgentToolCall): AgentCommandExecution | undefined {
  const input = toolCall.input?.trim();
  if (!input && !toolCall.output) return undefined;
  const [commandPart, cwdPart] = input?.split(/\n\ncwd:\s*/i) ?? [];
  return {
    command: commandPart || input,
    cwd: cwdPart,
    output: toolCall.output,
    status: toolCall.status,
  };
}

function fileChangeFromStructuredInput(input: string | undefined): AgentFileChangeEntry[] {
  const raw = input?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return fileChangeEntriesFromItem(parsed as Record<string, unknown>);
    }
  } catch {
    // Fall through to line parser.
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [kind, ...rest] = line.split(/\s+/);
      const path = rest.length > 0 ? rest.join(" ") : kind;
      const entry: AgentFileChangeEntry = { path: path ?? line };
      if (rest.length > 0 && kind) entry.kind = kind;
      return entry;
    })
    .filter((entry) => entry.path.length > 0);
}

function fileChangeFromTool(toolCall: AgentToolCall): AgentFileChange | undefined {
  const diff = toolCall.output && looksLikeDiff(toolCall.output) ? toolCall.output : undefined;
  const entries = fileChangeFromStructuredInput(toolCall.input);
  if (entries.length === 0 && !diff && !toolCall.output) return undefined;
  return {
    entries,
    diff,
    summary: diff ? undefined : toolCall.output,
    status: toolCall.status,
  };
}

function looksLikeDiff(text: string): boolean {
  const value = text.trim();
  return (
    value.startsWith("diff --git ") ||
    value.startsWith("@@ ") ||
    value.includes("\n@@ ") ||
    (value.includes("\n--- ") && value.includes("\n+++ "))
  );
}

function collectDiffStrings(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === undefined || value === null) return [];
  if (typeof value === "string") return looksLikeDiff(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectDiffStrings(entry, depth + 1));
  const raw = asRecord(value);
  if (!raw) return [];
  const direct: string[] = [];
  const nested: string[] = [];
  for (const [key, entry] of Object.entries(raw)) {
    const lowerKey = key.toLowerCase();
    const isDiffField =
      lowerKey.includes("diff") ||
      lowerKey.includes("patch") ||
      lowerKey.includes("unified");
    if (typeof entry === "string" && isDiffField && entry.trim()) {
      direct.push(entry);
    } else if (typeof entry === "object" && entry) {
      nested.push(...collectDiffStrings(entry, depth + 1));
    }
  }
  return [...direct, ...nested].filter((entry) => looksLikeDiff(entry));
}

function extractDiffText(value: unknown): string | undefined {
  const diffs = collectDiffStrings(value)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (diffs.length === 0) return undefined;
  return diffs
    .filter((entry, index, array) => array.indexOf(entry) === index)
    .join("\n\n")
    .slice(0, 24_000);
}

function toolInputFromItem(item: Record<string, unknown>): string | undefined {
  const itemType = firstString(item, ["type"]);
  const normalized = normalizedIdentifier(itemType);
  if (normalized === "commandexecution") {
    const command = firstString(item, ["command"]);
    const cwd = firstString(item, ["cwd"]);
    if (command && cwd) return `${command}\n\ncwd: ${cwd}`;
    return command ?? cwd;
  }
  if (normalized === "filechange" || normalized === "diff") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return summarizeFileChanges(changes) ?? firstString(item, ["path", "file", "filePath", "absolutePath", "relativePath"]);
  }
  return stringifyDefined(item.arguments ?? item.input ?? item.toolInput);
}

function titleFromCwd(cwd: string): string {
  return basename(cwd) || cwd || "Agent";
}

function textFromBlocks(blocks: AgentContentBlock[]): string {
  return blocks
    .map((block) => block.type === "text" ? block.text ?? "" : `[${block.mimeType ?? "image"} attachment]`)
    .filter(Boolean)
    .join("\n");
}

function contentBlocksFromValue(value: unknown): AgentContentBlock[] {
  if (typeof value === "string") {
    return value.trim() ? [{ type: "text", text: value }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => contentBlocksFromValue(entry));
  }
  const raw = asRecord(value);
  if (!raw) return [];
  const rawType = firstString(raw, ["type", "kind"]);
  const normalizedType = normalizedIdentifier(rawType);
  if (normalizedType === "image" || normalizedType === "inputimage" || normalizedType === "outputimage") {
    const data = firstString(raw, [
      "data",
      "url",
      "uri",
      "imageUrl",
      "image_url",
      "base64",
    ]);
    const mimeType = firstString(raw, ["mimeType", "mime_type", "mediaType", "media_type"]);
    const text = firstString(raw, ["text", "alt", "caption", "name"]);
    return [{ type: "image", data, mimeType, text }];
  }
  if (normalizedType === "text" || normalizedType === "outputtext" || normalizedType === "inputtext") {
    const text = firstString(raw, ["text", "content", "message"]);
    return text ? [{ type: "text", text }] : [];
  }
  const nested = raw.content ?? raw.contentItems ?? raw.parts;
  if (Array.isArray(nested)) return contentBlocksFromValue(nested);
  const text = firstString(raw, ["text", "message", "content"]);
  return text ? [{ type: "text", text }] : [];
}

function contentBlocksFromItem(item: Record<string, unknown>): AgentContentBlock[] {
  for (const key of ["content", "contentItems", "parts", "message"]) {
    const blocks = contentBlocksFromValue(item[key]);
    if (blocks.length > 0) return blocks;
  }
  const text = firstString(item, ["text", "message"]);
  return text ? [{ type: "text", text }] : [];
}

function protocolSupportsImages(protocol: AgentProtocol | undefined): boolean {
  return protocol === "codex-app-server" ||
    protocol === "claude-agent-sdk" ||
    protocol === "claude-stream-json";
}

function isSubagentItemType(itemType: string | undefined): boolean {
  const normalized = normalizedIdentifier(itemType);
  return (
    normalized === "collabagenttoolcall" ||
    normalized === "collabtoolcall" ||
    normalized.startsWith("collabagentspawn") ||
    normalized.startsWith("collabwaiting") ||
    normalized.startsWith("collabclose") ||
    normalized.startsWith("collabresume") ||
    normalized.startsWith("collabagentinteraction")
  );
}

function parseSubagentRef(value: unknown): AgentSubagentRef | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const threadId = firstString(raw, ["threadId", "threadID", "id", "sessionId"]);
  if (!threadId) return undefined;
  return {
    threadId,
    agentId: firstString(raw, ["agentId", "agentID"]),
    nickname: firstString(raw, ["nickname", "name", "label"]),
    role: firstString(raw, ["role", "kind"]),
    model: firstString(raw, ["model", "modelName"]),
    prompt: firstString(raw, ["prompt", "instructions", "message"]),
  };
}

function parseSubagentStates(value: unknown): Record<string, AgentSubagentState> {
  const result: Record<string, AgentSubagentState> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      const raw = asRecord(entry);
      const threadId = firstString(raw, ["threadId", "threadID", "id", "sessionId"]);
      const status = firstString(raw, ["status", "state", "phase"]);
      if (!threadId || !status) continue;
      result[threadId] = {
        threadId,
        status,
        message: firstString(raw, ["message", "summary", "text"]),
      };
    }
    return result;
  }
  const raw = asRecord(value);
  if (!raw) return result;
  for (const [threadId, entry] of Object.entries(raw)) {
    const state = asRecord(entry);
    if (state) {
      result[threadId] = {
        threadId,
        status: firstString(state, ["status", "state", "phase"]) ?? "running",
        message: firstString(state, ["message", "summary", "text"]),
      };
    } else if (typeof entry === "string") {
      result[threadId] = { threadId, status: entry };
    }
  }
  return result;
}

function parseStructuredInputOption(value: unknown, index: number): AgentStructuredInputOption | undefined {
  const raw = asRecord(value);
  if (!raw) {
    if (typeof value === "string" && value.trim()) {
      return { id: `option-${index + 1}`, label: value.trim() };
    }
    return undefined;
  }
  const label = firstString(raw, ["label", "title", "text", "value"]);
  if (!label) return undefined;
  return {
    id: firstString(raw, ["id", "optionId", "value"]) ?? `option-${index + 1}`,
    label,
    description: firstString(raw, ["description", "detail", "subtitle"]),
  };
}

function parseStructuredInputQuestion(value: unknown, index: number): AgentStructuredInputQuestion | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const question = firstString(raw, ["question", "prompt", "text", "message", "label"]);
  if (!question) return undefined;
  const options = arrayFromKeys(raw, ["options", "choices", "items"])
    .map(parseStructuredInputOption)
    .filter((option): option is AgentStructuredInputOption => Boolean(option));
  return {
    id: firstString(raw, ["id", "questionId", "key"]) ?? `question-${index + 1}`,
    header: firstString(raw, ["header", "title"]),
    question,
    isOther: raw.isOther === true,
    isSecret: raw.isSecret === true || raw.secret === true,
    selectionLimit: raw.multiSelect === true
      ? options.length || undefined
      : firstNumber(raw, ["selectionLimit", "maxSelections"]),
    options: options.length > 0 ? options : undefined,
  };
}

function decodeStructuredInput(value: unknown): AgentStructuredInput | undefined {
  const raw = asRecord(value) ?? {};
  const questions = arrayFromKeys(raw, ["questions", "items", "prompts"])
    .map(parseStructuredInputQuestion)
    .filter((question): question is AgentStructuredInputQuestion => Boolean(question));
  if (questions.length === 0) {
    const single = parseStructuredInputQuestion(raw, 0);
    if (single) questions.push(single);
  }
  if (questions.length === 0) return undefined;
  return {
    requestId: firstString(raw, ["requestId", "id", "inputId"]) ?? id("input"),
    questions,
  };
}

function decodeSubagentAction(
  item: Record<string, unknown>,
  status: "running" | "completed" | "failed" | "pending",
): AgentSubagentAction | undefined {
  const nested = asRecord(item.action) ?? asRecord(item.toolCall) ?? asRecord(item.call) ?? {};
  const receiverAgents = [
    ...arrayFromKeys(item, ["receiverAgents", "agents", "subagents", "receivers"]).map(parseSubagentRef),
    ...arrayFromKeys(nested, ["receiverAgents", "agents", "subagents", "receivers"]).map(parseSubagentRef),
  ].filter((entry): entry is AgentSubagentRef => Boolean(entry));
  const receiverThreadIds = [
    ...stringArray(item.receiverThreadIds),
    ...stringArray(item.threadIds),
    ...stringArray(item.childThreadIds),
    ...stringArray(item.agentThreadIds),
    ...stringArray(nested.receiverThreadIds),
    ...stringArray(nested.threadIds),
    ...receiverAgents.map((agent) => agent.threadId),
  ].filter((threadId, index, array) => array.indexOf(threadId) === index);
  const agentStates = {
    ...parseSubagentStates(item.agentStates ?? item.states ?? item.statusByThread),
    ...parseSubagentStates(nested.agentStates ?? nested.states ?? nested.statusByThread),
  };
  if (receiverThreadIds.length === 0 && Object.keys(agentStates).length === 0) return undefined;
  return {
    tool: firstString(item, ["tool", "toolName", "name", "type"]) ??
      firstString(nested, ["tool", "toolName", "name", "type"]) ??
      "subagent",
    status,
    prompt: firstString(item, ["prompt", "instructions", "message"]) ??
      firstString(nested, ["prompt", "instructions", "message"]),
    model: firstString(item, ["model", "modelName"]) ?? firstString(nested, ["model", "modelName"]),
    receiverThreadIds,
    receiverAgents,
    agentStates,
  };
}

function summarizeSubagentAction(action: AgentSubagentAction): string {
  const count = Math.max(1, action.receiverThreadIds.length, action.receiverAgents.length);
  const normalized = normalizedIdentifier(action.tool);
  if (normalized.includes("spawn")) return `启动 ${count} 个子 Agent`;
  if (normalized.includes("wait")) return `等待 ${count} 个子 Agent`;
  if (normalized.includes("resume")) return `恢复 ${count} 个子 Agent`;
  if (normalized.includes("close")) return `关闭 ${count} 个子 Agent`;
  if (normalized.includes("sendinput")) return `更新 ${count} 个子 Agent`;
  return count === 1 ? "子 Agent 活动" : `${count} 个子 Agent 活动`;
}

function previewText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

function providerLabel(provider: AgentProvider): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  return "Custom";
}

interface AgentModelOption {
  id: string;
  label: string;
}

interface ProviderRuntimeCapabilities {
  models?: AgentModelOption[];
  defaultModel?: string;
  reasoningEfforts?: string[];
  commands?: AgentCommandDescriptor[];
  modes?: AgentModeDescriptor[];
  currentMode?: string;
}

const ALL_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
const ALL_PERMISSION_MODES = ["read_only", "workspace_write", "full_access"] as const;

// Codex `model/list` is the source of truth — these are only used when the RPC
// returns nothing so mobile still sees a usable picker.
const CODEX_FALLBACK_MODELS: AgentModelOption[] = [
  { id: "default", label: "默认模型" },
];
const CODEX_FALLBACK_DEFAULT_MODEL = "default";
const CODEX_COMMAND_NAMES = ["plan", "exit-plan", "compact", "clear", "status", "review", "subagents"] as const;
const CLAUDE_REMOTE_HIDDEN_COMMANDS = new Set([
  "add-dir",
  "agents",
  "allowed-tools",
  "android",
  "app",
  "bashes",
  "branch",
  "bug",
  "checkpoint",
  "chrome",
  "color",
  "config",
  "continue",
  "copy",
  "cost",
  "desktop",
  "diff",
  "doctor",
  "exit",
  "export",
  "extra-usage",
  "feedback",
  "focus",
  "fork",
  "hooks",
  "ide",
  "init",
  "install-github-app",
  "install-slack-app",
  "ios",
  "keybindings",
  "login",
  "logout",
  "mcp",
  "memory",
  "migrate-installer",
  "mobile",
  "model",
  "passes",
  "permissions",
  "plugin",
  "powerup",
  "pr-comments",
  "privacy-settings",
  "quit",
  "rc",
  "release-notes",
  "remote-control",
  "remote-env",
  "resume",
  "rewind",
  "settings",
  "statusline",
  "stickers",
  "tasks",
  "teleport",
  "terminal-setup",
  "theme",
  "tp",
  "tui",
  "undo",
  "upgrade",
  "vim",
  "voice",
  "web-setup",
]);
const CLAUDE_BUILT_IN_COMMANDS: Array<{ name: string; description: string; argsMode?: AgentCommandDescriptor["argsMode"]; destructive?: boolean }> = [
  { name: "add-dir", description: "Add a working directory for file access", argsMode: "required" },
  { name: "agents", description: "Manage agent configurations", argsMode: "none" },
  { name: "autofix-pr", description: "Spawn a Claude Code web session to fix PR CI or review comments" },
  { name: "batch", description: "Orchestrate large-scale changes across parallel agents", argsMode: "required" },
  { name: "branch", description: "Create a branch of the current conversation" },
  { name: "fork", description: "Alias for /branch" },
  { name: "btw", description: "Ask a side question without adding to the conversation", argsMode: "required" },
  { name: "chrome", description: "Configure Claude in Chrome settings", argsMode: "none" },
  { name: "claude-api", description: "Load Claude API reference or migration guidance" },
  { name: "clear", description: "Start a new conversation with empty context", argsMode: "none", destructive: true },
  { name: "reset", description: "Alias for /clear", argsMode: "none", destructive: true },
  { name: "new", description: "Alias for /clear", argsMode: "none", destructive: true },
  { name: "color", description: "Set the prompt bar color" },
  { name: "compact", description: "Compact conversation history" },
  { name: "config", description: "Open configuration" },
  { name: "settings", description: "Alias for /config", argsMode: "none" },
  { name: "context", description: "Visualize current context usage", argsMode: "none" },
  { name: "copy", description: "Copy the last assistant response" },
  { name: "cost", description: "Alias for /usage", argsMode: "none" },
  { name: "debug", description: "Enable debug logging and troubleshoot the session" },
  { name: "desktop", description: "Continue the current session in Claude Code Desktop", argsMode: "none" },
  { name: "app", description: "Alias for /desktop", argsMode: "none" },
  { name: "diff", description: "Open an interactive diff viewer", argsMode: "none" },
  { name: "doctor", description: "Check Claude Code health", argsMode: "none" },
  { name: "effort", description: "Set model effort level" },
  { name: "exit", description: "Exit Claude Code", argsMode: "none", destructive: true },
  { name: "quit", description: "Alias for /exit", argsMode: "none", destructive: true },
  { name: "export", description: "Export conversation" },
  { name: "extra-usage", description: "Configure extra usage when rate limits are hit", argsMode: "none" },
  { name: "fast", description: "Toggle fast mode" },
  { name: "feedback", description: "Submit feedback about Claude Code" },
  { name: "bug", description: "Alias for /feedback" },
  { name: "fewer-permission-prompts", description: "Reduce common permission prompts", argsMode: "none" },
  { name: "focus", description: "Toggle the focus view", argsMode: "none" },
  { name: "heapdump", description: "Write a JavaScript heap snapshot for diagnostics", argsMode: "none" },
  { name: "help", description: "Show help and available commands", argsMode: "none" },
  { name: "hooks", description: "View hook configurations", argsMode: "none" },
  { name: "ide", description: "Manage IDE integrations and show status", argsMode: "none" },
  { name: "init", description: "Initialize project with a CLAUDE.md guide", argsMode: "none" },
  { name: "insights", description: "Generate a report analyzing Claude Code sessions", argsMode: "none" },
  { name: "install-github-app", description: "Set up the Claude GitHub Actions app", argsMode: "none" },
  { name: "install-slack-app", description: "Install the Claude Slack app", argsMode: "none" },
  { name: "keybindings", description: "Open or create keybindings configuration", argsMode: "none" },
  { name: "login", description: "Sign in", argsMode: "none" },
  { name: "logout", description: "Sign out", argsMode: "none" },
  { name: "loop", description: "Run a prompt repeatedly while the session stays open" },
  { name: "proactive", description: "Alias for /loop" },
  { name: "mcp", description: "Manage MCP servers and OAuth authentication", argsMode: "none" },
  { name: "memory", description: "Edit memory files and auto-memory settings", argsMode: "none" },
  { name: "mobile", description: "Show QR code to download the Claude mobile app", argsMode: "none" },
  { name: "ios", description: "Alias for /mobile", argsMode: "none" },
  { name: "android", description: "Alias for /mobile", argsMode: "none" },
  { name: "model", description: "Switch model" },
  { name: "passes", description: "Share a free week of Claude Code", argsMode: "none" },
  { name: "permissions", description: "Manage tool permission rules", argsMode: "none" },
  { name: "allowed-tools", description: "Alias for /permissions", argsMode: "none" },
  { name: "plan", description: "Enter Claude Code plan mode" },
  { name: "plugin", description: "Manage Claude Code plugins", argsMode: "none" },
  { name: "powerup", description: "Discover Claude Code features through lessons", argsMode: "none" },
  { name: "pr-comments", description: "Fetch PR comments on older Claude Code versions" },
  { name: "privacy-settings", description: "View and update privacy settings", argsMode: "none" },
  { name: "recap", description: "Generate a one-line session summary", argsMode: "none" },
  { name: "release-notes", description: "Show release notes", argsMode: "none" },
  { name: "reload-plugins", description: "Reload active plugins", argsMode: "none" },
  { name: "remote-control", description: "Make this session available for remote control", argsMode: "none" },
  { name: "rc", description: "Alias for /remote-control", argsMode: "none" },
  { name: "remote-env", description: "Configure the default remote environment", argsMode: "none" },
  { name: "rename", description: "Rename the current session" },
  { name: "resume", description: "Resume a conversation" },
  { name: "continue", description: "Alias for /resume" },
  { name: "review", description: "Review a pull request locally" },
  { name: "rewind", description: "Rewind the conversation or code to a previous point", argsMode: "none", destructive: true },
  { name: "checkpoint", description: "Alias for /rewind", argsMode: "none", destructive: true },
  { name: "undo", description: "Alias for /rewind", argsMode: "none", destructive: true },
  { name: "sandbox", description: "Toggle sandbox mode", argsMode: "none" },
  { name: "schedule", description: "Create, update, list, or run routines" },
  { name: "routines", description: "Alias for /schedule" },
  { name: "security-review", description: "Analyze pending changes for security issues", argsMode: "none" },
  { name: "setup-bedrock", description: "Configure Amazon Bedrock authentication", argsMode: "none" },
  { name: "setup-vertex", description: "Configure Google Vertex AI authentication", argsMode: "none" },
  { name: "simplify", description: "Review and simplify recently changed files" },
  { name: "skills", description: "List available skills", argsMode: "none" },
  { name: "stats", description: "Alias for /usage", argsMode: "none" },
  { name: "status", description: "Show status", argsMode: "none" },
  { name: "statusline", description: "Configure status line" },
  { name: "stickers", description: "Order Claude Code stickers", argsMode: "none" },
  { name: "tasks", description: "List and manage background tasks", argsMode: "none" },
  { name: "bashes", description: "Alias for /tasks", argsMode: "none" },
  { name: "team-onboarding", description: "Generate a team onboarding guide", argsMode: "none" },
  { name: "teleport", description: "Pull a Claude Code web session into this terminal", argsMode: "none" },
  { name: "tp", description: "Alias for /teleport", argsMode: "none" },
  { name: "terminal-setup", description: "Configure terminal keybindings", argsMode: "none" },
  { name: "theme", description: "Change color theme" },
  { name: "tui", description: "Set the terminal UI renderer" },
  { name: "ultraplan", description: "Draft a plan in an ultraplan web session", argsMode: "required" },
  { name: "ultrareview", description: "Run a deep cloud-based code review" },
  { name: "upgrade", description: "Open upgrade page", argsMode: "none" },
  { name: "usage", description: "Show usage and rate-limit status", argsMode: "none" },
  { name: "vim", description: "Toggle vim mode on older Claude Code versions", argsMode: "none" },
  { name: "voice", description: "Toggle voice dictation" },
  { name: "web-setup", description: "Connect your GitHub account to Claude Code on the web", argsMode: "none" },
];

function isClaudeRemoteFriendlyCommand(name: string): boolean {
  return !CLAUDE_REMOTE_HIDDEN_COMMANDS.has(name.replace(/^\/+/, ""));
}

function commandId(provider: AgentProvider, name: string, source: AgentCommandSource = "built_in"): string {
  return `${provider}:${source}:${name.replace(/^\/+/, "")}`;
}

function commandTitle(name: string): string {
  return `/${name.replace(/^\/+/, "")}`;
}

function makeCommand(input: {
  provider: AgentProvider;
  name: string;
  description?: string;
  source?: AgentCommandSource;
  category?: string;
  argsMode?: AgentCommandDescriptor["argsMode"];
  requiresIdle?: boolean;
  destructive?: boolean;
  disabledReason?: string;
  executionKind?: AgentCommandExecutionKind;
}): AgentCommandDescriptor {
  const cleanName = input.name.replace(/^\/+/, "");
  const source = input.source ?? "built_in";
  return {
    id: commandId(input.provider, cleanName, source),
    name: cleanName,
    title: commandTitle(cleanName),
    description: input.description,
    provider: input.provider,
    source,
    category: input.category,
    argsMode: input.argsMode ?? "optional",
    requiresIdle: input.requiresIdle,
    destructive: input.destructive,
    disabledReason: input.disabledReason,
    executionKind: input.executionKind ?? "prompt",
  };
}

function commandFromMarkdownFile(provider: AgentProvider, root: string, filePath: string, source: AgentCommandSource): AgentCommandDescriptor | undefined {
  if (!filePath.endsWith(".md")) return undefined;
  const rel = relative(root, filePath).replace(/\\/g, "/").replace(/\.md$/i, "");
  const name = rel.split("/").filter(Boolean).join(":");
  if (!name) return undefined;
  let description: string | undefined;
  try {
    const text = readFileSync(filePath, "utf8");
    description = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("---"))?.slice(0, 160);
  } catch {
    description = undefined;
  }
  return makeCommand({
    provider,
    name,
    description: description || "Custom Claude command",
    source,
    category: source === "project" ? "Project commands" : "User commands",
    argsMode: "raw",
  });
}

function walkMarkdownCommands(provider: AgentProvider, root: string, source: AgentCommandSource): AgentCommandDescriptor[] {
  if (!existsSync(root)) return [];
  const result: AgentCommandDescriptor[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const command = commandFromMarkdownFile(provider, root, path, source);
        if (command) result.push(command);
      }
    }
  };
  walk(root);
  return result;
}

function customClaudeCommands(cwd: string): AgentCommandDescriptor[] {
  const projectCommands = walkMarkdownCommands("claude", join(cwd, ".claude", "commands"), "project");
  const userCommands = walkMarkdownCommands("claude", join(homedir(), ".claude", "commands"), "user");
  return [...projectCommands, ...userCommands];
}

function defaultProviderCommands(provider: AgentProvider, cwd: string, enabled: boolean): AgentCommandDescriptor[] {
  const disabledReason = enabled ? undefined : `${providerLabel(provider)} 未安装或启动失败`;
  if (provider === "codex") {
    return CODEX_COMMAND_NAMES.map((name) => makeCommand({
      provider,
      name,
      source: "linkshell",
      category: name === "plan" || name === "exit-plan" ? "Modes" : "Codex",
      description: {
        "plan": "Enter Codex plan mode",
        "exit-plan": "Exit Codex plan mode",
        compact: "Compact the current thread",
        clear: "Start a fresh Codex thread",
        status: "Show LinkShell agent status",
        review: "Ask Codex to review local changes",
        subagents: "Insert a delegation prompt",
      }[name],
      argsMode: name === "review" || name === "subagents" ? "optional" : "none",
      destructive: name === "clear",
      disabledReason,
      executionKind: name === "review" || name === "subagents" ? "prompt" : "native",
    }));
  }
  if (provider === "claude") {
    const builtIns = CLAUDE_BUILT_IN_COMMANDS
      .filter((entry) => isClaudeRemoteFriendlyCommand(entry.name))
      .map((entry) => makeCommand({
        provider,
        name: entry.name,
        description: entry.description,
        argsMode: entry.argsMode,
        destructive: entry.destructive,
        disabledReason,
        executionKind: "prompt",
      }));
    const custom = customClaudeCommands(cwd).map((command) => ({
      ...command,
      disabledReason: command.disabledReason ?? disabledReason,
    }));
    return [...builtIns, ...custom];
  }
  return [
    makeCommand({
      provider,
      name: "status",
      source: "linkshell",
      category: "LinkShell",
      description: "Show LinkShell agent status",
      argsMode: "none",
      disabledReason,
      executionKind: "native",
    }),
  ];
}

function mergeCommands(...groups: Array<AgentCommandDescriptor[] | undefined>): AgentCommandDescriptor[] {
  const map = new Map<string, AgentCommandDescriptor>();
  for (const group of groups) {
    for (const command of group ?? []) {
      const key = `${command.provider ?? ""}:${command.name}`;
      const existing = map.get(key);
      map.set(key, {
        ...existing,
        ...command,
        disabledReason: command.disabledReason ?? existing?.disabledReason,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function runtimeCommands(provider: AgentProvider, value: unknown): AgentCommandDescriptor[] {
  const raw = asRecord(value);
  const commandsValue =
    Array.isArray(value) ? value :
    Array.isArray(raw?.commands) ? raw.commands :
    Array.isArray(raw?.slashCommands) ? raw.slashCommands :
    Array.isArray(raw?.slash_commands) ? raw.slash_commands :
    Array.isArray(raw?.available_commands) ? raw.available_commands :
    [];
  return commandsValue
    .map((entry) => {
      if (typeof entry === "string") {
        if (provider === "claude" && !isClaudeRemoteFriendlyCommand(entry)) return undefined;
        return makeCommand({
          provider,
          name: entry,
          description: undefined,
          source: "built_in",
          argsMode: "raw",
          executionKind: "prompt",
        });
      }
      const record = asRecord(entry);
      const name = firstString(record, ["name", "command", "id"]);
      if (!name) return undefined;
      if (provider === "claude" && !isClaudeRemoteFriendlyCommand(name)) return undefined;
      return makeCommand({
        provider,
        name,
        description: firstString(record, ["description", "summary"]),
        source: "built_in",
        category: firstString(record, ["category", "group"]),
        argsMode: "raw",
        executionKind: "prompt",
      });
    })
    .filter((entry): entry is AgentCommandDescriptor => Boolean(entry));
}

function parseModelListCapabilities(value: unknown): ProviderRuntimeCapabilities | undefined {
  const raw = asRecord(value);
  const modelsValue =
    Array.isArray(value) ? value :
    Array.isArray(raw?.data) ? raw.data :
    Array.isArray(raw?.models) ? raw.models :
    Array.isArray(raw?.items) ? raw.items :
    Array.isArray(raw?.modelOptions) ? raw.modelOptions :
    [];
  let inferredDefault: string | undefined;
  const efforts = new Set<string>();
  const models = modelsValue
    .map((entry, index) => {
      const model = asRecord(entry);
      if (!model) {
        return typeof entry === "string" && entry
          ? { id: entry, label: entry }
          : undefined;
      }
      if (model.hidden === true) return undefined;
      const modelId = firstString(model, ["id", "model", "name", "value"]) ?? `model-${index + 1}`;
      const label = firstString(model, ["displayName", "label", "title", "name"]) ?? modelId;
      if (model.isDefault === true && !inferredDefault) inferredDefault = modelId;
      const supported = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
      for (const item of supported) {
        const effort = typeof item === "string"
          ? item
          : firstString(asRecord(item), ["reasoningEffort", "id", "value"]);
        if (effort && ALL_REASONING_EFFORTS.includes(effort as typeof ALL_REASONING_EFFORTS[number])) {
          efforts.add(effort);
        }
      }
      return { id: modelId, label };
    })
    .filter((entry): entry is AgentModelOption => Boolean(entry));
  const defaultModel =
    firstString(raw, ["defaultModel", "default_model", "currentModel"]) ??
    firstString(asRecord(raw?.defaults), ["model"]) ??
    inferredDefault;
  const explicitEffortsValue =
    Array.isArray(raw?.reasoningEfforts) ? raw.reasoningEfforts :
    Array.isArray(raw?.reasoning_efforts) ? raw.reasoning_efforts :
    Array.isArray(raw?.efforts) ? raw.efforts :
    undefined;
  if (explicitEffortsValue) {
    for (const item of explicitEffortsValue) {
      if (typeof item === "string" && ALL_REASONING_EFFORTS.includes(item as typeof ALL_REASONING_EFFORTS[number])) {
        efforts.add(item);
      }
    }
  }
  const reasoningEfforts = efforts.size
    ? ALL_REASONING_EFFORTS.filter((effort) => efforts.has(effort))
    : undefined;
  if (models.length === 0 && !defaultModel && !reasoningEfforts?.length) return undefined;
  return {
    ...(models.length > 0 ? { models } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(reasoningEfforts?.length ? { reasoningEfforts } : {}),
  };
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function parseRemoteSessions(value: unknown): Array<{
  id: string;
  cwd?: string;
  title?: string;
  model?: string;
  createdAt?: number;
  lastActivityAt?: number;
}> {
  const raw = asRecord(value);
  const sessionsValue =
    Array.isArray(value) ? value :
    Array.isArray(raw?.data) ? raw.data :
    Array.isArray(raw?.threads) ? raw.threads :
    Array.isArray(raw?.sessions) ? raw.sessions :
    Array.isArray(raw?.items) ? raw.items :
    [];
  const result: Array<{
    id: string;
    cwd?: string;
    title?: string;
    model?: string;
    createdAt?: number;
    lastActivityAt?: number;
  }> = [];
  for (const entry of sessionsValue) {
    const session = asRecord(entry);
    if (!session) {
      if (typeof entry === "string" && entry) result.push({ id: entry });
      continue;
    }
    const nestedThread = asRecord(session.thread);
    const source = nestedThread ?? session;
    const id = firstString(source, ["id", "threadId", "sessionId", "agentSessionId"]);
    if (!id) continue;
    result.push({
      id,
      cwd: firstString(source, ["cwd", "workingDirectory", "workspacePath"]),
      title: firstString(source, ["title", "name", "summary", "preview"]),
      model: firstString(source, ["model", "modelId"]),
      createdAt: parseTimestamp(source.createdAt ?? source.created_at),
      lastActivityAt: parseTimestamp(source.lastActivityAt ?? source.updatedAt ?? source.modifiedAt ?? source.lastModified ?? source.updated_at),
    });
  }
  return result;
}

function threadFromProviderResult(value: unknown): Record<string, unknown> | undefined {
  const raw = asRecord(value);
  return asRecord(raw?.thread) ?? raw;
}

function threadFromTurnsListResult(sessionId: string, value: unknown): Record<string, unknown> | undefined {
  const raw = asRecord(value);
  const order = firstString(raw, ["sortDirection", "order", "sortOrder", "sort"]);
  const turns =
    Array.isArray(raw?.turns) ? raw.turns :
    Array.isArray(raw?.data) ? raw.data :
    Array.isArray(raw?.items) ? raw.items :
    Array.isArray(value) ? value :
    undefined;
  if (!turns) return undefined;
  const extracted = turns
    .map(extractTurn)
    .filter((turn): turn is Record<string, unknown> => Boolean(turn));
  const chronological = order && /asc/i.test(order)
    ? extracted
    : [...extracted].reverse();
  return { id: sessionId, turns: chronological };
}

function turnItemsFromThread(thread: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!thread) return [];
  const turnsValue = Array.isArray(thread.turns)
    ? thread.turns
    : Array.isArray(thread.items)
      ? [{ id: firstString(thread, ["turnId", "id"]), items: thread.items }]
      : [];
  const result: Record<string, unknown>[] = [];
  for (const turnEntry of turnsValue) {
    const turn = extractTurn(turnEntry);
    if (!turn) continue;
    const turnId = firstString(turn, ["id", "turnId"]);
    const createdAt = parseTimestamp(
      turn.createdAt ??
      turn.created_at ??
      turn.startedAt ??
      turn.started_at ??
      turn.completedAt ??
      turn.completed_at ??
      turn.updatedAt ??
      turn.updated_at,
    );
    const itemsRecord = asRecord(turn.items);
    const items = Array.isArray(turn.items)
      ? turn.items
      : Array.isArray(itemsRecord?.data)
        ? itemsRecord.data
        : Array.isArray(itemsRecord?.items)
          ? itemsRecord.items
          : Array.isArray(turn.item)
            ? turn.item
            : Array.isArray(turn.events)
              ? turn.events
              : [];
    for (const itemEntry of items) {
      const item = extractItem(itemEntry);
      if (!item) continue;
      result.push({
        ...item,
        ...(turnId && !firstString(item, ["turnId"]) ? { turnId } : {}),
        __turnCreatedAt: createdAt,
      });
    }
  }
  return result;
}

function activeTurnIdFromThread(thread: Record<string, unknown> | undefined): string | undefined {
  if (!thread) return undefined;
  const turnsValue = Array.isArray(thread.turns)
    ? thread.turns
    : Array.isArray(thread.items)
      ? [{ id: firstString(thread, ["turnId", "id"]), items: thread.items, status: thread.status }]
      : [];
  let activeTurnId: string | undefined;
  for (const turnEntry of turnsValue) {
    const turn = extractTurn(turnEntry);
    if (!turn) continue;
    const turnId = firstString(turn, ["id", "turnId"]);
    if (!turnId) continue;
    const status =
      firstString(turn, ["status", "state", "phase"]) ??
      firstString(asRecord(turn.status), ["status", "state", "phase", "type"]);
    const normalized = normalizedIdentifier(status);
    if ([
      "active",
      "running",
      "inprogress",
      "busy",
      "working",
      "streaming",
      "waitingpermission",
      "waitingforpermission",
      "requirespermission",
      "needspermission",
    ].includes(normalized)) {
      activeTurnId = turnId;
    }
  }
  return activeTurnId;
}

function timelineItemFromProviderItem(
  item: Record<string, unknown>,
  conversationId: string,
  index: number,
): AgentTimelineItem | undefined {
  const itemType = firstString(item, ["type"]);
  const normalized = normalizedIdentifier(itemType);
  const itemId = firstString(item, ["id", "itemId", "messageId", "toolCallId"]) ?? `history-${index + 1}`;
  const createdAt =
    parseTimestamp(item.createdAt ?? item.created_at ?? item.timestamp ?? item.__turnCreatedAt) ??
    Date.now() + index;
  const base = {
    id: itemId,
    conversationId,
    turnId: firstString(item, ["turnId"]),
    itemId,
    createdAt,
    updatedAt: parseTimestamp(item.updatedAt ?? item.updated_at) ?? createdAt,
    isStreaming: false,
  };

  if (
    normalized === "usermessage" ||
    normalized === "userinput" ||
    (normalized === "message" && item.role === "user")
  ) {
    const content = contentBlocksFromItem(item);
    const text = textFromBlocks(content);
    if (!content.length && !text) return undefined;
    return {
      ...base,
      type: "message",
      kind: "chat",
      role: "user",
      content,
      text,
    };
  }

  if (
    normalized === "agentmessage" ||
    normalized === "assistantmessage" ||
    (normalized === "message" && item.role !== "user")
  ) {
    const content = contentBlocksFromItem(item);
    const text = textFromBlocks(content);
    if (!content.length && !text) return undefined;
    return {
      ...base,
      type: "message",
      kind: "chat",
      role: item.role === "system" ? "system" : "assistant",
      content,
      text,
    };
  }

  if (normalized === "reasoning" || normalized === "thinking") {
    const text = firstString(item, ["text", "content", "summary", "message"]) ??
      stringifyDefined(item.contentItems ?? item.summary);
    if (!text) return undefined;
    return {
      ...base,
      type: "status",
      kind: "thinking",
      role: "system",
      text,
    };
  }

  if (normalized === "enteredreviewmode" || normalized === "exitedreviewmode") {
    const text = firstString(item, ["review", "text", "content", "summary", "message"]);
    return {
      ...base,
      type: "status",
      kind: "review",
      role: "system",
      text: text ?? (normalized === "enteredreviewmode" ? "正在审查" : "审查已完成"),
    };
  }

  if (normalized === "contextcompaction") {
    return {
      ...base,
      type: "status",
      kind: "context_compaction",
      role: "system",
      text: firstString(item, ["text", "summary", "message"]) ?? "上下文已压缩",
    };
  }

  if (isSubagentItemType(itemType)) {
    const subagent = decodeSubagentAction(item, normalizeToolStatus(item.status, true));
    if (!subagent) return undefined;
    return {
      ...base,
      type: "status",
      kind: "subagent_action",
      role: "system",
      text: summarizeSubagentAction(subagent),
      subagent,
    };
  }

  if (isToolItemType(itemType) || toolNameFromItem(item)) {
    const toolId = firstString(item, ["id", "itemId", "toolCallId"]) ?? itemId;
    const toolCall: AgentToolCall = {
      id: toolId,
      name: toolNameFromItem(item) ?? "工具",
      input: toolInputFromItem(item),
      output:
        normalized === "filechange" || normalized === "diff"
          ? extractDiffText(item) ?? firstString(item, ["output", "summary"])
          : firstString(item, ["aggregatedOutput", "output", "stdout", "stderr"]) ??
            stringifyDefined(item.result ?? item.error ?? item.contentItems),
      createdAt,
      status: normalizeToolStatus(item.status, true),
    };
    const kind: AgentTimelineKind = toolCall.name.includes("文件") || normalized === "filechange" || normalized === "diff"
      ? "file_change"
      : toolCall.name.includes("命令") || normalized === "commandexecution"
        ? "command_execution"
        : "tool_activity";
    return {
      ...base,
      id: `tool:${toolId}`,
      type: "tool_call",
      kind,
      itemId: toolId,
      toolCall,
      commandExecution: kind === "command_execution" ? commandExecutionFromTool(toolCall) : undefined,
      fileChange: kind === "file_change" ? fileChangeFromTool(toolCall) : undefined,
    };
  }

  return undefined;
}

function timelineItemsFromProviderThread(
  value: unknown,
  conversationId: string,
): AgentTimelineItem[] {
  const items = turnItemsFromThread(threadFromProviderResult(value))
    .map((item, index) => timelineItemFromProviderItem(item, conversationId, index))
    .filter((item): item is AgentTimelineItem => Boolean(item));
  const byId = new Map<string, AgentTimelineItem>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_TIMELINE_ITEMS);
}

function previewFromTimelineItem(item: AgentTimelineItem): string | undefined {
  if (item.error) return item.error;
  if (item.text) return item.text;
  if (item.content?.length) return textFromBlocks(item.content);
  if (item.toolCall) return `${item.toolCall.name} · ${item.toolCall.status}`;
  if (item.permission) return `需要授权 ${item.permission.toolName ?? ""}`.trim();
  if (item.subagent) return summarizeSubagentAction(item.subagent);
  return undefined;
}

export class AgentWorkspaceProxy {
  private clients = new Map<AgentProvider, AcpClient | ClaudeSdkClient | ClaudeStreamJsonClient>();
  private agentProtocols = new Map<AgentProvider, AgentProtocol>();
  private providerCapabilities = new Map<AgentProvider, ProviderRuntimeCapabilities>();
  private providerErrors = new Map<AgentProvider, string>();
  private initialized = false;
  private status: AgentStatus = "unavailable";
  private error: string | undefined;
  private activeConversationId: string | undefined;
  private currentTurnIds = new Map<string, string>();
  private turnConversationIds = new Map<string, string>();
  private conversations = new Map<string, AgentConversation>();
  private conversationByAgentSessionId = new Map<string, string>();
  private timelines = new Map<string, AgentTimelineItem[]>();
  // Conversations the user "deleted" (forgot). We never touch the agent's
  // on-disk transcript, so syncProviderSessions would otherwise re-list and
  // resurrect them. Tombstone by agentSessionId (the stable provider key) so a
  // forgotten conversation stays gone for the life of this workspace process.
  private deletedAgentSessionIds = new Set<string>();
  // Opaque codex turns cursor per conversation, pointing at OLDER history to
  // page through (captured at hydration, advanced on each history.request).
  private historyCursors = new Map<string, string | undefined>();
  private toolOutputBuffers = new Map<string, string>();
  private pendingPermissions = new Map<string, AgentPermission>();
  private permissionWaiters = new Map<string, PendingPermissionWaiter>();
  private permissionSources = new Map<string, string>();
  private pendingStructuredInputs = new Map<string, { conversationId: string; input: AgentStructuredInput }>();
  private structuredInputWaiters = new Map<string, PendingStructuredInputWaiter>();
  private itemConversationIds = new Map<string, string>();
  private toolConversationIds = new Map<string, string>();

  constructor(
    private readonly input: {
      sessionId: string;
      cwd: string;
      availableProviders: AgentProvider[];
      command?: string;
      send: (envelope: Envelope) => void;
      verbose?: boolean;
    },
  ) {}

  async handleEnvelope(envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case "agent.v2.capabilities.request":
        await this.initialize();
        this.sendCapabilities();
        break;
      case "agent.v2.conversation.open": {
        const payload = parseTypedPayload("agent.v2.conversation.open", envelope.payload);
        await this.openConversation(payload);
        break;
      }
      case "agent.v2.conversation.update": {
        const payload = parseTypedPayload("agent.v2.conversation.update", envelope.payload);
        const conversation = this.conversations.get(payload.conversationId);
        if (!conversation) break;
        if (payload.title !== undefined) {
          const trimmed = payload.title.trim();
          conversation.title = trimmed === "" ? undefined : trimmed;
        }
        if (payload.archived !== undefined) conversation.archived = payload.archived;
        conversation.lastActivityAt = Date.now();
        // Echo the updated record so every client refreshes (the web store
        // force-replaces by id on any event carrying `conversation`).
        this.emitConversation(conversation);
        break;
      }
      case "agent.v2.conversation.delete": {
        const payload = parseTypedPayload("agent.v2.conversation.delete", envelope.payload);
        const conversation = this.conversations.get(payload.conversationId);
        // Forget the conversation from the workspace's tracked set. We do NOT
        // delete the provider's on-disk transcript — only stop tracking it and
        // tombstone its session id so syncProviderSessions won't re-add it.
        if (conversation?.agentSessionId) {
          this.deletedAgentSessionIds.add(conversation.agentSessionId);
          this.conversationByAgentSessionId.delete(conversation.agentSessionId);
        }
        this.conversations.delete(payload.conversationId);
        this.timelines.delete(payload.conversationId);
        this.historyCursors.delete(payload.conversationId);
        this.input.send(createEnvelope({
          type: "agent.v2.conversation.deleted",
          sessionId: this.input.sessionId,
          payload: { conversationId: payload.conversationId },
        }));
        break;
      }
      case "agent.v2.conversation.list": {
        const payload = parseTypedPayload("agent.v2.conversation.list", envelope.payload);
        await this.syncProviderSessions();
        const conversations = [...this.conversations.values()].filter((conversation) =>
          payload.includeArchived ? true : !conversation.archived,
        );
        this.input.send(createEnvelope({
          type: "agent.v2.conversation.list.result",
          sessionId: this.input.sessionId,
          payload: { conversations },
        }));
        break;
      }
      case "agent.v2.snapshot.request": {
        const payload = parseTypedPayload("agent.v2.snapshot.request", envelope.payload);
        await this.syncProviderSessions();
        this.sendSnapshot(payload.conversationId);
        break;
      }
      case "agent.v2.history.request": {
        const payload = parseTypedPayload("agent.v2.history.request", envelope.payload);
        await this.loadOlderHistory(payload);
        break;
      }
      case "agent.v2.prompt": {
        const payload = parseTypedPayload("agent.v2.prompt", envelope.payload);
        await this.sendPrompt(payload);
        break;
      }
      case "agent.v2.command.execute": {
        const payload = parseTypedPayload("agent.v2.command.execute", envelope.payload);
        await this.executeCommand(payload);
        break;
      }
      case "agent.v2.cancel": {
        const payload = parseTypedPayload("agent.v2.cancel", envelope.payload);
        const conversation = this.conversations.get(payload.conversationId);
        if (!conversation) break;
        const turnId = this.currentTurnIds.get(payload.conversationId);
        if (this.protocolForProvider(conversation.provider) === "codex-app-server" && !turnId) {
          this.rejectAgentAction(
            conversation,
            "无法停止 Codex：当前运行 turn 尚未同步，请重新打开对话后再试。",
            conversation.status,
          );
          break;
        }
        this.cancelPendingPermissions(payload.conversationId);
        const cancelClient = this.clientForProvider(conversation.provider);
        cancelClient?.cancel({
          sessionId: conversation.agentSessionId,
          turnId,
        });
        this.forgetCurrentTurn(payload.conversationId);
        this.updateConversationStatus(payload.conversationId, "idle");
        this.emitStatus(payload.conversationId, "idle", "已停止");
        break;
      }
      case "agent.v2.permission.respond": {
        const payload = parseTypedPayload("agent.v2.permission.respond", envelope.payload);
        this.respondPermission(payload);
        break;
      }
      case "agent.v2.structured_input.respond": {
        const payload = parseTypedPayload("agent.v2.structured_input.respond", envelope.payload);
        this.respondStructuredInput(payload);
        break;
      }
    }
  }

  stop(): void {
    for (const client of this.clients.values()) {
      client.stop();
    }
    this.clients.clear();
  }

  private clientForProvider(provider: AgentProvider): AcpClient | ClaudeSdkClient | ClaudeStreamJsonClient | undefined {
    return this.clients.get(provider);
  }

  private shouldRecycleProviderClient(provider: AgentProvider, error: unknown): boolean {
    if (provider !== "codex") return false;
    const message = error instanceof Error ? error.message : String(error);
    return /ACP agent is not running|ACP request timed out|Transport channel closed|TokenRefreshFailed|Failed to parse server response|channel closed|EPIPE|ECONNRESET/i.test(message);
  }

  private async recycleProviderClient(
    provider: AgentProvider,
    error: unknown,
  ): Promise<AcpClient | ClaudeSdkClient | ClaudeStreamJsonClient | undefined> {
    if (!this.shouldRecycleProviderClient(provider, error)) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    const existing = this.clients.get(provider);
    if (existing) {
      try { existing.stop(); } catch {}
    }
    this.clients.delete(provider);
    this.agentProtocols.delete(provider);
    this.providerErrors.set(provider, message);
    return this.ensureProviderClient(provider);
  }

  private protocolForProvider(provider: AgentProvider): AgentProtocol | undefined {
    return this.agentProtocols.get(provider);
  }

  private defaultModelForProvider(provider: AgentProvider): string | undefined {
    const capabilities = this.providerCapabilities.get(provider);
    const defaultModel = capabilities?.defaultModel?.trim();
    if (defaultModel) return defaultModel;
    return capabilities?.models?.find((model) => model.id && model.id !== "default")?.id;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    // Eagerly start all detected providers so capabilities report real status
    const startPromises = this.input.availableProviders.map((p) => this.ensureProviderClient(p));
    await Promise.allSettled(startPromises);
    this.status = "idle";
    this.error = undefined;
    this.sendCapabilities();
  }

  private async ensureProviderClient(provider: AgentProvider): Promise<AcpClient | ClaudeSdkClient | ClaudeStreamJsonClient | undefined> {
    const existing = this.clients.get(provider);
    if (existing) return existing;

    const resolved = resolveAgentCommand({
      provider,
      command: this.input.command,
    });
    if (!resolved) {
      if (this.input.verbose) {
        process.stderr.write(`[agent:v2] no command for provider ${provider}\n`);
      }
      return undefined;
    }

    const tryCreateClient = async (config: typeof resolved): Promise<AcpClient | ClaudeSdkClient | ClaudeStreamJsonClient> => {
      this.agentProtocols.set(provider, config.protocol);
      const isClaudeSdk = config.protocol === "claude-agent-sdk";
      const isClaudeStreamJson = config.protocol === "claude-stream-json";
      const client = isClaudeSdk
        ? new ClaudeSdkClient({
            command: config.command,
            protocol: config.protocol,
            framing: config.framing,
            cwd: this.input.cwd,
            onNotification: (method, params) => this.handleNotification(method, params),
            onRequest: (method, params) => this.handleRequest(method, params),
            onExit: (message) => this.handleProviderExit(provider, message),
          })
        : isClaudeStreamJson
        ? new ClaudeStreamJsonClient({
            command: config.command,
            protocol: config.protocol,
            framing: config.framing,
            cwd: this.input.cwd,
            onNotification: (method, params) => this.handleNotification(method, params),
            onRequest: (method, params) => this.handleRequest(method, params),
            onExit: (message) => this.handleProviderExit(provider, message),
          })
        : new AcpClient({
            command: config.command,
            protocol: config.protocol,
            framing: config.framing,
            cwd: this.input.cwd,
            onNotification: (method, params) => this.handleNotification(method, params),
            onRequest: (method, params) => this.handleRequest(method, params),
            onExit: (message) => this.handleProviderExit(provider, message),
      });
      await client.initialize();
      return client;
    };

    try {
      const client = await tryCreateClient(resolved);
      this.clients.set(provider, client);
      this.providerErrors.delete(provider);
      await this.refreshProviderCapabilities(provider, client, resolved.protocol);
      this.status = "idle";
      this.error = undefined;
      this.sendCapabilities();
      return client;
    } catch (error) {
      if (provider === "claude" && resolved.protocol === "claude-agent-sdk") {
        if (this.input.verbose) {
          process.stderr.write(`[agent:v2] Claude SDK failed, falling back to stream-json: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        try {
          const fallback = {
            provider,
            command: "claude --print --output-format stream-json --input-format stream-json --verbose --permission-mode bypassPermissions",
            protocol: "claude-stream-json" as const,
            framing: "newline" as const,
          };
          const client = await tryCreateClient(fallback);
          this.clients.set(provider, client);
          this.providerErrors.delete(provider);
          await this.refreshProviderCapabilities(provider, client, fallback.protocol);
          this.status = "idle";
          this.error = undefined;
          this.sendCapabilities();
          return client;
        } catch (fallbackError) {
          if (this.input.verbose) {
            process.stderr.write(`[agent:v2] Claude stream-json fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n`);
          }
        }
      }
      if (this.input.verbose) {
        process.stderr.write(`[agent:v2] failed to start ${provider}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      this.providerErrors.set(provider, error instanceof Error ? error.message : String(error));
      this.sendCapabilities();
      return undefined;
    }
  }

  private async refreshProviderCapabilities(
    provider: AgentProvider,
    client: AcpClient | ClaudeSdkClient | ClaudeStreamJsonClient,
    protocol: AgentProtocol,
  ): Promise<void> {
    if (client instanceof AcpClient && protocol !== "codex-app-server") return;
    const listModels = (client as { listModels?: () => Promise<unknown> }).listModels;
    let runtimeCapabilities: ProviderRuntimeCapabilities | undefined;
    if (typeof listModels === "function") {
      try {
        const result = await listModels.call(client);
        runtimeCapabilities = parseModelListCapabilities(result);
      } catch (error) {
        if (this.input.verbose) {
          process.stderr.write(`[agent:v2] model/list failed for ${provider}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
    if (provider === "codex") {
      // Codex `model/list` is unreliable across versions — make sure mobile always
      // sees a usable model picker by merging in a static fallback list.
      const merged: ProviderRuntimeCapabilities = {
        models: runtimeCapabilities?.models?.length
          ? runtimeCapabilities.models
          : [...CODEX_FALLBACK_MODELS],
        defaultModel: runtimeCapabilities?.defaultModel ?? CODEX_FALLBACK_DEFAULT_MODEL,
        reasoningEfforts: runtimeCapabilities?.reasoningEfforts?.length
          ? runtimeCapabilities.reasoningEfforts
          : [...ALL_REASONING_EFFORTS],
        commands: runtimeCapabilities?.commands,
        modes: runtimeCapabilities?.modes,
        currentMode: runtimeCapabilities?.currentMode,
      };
      this.providerCapabilities.set(provider, merged);
      return;
    }
    if (runtimeCapabilities) this.providerCapabilities.set(provider, runtimeCapabilities);
  }

  private async syncProviderSessions(): Promise<void> {
    await this.initialize();
    for (const [provider, client] of this.clients) {
      try {
        let activeClient = client;
        let result: unknown;
        try {
          result = await activeClient.listSessions();
        } catch (error) {
          const recovered = await this.recycleProviderClient(provider, error);
          if (!recovered) throw error;
          activeClient = recovered;
          result = await activeClient.listSessions();
        }
        for (const remote of parseRemoteSessions(result)) {
          const agentSessionId = remote.id;
          // Skip conversations the user explicitly forgot — don't resurrect them.
          if (this.deletedAgentSessionIds.has(agentSessionId)) continue;
          const existingId = this.conversationByAgentSessionId.get(agentSessionId);
          const now = Date.now();
          const conversationId = existingId ?? makeAgentV2RemoteConversationId(provider, agentSessionId);
          const existing = this.conversations.get(conversationId);
          const cwd = remote.cwd ?? existing?.cwd ?? this.input.cwd;
          const conversation: AgentConversation = {
            id: conversationId,
            agentSessionId,
            provider,
            cwd,
            title: remote.title ?? existing?.title ?? titleFromCwd(cwd),
            model: remote.model ?? existing?.model,
            reasoningEffort: existing?.reasoningEffort,
            permissionMode: existing?.permissionMode,
            collaborationMode: existing?.collaborationMode,
            status: existing?.status ?? "idle",
            archived: existing?.archived ?? false,
            lastMessagePreview: existing?.lastMessagePreview,
            lastActivityAt: remote.lastActivityAt ?? existing?.lastActivityAt ?? now,
            createdAt: remote.createdAt ?? existing?.createdAt ?? now,
          };
          this.conversations.set(conversation.id, conversation);
          this.conversationByAgentSessionId.set(agentSessionId, conversation.id);
          this.timelines.set(conversation.id, this.timelines.get(conversation.id) ?? []);
        }
      } catch (error) {
        if (this.input.verbose) {
          process.stderr.write(`[agent:v2] session list failed for ${provider}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
  }

  private async hydrateConversationFromProvider(
    conversation: AgentConversation,
    seedResult?: unknown,
  ): Promise<void> {
    let client = this.clientForProvider(conversation.provider);
    if (!client || !conversation.agentSessionId) return;
    let source = seedResult;
    const hasSeedTurns = turnItemsFromThread(threadFromProviderResult(seedResult)).length > 0;
    if (!hasSeedTurns) {
      const readSession = (client as { readSession?: (input: { sessionId: string; includeTurns?: boolean }) => Promise<unknown> }).readSession;
      if (typeof readSession === "function") {
        try {
          source = await readSession.call(client, {
            sessionId: conversation.agentSessionId,
            includeTurns: true,
          });
        } catch (error) {
          const recovered = await this.recycleProviderClient(conversation.provider, error);
          if (recovered) client = recovered;
          if (this.input.verbose) {
            process.stderr.write(`[agent:v2] thread/read hydration failed for ${conversation.provider}: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
      }
      if (turnItemsFromThread(threadFromProviderResult(source)).length === 0) {
        const listTurns = (client as { listTurns?: (input: {
          sessionId: string;
          limit?: number;
          cursor?: string;
          sortDirection?: "asc" | "desc";
          itemsView?: "summary" | "full";
        }) => Promise<unknown> }).listTurns;
        if (typeof listTurns === "function") {
          try {
            let turnsResult: unknown;
            try {
              turnsResult = await listTurns.call(client, {
                sessionId: conversation.agentSessionId,
                limit: MAX_TIMELINE_ITEMS,
                sortDirection: "desc",
                itemsView: "full",
              });
            } catch (error) {
              const recovered = await this.recycleProviderClient(conversation.provider, error);
              if (!recovered) throw error;
              client = recovered;
              const recoveredListTurns = (client as { listTurns?: typeof listTurns }).listTurns;
              if (typeof recoveredListTurns !== "function") throw error;
              turnsResult = await recoveredListTurns.call(client, {
                sessionId: conversation.agentSessionId,
                limit: MAX_TIMELINE_ITEMS,
                sortDirection: "desc",
                itemsView: "full",
              });
            }
            const turnsThread = threadFromTurnsListResult(conversation.agentSessionId, turnsResult);
            if (turnsThread) source = { thread: turnsThread };
            // Capture the opaque cursor pointing at OLDER turns so the client
            // can page further back via agent.v2.history.request.
            const olderCursor = firstString(asRecord(turnsResult), ["nextCursor", "next_cursor", "cursor"]);
            this.historyCursors.set(conversation.id, olderCursor);
          } catch (error) {
            if (this.input.verbose) {
              process.stderr.write(`[agent:v2] thread/turns/list hydration failed for ${conversation.provider}: ${error instanceof Error ? error.message : String(error)}\n`);
            }
          }
        }
      }
    }

    const thread = threadFromProviderResult(source);
    const activeTurnId = activeTurnIdFromThread(thread);
    if (activeTurnId) this.rememberTurnConversationId(conversation.id, activeTurnId);
    const model = firstString(thread, ["model", "modelId", "currentModel"]);
    if (model && !conversation.model) conversation.model = model;

    const hydratedItems = timelineItemsFromProviderThread(source, conversation.id);
    if (hydratedItems.length === 0) return;
    const existing = this.timelines.get(conversation.id) ?? [];
    const merged = new Map<string, AgentTimelineItem>();
    for (const item of [...existing, ...hydratedItems]) {
      merged.set(item.id, item);
    }
    const nextItems = [...merged.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-MAX_TIMELINE_ITEMS);
    this.timelines.set(conversation.id, nextItems);
    for (const item of nextItems) {
      this.rememberItemConversationId(conversation.id, item);
    }
    const lastPreview = [...nextItems].reverse()
      .map((item) => previewText(previewFromTimelineItem(item) ?? ""))
      .find(Boolean);
    if (lastPreview && !conversation.lastMessagePreview) {
      conversation.lastMessagePreview = lastPreview;
    }
  }

  private sendCapabilities(): void {
    const providers = this.input.availableProviders.map((provider) => {
      const client = this.clients.get(provider);
      const protocol = this.agentProtocols.get(provider);
      const runtimeCapabilities = this.providerCapabilities.get(provider);
      const enabled = Boolean(client);
      const supportsImages = enabled && protocolSupportsImages(protocol);
      const isClaudeFallback = protocol === "claude-stream-json";
      const supportsPermission = enabled && !isClaudeFallback;
      const supportsReasoningEffort = enabled && !isClaudeFallback;
      const commands = mergeCommands(
        defaultProviderCommands(provider, this.input.cwd, enabled),
        runtimeCapabilities?.commands,
      );
      const currentMode = [...this.conversations.values()].find((conversation) => conversation.provider === provider)?.collaborationMode;
      return {
        id: provider,
        label: providerLabel(provider),
        enabled,
        reason: enabled ? undefined : this.providerErrors.get(provider) ?? `${providerLabel(provider)} 未安装或启动失败`,
        supportsImages,
        supportsPermission,
        supportsPlan: enabled,
        supportsCancel: enabled,
        models: runtimeCapabilities?.models ?? [{ id: "default", label: "默认模型" }],
        defaultModel: runtimeCapabilities?.defaultModel ?? "default",
        reasoningEfforts: supportsReasoningEffort
          ? runtimeCapabilities?.reasoningEfforts ?? [...ALL_REASONING_EFFORTS]
          : [],
        permissionModes: supportsPermission ? [...ALL_PERMISSION_MODES] : [],
        commands,
        modes: runtimeCapabilities?.modes ?? (provider === "codex" ? [
          { id: "default", title: "Default", description: "Run normal implementation turns" },
          { id: "plan", title: "Plan", description: "Discuss and produce an implementation plan first" },
        ] : []),
        currentMode,
        features: {
          images: supportsImages,
          permissions: supportsPermission,
          plan: enabled,
          cancel: enabled,
          reasoningEffort: supportsReasoningEffort,
          streamJsonFallback: isClaudeFallback,
        },
      };
    });
    const anyEnabled = providers.some((p) => p.enabled);
    const anyPermission = providers.some((p) => p.supportsPermission);
    this.input.send(createEnvelope({
      type: "agent.v2.capabilities",
      sessionId: this.input.sessionId,
      payload: {
        enabled: anyEnabled,
        provider: this.input.availableProviders[0] ?? "codex",
        providers,
        protocolVersion: 1,
        workspaceProtocolVersion: 2,
        error: anyEnabled ? undefined : "没有可用的 Agent provider。请安装 Claude Code 或 Codex CLI。",
        supportsSessionList: anyEnabled,
        supportsSessionLoad: anyEnabled,
        supportsImages: providers.some((p) => p.supportsImages),
        supportsAudio: false,
        supportsPermission: anyPermission,
        supportsPlan: anyEnabled,
        supportsCancel: anyEnabled,
      },
    }));
  }

  private async openConversation(payload: {
    conversationId?: string;
    agentSessionId?: string;
    cwd?: string;
    provider?: AgentProvider;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: AgentPermissionMode;
    collaborationMode?: AgentCollaborationMode;
    title?: string;
  }): Promise<AgentConversation | undefined> {
    const provider = payload.provider ?? this.input.availableProviders[0];
    if (!provider) {
      return this.openFailure(payload, "没有可用的 Agent provider。");
    }
    if (!this.input.availableProviders.includes(provider)) {
      return this.openFailure(
        payload,
        `${providerLabel(provider)} 未安装或不可用。`,
      );
    }

    let cwd = payload.cwd ?? this.input.cwd;
    let agentSessionId = payload.agentSessionId;
    let existingConversation =
      (payload.conversationId ? this.conversations.get(payload.conversationId) : undefined) ??
      (agentSessionId ? this.conversations.get(this.conversationByAgentSessionId.get(agentSessionId) ?? "") : undefined);
    if (!payload.cwd && existingConversation?.cwd) cwd = existingConversation.cwd;

    let client = await this.ensureProviderClient(provider);
    if (!client) {
      const message = this.providerErrors.get(provider) ?? `${providerLabel(provider)} 启动失败。请确认 CLI 已安装并可用。`;
      if (existingConversation) {
        this.activeConversationId = existingConversation.id;
        this.input.send(createEnvelope({
          type: "agent.v2.conversation.opened",
          sessionId: this.input.sessionId,
          payload: {
            conversation: existingConversation,
            snapshot: this.timelines.get(existingConversation.id) ?? [],
            requestedConversationId: payload.conversationId,
            providerError: message,
          },
        }));
        this.sendCapabilities();
        return existingConversation;
      }
      if (payload.conversationId) {
        return this.openOfflineHistory(payload, message, cwd);
      }
      return this.openFailure(payload, message, cwd);
    }

    if (existingConversation && existingConversation.status !== "error" && existingConversation.agentSessionId) {
      const requestedCanonicalId = makeAgentV2RemoteConversationId(provider, existingConversation.agentSessionId);
      if (
        payload.conversationId &&
        payload.conversationId === requestedCanonicalId &&
        existingConversation.id !== payload.conversationId
      ) {
        existingConversation = this.adoptConversationId(existingConversation.id, payload.conversationId);
      }
      if ((this.timelines.get(existingConversation.id) ?? []).length === 0 && existingConversation.status !== "running") {
        try {
          const existingAgentSessionId = existingConversation.agentSessionId!;
          let result: unknown;
          try {
            result = await client.loadSession({ sessionId: existingAgentSessionId, cwd });
          } catch (error) {
            const recovered = await this.recycleProviderClient(provider, error);
            if (!recovered) throw error;
            client = recovered;
            result = await client.loadSession({ sessionId: existingAgentSessionId, cwd });
          }
          const nextAgentSessionId = this.extractSessionId(result);
          if (nextAgentSessionId && nextAgentSessionId !== existingAgentSessionId) {
            this.conversationByAgentSessionId.delete(existingAgentSessionId);
            existingConversation.agentSessionId = nextAgentSessionId;
            this.conversationByAgentSessionId.set(nextAgentSessionId, existingConversation.id);
          }
          await this.hydrateConversationFromProvider(existingConversation, result);
        } catch (error) {
          if (this.input.verbose) {
            process.stderr.write(`[agent:v2] resume failed for ${provider}: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
      }
      this.activeConversationId = existingConversation.id;
      this.input.send(createEnvelope({
        type: "agent.v2.conversation.opened",
        sessionId: this.input.sessionId,
        payload: {
          conversation: existingConversation,
          snapshot: this.timelines.get(existingConversation.id) ?? [],
          requestedConversationId: payload.conversationId,
        },
      }));
      return existingConversation;
    }

    try {
      let result: unknown;
      try {
        result = agentSessionId
          ? await client.loadSession({ sessionId: agentSessionId, cwd })
          : await client.newSession({ cwd });
      } catch (error) {
        const recovered = await this.recycleProviderClient(provider, error);
        if (!recovered) throw error;
        client = recovered;
        result = agentSessionId
          ? await client.loadSession({ sessionId: agentSessionId, cwd })
          : await client.newSession({ cwd });
      }
      agentSessionId = this.extractSessionId(result) ?? agentSessionId ?? id("agent-session");
      const now = Date.now();
      const conversationId = makeAgentV2RemoteConversationId(provider, agentSessionId);
      const conversation: AgentConversation = {
        ...existingConversation,
        id: conversationId,
        agentSessionId,
        provider,
        cwd,
        title: payload.title ?? existingConversation?.title ?? titleFromCwd(cwd),
        model: payload.model ?? existingConversation?.model,
        reasoningEffort: payload.reasoningEffort ?? existingConversation?.reasoningEffort,
        permissionMode: payload.permissionMode ?? existingConversation?.permissionMode,
        collaborationMode: payload.collaborationMode ?? existingConversation?.collaborationMode,
        status: "idle",
        archived: existingConversation?.archived ?? false,
        lastMessagePreview: existingConversation?.status === "error" ? undefined : existingConversation?.lastMessagePreview,
        lastActivityAt: now,
        createdAt: existingConversation?.createdAt ?? now,
      };
      this.conversations.set(conversation.id, conversation);
      this.conversationByAgentSessionId.set(agentSessionId, conversation.id);
      this.activeConversationId = conversation.id;
      this.timelines.set(conversation.id, this.timelines.get(conversation.id) ?? []);
      await this.hydrateConversationFromProvider(conversation, result);
      this.input.send(createEnvelope({
        type: "agent.v2.conversation.opened",
        sessionId: this.input.sessionId,
        payload: {
          conversation,
          snapshot: this.timelines.get(conversation.id) ?? [],
          requestedConversationId: payload.conversationId,
        },
      }));
      return conversation;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.openFailure(payload, message, cwd);
    }
  }

  private openFailure(
    payload: {
      conversationId?: string;
      cwd?: string;
      provider?: AgentProvider;
      model?: string;
      reasoningEffort?: string;
      permissionMode?: AgentPermissionMode;
      collaborationMode?: AgentCollaborationMode;
      title?: string;
    },
    message: string,
    cwd = payload.cwd ?? this.input.cwd,
  ): AgentConversation {
    const fallbackId = payload.conversationId ?? id("agent-conversation");
    const now = Date.now();
    const conversation: AgentConversation = {
      id: fallbackId,
      provider: payload.provider ?? this.input.availableProviders[0] ?? "codex",
      cwd,
      title: payload.title ?? titleFromCwd(cwd),
      model: payload.model,
      reasoningEffort: payload.reasoningEffort,
      permissionMode: payload.permissionMode,
      collaborationMode: payload.collaborationMode,
      status: "error",
      archived: false,
      lastMessagePreview: message,
      lastActivityAt: now,
      createdAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    this.activeConversationId = conversation.id;
    this.addItem(conversation.id, {
      id: id("error"),
      conversationId: conversation.id,
      type: "error",
      error: message,
      createdAt: now,
    });
    this.input.send(createEnvelope({
      type: "agent.v2.conversation.opened",
      sessionId: this.input.sessionId,
      payload: {
        conversation,
        snapshot: this.timelines.get(conversation.id) ?? [],
        requestedConversationId: payload.conversationId,
      },
    }));
    return conversation;
  }

  private openOfflineHistory(
    payload: {
      conversationId?: string;
      agentSessionId?: string;
      cwd?: string;
      provider?: AgentProvider;
      model?: string;
      reasoningEffort?: string;
      permissionMode?: AgentPermissionMode;
      collaborationMode?: AgentCollaborationMode;
      title?: string;
    },
    message: string,
    cwd = payload.cwd ?? this.input.cwd,
  ): AgentConversation {
    const now = Date.now();
    const conversation: AgentConversation = {
      id: payload.conversationId!,
      agentSessionId: payload.agentSessionId,
      provider: payload.provider ?? this.input.availableProviders[0] ?? "codex",
      cwd,
      title: payload.title ?? titleFromCwd(cwd),
      model: payload.model,
      reasoningEffort: payload.reasoningEffort,
      permissionMode: payload.permissionMode,
      collaborationMode: payload.collaborationMode,
      status: "idle",
      archived: false,
      lastActivityAt: now,
      createdAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    if (conversation.agentSessionId) {
      this.conversationByAgentSessionId.set(conversation.agentSessionId, conversation.id);
    }
    this.activeConversationId = conversation.id;
    this.input.send(createEnvelope({
      type: "agent.v2.conversation.opened",
      sessionId: this.input.sessionId,
      payload: {
        conversation,
        snapshot: this.timelines.get(conversation.id) ?? [],
        requestedConversationId: payload.conversationId,
        providerError: message,
      },
    }));
    this.sendCapabilities();
    return conversation;
  }

  private async sendPrompt(payload: {
    conversationId: string;
    clientMessageId: string;
    contentBlocks: AgentContentBlock[];
    delivery?: "auto" | "new_turn" | "steer";
    targetTurnId?: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: AgentPermissionMode;
    collaborationMode?: AgentCollaborationMode;
  }): Promise<void> {
    const conversation =
      this.conversations.get(payload.conversationId) ??
      await this.openConversation({ conversationId: payload.conversationId });
    if (!conversation) return;
    if (!conversation.agentSessionId) {
      this.rejectAgentAction(
        conversation,
        "Agent session 尚未就绪，消息没有发送。请重新打开对话后再试。",
      );
      return;
    }
    const client = this.clientForProvider(conversation.provider) ?? await this.ensureProviderClient(conversation.provider);
    if (!client) {
      this.rejectAgentAction(
        conversation,
        this.providerErrors.get(conversation.provider) ?? `${providerLabel(conversation.provider)} 未连接，消息没有发送。`,
        "error",
      );
      return;
    }

    const protocol = this.protocolForProvider(conversation.provider);
    if (payload.contentBlocks.some((block) => block.type === "image") && !protocolSupportsImages(protocol)) {
      this.rejectAgentAction(
        conversation,
        "当前 Agent provider 暂不支持图片输入，请升级 CLI 或切换到 Codex。",
      );
      return;
    }

    const priorSettings = {
      model: conversation.model,
      reasoningEffort: conversation.reasoningEffort,
      permissionMode: conversation.permissionMode,
    };
    const effectiveModel = payload.model ??
      conversation.model ??
      (protocol === "codex-app-server" ? this.defaultModelForProvider(conversation.provider) : undefined);
    const wasRunning = conversation.status === "running";
    const activeTurnId = payload.targetTurnId ?? this.currentTurnIds.get(conversation.id);
    const shouldSteer = Boolean(
      payload.delivery !== "new_turn" &&
      wasRunning &&
      protocol === "codex-app-server" &&
      activeTurnId,
    );
    if (wasRunning && payload.delivery !== "new_turn" && protocol !== "codex-app-server") {
      this.addItem(conversation.id, {
        id: id("error"),
        conversationId: conversation.id,
        type: "error",
        error: `${providerLabel(conversation.provider)} 当前不支持运行中追加输入。请等待本轮结束，或先停止后再发送。`,
        createdAt: Date.now(),
      });
      return;
    }
    if (payload.delivery === "steer" && protocol === "codex-app-server" && !activeTurnId) {
      this.rejectAgentAction(
        conversation,
        "当前没有可追加输入的 Codex turn。请等待本轮开始后重试，或作为新消息发送。",
      );
      return;
    }
    conversation.model = effectiveModel ?? conversation.model;
    conversation.reasoningEffort = payload.reasoningEffort ?? conversation.reasoningEffort;
    conversation.permissionMode = payload.permissionMode ?? conversation.permissionMode;
    conversation.collaborationMode = payload.collaborationMode ?? conversation.collaborationMode;
    conversation.status = "running";
    conversation.lastActivityAt = Date.now();
    this.activeConversationId = conversation.id;

    if (effectiveModel && effectiveModel !== priorSettings.model) {
      const runtimeCapabilities = this.providerCapabilities.get(conversation.provider);
      const label = runtimeCapabilities?.models?.find((m) => m.id === effectiveModel)?.label ?? effectiveModel;
      this.emitNotice({
        conversationId: conversation.id,
        kind: "model_changed",
        title: `已切换模型 · ${label}`,
        detail: `${providerLabel(conversation.provider)} 下次回复将使用 ${effectiveModel}`,
      });
    }
    if (payload.reasoningEffort && payload.reasoningEffort !== priorSettings.reasoningEffort) {
      this.emitNotice({
        conversationId: conversation.id,
        kind: "effort_changed",
        title: `思考强度 · ${payload.reasoningEffort}`,
      });
    }
    if (payload.permissionMode && payload.permissionMode !== priorSettings.permissionMode) {
      this.emitNotice({
        conversationId: conversation.id,
        kind: "permission_changed",
        title: `权限模式 · ${payload.permissionMode}`,
      });
    }

    const userText = textFromBlocks(payload.contentBlocks);
    this.addItem(conversation.id, {
      id: payload.clientMessageId,
      conversationId: conversation.id,
      type: "message",
      role: "user",
      content: payload.contentBlocks,
      text: userText,
      metadata: shouldSteer ? { delivery: "steer", targetTurnId: activeTurnId } : undefined,
      createdAt: Date.now(),
    });
    this.emitConversation(conversation);

    const promptAsNewTurn = () =>
      client.prompt({
        sessionId: conversation.agentSessionId!,
        content: payload.contentBlocks,
        clientMessageId: payload.clientMessageId,
        model: effectiveModel,
        reasoningEffort: payload.reasoningEffort,
        permissionMode: payload.permissionMode,
        collaborationMode: payload.collaborationMode ?? conversation.collaborationMode,
        cwd: conversation.cwd,
      });

    try {
      const steer = (client as { steer?: (input: { sessionId: string; turnId: string; content: AgentContentBlock[] }) => Promise<unknown> }).steer;
      let result: unknown;
      if (shouldSteer && typeof steer === "function") {
        try {
          result = await steer.call(client, {
            sessionId: conversation.agentSessionId,
            turnId: activeTurnId!,
            content: payload.contentBlocks,
          });
        } catch (steerError) {
          this.forgetCurrentTurn(conversation.id, activeTurnId);
          const userItem = this.findItem(conversation.id, payload.clientMessageId);
          if (userItem) {
            this.upsertItem(conversation.id, {
              ...userItem,
              metadata: {
                ...(userItem.metadata ?? {}),
                delivery: "new_turn",
                fallbackFrom: "steer",
                failedTargetTurnId: activeTurnId,
              },
              updatedAt: Date.now(),
            });
          }
          this.addItem(conversation.id, {
            id: id("status"),
            conversationId: conversation.id,
            type: "status",
            role: "system",
            text: "Codex 未接收运行中追加输入，已改为发送新消息。",
            status: "running",
            createdAt: Date.now(),
          });
          result = await promptAsNewTurn();
        }
      } else {
        result = await promptAsNewTurn();
      }
      const nextAgentSessionId = this.extractSessionId(result);
      if (nextAgentSessionId && nextAgentSessionId !== conversation.agentSessionId) {
        if (conversation.agentSessionId) this.conversationByAgentSessionId.delete(conversation.agentSessionId);
        conversation.agentSessionId = nextAgentSessionId;
        this.conversationByAgentSessionId.set(nextAgentSessionId, conversation.id);
      }
      const turnId = this.extractTurnId(result);
      if (turnId) this.rememberTurnConversationId(conversation.id, turnId);
      if (conversation.status === "running" && protocol !== "codex-app-server") {
        this.updateConversationStatus(conversation.id, "idle");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateConversationStatus(conversation.id, "error", message);
      this.addItem(conversation.id, {
        id: id("error"),
        conversationId: conversation.id,
        type: "error",
        error: message,
        createdAt: Date.now(),
      });
    }
  }

  private commandForConversation(conversation: AgentConversation, commandId: string): AgentCommandDescriptor | undefined {
    const runtimeCapabilities = this.providerCapabilities.get(conversation.provider);
    const commands = mergeCommands(
      defaultProviderCommands(conversation.provider, conversation.cwd, true),
      runtimeCapabilities?.commands,
    );
    return commands.find((command) =>
      command.id === commandId ||
      command.name === commandId ||
      `/${command.name}` === commandId
    );
  }

  private async executeCommand(payload: {
    conversationId: string;
    commandId: string;
    rawText?: string;
    args?: string;
    clientMessageId: string;
  }): Promise<void> {
    const conversation =
      this.conversations.get(payload.conversationId) ??
      await this.openConversation({ conversationId: payload.conversationId });
    if (!conversation) return;
    if (!conversation.agentSessionId) {
      this.addItem(payload.conversationId, {
        id: id("error"),
        conversationId: payload.conversationId,
        type: "error",
        error: "Agent session 尚未就绪，命令没有执行。请重新打开对话后再试。",
        createdAt: Date.now(),
      });
      return;
    }

    const command = this.commandForConversation(conversation, payload.commandId);
    if (!command) {
      this.addItem(conversation.id, {
        id: id("error"),
        conversationId: conversation.id,
        type: "error",
        error: `未知命令：${payload.commandId}`,
        createdAt: Date.now(),
      });
      return;
    }

    if (command.disabledReason) {
      this.addItem(conversation.id, {
        id: id("error"),
        conversationId: conversation.id,
        type: "error",
        error: command.disabledReason,
        createdAt: Date.now(),
      });
      return;
    }

    const rawText = payload.rawText?.trim() || `/${command.name}${payload.args?.trim() ? ` ${payload.args.trim()}` : ""}`;
    if (command.executionKind === "prompt") {
      await this.sendPrompt({
        conversationId: conversation.id,
        clientMessageId: payload.clientMessageId,
        contentBlocks: [{ type: "text", text: rawText }],
        model: conversation.model,
        reasoningEffort: conversation.reasoningEffort,
        permissionMode: conversation.permissionMode,
        collaborationMode: conversation.collaborationMode,
      });
      return;
    }

    this.addItem(conversation.id, {
      id: payload.clientMessageId,
      conversationId: conversation.id,
      type: "message",
      kind: "chat",
      role: "user",
      content: [{ type: "text", text: rawText }],
      text: rawText,
      metadata: { commandId: command.id, commandExecutionKind: command.executionKind },
      createdAt: Date.now(),
    });

    if (command.executionKind === "local_ui") {
      this.emitStatus(conversation.id, "idle", `${command.title} 已由移动端处理。`);
      return;
    }

    await this.executeNativeCommand(conversation, command, payload.args?.trim());
  }

  private async executeNativeCommand(
    conversation: AgentConversation,
    command: AgentCommandDescriptor,
    args?: string,
  ): Promise<void> {
    const client = this.clientForProvider(conversation.provider);
    const now = Date.now();
    try {
      if (command.name === "status") {
        this.emitStatus(
          conversation.id,
          conversation.status,
          `${providerLabel(conversation.provider)} · ${conversation.collaborationMode === "plan" ? "Plan mode" : "Default mode"} · ${conversation.cwd}`,
        );
        return;
      }

      if (conversation.provider !== "codex") {
        const message = `${command.title} 暂无 ${providerLabel(conversation.provider)} 原生实现。`;
        this.emitNotice({
          conversationId: conversation.id,
          kind: "native_unsupported",
          title: `${command.title} 不支持`,
          detail: `${providerLabel(conversation.provider)} 当前未实现这个命令。`,
        });
        this.addItem(conversation.id, {
          id: id("error"),
          conversationId: conversation.id,
          type: "error",
          error: message,
          createdAt: now,
        });
        return;
      }

      if (command.name === "plan" || command.name === "exit-plan") {
        conversation.collaborationMode = command.name === "plan" ? "plan" : "default";
        conversation.status = "idle";
        conversation.lastMessagePreview = command.name === "plan" ? "已进入 Plan mode" : "已退出 Plan mode";
        conversation.lastActivityAt = now;
        this.emitConversation(conversation);
        this.sendCapabilities();
        this.emitStatus(conversation.id, "idle", command.name === "plan"
          ? "已进入 Plan mode。下一条消息会先制定计划。"
          : "已退出 Plan mode。");
        return;
      }

      if (command.name === "compact") {
        if (!(client instanceof AcpClient)) throw new Error("当前 Codex runtime 不支持原生 compact。");
        conversation.status = "running";
        this.emitConversation(conversation);
        this.addItem(conversation.id, {
          id: id("compact"),
          conversationId: conversation.id,
          type: "status",
          kind: "context_compaction",
          text: "正在压缩上下文",
          status: "running",
          isStreaming: true,
          createdAt: now,
        });
        await client.compact({ sessionId: conversation.agentSessionId! });
        this.updateConversationStatus(conversation.id, "idle", "上下文压缩完成");
        this.emitStatus(conversation.id, "idle", "上下文压缩完成。");
        return;
      }

      if (command.name === "clear") {
        if (!client) throw new Error("Agent provider 不在线。");
        const result = await client.newSession({ cwd: conversation.cwd });
        const nextAgentSessionId = this.extractSessionId(result) ?? id("agent-session");
        if (conversation.agentSessionId) this.conversationByAgentSessionId.delete(conversation.agentSessionId);
        conversation.agentSessionId = nextAgentSessionId;
        conversation.collaborationMode = "default";
        conversation.status = "idle";
        conversation.lastMessagePreview = "上下文已重置";
        conversation.lastActivityAt = now;
        this.conversationByAgentSessionId.set(nextAgentSessionId, conversation.id);
        this.timelines.set(conversation.id, []);
        this.emitConversation(conversation);
        this.emitStatus(conversation.id, "idle", "上下文已重置，已创建新的 Codex thread。");
        return;
      }

      if (command.name === "review" || command.name === "subagents") {
        const prompt = command.name === "review"
          ? args || "Review the current local changes."
          : args || "Run subagents for distinct tasks in parallel when useful, then synthesize the results.";
        await this.sendPrompt({
          conversationId: conversation.id,
          clientMessageId: id(command.name),
          contentBlocks: [{ type: "text", text: prompt }],
          model: conversation.model,
          reasoningEffort: conversation.reasoningEffort,
          permissionMode: conversation.permissionMode,
          collaborationMode: conversation.collaborationMode,
        });
        return;
      }

      throw new Error(`命令暂未实现：/${command.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateConversationStatus(conversation.id, "error", message);
      this.addItem(conversation.id, {
        id: id("error"),
        conversationId: conversation.id,
        type: "error",
        error: message,
        createdAt: Date.now(),
      });
    }
  }

  private handleRequest(method: string, params: unknown): Promise<unknown> | unknown {
    if (method === "claude/askUserQuestion") {
      return this.handleStructuredInput({ ...(asRecord(params) ?? {}), source: method }, true);
    }
    if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
      return this.handleStructuredInput(params, true);
    }
    if (method === "mcpServer/elicitation/request") {
      return this.handleStructuredInput({ ...(asRecord(params) ?? {}), source: method }, true);
    }
    if (isPermissionRequestMethod(method)) {
      return this.handlePermission(params, true, method);
    }
    if (this.input.verbose) {
      process.stderr.write(`[agent:v2:request] unsupported ${method}\n`);
    }
    return {};
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.input.verbose) {
      process.stderr.write(`[agent:v2] ${method} ${stringify(params).slice(0, 500)}\n`);
    }
    if (method === "initialized") {
      const conversationId = this.conversationIdFromParams(params) ?? this.fallbackConversationId();
      const provider = conversationId ? this.conversations.get(conversationId)?.provider : this.input.availableProviders[0];
      if (provider) {
        const commands = runtimeCommands(provider, params);
        if (commands.length > 0) {
          const existing = this.providerCapabilities.get(provider);
          this.providerCapabilities.set(provider, {
            ...(existing ?? {}),
            commands: mergeCommands(existing?.commands, commands),
          });
          this.sendCapabilities();
        }
      }
      const initModel = firstString(asRecord(params), ["model", "currentModel"]);
      if (initModel && conversationId) {
        const conversation = this.conversations.get(conversationId);
        if (conversation && conversation.model !== initModel) {
          conversation.model = initModel;
          conversation.lastActivityAt = Date.now();
          this.emitConversation(conversation);
        }
      }
      return;
    }
    if (
      method.startsWith("account/") ||
      method.startsWith("mcpServer/startupStatus/") ||
      method === "serverRequest/resolved" ||
      method === "mcpServer/oauthLogin/completed"
    ) {
      return;
    }

    const conversationId = this.conversationIdFromParams(params) ?? this.fallbackConversationId();
    if (method === "thread/tokenUsage/updated") {
      // Codex emits cumulative token usage for the thread. Carry it onto the
      // conversation so clients can show a context meter (parity with Codex's
      // own /status). Cost is Claude-only; Codex usually omits it.
      if (conversationId) {
        const raw = asRecord(params);
        const usage = asRecord(raw?.usage) ? raw?.usage : params;
        this.applyConversationUsage(conversationId, usage);
      }
      return;
    }
    if (method === "thread/status/changed") {
      const status = agentStatusFromThreadStatus(params);
      if (conversationId && status) {
        const raw = asRecord(params);
        const turnId = this.extractTurnId(raw);
        if (turnId && (status === "running" || status === "waiting_permission")) {
          this.rememberTurnConversationId(conversationId, turnId);
        }
        if (status === "idle" || status === "error") {
          this.forgetCurrentTurn(conversationId, turnId);
        }
        const message =
          status === "error"
            ? firstString(raw, ["message", "error", "reason"])
            : undefined;
        this.updateConversationStatus(conversationId, status, message);
      }
      return;
    }
    if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
      this.handleStructuredInput(params);
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.handleStructuredInput({ ...(asRecord(params) ?? {}), source: method });
      return;
    }
    if (isPermissionRequestMethod(method)) {
      this.handlePermission(params, false, method);
      return;
    }
    if (method === "thread/started") {
      const agentSessionId = this.extractSessionId(params);
      if (agentSessionId && conversationId) {
        this.conversationByAgentSessionId.set(agentSessionId, conversationId);
        const conversation = this.conversations.get(conversationId);
        if (conversation) {
          conversation.agentSessionId = agentSessionId;
          conversation.lastActivityAt = Date.now();
          const startedModel = firstString(asRecord(params), ["model", "currentModel"]);
          if (startedModel && conversation.model !== startedModel) {
            conversation.model = startedModel;
          }
          this.emitConversation(conversation);
        }
      }
      return;
    }
    if (method === "turn/started") {
      if (conversationId) {
        const turnId = this.extractTurnId(params);
        if (turnId) this.rememberTurnConversationId(conversationId, turnId);
        this.updateConversationStatus(conversationId, "running");
      }
      return;
    }
    if (method === "turn/completed") {
      if (conversationId) {
        // Claude reports cumulative usage + cost on turn completion (Codex sends
        // it via thread/tokenUsage/updated instead). Capture it for the meter.
        const raw = asRecord(params);
        const cost = firstNumber(raw, ["totalCostUsd", "total_cost_usd"]);
        if (raw?.usage != null || cost != null) {
          this.applyConversationUsage(conversationId, raw?.usage, cost);
        }
        this.forgetCurrentTurn(conversationId, this.extractTurnId(params));
        this.updateConversationStatus(conversationId, "idle");
      }
      return;
    }
    if (method === "session/request_permission") {
      this.handlePermission(params, false, method);
      return;
    }

    switch (method) {
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(params);
        return;
      case "turn/plan/updated":
        this.handlePlanUpdated(params);
        return;
      case "item/plan/delta":
        this.handlePlanDelta(params);
        return;
      case "item/started":
        this.handleItemStarted(params);
        return;
      case "item/completed":
        this.handleItemCompleted(params);
        return;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "item/mcpToolCall/progress":
        this.handleToolDelta(method, params);
        return;
      case "item/fileChange/patchUpdated":
        this.handleFilePatchUpdated(params);
        return;
      case "turn/diff/updated":
        this.handleTurnDiffUpdated(params);
        return;
      case "command/exec/outputDelta":
        this.handleCommandExecDelta(params);
        return;
      case "item/autoApprovalReview/started":
        this.handleAutoApprovalReview(params, true);
        return;
      case "item/autoApprovalReview/completed":
        this.handleAutoApprovalReview(params, false);
        return;
      case "item/commandExecution/terminalInteraction":
        return;
    }

    if (method === "session/update") {
      this.handleSessionUpdate(params);
      return;
    }
  }

  private handleAgentMessageDelta(params: unknown): void {
    const raw = asRecord(params);
    if (!raw) return;
    const conversationId = this.conversationIdFromParams(raw) ?? this.fallbackConversationId();
    if (!conversationId) return;
    const itemId = firstString(raw, ["itemId", "id", "messageId"]) ?? id("msg");
    const delta = firstString(raw, ["delta", "text", "content"]);
    if (!delta) return;
    const existing = this.findItem(conversationId, itemId);
    const text = `${existing?.text ?? ""}${delta}`;
    const item: AgentTimelineItem = {
      id: itemId,
      conversationId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      text,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      isStreaming: true,
    };
    this.upsertItem(conversationId, item);
    this.updateConversationPreview(conversationId, text, "running");
  }

  private handlePlanUpdated(params: unknown): void {
    const raw = asRecord(params);
    const conversationId = this.conversationIdFromParams(raw) ?? this.fallbackConversationId();
    if (!conversationId) return;
    const plan = Array.isArray(raw?.plan) ? raw.plan : [];
    const steps = plan
      .map((entry, index) => {
        const step = asRecord(entry);
        const text = firstString(step, ["text", "title", "description", "message"]);
        if (!text) return undefined;
        return {
          id: firstString(step, ["id"]) ?? `plan-${index + 1}`,
          text,
          status: normalizePlanStatus(step?.status),
        } satisfies AgentPlanStep;
      })
      .filter((step): step is AgentPlanStep => Boolean(step));
    if (steps.length === 0) return;
    this.upsertItem(conversationId, {
      id: "plan",
      conversationId,
      type: "plan",
      plan: steps,
      createdAt: this.findItem(conversationId, "plan")?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
  }

  private handlePlanDelta(params: unknown): void {
    const raw = asRecord(params);
    if (!raw) return;
    const conversationId = this.conversationIdFromParams(raw) ?? this.fallbackConversationId();
    if (!conversationId) return;
    const itemId = firstString(raw, ["itemId", "id"]) ?? "plan";
    const delta = firstString(raw, ["delta", "text"]);
    if (!delta) return;
    const existing = this.findItem(conversationId, itemId);
    const text = `${existing?.text ?? ""}${delta}`;
    const step: AgentPlanStep = { id: itemId, text, status: "in_progress" };
    this.upsertItem(conversationId, {
      id: itemId,
      conversationId,
      type: "plan",
      text,
      plan: [step],
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
  }

  private handleItemStarted(params: unknown): void {
    const item = extractItem(params);
    if (!item) return;
    const sourceConversationId = this.conversationIdFromParams(params);
    const routedItem = sourceConversationId ? { ...item, conversationId: sourceConversationId } : item;
    const itemType = firstString(routedItem, ["type"]);
    const normalizedItemType = normalizedIdentifier(itemType);
    if (normalizedItemType === "agentmessage" || normalizedItemType === "assistantmessage") {
      this.handleCompletedMessageItem(routedItem, true);
      return;
    }
    if (normalizedItemType === "plan") {
      this.handlePlanUpdated({ plan: [routedItem], conversationId: sourceConversationId });
      return;
    }
    if (isSubagentItemType(itemType)) {
      this.handleSubagentItem(routedItem, "running", true);
      return;
    }
    if (this.handleSemanticSystemItem(routedItem, "running", true)) return;
    const conversationId = this.conversationIdFromParams(routedItem) ?? this.fallbackConversationId();
    const toolCall = this.toolCallFromItem(routedItem, "running");
    if (!conversationId || !toolCall) return;
    this.toolConversationIds.set(toolCall.id, conversationId);
    this.upsertTool(conversationId, toolCall);
  }

  private handleItemCompleted(params: unknown): void {
    const item = extractItem(params);
    if (!item) return;
    const sourceConversationId = this.conversationIdFromParams(params);
    const routedItem = sourceConversationId ? { ...item, conversationId: sourceConversationId } : item;
    const itemType = firstString(routedItem, ["type"]);
    const normalizedItemType = normalizedIdentifier(itemType);
    if (normalizedItemType === "agentmessage" || normalizedItemType === "assistantmessage") {
      this.handleCompletedMessageItem(routedItem, false);
      return;
    }
    if (normalizedItemType === "plan") {
      this.handlePlanDelta({ ...routedItem, delta: firstString(routedItem, ["text", "content", "message"]) });
      return;
    }
    if (isSubagentItemType(itemType)) {
      this.handleSubagentItem(routedItem, normalizeToolStatus(routedItem.status, true), false);
      return;
    }
    if (this.handleSemanticSystemItem(routedItem, normalizeToolStatus(routedItem.status, true), false)) return;
    const conversationId = this.conversationIdFromParams(routedItem) ?? this.fallbackConversationId();
    const toolCall = this.toolCallFromItem(routedItem, normalizeToolStatus(routedItem.status, true));
    if (!conversationId || !toolCall) return;
    const bufferedOutput = this.toolOutputBuffers.get(toolCall.id);
    if (bufferedOutput && !toolCall.output) toolCall.output = bufferedOutput;
    this.upsertTool(conversationId, toolCall);
  }

  private handleToolDelta(method: string, params: unknown): void {
    const raw = asRecord(params);
    if (!raw) return;
    const itemId = firstString(raw, ["itemId", "id", "toolCallId"]) ?? id("tool");
    const delta = firstString(raw, ["delta", "message", "text"]);
    if (!delta) return;
    const conversationId =
      this.conversationIdFromParams(raw) ??
      this.toolConversationIds.get(itemId) ??
      this.itemConversationIds.get(itemId) ??
      this.fallbackConversationId();
    if (!conversationId) return;
    const output = appendCapped(this.toolOutputBuffers.get(itemId), delta, 6000);
    this.toolOutputBuffers.set(itemId, output);
    const existing = this.findTool(conversationId, itemId);
    this.upsertTool(conversationId, {
      id: itemId,
      name: existing?.name ?? nameFromToolMethod(method),
      input: existing?.input,
      output,
      createdAt: existing?.createdAt ?? Date.now(),
      status: "running",
    });
  }

  private handleFilePatchUpdated(params: unknown): void {
    const raw = asRecord(params);
    if (!raw) return;
    const itemId = firstString(raw, ["itemId", "id"]) ?? id("file");
    const conversationId =
      this.conversationIdFromParams(raw) ??
      this.toolConversationIds.get(itemId) ??
      this.itemConversationIds.get(itemId) ??
      this.fallbackConversationId();
    if (!conversationId) return;
    const output =
      extractDiffText(raw) ??
      summarizeFileChanges(Array.isArray(raw.changes) ? raw.changes : []);
    const existing = this.findTool(conversationId, itemId);
    this.upsertTool(conversationId, {
      id: itemId,
      name: existing?.name ?? "文件修改",
      input: existing?.input,
      output: output || existing?.output,
      createdAt: existing?.createdAt ?? Date.now(),
      status: existing?.status ?? "running",
    });
  }

  private handleTurnDiffUpdated(params: unknown): void {
    const raw = asRecord(params);
    if (!raw) return;
    const conversationId = this.conversationIdFromParams(raw) ?? this.fallbackConversationId();
    if (!conversationId) return;
    const diff = extractDiffText(raw);
    if (!diff) return;
    const itemId =
      firstString(raw, ["itemId", "id", "turnId"]) ??
      `workspace-diff:${conversationId}`;
    const existing = this.findTool(conversationId, itemId);
    const changes = Array.isArray(raw.changes) ? raw.changes : [];
    this.upsertTool(conversationId, {
      id: itemId,
      name: existing?.name ?? "文件修改",
      input: existing?.input ?? summarizeFileChanges(changes),
      output: diff,
      createdAt: existing?.createdAt ?? Date.now(),
      status: existing?.status ?? "running",
    });
  }

  private handleCommandExecDelta(params: unknown): void {
    const raw = asRecord(params);
    if (!raw) return;
    const processId = firstString(raw, ["processId", "id"]) ?? id("exec");
    const delta =
      firstString(raw, ["delta", "text"]) ??
      decodeBase64(firstString(raw, ["deltaBase64"]));
    if (!delta) return;
    const conversationId =
      this.conversationIdFromParams(raw) ??
      this.toolConversationIds.get(processId) ??
      this.itemConversationIds.get(processId) ??
      this.fallbackConversationId();
    if (!conversationId) return;
    const output = appendCapped(this.toolOutputBuffers.get(processId), delta, 6000);
    this.toolOutputBuffers.set(processId, output);
    const existing = this.findTool(conversationId, processId);
    this.upsertTool(conversationId, {
      id: processId,
      name: existing?.name ?? "命令输出",
      input: existing?.input,
      output,
      createdAt: existing?.createdAt ?? Date.now(),
      status: "running",
    });
  }

  private handleAutoApprovalReview(params: unknown, streaming: boolean): void {
    const raw = asRecord(params) ?? {};
    const conversationId = this.conversationIdFromParams(raw) ?? this.fallbackConversationId();
    if (!conversationId) return;
    const itemId = firstString(raw, ["itemId", "id", "reviewId"]) ?? "auto-approval-review";
    const existing = this.findItem(conversationId, itemId);
    const decision = firstString(raw, ["decision", "result", "outcome", "status"]);
    const summary =
      firstString(raw, ["summary", "message", "text", "reason"]) ??
      stringifyDefined(raw.review ?? raw.details);
    this.upsertItem(conversationId, {
      id: itemId,
      conversationId,
      type: "status",
      kind: "review",
      role: "system",
      turnId: this.extractTurnId(raw) ?? this.currentTurnIds.get(conversationId),
      itemId,
      text: summary ?? (streaming ? "正在审查自动授权" : decision ? `自动授权审查：${decision}` : "已完成自动授权审查"),
      metadata: {
        ...(existing?.metadata ?? {}),
        autoApprovalReview: true,
        ...(decision ? { decision } : {}),
      },
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      isStreaming: streaming,
    });
    this.updateConversationPreview(conversationId, streaming ? "正在审查自动授权" : "已完成自动授权审查", streaming ? "running" : undefined);
  }

  private handleCompletedMessageItem(item: Record<string, unknown>, streaming: boolean): void {
    const conversationId = this.conversationIdFromParams(item) ?? this.fallbackConversationId();
    if (!conversationId) return;
    const itemId = firstString(item, ["id"]) ?? id("msg");
    const existing = this.findItem(conversationId, itemId);
    const content = contentBlocksFromItem(item);
    const nextContent = content.length > 0
      ? content
      : existing?.content ?? (existing?.text ? [{ type: "text", text: existing.text }] : []);
    const text = textFromBlocks(nextContent);
    if (!nextContent.length && !text) return;
    this.upsertItem(conversationId, {
      id: itemId,
      conversationId,
      type: "message",
      role: "assistant",
      content: nextContent,
      text,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      isStreaming: streaming,
    });
    this.updateConversationPreview(conversationId, text || "图片附件", streaming ? "running" : "idle");
  }

  private handleSessionUpdate(params: unknown): void {
    const raw = asRecord(params) ?? {};
    const nested = asRecord(raw.params) ?? {};
    const text =
      firstString(raw, ["delta", "text", "content", "message"]) ??
      firstString(nested, ["delta", "text", "content", "message"]);
    const content = contentBlocksFromItem(raw);
    if (!text && content.length === 0) return;
    const conversationId = this.conversationIdFromParams(raw) ?? this.fallbackConversationId();
    if (!conversationId) return;
    if (firstString(raw, ["toolName", "tool", "name"])) {
      this.upsertTool(conversationId, {
        id: firstString(raw, ["toolCallId", "callId", "id"]) ?? id("tool"),
        name: firstString(raw, ["toolName", "tool", "name"]) ?? "tool",
        input: stringify(raw.input ?? raw.toolInput ?? ""),
        output: stringify(raw.output ?? raw.result ?? ""),
        createdAt: Date.now(),
        status: raw.status === "completed" || raw.status === "failed" || raw.status === "running"
          ? raw.status
          : "running",
      });
      return;
    }
    const role = raw.role === "user" || raw.role === "system" ? raw.role : "assistant";
    const blocks = content.length > 0 ? content : [{ type: "text" as const, text }];
    const preview = textFromBlocks(blocks);
    this.upsertItem(conversationId, {
      id: firstString(raw, ["messageId", "id"]) ?? id("msg"),
      conversationId,
      type: "message",
      role,
      content: blocks,
      text: preview,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isStreaming: raw.done === false || raw.isStreaming === true,
    });
    this.updateConversationPreview(conversationId, preview || "图片附件", raw.done === true ? "idle" : "running");
  }

  private handleSemanticSystemItem(
    item: Record<string, unknown>,
    status: AgentToolCall["status"],
    streaming: boolean,
  ): boolean {
    const itemType = firstString(item, ["type"]);
    const normalized = normalizedIdentifier(itemType);
    const conversationId = this.conversationIdFromParams(item) ?? this.fallbackConversationId();
    if (!conversationId) return false;
    const itemId = firstString(item, ["id", "itemId"]) ?? id("item");
    const existing = this.findItem(conversationId, itemId);
    const base = {
      id: itemId,
      conversationId,
      type: "status" as const,
      role: "system" as const,
      turnId: this.extractTurnId(item) ?? this.currentTurnIds.get(conversationId),
      itemId,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      isStreaming: streaming,
    };

    if (normalized === "reasoning" || normalized === "thinking") {
      const text = firstString(item, ["text", "content", "summary", "message"]) ??
        stringifyDefined(item.contentItems ?? item.summary);
      if (!text?.trim()) return true;
      this.upsertItem(conversationId, {
        ...base,
        kind: "thinking",
        text,
      });
      return true;
    }

    if (normalized === "enteredreviewmode") {
      const target = firstString(item, ["review", "target", "label"]) ?? "changes";
      this.upsertItem(conversationId, {
        ...base,
        kind: "review",
        text: status === "completed" ? `已完成审查 ${target}` : `正在审查 ${target}`,
      });
      return true;
    }

    if (normalized === "contextcompaction") {
      this.upsertItem(conversationId, {
        ...base,
        kind: "context_compaction",
        text: status === "completed" ? "上下文已压缩" : "正在压缩上下文",
      });
      return true;
    }

    return false;
  }

  private handleSubagentItem(
    item: Record<string, unknown>,
    status: AgentToolCall["status"],
    streaming: boolean,
  ): void {
    const conversationId = this.conversationIdFromParams(item) ?? this.fallbackConversationId();
    if (!conversationId) return;
    const subagent = decodeSubagentAction(item, status);
    if (!subagent) return;
    const itemId = firstString(item, ["id", "itemId"]) ?? id("subagent");
    const text = summarizeSubagentAction(subagent);
    const existing = this.findItem(conversationId, itemId);
    this.upsertItem(conversationId, {
      id: itemId,
      conversationId,
      type: "status",
      kind: "subagent_action",
      role: "system",
      turnId: this.extractTurnId(item) ?? this.currentTurnIds.get(conversationId),
      itemId,
      text,
      subagent,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      isStreaming: streaming,
    });
    this.updateConversationPreview(conversationId, text, streaming ? "running" : "idle");
  }

  private handleStructuredInput(params: unknown, waitForResponse = false): Promise<unknown> | void {
    const raw = asRecord(params) ?? {};
    const conversationId = this.conversationIdFromParams(raw) ?? this.fallbackConversationId();
    const source = firstString(raw, ["method", "source", "requestMethod"]);
    const formatResponse = (answers: Record<string, string[]>, input?: AgentStructuredInput) =>
      formatStructuredInputResponseForSource(source, answers, input);
    if (!conversationId) return waitForResponse ? Promise.resolve(formatResponse({})) : undefined;
    const structuredInput = decodeStructuredInput(raw);
    if (!structuredInput) return waitForResponse ? Promise.resolve(formatResponse({})) : undefined;
    const text = structuredInput.questions.map((question) => question.question).join("\n");
    this.pendingStructuredInputs.set(structuredInput.requestId, { conversationId, input: structuredInput });
    this.upsertItem(conversationId, {
      id: `input:${structuredInput.requestId}`,
      conversationId,
      type: "status",
      kind: "user_input_prompt",
      role: "system",
      text,
      structuredInput,
      metadata: { inputPending: true },
      createdAt: this.findItem(conversationId, `input:${structuredInput.requestId}`)?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    this.updateConversationPreview(conversationId, "需要用户输入", "running");
    if (!waitForResponse) return;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingStructuredInputs.delete(structuredInput.requestId);
        this.structuredInputWaiters.delete(structuredInput.requestId);
        resolve(formatResponse({}, structuredInput));
        this.markStructuredInput(conversationId, structuredInput.requestId, {
          inputPending: false,
          inputError: "等待用户输入超时",
        });
      }, PERMISSION_TIMEOUT_MS);
      this.structuredInputWaiters.set(structuredInput.requestId, { resolve, timer, source, input: structuredInput });
    });
  }

  private toolCallFromItem(
    item: Record<string, unknown>,
    fallbackStatus: AgentToolCall["status"],
  ): AgentToolCall | undefined {
    const itemId = firstString(item, ["id", "itemId", "toolCallId"]);
    if (!itemId) return undefined;
    const itemType = firstString(item, ["type"]);
    const normalizedItemType = normalizedIdentifier(itemType);
    const name = toolNameFromItem(item);
    if (!name && !isToolItemType(itemType)) return undefined;
    const bufferedOutput = this.toolOutputBuffers.get(itemId);
    const rawOutput =
      firstString(item, ["aggregatedOutput", "output", "stdout", "stderr"]) ??
      stringifyDefined(item.result ?? item.error ?? item.contentItems);
    const output = normalizedItemType === "filechange" || normalizedItemType === "diff"
      ? extractDiffText(item) ?? bufferedOutput ?? rawOutput
      : rawOutput ?? bufferedOutput;
    return {
      id: itemId,
      name: name ?? "工具",
      input: toolInputFromItem(item),
      output,
      createdAt: Date.now(),
      status: normalizeToolStatus(item.status, fallbackStatus === "completed"),
    };
  }

  private handlePermission(
    params: unknown,
    waitForResponse: boolean,
    source?: string,
  ): Promise<unknown> | void {
    const raw = asRecord(params) ?? {};
    const conversationId = this.conversationIdFromParams(raw) ?? this.fallbackConversationId();
    if (!conversationId) return waitForResponse ? Promise.resolve({ outcome: { outcome: "cancelled" } }) : undefined;
    const requestId = firstString(raw, ["requestId", "id", "permissionId"]) ?? id("perm");
    const rawToolCall = asRecord(raw.toolCall) ?? raw;
    // Codex app-server command/file approvals carry `command`/`reason`/`cwd`
    // (not toolCall/context). Surface them so the card actually shows what's
    // being approved; fall back to the Claude/MCP shape otherwise.
    const codexCommand = firstString(raw, ["command"]);
    const codexCwd = firstString(raw, ["cwd"]);
    const permission: AgentPermission = {
      requestId,
      toolName:
        firstString(rawToolCall, ["toolName", "tool", "name", "title", "kind"]) ??
        (codexCommand ? "shell" : undefined),
      toolInput: codexCommand
        ? (codexCwd ? `$ ${codexCommand}\n# cwd: ${codexCwd}` : `$ ${codexCommand}`)
        : stringify(rawToolCall.input ?? rawToolCall.toolInput ?? rawToolCall),
      context: firstString(raw, ["context", "description", "message", "title", "reason"]),
      options: parsePermissionOptions(raw.options),
    };
    this.pendingPermissions.set(requestId, permission);
    if (source) this.permissionSources.set(requestId, source);
    this.updateConversationStatus(conversationId, "waiting_permission");
    const item: AgentTimelineItem = {
      id: `permission:${requestId}`,
      conversationId,
      type: "permission",
      permission,
      metadata: {
        protocol: "v2",
        permissionLive: true,
        permissionExpired: false,
        permissionPending: false,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.upsertItem(conversationId, item);
    this.input.send(createEnvelope({
      type: "agent.v2.permission.request",
      sessionId: this.input.sessionId,
      payload: { conversationId, ...permission, item },
    }));

    if (!waitForResponse) return;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        this.permissionWaiters.delete(requestId);
        this.permissionSources.delete(requestId);
        resolve(formatPermissionResponse(source, "cancelled", "cancelled"));
        this.updateConversationStatus(conversationId, "idle");
      }, PERMISSION_TIMEOUT_MS);
      this.permissionWaiters.set(requestId, { resolve, timer });
    });
  }

  private respondPermission(payload: {
    conversationId: string;
    requestId: string;
    outcome: "allow" | "deny" | "cancelled";
    optionId?: string;
  }): void {
    const permission = this.pendingPermissions.get(payload.requestId);
    const waiter = this.permissionWaiters.get(payload.requestId);
    const existingItem = this.findItem(payload.conversationId, `permission:${payload.requestId}`);
    const alreadyResolved = Boolean(existingItem?.metadata?.permissionOutcome);
    if (!permission && !waiter && alreadyResolved) return;
    this.pendingPermissions.delete(payload.requestId);
    const selectedOptionId =
      payload.optionId ?? selectPermissionOption(permission, payload.outcome);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.permissionWaiters.delete(payload.requestId);
      waiter.resolve(formatPermissionResponse(
        this.permissionSources.get(payload.requestId),
        payload.outcome,
        selectedOptionId,
      ));
      this.permissionSources.delete(payload.requestId);
    } else {
      const conversation = this.conversations.get(payload.conversationId);
      const respondClient = conversation ? this.clientForProvider(conversation.provider) : undefined;
      respondClient?.respondPermission({
        sessionId: conversation?.agentSessionId,
        requestId: payload.requestId,
        outcome: payload.outcome === "cancelled" ? "deny" : payload.outcome,
        optionId: selectedOptionId,
      });
    }
    this.markPermission(payload.conversationId, payload.requestId, {
      permissionOutcome: payload.outcome,
      optionId: selectedOptionId,
      permissionError: undefined,
      permissionPending: false,
    });
    if (permission || waiter || existingItem) {
      this.updateConversationStatus(payload.conversationId, "running");
    }
  }

  private respondStructuredInput(payload: {
    conversationId: string;
    requestId: string;
    answers: Record<string, string[]>;
  }): void {
    const pending = this.pendingStructuredInputs.get(payload.requestId);
    const waiter = this.structuredInputWaiters.get(payload.requestId);
    const existingItem = this.findItem(payload.conversationId, `input:${payload.requestId}`);
    const alreadySubmitted = existingItem?.metadata?.inputSubmitted === true;
    if (!pending && !waiter && alreadySubmitted) return;
    this.pendingStructuredInputs.delete(payload.requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.structuredInputWaiters.delete(payload.requestId);
      waiter.resolve(formatStructuredInputResponseForSource(waiter.source, payload.answers, waiter.input));
    }
    this.markStructuredInput(payload.conversationId, payload.requestId, {
      inputPending: false,
      inputSubmitted: true,
      inputSubmitting: false,
      inputError: undefined,
      answers: payload.answers,
    });
    if (pending || waiter || existingItem) {
      this.updateConversationStatus(pending?.conversationId ?? payload.conversationId, "running");
    }
  }

  private markPermission(
    conversationId: string,
    requestId: string,
    metadata: Record<string, unknown>,
  ): void {
    const item = this.findItem(conversationId, `permission:${requestId}`);
    if (!item) return;
    this.upsertItem(conversationId, {
      ...item,
      metadata: { ...(item.metadata ?? {}), ...metadata },
      updatedAt: Date.now(),
    });
  }

  private markStructuredInput(
    conversationId: string,
    requestId: string,
    metadata: Record<string, unknown>,
  ): void {
    const item = this.findItem(conversationId, `input:${requestId}`);
    if (!item) return;
    this.upsertItem(conversationId, {
      ...item,
      metadata: { ...(item.metadata ?? {}), ...metadata },
      updatedAt: Date.now(),
    });
  }

  private addItem(conversationId: string, item: AgentTimelineItem): void {
    this.rememberItemConversationId(conversationId, item);
    const timeline = this.timelines.get(conversationId) ?? [];
    timeline.push(item);
    timeline.sort((a, b) => a.createdAt - b.createdAt);
    if (timeline.length > MAX_TIMELINE_ITEMS) {
      timeline.splice(0, timeline.length - MAX_TIMELINE_ITEMS);
    }
    this.timelines.set(conversationId, timeline);
    this.emitItem(conversationId, item);
  }

  private upsertItem(conversationId: string, item: AgentTimelineItem): void {
    this.rememberItemConversationId(conversationId, item);
    const timeline = this.timelines.get(conversationId) ?? [];
    const index = timeline.findIndex((entry) => entry.id === item.id);
    if (index >= 0) timeline[index] = item;
    else timeline.push(item);
    timeline.sort((a, b) => a.createdAt - b.createdAt);
    if (timeline.length > MAX_TIMELINE_ITEMS) {
      timeline.splice(0, timeline.length - MAX_TIMELINE_ITEMS);
    }
    this.timelines.set(conversationId, timeline);
    this.emitItem(conversationId, item);
  }

  private upsertTool(conversationId: string, toolCall: AgentToolCall): void {
    const duplicate = this.findDuplicateFileTool(conversationId, toolCall);
    if (duplicate && duplicate.id !== toolCall.id) {
      this.removeToolItem(conversationId, toolCall.id);
    }
    const targetToolId = duplicate?.id ?? toolCall.id;
    const existing = this.findTool(conversationId, targetToolId);
    const nextToolCall = {
      ...existing,
      ...toolCall,
      id: targetToolId,
      createdAt: existing?.createdAt ?? toolCall.createdAt ?? Date.now(),
    };
    this.toolConversationIds.set(toolCall.id, conversationId);
    this.toolConversationIds.set(nextToolCall.id, conversationId);
    this.itemConversationIds.set(toolCall.id, conversationId);
    this.itemConversationIds.set(nextToolCall.id, conversationId);
    const kind: AgentTimelineKind = nextToolCall.name.includes("文件")
      ? "file_change"
      : nextToolCall.name.includes("命令")
        ? "command_execution"
        : "tool_activity";
    this.upsertItem(conversationId, {
      id: `tool:${nextToolCall.id}`,
      conversationId,
      type: "tool_call",
      kind,
      itemId: nextToolCall.id,
      toolCall: nextToolCall,
      commandExecution: kind === "command_execution" ? commandExecutionFromTool(nextToolCall) : undefined,
      fileChange: kind === "file_change" ? fileChangeFromTool(nextToolCall) : undefined,
      createdAt: nextToolCall.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
  }

  private findDuplicateFileTool(
    conversationId: string,
    toolCall: AgentToolCall,
  ): AgentToolCall | undefined {
    const output = toolCall.output?.trim();
    if (!toolCall.name.includes("文件") || !output) return undefined;
    return this.timelines.get(conversationId)?.find((entry) =>
      entry.type === "tool_call" &&
      entry.toolCall?.id !== toolCall.id &&
      entry.toolCall?.name.includes("文件") &&
      entry.toolCall.output?.trim() === output
    )?.toolCall;
  }

  private removeToolItem(conversationId: string, toolId: string): void {
    const timeline = this.timelines.get(conversationId);
    if (!timeline) return;
    const index = timeline.findIndex((entry) => entry.id === `tool:${toolId}`);
    if (index >= 0) timeline.splice(index, 1);
  }

  private findItem(conversationId: string, itemId: string): AgentTimelineItem | undefined {
    return this.timelines.get(conversationId)?.find((item) => item.id === itemId);
  }

  private findTool(conversationId: string, toolId: string): AgentToolCall | undefined {
    const item = this.timelines.get(conversationId)?.find((entry) =>
      entry.type === "tool_call" && entry.toolCall?.id === toolId,
    );
    return item?.toolCall;
  }

  private adoptConversationId(oldId: string, newId: string): AgentConversation {
    const conversation = this.conversations.get(oldId);
    if (!conversation) {
      const existing = this.conversations.get(newId);
      if (!existing) throw new Error(`Unknown agent conversation ${oldId}`);
      return existing;
    }

    const target = this.conversations.get(newId);
    const oldTimeline = this.timelines.get(oldId) ?? [];
    const newTimeline = this.timelines.get(newId) ?? [];
    const mergedTimeline = new Map<string, AgentTimelineItem>();
    for (const item of [...newTimeline, ...oldTimeline]) {
      mergedTimeline.set(item.id, { ...item, conversationId: newId });
    }

    if (target && target !== conversation) {
      conversation.agentSessionId = conversation.agentSessionId ?? target.agentSessionId;
      conversation.title = conversation.title ?? target.title;
      conversation.model = conversation.model ?? target.model;
      conversation.reasoningEffort = conversation.reasoningEffort ?? target.reasoningEffort;
      conversation.permissionMode = conversation.permissionMode ?? target.permissionMode;
      conversation.lastMessagePreview = conversation.lastMessagePreview ?? target.lastMessagePreview;
      conversation.createdAt = Math.min(conversation.createdAt, target.createdAt);
      conversation.lastActivityAt = Math.max(conversation.lastActivityAt, target.lastActivityAt);
    }

    this.conversations.delete(oldId);
    conversation.id = newId;
    this.conversations.set(newId, conversation);
    this.timelines.delete(oldId);
    this.timelines.set(
      newId,
      [...mergedTimeline.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-MAX_TIMELINE_ITEMS),
    );

    for (const [agentSessionId, conversationId] of this.conversationByAgentSessionId) {
      if (conversationId === oldId) {
        this.conversationByAgentSessionId.set(agentSessionId, newId);
      }
    }
    for (const [toolId, conversationId] of this.toolConversationIds) {
      if (conversationId === oldId) {
        this.toolConversationIds.set(toolId, newId);
      }
    }
    for (const [turnId, conversationId] of this.turnConversationIds) {
      if (conversationId === oldId) {
        this.turnConversationIds.set(turnId, newId);
      }
    }
    const currentTurnId = this.currentTurnIds.get(oldId);
    if (currentTurnId) {
      this.currentTurnIds.delete(oldId);
      this.currentTurnIds.set(newId, currentTurnId);
      this.turnConversationIds.set(currentTurnId, newId);
    }
    for (const [itemId, conversationId] of this.itemConversationIds) {
      if (conversationId === oldId) {
        this.itemConversationIds.set(itemId, newId);
      }
    }
    if (this.activeConversationId === oldId) {
      this.activeConversationId = newId;
    }
    return conversation;
  }

  private emitItem(conversationId: string, item: AgentTimelineItem): void {
    const conversation = this.conversations.get(conversationId);
    this.input.send(createEnvelope({
      type: "agent.v2.event",
      sessionId: this.input.sessionId,
      payload: { conversationId, conversation: conversation ? { ...conversation } : undefined, item },
    }));
  }

  private emitConversation(conversation: AgentConversation): void {
    this.input.send(createEnvelope({
      type: "agent.v2.event",
      sessionId: this.input.sessionId,
      payload: { conversationId: conversation.id, conversation: { ...conversation } },
    }));
  }

  // Normalize a provider usage payload (Claude result.usage, Codex
  // thread/tokenUsage/updated) into our wire shape, merge onto the conversation,
  // and emit. Field names vary by provider so we probe snake_case + camelCase.
  // Missing fields preserve the previous value (cumulative view). No-ops when
  // nothing meaningful resolves, so a stray empty payload won't blank the meter.
  private applyConversationUsage(conversationId: string, raw: unknown, costUsd?: number): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    const rec = asRecord(raw);
    const num = (...keys: string[]): number | undefined => {
      for (const k of keys) {
        const v = rec?.[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
      return undefined;
    };
    const inputTokens = num("input_tokens", "inputTokens", "input");
    const outputTokens = num("output_tokens", "outputTokens", "output");
    const cacheReadTokens = num(
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "cache_read_tokens",
      "cached_input_tokens",
      "cacheReadTokens",
    );
    let totalTokens = num("total_tokens", "totalTokens", "total");
    if (totalTokens == null && (inputTokens != null || outputTokens != null)) {
      totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
    }
    const contextWindow =
      num("context_window", "contextWindow", "model_context_window", "window") ??
      contextWindowForModel(conversation.model);

    const prev = conversation.usage ?? {};
    const next: AgentConversationUsage = {
      inputTokens: inputTokens ?? prev.inputTokens,
      outputTokens: outputTokens ?? prev.outputTokens,
      cacheReadTokens: cacheReadTokens ?? prev.cacheReadTokens,
      totalTokens: totalTokens ?? prev.totalTokens,
      contextWindow: contextWindow ?? prev.contextWindow,
      totalCostUsd: costUsd ?? prev.totalCostUsd,
      updatedAt: Date.now(),
    };
    if (
      next.inputTokens == null &&
      next.outputTokens == null &&
      next.totalTokens == null &&
      next.totalCostUsd == null
    ) {
      return;
    }
    conversation.usage = next;
    this.emitConversation(conversation);
  }

  private emitStatus(conversationId: string, status: AgentStatus, text?: string): void {
    this.addItem(conversationId, {
      id: id("status"),
      conversationId,
      type: "status",
      status,
      text,
      createdAt: Date.now(),
    });
  }

  private emitNotice(input: {
    conversationId?: string;
    kind:
      | "model_changed"
      | "effort_changed"
      | "permission_changed"
      | "native_unsupported"
      | "info"
      | "warning";
    title: string;
    detail?: string;
    durationMs?: number;
  }): void {
    this.input.send(createEnvelope({
      type: "agent.v2.notice",
      sessionId: this.input.sessionId,
      payload: input,
    }));
  }

  private rejectAgentAction(
    conversation: AgentConversation,
    message: string,
    status: AgentStatus = "idle",
  ): void {
    this.updateConversationStatus(conversation.id, status, message);
    this.addItem(conversation.id, {
      id: id("error"),
      conversationId: conversation.id,
      type: "error",
      error: message,
      createdAt: Date.now(),
    });
  }

  private updateConversationPreview(
    conversationId: string,
    text: string,
    status?: AgentStatus,
  ): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.lastMessagePreview = previewText(text);
    conversation.lastActivityAt = Date.now();
    if (status) conversation.status = status;
    this.emitConversation(conversation);
  }

  private updateConversationStatus(
    conversationId: string,
    status: AgentStatus,
    error?: string,
  ): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.status = status;
    if (error) conversation.lastMessagePreview = error;
    conversation.lastActivityAt = Date.now();
    this.emitConversation(conversation);
  }

  private sendSnapshot(conversationId?: string): void {
    const conversations = [...this.conversations.values()];
    const items = conversationId
      ? this.timelines.get(conversationId) ?? []
      : [...this.timelines.values()].flat();
    this.input.send(createEnvelope({
      type: "agent.v2.snapshot",
      sessionId: this.input.sessionId,
      payload: {
        conversations,
        activeConversationId: this.activeConversationId,
        items,
      },
    }));
  }

  /** Page OLDER transcript history for a conversation (client scrolling up).
   *  Only Codex's app-server exposes paginated reads; other providers report
   *  no more history. Pure pass-through — does not touch the bounded live
   *  timeline. The client prepends the returned (ascending) items. */
  private async loadOlderHistory(payload: {
    conversationId: string;
    cursor?: string;
    limit: number;
  }): Promise<void> {
    const sendResult = (
      items: AgentTimelineItem[],
      nextCursor?: string,
    ): void => {
      this.input.send(createEnvelope({
        type: "agent.v2.history.result",
        sessionId: this.input.sessionId,
        payload: {
          conversationId: payload.conversationId,
          items,
          nextCursor,
          hasMore: Boolean(nextCursor),
        },
      }));
    };

    const conversation = this.conversations.get(payload.conversationId);
    if (!conversation?.agentSessionId) return sendResult([], undefined);

    const client = this.clientForProvider(conversation.provider);
    const listTurns = (client as {
      listTurns?: (input: {
        sessionId: string;
        limit?: number;
        cursor?: string;
        sortDirection?: "asc" | "desc";
        itemsView?: "summary" | "full";
      }) => Promise<unknown>;
    } | undefined)?.listTurns;
    if (typeof listTurns !== "function") return sendResult([], undefined);

    // Client-supplied cursor wins; else the one captured at hydration. Absent
    // cursor means we're already at the start of history.
    const cursor = payload.cursor ?? this.historyCursors.get(payload.conversationId);
    if (!cursor) return sendResult([], undefined);

    try {
      const turnsResult = await listTurns.call(client, {
        sessionId: conversation.agentSessionId,
        limit: payload.limit,
        cursor,
        sortDirection: "desc",
        itemsView: "full",
      });
      const turnsThread = threadFromTurnsListResult(conversation.agentSessionId, turnsResult);
      const items = turnsThread
        ? timelineItemsFromProviderThread({ thread: turnsThread }, payload.conversationId)
        : [];
      const nextCursor = firstString(asRecord(turnsResult), ["nextCursor", "next_cursor", "cursor"]);
      this.historyCursors.set(payload.conversationId, nextCursor);
      sendResult(items, nextCursor);
    } catch (error) {
      if (this.input.verbose) {
        process.stderr.write(
          `[agent:v2] history page failed for ${conversation.provider}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      sendResult([], undefined);
    }
  }

  private conversationIdFromParams(params: unknown): string | undefined {
    const raw = asRecord(params);
    if (!raw) return undefined;
    const directConversationId = firstString(raw, ["conversationId"]);
    if (directConversationId && this.conversations.has(directConversationId)) {
      return directConversationId;
    }
    const threadId = firstString(raw, ["threadId", "sessionId", "agentSessionId"]);
    if (threadId) {
      const conversationId = this.conversationByAgentSessionId.get(threadId);
      if (conversationId) return conversationId;
    }
    const agentSessionId = this.extractSessionId(raw);
    if (agentSessionId) {
      const conversationId = this.conversationByAgentSessionId.get(agentSessionId);
      if (conversationId) return conversationId;
    }
    const turnId = this.extractTurnId(raw) ?? firstString(raw, ["turnId"]);
    if (turnId) {
      const conversationId = this.turnConversationIds.get(turnId);
      if (conversationId) return conversationId;
    }
    const itemId = firstString(raw, [
      "itemId",
      "messageId",
      "toolCallId",
      "processId",
      "callId",
      "requestId",
      "permissionId",
      "id",
    ]);
    if (itemId) {
      const conversationId =
        this.itemConversationIds.get(itemId) ??
        this.toolConversationIds.get(itemId);
      if (conversationId) return conversationId;
    }
    for (const nested of [raw.params, raw.item, raw.message, raw.toolCall, raw.command, raw.event]) {
      const nestedRecord = asRecord(nested);
      if (!nestedRecord || nestedRecord === raw) continue;
      const conversationId = this.conversationIdFromParams(nestedRecord);
      if (conversationId) return conversationId;
    }
    return undefined;
  }

  private fallbackConversationId(): string | undefined {
    const liveConversations = [...this.conversations.values()].filter((conversation) =>
      conversation.status === "running" || conversation.status === "waiting_permission",
    );
    return liveConversations.length === 1 ? liveConversations[0]?.id : undefined;
  }

  private rememberTurnConversationId(conversationId: string, turnId: string): void {
    this.currentTurnIds.set(conversationId, turnId);
    this.turnConversationIds.set(turnId, conversationId);
  }

  private forgetCurrentTurn(conversationId: string, turnId?: string): void {
    const currentTurnId = this.currentTurnIds.get(conversationId);
    this.currentTurnIds.delete(conversationId);
    if (turnId) this.turnConversationIds.delete(turnId);
    if (currentTurnId && currentTurnId !== turnId) this.turnConversationIds.delete(currentTurnId);
  }

  private rememberItemConversationId(conversationId: string, item: AgentTimelineItem): void {
    const keys = [
      item.id,
      item.itemId,
      item.toolCall?.id,
      item.permission?.requestId,
      item.structuredInput?.requestId,
    ].filter((key): key is string => Boolean(key));
    for (const key of keys) {
      this.itemConversationIds.set(key, conversationId);
    }
    if (item.turnId) {
      this.turnConversationIds.set(item.turnId, conversationId);
    }
  }

  private handleProviderExit(provider: AgentProvider, message: string): void {
    this.clients.delete(provider);
    this.agentProtocols.delete(provider);
    this.providerErrors.set(provider, message);
    for (const conversation of this.conversations.values()) {
      if (conversation.provider === provider && conversation.status === "waiting_permission") {
        this.cancelPendingPermissions(conversation.id, false);
      }
    }
    for (const conversation of this.conversations.values()) {
      if (conversation.provider !== provider) continue;
      if (conversation.status !== "running" && conversation.status !== "waiting_permission") {
        this.emitConversation(conversation);
        continue;
      }
      conversation.status = "error";
      conversation.lastMessagePreview = message;
      conversation.lastActivityAt = Date.now();
      this.forgetCurrentTurn(conversation.id);
      this.emitConversation(conversation);
      this.addItem(conversation.id, {
        id: id("error"),
        conversationId: conversation.id,
        type: "error",
        error: message,
        createdAt: Date.now(),
      });
    }
    this.sendCapabilities();
  }

  private cancelPendingPermissions(conversationId?: string, updateStatus = true): void {
    for (const [requestId, waiter] of this.permissionWaiters) {
      if (conversationId && this.itemConversationIds.get(requestId) !== conversationId) continue;
      clearTimeout(waiter.timer);
      waiter.resolve(formatPermissionResponse(
        this.permissionSources.get(requestId),
        "cancelled",
        "cancelled",
      ));
      this.pendingPermissions.delete(requestId);
      this.permissionSources.delete(requestId);
    }
    if (!conversationId) this.permissionWaiters.clear();
    for (const [requestId, waiter] of this.structuredInputWaiters) {
      const pending = this.pendingStructuredInputs.get(requestId);
      if (conversationId && pending?.conversationId !== conversationId) continue;
      clearTimeout(waiter.timer);
      waiter.resolve(formatStructuredInputResponseForSource(waiter.source, {}, waiter.input));
      if (pending) {
        this.markStructuredInput(pending.conversationId, requestId, {
          inputPending: false,
          inputError: "已停止",
        });
      }
      this.pendingStructuredInputs.delete(requestId);
      this.structuredInputWaiters.delete(requestId);
    }
    if (!conversationId) this.structuredInputWaiters.clear();
    if (conversationId && updateStatus) this.updateConversationStatus(conversationId, "idle");
  }

  private extractSessionId(value: unknown): string | undefined {
    const raw = asRecord(value);
    if (!raw) return undefined;
    const thread = asRecord(raw.thread);
    if (thread) {
      const threadId = firstString(thread, ["id", "threadId"]);
      if (threadId) return threadId;
    }
    return firstString(raw, ["sessionId", "id", "agentSessionId", "threadId"]);
  }

  private extractTurnId(value: unknown): string | undefined {
    const raw = asRecord(value);
    if (!raw) return undefined;
    const turn = asRecord(raw.turn);
    if (turn) {
      const turnId = firstString(turn, ["id", "turnId"]);
      if (turnId) return turnId;
    }
    return firstString(raw, ["turnId", "id"]);
  }
}

function parsePermissionOptions(value: unknown): AgentPermission["options"] {
  if (!Array.isArray(value)) {
    return [
      { id: "allow", label: "允许", kind: "allow" },
      { id: "deny", label: "拒绝", kind: "deny" },
    ];
  }

  const options = value
    .map((entry, index) => {
      const raw = asRecord(entry) ?? {};
      const idValue = raw.optionId ?? raw.id ?? raw.kind ?? `option-${index + 1}`;
      const labelValue = raw.name ?? raw.label ?? raw.kind ?? String(idValue);
      const id = String(idValue);
      const label = String(labelValue);
      const normalized = `${id} ${label}`.toLowerCase();
      const kind: AgentPermission["options"][number]["kind"] = normalized.includes("reject") || normalized.includes("deny")
        ? "deny"
        : normalized.includes("allow")
          ? "allow"
          : "other";
      return { id, label, kind };
    })
    .filter((option) => option.id.length > 0 && option.label.length > 0);

  return options.length > 0
    ? options
    : [
        { id: "allow", label: "允许", kind: "allow" },
        { id: "deny", label: "拒绝", kind: "deny" },
      ];
}

function selectPermissionOption(
  permission: AgentPermission | undefined,
  outcome: "allow" | "deny" | "cancelled",
): string {
  if (outcome === "cancelled") return "cancelled";
  const option = permission?.options.find((item) => item.kind === outcome);
  return option?.id ?? outcome;
}

function isPermissionRequestMethod(method: string): boolean {
  return (
    method === "session/request_permission" ||
    method.endsWith("/requestApproval") ||
    method === "mcpServer/elicitation/request" ||
    method === "claude/requestApproval"
  );
}

function formatStructuredInputResponse(answers: Record<string, string[]>): unknown {
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([questionId, values]) => [
        questionId,
        { answers: values.map((value) => value.trim()).filter(Boolean) },
      ]),
    ),
  };
}

function formatClaudeAskUserQuestionResponse(
  answers: Record<string, string[]>,
  input?: AgentStructuredInput,
): unknown {
  const questions = input?.questions ?? [];
  const byQuestionText: Record<string, string | string[]> = {};
  for (const question of questions) {
    const values = answers[question.id] ?? answers[question.question] ?? [];
    const cleaned = values.map((value) => value.trim()).filter(Boolean);
    if (cleaned.length === 0) continue;
    byQuestionText[question.question] = question.selectionLimit && question.selectionLimit > 1
      ? cleaned
      : cleaned[0] ?? "";
  }
  return {
    behavior: "allow",
    updatedInput: {
      questions: questions.map((question) => ({
        question: question.question,
        header: question.header,
        options: question.options?.map((option) => ({
          label: option.label,
          description: option.description,
        })) ?? [],
        multiSelect: Boolean(question.selectionLimit && question.selectionLimit > 1),
      })),
      answers: byQuestionText,
    },
  };
}

function formatMcpElicitationResponse(answers: Record<string, string[]>): unknown {
  const content = Object.fromEntries(
    Object.entries(answers).map(([questionId, values]) => [
      questionId,
      values.length <= 1 ? values[0] ?? "" : values,
    ]),
  );
  return {
    action: Object.keys(content).length > 0 ? "accept" : "cancel",
    content,
    _meta: { source: "linkshell" },
  };
}

function formatStructuredInputResponseForSource(
  source: string | undefined,
  answers: Record<string, string[]>,
  input?: AgentStructuredInput,
): unknown {
  if (source === "mcpServer/elicitation/request") {
    return formatMcpElicitationResponse(answers);
  }
  if (source === "claude/askUserQuestion") {
    return formatClaudeAskUserQuestionResponse(answers, input);
  }
  return formatStructuredInputResponse(answers);
}

function formatPermissionResponse(
  source: string | undefined,
  outcome: "allow" | "deny" | "cancelled",
  optionId: string,
): unknown {
  if (source === "item/commandExecution/requestApproval" || source === "item/fileChange/requestApproval") {
    return { decision: outcome === "allow" ? "accept" : outcome === "deny" ? "decline" : "cancel" };
  }
  if (source === "item/permissions/requestApproval") {
    if (outcome === "allow") {
      return {
        permissions: { type: "managed", network: { enabled: true }, fileSystem: { type: "fullAccess" } },
        scope: optionId.includes("session") ? "session" : "turn",
      };
    }
    return { permissions: { type: "managed", network: { enabled: false }, fileSystem: { type: "readOnly" } } };
  }
  if (source === "claude/requestApproval") {
    return { behavior: outcome === "allow" ? "allow" : "deny" };
  }
  if (source === "mcpServer/elicitation/request") {
    return outcome === "allow"
      ? { action: "accept", content: { optionId }, _meta: { source: "linkshell" } }
      : { action: outcome === "cancelled" ? "cancel" : "decline", content: {}, _meta: { source: "linkshell" } };
  }
  return {
    outcome:
      outcome === "cancelled"
        ? { outcome: "cancelled" }
        : { outcome: "selected", optionId },
  };
}
