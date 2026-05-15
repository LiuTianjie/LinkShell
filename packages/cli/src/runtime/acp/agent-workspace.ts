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
import { listClaudeStoredSessions, loadClaudeStoredTimeline } from "./claude-sessions.js";
import { listCodexStoredSessions, loadCodexStoredTimeline } from "./codex-sessions.js";
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
}

const PERMISSION_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMELINE_ITEMS = 200;
const MAX_SNAPSHOT_ITEMS = 80;
const MAX_SNAPSHOT_TEXT_BYTES = 128 * 1024;

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateUtf8(value: string | undefined, maxBytes = MAX_SNAPSHOT_TEXT_BYTES): string | undefined {
  if (!value) return value;
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) {
    end = Math.floor(end * 0.9);
  }
  return `${value.slice(0, end)}\n\n[truncated by LinkShell: original ${Buffer.byteLength(value, "utf8")} bytes]`;
}

function snapshotContentBlocks(
  blocks: AgentContentBlock[] | undefined,
  options: { stripImages?: boolean } = {},
): AgentContentBlock[] | undefined {
  if (!blocks) return undefined;
  return blocks.map((block) =>
    block.type === "image" && options.stripImages !== false
      ? { ...block, data: undefined, text: block.text || "图片附件" }
      : { ...block, text: truncateUtf8(block.text) },
  );
}

function snapshotTimelineItem(
  item: AgentTimelineItem,
  options: { stripImages?: boolean } = {},
): AgentTimelineItem {
  return {
    ...item,
    content: snapshotContentBlocks(item.content, options),
    text: truncateUtf8(item.text),
    toolCall: item.toolCall
      ? {
          ...item.toolCall,
          input: truncateUtf8(item.toolCall.input),
          output: truncateUtf8(item.toolCall.output),
        }
      : undefined,
    commandExecution: item.commandExecution
      ? {
          ...item.commandExecution,
          command: truncateUtf8(item.commandExecution.command, 16 * 1024),
          output: truncateUtf8(item.commandExecution.output),
        }
      : undefined,
    fileChange: item.fileChange
      ? {
          ...item.fileChange,
          diff: truncateUtf8(item.fileChange.diff),
          summary: truncateUtf8(item.fileChange.summary),
        }
      : undefined,
    permission: item.permission
      ? {
          ...item.permission,
          toolInput: truncateUtf8(item.permission.toolInput),
          context: truncateUtf8(item.permission.context),
        }
      : undefined,
  };
}

function snapshotTimelineItems(items: AgentTimelineItem[]): AgentTimelineItem[] {
  return items.slice(-MAX_SNAPSHOT_ITEMS).map((item) => snapshotTimelineItem(item));
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
    selectionLimit: firstNumber(raw, ["selectionLimit", "maxSelections"]),
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
const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const AGENT_PERMISSION_MODES: AgentPermissionMode[] = ["read_only", "workspace_write", "full_access"];
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
    return [];
  }
  if (provider === "claude") {
    const custom = customClaudeCommands(cwd).map((command) => ({
      ...command,
      disabledReason: command.disabledReason ?? disabledReason,
    }));
    return custom;
  }
  return [];
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
    Array.isArray(raw?.models) ? raw.models :
    Array.isArray(raw?.items) ? raw.items :
    Array.isArray(raw?.modelOptions) ? raw.modelOptions :
    [];
  const models = modelsValue
    .map((entry, index) => {
      const model = asRecord(entry);
      if (!model) {
        return typeof entry === "string" && entry
          ? { id: entry, label: entry }
          : undefined;
      }
      const modelId = firstString(model, ["id", "model", "name", "value"]) ?? `model-${index + 1}`;
      const label = firstString(model, ["label", "title", "displayName", "name"]) ?? modelId;
      return { id: modelId, label };
    })
    .filter((entry): entry is AgentModelOption => Boolean(entry));
  const defaultModel =
    firstString(raw, ["defaultModel", "default_model", "currentModel"]) ??
    firstString(asRecord(raw?.defaults), ["model"]);
  const effortsValue =
    Array.isArray(raw?.reasoningEfforts) ? raw.reasoningEfforts :
    Array.isArray(raw?.reasoning_efforts) ? raw.reasoning_efforts :
    Array.isArray(raw?.efforts) ? raw.efforts :
    undefined;
  const reasoningEfforts = effortsValue
    ?.filter((entry): entry is string => typeof entry === "string" && ALL_REASONING_EFFORTS.includes(entry as typeof ALL_REASONING_EFFORTS[number]));
  if (models.length === 0 && !defaultModel && !reasoningEfforts?.length) return undefined;
  return {
    ...(models.length > 0 ? { models: [{ id: "default", label: "默认模型" }, ...models] } : {}),
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
  archived?: boolean;
}> {
  const raw = asRecord(value);
  const sessionsValue =
    Array.isArray(value) ? value :
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
    archived?: boolean;
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
      title: firstString(source, ["title", "name", "summary"]),
      model: firstString(source, ["model", "modelId"]),
      createdAt: parseTimestamp(source.createdAt ?? source.created_at),
      lastActivityAt: parseTimestamp(source.lastActivityAt ?? source.updatedAt ?? source.modifiedAt ?? source.lastModified ?? source.updated_at),
      archived: typeof source.archived === "boolean" ? source.archived : undefined,
    });
  }
  return result;
}

export class AgentWorkspaceProxy {
  private clients = new Map<AgentProvider, AcpClient | ClaudeSdkClient | ClaudeStreamJsonClient>();
  private agentProtocols = new Map<AgentProvider, AgentProtocol>();
  private providerCapabilities = new Map<AgentProvider, ProviderRuntimeCapabilities>();
  private initialized = false;
  private status: AgentStatus = "unavailable";
  private error: string | undefined;
  private activeConversationId: string | undefined;
  private currentTurnIds = new Map<string, string>();
  private turnConversationIds = new Map<string, string>();
  private conversations = new Map<string, AgentConversation>();
  private conversationByAgentSessionId = new Map<string, string>();
  private timelines = new Map<string, AgentTimelineItem[]>();
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
      hostDeviceId: string;
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
      case "agent.v2.conversation.list": {
        const payload = parseTypedPayload("agent.v2.conversation.list", envelope.payload);
        await this.syncProviderSessions();
        const conversations = [...this.conversations.values()].filter((conversation) =>
          payload.includeArchived ? true : !conversation.archived,
        );
        this.input.send(createEnvelope({
          type: "agent.v2.conversation.list.result",
          hostDeviceId: this.input.hostDeviceId,
          payload: { conversations },
        }));
        break;
      }
      case "agent.v2.snapshot.request": {
        const payload = parseTypedPayload("agent.v2.snapshot.request", envelope.payload);
        this.sendSnapshot(payload.conversationId);
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
        this.cancelPendingPermissions(payload.conversationId);
        const cancelClient = conversation ? this.clientForProvider(conversation.provider) : undefined;
        cancelClient?.cancel({
          sessionId: conversation?.agentSessionId,
          turnId: this.currentTurnIds.get(payload.conversationId),
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

  private protocolForProvider(provider: AgentProvider): AgentProtocol | undefined {
    return this.agentProtocols.get(provider);
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
    if (typeof listModels !== "function") return;
    try {
      const result = await listModels.call(client);
      const runtimeCapabilities = parseModelListCapabilities(result);
      if (runtimeCapabilities) this.providerCapabilities.set(provider, runtimeCapabilities);
    } catch (error) {
      if (this.input.verbose) {
        process.stderr.write(`[agent:v2] model/list failed for ${provider}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  private async syncProviderSessions(): Promise<void> {
    await this.initialize();
    this.upsertProviderSessions("codex", listCodexStoredSessions(this.input.cwd));
    this.upsertProviderSessions("claude", listClaudeStoredSessions(this.input.cwd));
    for (const [provider, client] of this.clients) {
      try {
        const result = await client.listSessions();
        this.upsertProviderSessions(provider, result);
      } catch (error) {
        if (this.input.verbose) {
          process.stderr.write(`[agent:v2] session list failed for ${provider}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
  }

  private upsertProviderSessions(provider: AgentProvider, result: unknown): void {
    for (const remote of parseRemoteSessions(result)) {
      const agentSessionId = remote.id;
      const existingId = this.conversationByAgentSessionId.get(agentSessionId);
      const now = Date.now();
      const conversationId = existingId ?? `agent:${agentSessionId}`;
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
        archived: remote.archived ?? existing?.archived ?? false,
        lastMessagePreview: existing?.lastMessagePreview,
        lastActivityAt: remote.lastActivityAt ?? existing?.lastActivityAt ?? now,
        createdAt: remote.createdAt ?? existing?.createdAt ?? now,
      };
      this.conversations.set(conversation.id, conversation);
      this.conversationByAgentSessionId.set(agentSessionId, conversation.id);
      this.timelines.set(conversation.id, this.timelines.get(conversation.id) ?? []);
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
      const supportsReasoningEffort = enabled;
      const commands = mergeCommands(
        defaultProviderCommands(provider, this.input.cwd, enabled),
        runtimeCapabilities?.commands,
      );
      const currentMode = [...this.conversations.values()].find((conversation) => conversation.provider === provider)?.collaborationMode;
      return {
        id: provider,
        label: providerLabel(provider),
        enabled,
        reason: enabled ? undefined : `${providerLabel(provider)} 未安装或启动失败`,
        supportsImages,
        supportsPermission,
        supportsPlan: enabled,
        supportsCancel: enabled,
        models: runtimeCapabilities?.models ?? [{ id: "default", label: "默认模型" }],
        defaultModel: runtimeCapabilities?.defaultModel,
        reasoningEfforts: supportsReasoningEffort
          ? runtimeCapabilities?.reasoningEfforts ?? (provider === "claude" ? [...CLAUDE_REASONING_EFFORTS] : [...ALL_REASONING_EFFORTS])
          : [],
        permissionModes: supportsPermission ? AGENT_PERMISSION_MODES : [],
        commands,
        modes: runtimeCapabilities?.modes ?? [],
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
      hostDeviceId: this.input.hostDeviceId,
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
    const cwd = payload.cwd ?? this.input.cwd;
    let agentSessionId = payload.agentSessionId;
    let existingConversation =
      (payload.conversationId ? this.conversations.get(payload.conversationId) : undefined) ??
      (agentSessionId ? this.conversations.get(this.conversationByAgentSessionId.get(agentSessionId) ?? "") : undefined);

    if (existingConversation && existingConversation.status !== "error" && existingConversation.agentSessionId) {
      if (payload.conversationId && existingConversation.id !== payload.conversationId) {
        existingConversation = this.adoptConversationId(existingConversation.id, payload.conversationId);
      }
      this.hydrateStoredTimeline(existingConversation);
      this.activeConversationId = existingConversation.id;
      this.input.send(createEnvelope({
        type: "agent.v2.conversation.opened",
        hostDeviceId: this.input.hostDeviceId,
        payload: {
          conversation: existingConversation,
          snapshot: snapshotTimelineItems(this.timelines.get(existingConversation.id) ?? []),
        },
      }));
      return existingConversation;
    }

    if (!provider) {
      return this.openFailure(payload, "没有可用的 Agent provider。");
    }
    if (!this.input.availableProviders.includes(provider)) {
      return this.openFailure(
        payload,
        `${providerLabel(provider)} 未安装或不可用。`,
      );
    }

    const client = await this.ensureProviderClient(provider);
    if (!client) {
      return this.openFailure(
        payload,
        `${providerLabel(provider)} 启动失败。请确认 CLI 已安装并可用。`,
      );
    }

    try {
      const result = agentSessionId
        ? await client.loadSession({ sessionId: agentSessionId, cwd })
        : await client.newSession({ cwd });
      agentSessionId = this.extractSessionId(result) ?? agentSessionId ?? id("agent-session");
      const now = Date.now();
      const conversationId = payload.conversationId ?? `agent:${agentSessionId}`;
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
      this.hydrateStoredTimeline(conversation);
      this.input.send(createEnvelope({
        type: "agent.v2.conversation.opened",
        hostDeviceId: this.input.hostDeviceId,
        payload: { conversation, snapshot: snapshotTimelineItems(this.timelines.get(conversation.id) ?? []) },
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
      hostDeviceId: this.input.hostDeviceId,
      payload: { conversation, snapshot: snapshotTimelineItems(this.timelines.get(conversation.id) ?? []) },
    }));
    return conversation;
  }

  private async sendPrompt(payload: {
    conversationId: string;
    clientMessageId: string;
    contentBlocks: AgentContentBlock[];
    model?: string | null;
    reasoningEffort?: string | null;
    permissionMode?: AgentPermissionMode | null;
    collaborationMode?: AgentCollaborationMode | null;
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
        error: "Agent session 尚未就绪，消息没有发送。请重新打开对话后再试。",
        createdAt: Date.now(),
      });
      return;
    }
    const client = this.clientForProvider(conversation.provider);
    if (!client) {
      this.addItem(conversation.id, {
        id: id("error"),
        conversationId: conversation.id,
        type: "error",
        error: `${providerLabel(conversation.provider)} 未连接，消息没有发送。`,
        createdAt: Date.now(),
      });
      return;
    }

    const protocol = this.protocolForProvider(conversation.provider);
    if (payload.contentBlocks.some((block) => block.type === "image") && !protocolSupportsImages(protocol)) {
      conversation.status = "idle";
      conversation.lastActivityAt = Date.now();
      this.emitConversation(conversation);
      this.addItem(conversation.id, {
        id: id("error"),
        conversationId: conversation.id,
        type: "error",
        error: "当前 Agent provider 暂不支持图片输入，请升级 CLI 或切换到 Codex。",
        createdAt: Date.now(),
      });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "model")) {
      conversation.model = payload.model ?? undefined;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "reasoningEffort")) {
      conversation.reasoningEffort = payload.reasoningEffort ?? undefined;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "permissionMode")) {
      conversation.permissionMode = payload.permissionMode ?? undefined;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "collaborationMode")) {
      conversation.collaborationMode = payload.collaborationMode ?? "default";
    }
    conversation.status = "running";
    conversation.lastActivityAt = Date.now();
    this.activeConversationId = conversation.id;

    const userText = textFromBlocks(payload.contentBlocks);
    this.addItem(conversation.id, {
      id: payload.clientMessageId,
      conversationId: conversation.id,
      type: "message",
      role: "user",
      content: payload.contentBlocks,
      text: userText,
      createdAt: Date.now(),
    });
    this.emitConversation(conversation);

    try {
      const result = await client.prompt({
        sessionId: conversation.agentSessionId,
        content: payload.contentBlocks,
        clientMessageId: payload.clientMessageId,
        model: conversation.model,
        reasoningEffort: conversation.reasoningEffort,
        permissionMode: conversation.permissionMode,
        collaborationMode: conversation.collaborationMode,
        cwd: conversation.cwd,
      });
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
        this.addItem(conversation.id, {
          id: id("error"),
          conversationId: conversation.id,
          type: "error",
          error: `${command.title} 暂无 ${providerLabel(conversation.provider)} 原生实现。`,
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
      return;
    }
    if (
      method.startsWith("account/") ||
      method.startsWith("mcpServer/startupStatus/") ||
      method === "thread/status/changed" ||
      method === "thread/tokenUsage/updated" ||
      method === "serverRequest/resolved" ||
      method === "mcpServer/oauthLogin/completed"
    ) {
      return;
    }

    const conversationId = this.conversationIdFromParams(params) ?? this.fallbackConversationId();
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
    const formatResponse = source === "mcpServer/elicitation/request"
      ? formatMcpElicitationResponse
      : formatStructuredInputResponse;
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
        resolve(formatResponse({}));
        this.markStructuredInput(conversationId, structuredInput.requestId, {
          inputPending: false,
          inputError: "等待用户输入超时",
        });
      }, PERMISSION_TIMEOUT_MS);
      this.structuredInputWaiters.set(structuredInput.requestId, { resolve, timer, source });
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
    const permission: AgentPermission = {
      requestId,
      toolName: firstString(rawToolCall, ["toolName", "tool", "name", "title", "kind"]),
      toolInput: stringify(rawToolCall.input ?? rawToolCall.toolInput ?? rawToolCall),
      context: firstString(raw, ["context", "description", "message", "title"]),
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.upsertItem(conversationId, item);
    this.input.send(createEnvelope({
      type: "agent.v2.permission.request",
      hostDeviceId: this.input.hostDeviceId,
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
    this.pendingPermissions.delete(payload.requestId);
    const selectedOptionId =
      payload.optionId ?? selectPermissionOption(permission, payload.outcome);
    const waiter = this.permissionWaiters.get(payload.requestId);
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
    this.updateConversationStatus(payload.conversationId, "running");
  }

  private respondStructuredInput(payload: {
    conversationId: string;
    requestId: string;
    answers: Record<string, string[]>;
  }): void {
    const pending = this.pendingStructuredInputs.get(payload.requestId);
    this.pendingStructuredInputs.delete(payload.requestId);
    const waiter = this.structuredInputWaiters.get(payload.requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.structuredInputWaiters.delete(payload.requestId);
      const formatResponse = waiter.source === "mcpServer/elicitation/request"
        ? formatMcpElicitationResponse
        : formatStructuredInputResponse;
      waiter.resolve(formatResponse(payload.answers));
    }
    this.markStructuredInput(payload.conversationId, payload.requestId, {
      inputPending: false,
      inputSubmitted: true,
      inputSubmitting: false,
      inputError: undefined,
      answers: payload.answers,
    });
    this.updateConversationStatus(pending?.conversationId ?? payload.conversationId, "running");
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
      hostDeviceId: this.input.hostDeviceId,
      payload: { conversationId, conversation, item: snapshotTimelineItem(item, { stripImages: false }) },
    }));
  }

  private emitConversation(conversation: AgentConversation): void {
    this.input.send(createEnvelope({
      type: "agent.v2.event",
      hostDeviceId: this.input.hostDeviceId,
      payload: { conversationId: conversation.id, conversation },
    }));
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
    if (conversationId) {
      const conversation = this.conversations.get(conversationId);
      if (conversation) this.hydrateStoredTimeline(conversation);
    } else if (this.activeConversationId) {
      const conversation = this.conversations.get(this.activeConversationId);
      if (conversation) this.hydrateStoredTimeline(conversation);
    }
    const conversations = [...this.conversations.values()];
    const items = conversationId
      ? snapshotTimelineItems(this.timelines.get(conversationId) ?? [])
      : [];
    this.input.send(createEnvelope({
      type: "agent.v2.snapshot",
      hostDeviceId: this.input.hostDeviceId,
      payload: {
        conversations,
        activeConversationId: this.activeConversationId,
        items,
      },
    }));
  }

  private hydrateStoredTimeline(conversation: AgentConversation): void {
    if (!conversation.agentSessionId) return;
    const existing = this.timelines.get(conversation.id) ?? [];
    if (existing.length > 0) return;
    const result = conversation.provider === "codex"
      ? loadCodexStoredTimeline(conversation.agentSessionId, conversation.id, conversation.cwd || this.input.cwd)
      : conversation.provider === "claude"
      ? loadClaudeStoredTimeline(conversation.agentSessionId, conversation.id)
      : { items: [] };
    if (result.items.length === 0) return;
    const items = result.items
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-MAX_TIMELINE_ITEMS) as AgentTimelineItem[];
    this.timelines.set(conversation.id, items);
    for (const item of items) this.rememberItemConversationId(conversation.id, item);
    const lastMessage = [...items].reverse().find((item) => item.text?.trim());
    if (lastMessage?.text && !conversation.lastMessagePreview) {
      conversation.lastMessagePreview = previewText(lastMessage.text);
    }
    const lastActivityAt = items.at(-1)?.createdAt;
    if (lastActivityAt) {
      conversation.lastActivityAt = Math.max(conversation.lastActivityAt, lastActivityAt);
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
    this.cancelPendingPermissions();
    for (const conversation of this.conversations.values()) {
      if (conversation.provider !== provider) continue;
      conversation.status = "error";
      conversation.lastMessagePreview = message;
      conversation.lastActivityAt = Date.now();
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

  private cancelPendingPermissions(conversationId?: string): void {
    for (const [requestId, waiter] of this.permissionWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(formatPermissionResponse(
        this.permissionSources.get(requestId),
        "cancelled",
        "cancelled",
      ));
      this.pendingPermissions.delete(requestId);
      this.permissionSources.delete(requestId);
    }
    this.permissionWaiters.clear();
    for (const [requestId, waiter] of this.structuredInputWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(formatStructuredInputResponse({}));
      const pending = this.pendingStructuredInputs.get(requestId);
      if (pending) {
        this.markStructuredInput(pending.conversationId, requestId, {
          inputPending: false,
          inputError: "已停止",
        });
      }
      this.pendingStructuredInputs.delete(requestId);
    }
    this.structuredInputWaiters.clear();
    if (conversationId) this.updateConversationStatus(conversationId, "idle");
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
