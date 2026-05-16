import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { createEnvelope, parseTypedPayload } from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";
import type { ProjectRecord } from "../storage/projects";
import type { SessionInfo, SessionManagerHandle } from "./useSessionManager";
import {
  archiveAgentConversation,
  loadAgentHistoryPageState,
  loadAgentConversations,
  loadAgentTimeline,
  makeAgentConversationId,
  replaceAgentConversationsForDevice,
  renameAgentConversation,
  saveAgentHistoryPageState,
  saveAgentTimeline,
  upsertAgentConversation,
  upsertAgentTimelineItem,
  type AgentCapabilities,
  type AgentCollaborationMode,
  type AgentCommandDescriptor,
  type AgentContentBlock,
  type AgentConversationRecord,
  type AgentFileChange,
  type AgentModelOption,
  type AgentProvider,
  type AgentProviderCapability,
  type AgentPermissionMode,
  type AgentReasoningEffort,
  type AgentServiceTier,
  type AgentStructuredInput,
  type AgentStructuredInputOption,
  type AgentStructuredInputQuestion,
  type AgentTimelineItem,
  type AgentToolCall,
} from "../storage/agent-workspace";

interface OpenConversationInput {
  conversationId?: string;
  agentSessionId?: string;
  hostDeviceId?: string;
  sessionId: string;
  machineId?: string;
  serverUrl?: string;
  cwd: string;
  provider?: AgentProvider;
  title?: string;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  serviceTier?: AgentServiceTier;
  permissionMode?: AgentPermissionMode;
  collaborationMode?: AgentCollaborationMode;
}

export interface OpenConversationResult {
  conversationId: string | null;
  status?: AgentConversationRecord["status"];
  error?: string;
}

type CodexRpcId = string | number;
type CodexDeliveryState = "pending" | "confirmed" | "failed";

interface CodexRpcMessage {
  jsonrpc?: string;
  id?: CodexRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface CodexMessageItem {
  threadId: string;
  turnId?: string;
  itemId: string;
  orderIndex: number;
  role?: "user" | "assistant" | "system";
  type:
    | "message"
    | "command"
    | "file_change"
    | "tool"
    | "approval"
    | "structured_input"
    | "status"
    | "error"
    | "reasoning"
    | "plan"
    | "review"
    | "context_compaction";
  text?: string;
  content?: AgentContentBlock[];
  fileChange?: AgentFileChange;
  command?: string;
  output?: string;
  diff?: string;
  requestId?: string;
  rpcId?: CodexRpcId;
  requestMethod?: string;
  structuredInput?: AgentTimelineItem["structuredInput"];
  answers?: Record<string, string[]>;
  permissionOutcome?: "allow" | "deny" | "cancelled";
  permissionSubmitting?: boolean;
  permissionError?: string;
  raw?: unknown;
  isStreaming?: boolean;
  deliveryState: CodexDeliveryState;
  createdAt: number;
  updatedAt?: number;
}

interface PendingCodexDelta {
  conversationId: string;
  item: CodexMessageItem;
}

interface CodexThreadState {
  threadId: string;
  conversationId: string;
  nextCursor?: string;
  activeTurnId?: string;
  isRunning: boolean;
  items: CodexMessageItem[];
}

interface PendingCodexRequest {
  sessionId: string;
  method: string;
  conversationId?: string;
  clientMessageId?: string;
  resolve?: (message: CodexRpcMessage) => void;
  reject?: (message: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AgentFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
}

export interface AgentFileBrowseResult {
  path: string;
  entries: AgentFileEntry[];
  error?: string;
}

export interface AgentFileReadResult {
  path: string;
  content: string;
  encoding: "utf8";
  size?: number;
  truncated: boolean;
  error?: string;
}

export interface AgentWorkspaceHandle {
  conversations: AgentConversationRecord[];
  archivedConversations: AgentConversationRecord[];
  activeConversationId: string | null;
  capabilitiesBySessionId: Map<string, AgentCapabilities>;
  connectedSessions: SessionInfo[];
  refresh: () => Promise<void>;
  requestCapabilities: (sessionId?: string) => void;
  requestConversationList: (sessionId?: string) => void;
  refreshConversation: (conversationId: string) => void;
  openConversation: (input: OpenConversationInput) => Promise<OpenConversationResult>;
  openProject: (record: ProjectRecord) => Promise<string | null>;
  resumeConversation: (conversationId: string) => Promise<string | null>;
  ensureConversationSession: (conversationId: string, preferredSessionId?: string) => boolean;
  getConversation: (conversationId: string) => AgentConversationRecord | undefined;
  getTimeline: (conversationId: string) => AgentTimelineItem[];
  sendPrompt: (
    conversationId: string,
    text: string,
    options?: {
      model?: string;
      reasoningEffort?: AgentReasoningEffort;
      serviceTier?: AgentServiceTier;
      permissionMode?: AgentPermissionMode;
      collaborationMode?: AgentCollaborationMode;
      attachments?: AgentContentBlock[];
      forceSteer?: boolean;
    },
  ) => void;
  executeCommand: (
    conversationId: string,
    command: AgentCommandDescriptor,
    rawText: string,
    args?: string,
  ) => void;
  updateConversationSettings: (
    conversationId: string,
    settings: {
      model?: string;
      reasoningEffort?: AgentReasoningEffort;
      serviceTier?: AgentServiceTier;
      permissionMode?: AgentPermissionMode;
      collaborationMode?: AgentCollaborationMode;
    },
  ) => Promise<void>;
  cancel: (conversationId: string) => void;
  respondPermission: (
    conversationId: string,
    requestId: string,
    outcome: "allow" | "deny" | "cancelled",
    optionId?: string,
  ) => boolean;
  suppressPermissionRequest: (
    conversationId: string,
    requestId: string,
    outcome?: "allow" | "deny" | "cancelled",
    optionId?: string,
  ) => void;
  respondStructuredInput: (
    conversationId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ) => void;
  browseFiles: (conversationId: string, path: string) => Promise<AgentFileBrowseResult>;
  readFile: (conversationId: string, path: string, maxBytes?: number) => Promise<AgentFileReadResult>;
  loadOlderHistory: (conversationId: string) => void;
  archive: (conversationId: string, archived: boolean) => Promise<void>;
  rename: (conversationId: string, title: string) => Promise<void>;
}

function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function textFromBlocks(blocks: AgentContentBlock[] | undefined): string {
  return (blocks ?? [])
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "image") return `[${block.mimeType ?? "image"} attachment]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizePromptFileReference(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim();
  if (!value) return undefined;
  if (/^(https?:|mailto:|tel:|sms:|linkshell:)/i.test(value)) return undefined;
  if (/^file:\/\//i.test(value)) value = value.replace(/^file:\/\//i, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep non-URI text as-is.
  }
  value = value
    .replace(/[#?].*$/, "")
    .replace(/:(\d+)(?::\d+)?$/, "")
    .trim();
  if (!value || value.includes("\0")) return undefined;
  if (value.startsWith("/") || value.startsWith("~") || value.startsWith("./") || value.startsWith("../")) return value;
  if (value.includes("/") || /^[\w.-]+\.[A-Za-z0-9]+$/.test(value)) return value;
  return undefined;
}

function fileNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function normalizePosixPath(path: string): string {
  const absolute = path.startsWith("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  return `${absolute ? "/" : ""}${segments.join("/")}` || (absolute ? "/" : ".");
}

function base64ToUtf8(data: string): string {
  const atobFn = (globalThis as { atob?: (value: string) => string }).atob;
  if (typeof atobFn !== "function") return "";
  const binary = atobFn(data);
  const bytes = Array.from(binary, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
  try {
    return decodeURIComponent(bytes);
  } catch {
    return binary;
  }
}

function resolvePromptFileReference(path: string, cwd: string | undefined): string {
  if (path.startsWith("/") || path.startsWith("~")) return path;
  const root = cwd?.replace(/\/+$/, "") || "";
  if (!root) return path;
  if (path.startsWith("./")) return normalizePosixPath(`${root}/${path.slice(2)}`);
  if (path.startsWith("../")) return normalizePosixPath(`${root}/${path}`);
  return normalizePosixPath(`${root}/${path}`);
}

function extractPromptFileBlocks(text: string, cwd: string | undefined): AgentContentBlock[] {
  const blocks: AgentContentBlock[] = [];
  const seen = new Set<string>();
  const pattern = /(^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[2] ?? match[3] ?? match[4];
    const normalized = normalizePromptFileReference(raw);
    if (!normalized) continue;
    const path = resolvePromptFileReference(normalized, cwd);
    if (seen.has(path)) continue;
    seen.add(path);
    blocks.push({
      type: "file",
      path,
      name: fileNameFromPath(path),
      text: `@${normalized}`,
    });
  }
  return blocks;
}

function titleFromCwd(cwd: string | undefined): string {
  return cwd?.split("/").filter(Boolean).pop() || "Codex";
}

function stableCodexTitle(incoming: string | undefined, previous: string | undefined, cwd: string): string {
  const title = incoming?.trim();
  if (title && title !== "Codex") return title;
  return previous?.trim() || titleFromCwd(cwd);
}

function previewFromItem(item: AgentTimelineItem): string | undefined {
  if (item.error) return item.error;
  if (item.kind === "subagent_action" && item.subagent) {
    const count = Math.max(1, item.subagent.receiverThreadIds.length, item.subagent.receiverAgents.length);
    return count === 1 ? "子 Agent 活动" : `${count} 个子 Agent 活动`;
  }
  if (item.kind === "user_input_prompt") return "Agent 需要补充信息";
  if (item.kind === "thinking") return "正在思考";
  if (item.kind === "review") return "正在审查";
  if (item.kind === "context_compaction") return "正在压缩上下文";
  if (item.text) return item.text.replace(/\s+/g, " ").trim().slice(0, 160);
  if (item.type === "message") return textFromBlocks(item.content).replace(/\s+/g, " ").trim().slice(0, 160);
  if (item.toolCall) return `${item.toolCall.name} · ${item.toolCall.status}`;
  if (item.permission) return `需要授权 ${item.permission.toolName ?? ""}`.trim();
  return undefined;
}

function mergeTimeline(
  current: AgentTimelineItem[],
  incoming: AgentTimelineItem[],
): AgentTimelineItem[] {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    map.set(item.id, item);
  }
  return [...map.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-200);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(value: unknown, keys: string[]): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim()) return raw;
  }
  return undefined;
}

function firstNumber(value: unknown, keys: string[]): number | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))) return Number(raw);
  }
  return undefined;
}

function codexTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function codexOptionalTimestamp(value: unknown): number | undefined {
  const parsed = codexTimestamp(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function arrayFromKeys(value: unknown, keys: string[]): unknown[] {
  const record = asRecord(value);
  if (!record) return [];
  for (const key of keys) {
    const raw = record[key];
    if (Array.isArray(raw)) return raw;
  }
  return [];
}

function codexText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(codexText).filter(Boolean).join("\n");
  }
  const record = asRecord(value);
  if (!record) return "";
  const direct = firstString(record, ["text", "content", "message", "delta", "output"]);
  if (direct) return direct;
  return codexText(record.content ?? record.message ?? record.parts ?? record.items);
}

function normalizedCodexToken(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[_\-\s/]+/g, "")
    : "";
}

function codexItemType(value: unknown): string {
  const record = asRecord(value);
  return normalizedCodexToken(firstString(record, ["type", "kind", "name"]) ?? "");
}

function codexMessageMergeKey(item: Pick<CodexMessageItem, "turnId" | "itemId" | "requestId" | "type">): string {
  if ((item.type === "approval" || item.type === "structured_input") && item.requestId) {
    return `${item.type}:${item.requestId}`;
  }
  return `${item.turnId ?? "no-turn"}:${item.itemId}`;
}

function codexTimelineItemId(item: CodexMessageItem): string {
  if (item.type === "approval" && item.requestId) return `approval:${item.requestId}`;
  if (item.type === "structured_input" && item.requestId) return `input:${item.requestId}`;
  return `codex:${codexMessageMergeKey(item)}`;
}

function codexItemStatus(value: unknown): AgentToolCall["status"] {
  const normalized = normalizedCodexToken(codexStatus(value));
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "running" || normalized === "inprogress" || normalized === "active" || normalized === "streaming") return "running";
  if (normalized === "pending" || normalized === "queued") return "pending";
  return "completed";
}

function codexContentBlocks(value: unknown): AgentContentBlock[] {
  if (typeof value === "string") return value.trim() ? [{ type: "text", text: value }] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => codexContentBlocks(entry));
  const record = asRecord(value);
  if (!record) return [];
  const rawType = firstString(record, ["type", "kind"]);
  const normalizedType = rawType?.toLowerCase().replace(/[_\-\s/]+/g, "");
  if (normalizedType === "image" || normalizedType === "inputimage" || normalizedType === "outputimage") {
    const data = firstString(record, ["data", "url", "uri", "imageUrl", "image_url", "base64"]);
    const mimeType = firstString(record, ["mimeType", "mime_type", "mediaType", "media_type"]);
    const text = firstString(record, ["text", "alt", "caption", "name"]);
    return [{ type: "image", data, mimeType, text }];
  }
  if (normalizedType === "text" || normalizedType === "inputtext" || normalizedType === "outputtext") {
    const text = firstString(record, ["text", "content", "message"]);
    return text ? [{ type: "text", text }] : [];
  }
  if (normalizedType === "file" || normalizedType === "inputfile" || normalizedType === "filereference") {
    const path = firstString(record, ["path", "file", "filePath", "file_path", "absolutePath", "relativePath"]);
    const text = firstString(record, ["text", "name", "label"]);
    return path ? [{ type: "file", path, name: text, text: text ?? `@${path}` }] : [];
  }
  const nested = codexContentBlocks(record.content ?? record.message ?? record.parts ?? record.items);
  if (nested.length > 0) return nested;
  const text = firstString(record, ["text", "delta", "output"]);
  return text ? [{ type: "text", text }] : [];
}

function codexInitializeErrorIsBenign(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already\s+initialized/i.test(message) || message.includes("Codex request timed out: initialize");
}

function codexPreviewIsControlNoise(value: string | undefined): boolean {
  if (!value) return false;
  return /already\s+initialized/i.test(value) || value.includes("Codex request timed out: initialize");
}

function codexStatus(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return firstString(record, ["status", "state", "phase", "lifecycle", "type"]) ??
    firstString(asRecord(record.status), ["type", "status", "state"]) ??
    firstString(asRecord(record.state), ["type", "status", "state"]);
}

function codexRunningTurnId(value: unknown): string | undefined {
  return firstString(value, [
    "runningTurnId",
    "running_turn_id",
    "activeTurnId",
    "active_turn_id",
    "currentTurnId",
    "current_turn_id",
    "turnId",
  ]) ?? firstString(asRecord(value)?.activeTurn, ["id", "turnId"]);
}

function codexThreadIsRunning(value: unknown): boolean {
  const status = codexStatus(value)?.toLowerCase();
  return Boolean(codexRunningTurnId(value)) ||
    status === "active" ||
    status === "inprogress" ||
    status === "in_progress" ||
    status === "in-progress" ||
    status === "running" ||
    status === "busy" ||
    status === "streaming";
}

function codexThreadIsWaitingForUser(value: unknown): boolean {
  const statusRecord = asRecord(asRecord(value)?.status) ?? asRecord(value);
  const flags = Array.isArray(statusRecord?.activeFlags) ? statusRecord.activeFlags : [];
  return flags.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput");
}

function summarizeCodexFileChanges(changes: unknown[]): string | undefined {
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
  return lines.length > 0 ? lines.slice(0, 12).join("\n") : undefined;
}

function codexFileChangeEntriesFromValue(value: unknown): AgentFileChange["entries"] {
  const item = asRecord(value);
  if (!item) return [];
  const changes = [
    ...(Array.isArray(item.changes) ? item.changes : []),
    ...(Array.isArray(item.entries) ? item.entries : []),
    ...(Array.isArray(item.files) ? item.files : []),
    ...(Array.isArray(item.fileChanges) ? item.fileChanges : []),
  ];
  const entries: AgentFileChange["entries"] = [];
  for (const change of changes) {
    const raw = asRecord(change);
    if (!raw) continue;
    const path =
      firstString(raw, ["path", "file", "filePath", "absolutePath", "relativePath"]) ??
      firstString(asRecord(raw.update), ["path", "file", "filePath"]);
    if (!path) continue;
    const totals = asRecord(raw.totals) ?? asRecord(raw.diffStats) ?? asRecord(raw.stats);
    const kind = firstString(raw, ["kind", "type", "operation", "action"]);
    const added = firstNumber(raw, ["added", "additions"]) ?? firstNumber(totals, ["added", "additions"]);
    const removed = firstNumber(raw, ["removed", "deletions"]) ?? firstNumber(totals, ["removed", "deletions"]);
    entries.push({
      path,
      kind,
      added,
      removed,
    });
  }
  const directPath = firstString(item, ["path", "file", "filePath", "absolutePath", "relativePath"]);
  if (entries.length === 0 && directPath) {
    entries.push({
      path: directPath,
      kind: firstString(item, ["kind", "type", "operation", "action"]),
    });
  }
  return entries;
}

function codexLooksLikeDiff(text: string): boolean {
  const value = text.trim();
  return value.startsWith("diff --git ") ||
    value.startsWith("*** Begin Patch") ||
    value.startsWith("@@ ") ||
    value.includes("\n@@ ") ||
    (value.includes("\n--- ") && value.includes("\n+++ "));
}

function codexCollectDiffStrings(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === undefined || value === null) return [];
  if (typeof value === "string") return codexLooksLikeDiff(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => codexCollectDiffStrings(entry, depth + 1));
  const raw = asRecord(value);
  if (!raw) return [];
  const direct: string[] = [];
  const nested: string[] = [];
  for (const [key, entry] of Object.entries(raw)) {
    const lowerKey = key.toLowerCase();
    const isDiffField = lowerKey.includes("diff") || lowerKey.includes("patch") || lowerKey.includes("unified");
    if (typeof entry === "string" && isDiffField && codexLooksLikeDiff(entry)) {
      direct.push(entry);
    } else if (entry && typeof entry === "object") {
      nested.push(...codexCollectDiffStrings(entry, depth + 1));
    }
  }
  return [...direct, ...nested];
}

function codexDiffText(value: unknown): string | undefined {
  const diffs = codexCollectDiffStrings(value)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return diffs.length > 0
    ? diffs.filter((entry, index, array) => array.indexOf(entry) === index).join("\n\n")
    : undefined;
}

function codexFileChangeFromValue(
  value: unknown,
  status: AgentFileChange["status"],
  fallbackDiff?: string,
): AgentFileChange | undefined {
  const item = asRecord(value);
  const changes = item
    ? [
        ...(Array.isArray(item.changes) ? item.changes : []),
        ...(Array.isArray(item.entries) ? item.entries : []),
        ...(Array.isArray(item.files) ? item.files : []),
        ...(Array.isArray(item.fileChanges) ? item.fileChanges : []),
      ]
    : [];
  const entries = codexFileChangeEntriesFromValue(value);
  const diff = fallbackDiff ?? codexDiffText(value);
  const summary = changes.length > 0 ? summarizeCodexFileChanges(changes) : undefined;
  const changeSetId = firstString(value, ["changeSetId", "changesetId", "patchId"]);
  if (entries.length === 0 && !diff && !summary && !changeSetId) return undefined;
  return { entries, diff, summary, changeSetId, status };
}

function codexPlanStepsFromValue(value: unknown): AgentTimelineItem["plan"] | undefined {
  const record = asRecord(value);
  const candidates = [
    ...(Array.isArray(value) ? value : []),
    ...(Array.isArray(record?.steps) ? record.steps : []),
    ...(Array.isArray(record?.plan) ? record.plan : []),
    ...(Array.isArray(record?.items) ? record.items : []),
  ];
  const steps = candidates
    .map((entry, index) => {
      const raw = asRecord(entry);
      const text = raw
        ? firstString(raw, ["text", "content", "description", "title", "step"])
        : typeof entry === "string"
          ? entry
          : undefined;
      if (!text?.trim()) return undefined;
      const statusToken = normalizedCodexToken(firstString(raw, ["status", "state"]) ?? "");
      return {
        id: firstString(raw, ["id", "stepId", "step_id"]) ?? `step-${index + 1}`,
        text: text.trim(),
        status: statusToken === "completed" || statusToken === "done"
          ? "completed" as const
          : statusToken === "inprogress" || statusToken === "running" || statusToken === "active"
            ? "in_progress" as const
            : "pending" as const,
      };
    })
    .filter((entry): entry is NonNullable<AgentTimelineItem["plan"]>[number] => Boolean(entry));
  return steps.length > 0 ? steps : undefined;
}

function codexToolNameFromValue(value: unknown): string | undefined {
  const raw = asRecord(value);
  return firstString(raw, ["toolName", "tool_name", "name", "command", "title", "label"]) ??
    firstString(asRecord(raw?.tool), ["name", "toolName"]);
}

function codexToolInputFromValue(value: unknown): string | undefined {
  const raw = asRecord(value);
  return codexText(raw?.input ?? raw?.arguments ?? raw?.args ?? raw?.params ?? raw?.content);
}

function codexGeneratedImageMarkdown(value: unknown): string | undefined {
  const raw = asRecord(value);
  const candidates = [
    firstString(raw, ["url", "uri", "imageUrl", "image_url", "data"]),
    firstString(asRecord(raw?.image), ["url", "uri", "data"]),
    firstString(asRecord(raw?.output), ["url", "uri", "data"]),
  ].filter((entry): entry is string => Boolean(entry));
  const source = candidates[0];
  if (!source) return undefined;
  const alt = firstString(raw, ["alt", "caption", "prompt", "text"]) ?? "Generated image";
  return `![${alt.replace(/[\]\n\r]/g, " ")}](${source})`;
}

function codexThreadId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return firstString(record, ["threadId", "conversationId", "sessionId"]) ??
    firstString(record.thread, ["id", "threadId"]);
}

function codexTurnId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return firstString(record, ["turnId", "id"]) ?? firstString(record.turn, ["id", "turnId"]);
}

function codexTurnStatus(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return firstString(record, ["status", "state"]) ?? firstString(record.turn, ["status", "state"]);
}

function codexTurnStatusIsRunning(status: string | undefined): boolean {
  const normalized = status?.toLowerCase();
  return normalized === "inprogress" ||
    normalized === "in_progress" ||
    normalized === "in-progress" ||
    normalized === "running" ||
    normalized === "active" ||
    normalized === "streaming";
}

function codexTurnStatusIsFailed(status: string | undefined): boolean {
  const normalized = status?.toLowerCase();
  return normalized === "failed" || normalized === "error";
}

function codexItemId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return firstString(record, ["itemId", "messageId", "toolCallId", "callId", "id"]) ??
    firstString(record.item, ["id", "itemId"]);
}

function isCodexUnmaterializedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("not materialized yet") ||
    message.includes("unavailable before first user message") ||
    message.includes("no rollout found for thread id");
}

function codexInputBlocks(blocks: AgentContentBlock[]): unknown[] {
  return blocks.map((block) => {
    if (block.type === "image" && block.data) {
      return { type: "image", url: block.data };
    }
    if (block.type === "file" && block.path) {
      return { type: "mention", path: block.path, name: block.name ?? fileNameFromPath(block.path) };
    }
    return { type: "text", text: block.text ?? "", text_elements: [] };
  });
}

function codexTurnToMessages(turn: unknown, threadId: string, turnIndex: number): CodexMessageItem[] {
  const record = asRecord(turn);
  const turnId = codexTurnId(turn) ?? `turn-${turnIndex + 1}`;
  const baseCreatedAt = codexTimestamp(
    record?.createdAt ?? record?.created_at ?? record?.startedAt ?? record?.completedAt,
  );
  const items = Array.isArray(record?.items) ? record.items : [];
  const messages: CodexMessageItem[] = [];

  if (items.length > 0) {
    items.forEach((rawItem, itemIndex) => {
      const item = asRecord(rawItem);
      if (!item) return;
      const type = codexItemType(item);
      const itemId = codexItemId(item) ?? `${turnId}:item-${itemIndex + 1}`;
      const createdAt = codexTimestamp(
        item.createdAt ?? item.created_at ?? item.startedAt ?? item.completedAt,
        baseCreatedAt + itemIndex,
      );
      const baseItem = {
        threadId,
        turnId,
        itemId,
        orderIndex: messages.length + 1,
        raw: item,
        deliveryState: "confirmed" as const,
        createdAt,
      };
      if (type === "usermessage" || (type === "message" && normalizedCodexToken(item.role) === "user")) {
        const content = codexContentBlocks(item.content ?? item.text ?? item);
        const text = textFromBlocks(content) || codexText(item.content ?? item.text ?? item);
        if (!text && content.length === 0) return;
        messages.push({
          ...baseItem,
          role: "user",
          type: "message",
          text,
          content,
        });
        return;
      }
      if (
        type === "agentmessage" ||
        type === "assistantmessage" ||
        (type === "message" && normalizedCodexToken(item.role) !== "user")
      ) {
        const content = codexContentBlocks(item.content ?? item.text ?? item);
        const text = textFromBlocks(content) || codexText(item.text ?? item.content ?? item);
        if (!text && content.length === 0) return;
        messages.push({
          ...baseItem,
          role: "assistant",
          type: "message",
          text,
          content,
        });
        return;
      }
      if (type === "plan" || type === "planupdate" || type === "updateplan") {
        const plan = codexPlanStepsFromValue(item);
        const text = codexText(item.plan ?? item.steps ?? item.content ?? item.text ?? item);
        if (!plan && !text) return;
        messages.push({
          ...baseItem,
          role: "assistant",
          type: "plan",
          text,
          raw: { ...item, plan },
        });
        return;
      }
      if (type === "reasoning" || type === "thinking" || type === "reasoningsummary") {
        const text = codexText(item.summary ?? item.text ?? item.content ?? item);
        if (!text) return;
        messages.push({
          ...baseItem,
          role: "system",
          type: "reasoning",
          text,
        });
        return;
      }
      if (type === "imagegeneration" || type === "imagegenerationcall" || type === "imagegenerationend" || type === "imageview") {
        const text = codexGeneratedImageMarkdown(item);
        if (!text) return;
        messages.push({
          ...baseItem,
          role: "assistant",
          type: "message",
          text,
          content: [{ type: "text", text }],
        });
        return;
      }
      if (type === "commandexecution" || type.includes("command")) {
        messages.push({
          ...baseItem,
          type: "command",
          command: firstString(item, ["command", "name"]) ?? codexToolNameFromValue(item),
          output: codexText(item.output ?? item.text ?? item.content ?? item.result),
        });
        return;
      }
      if (type === "filechange" || type === "diff" || type.includes("filechange")) {
        const diff = firstString(item, ["diff", "patch", "unified_diff"]) ?? codexDiffText(item);
        const status = codexItemStatus(item);
        const fileChange = codexFileChangeFromValue(item, status, diff);
        messages.push({
          ...baseItem,
          type: "file_change",
          text: fileChange?.summary ?? codexText(item.summary ?? item.text ?? item.content ?? item),
          diff,
          fileChange,
        });
        return;
      }
      if (type === "toolcall" || type.includes("tool")) {
        const name = codexToolNameFromValue(item) ?? "工具";
        const inputText = codexToolInputFromValue(item);
        const output = codexText(item.output ?? item.result ?? item.text ?? item.content);
        messages.push({
          ...baseItem,
          type: "tool",
          command: name,
          text: inputText,
          output,
        });
        return;
      }
      if (type === "enteredreviewmode" || type === "review") {
        const text = codexText(item.review ?? item.text ?? item.content) || "Reviewing changes...";
        messages.push({
          ...baseItem,
          role: "system",
          type: "review",
          text,
        });
        return;
      }
      if (type === "exitedreviewmode") {
        const content = codexContentBlocks(item.review ?? item.text ?? item.content);
        const text = textFromBlocks(content) || codexText(item.review ?? item.text ?? item.content);
        if (!text) return;
        messages.push({
          ...baseItem,
          role: "assistant",
          type: "message",
          text,
          content,
        });
        return;
      }
      if (type === "contextcompaction" || type === "compact" || type === "compaction") {
        const text = codexText(item.summary ?? item.text ?? item.content ?? item);
        messages.push({
          ...baseItem,
          role: "system",
          type: "context_compaction",
          text: text || "上下文已压缩",
        });
      }
    });
    return messages;
  }

  const input = Array.isArray(record?.input) ? record?.input : Array.isArray(record?.inputs) ? record?.inputs : [];
  const output = Array.isArray(record?.output) ? record?.output : [];
  const userContent = codexContentBlocks(input);
  const userText = textFromBlocks(userContent) || codexText(input);
  if (userText || userContent.length > 0) {
    messages.push({
      threadId,
      turnId,
      itemId: `${turnId}:user`,
      orderIndex: messages.length + 1,
      role: "user",
      type: "message",
      text: userText,
      content: userContent,
      deliveryState: "confirmed",
      createdAt: baseCreatedAt,
    });
  }
  const assistantContent = codexContentBlocks(output);
  const assistantText = textFromBlocks(assistantContent) || codexText(output);
  if (assistantText || assistantContent.length > 0) {
    messages.push({
      threadId,
      turnId,
      itemId: `${turnId}:assistant`,
      orderIndex: messages.length + 1,
      role: "assistant",
      type: "message",
      text: assistantText,
      content: assistantContent,
      deliveryState: "confirmed",
      createdAt: baseCreatedAt + 1,
    });
  }
  return messages;
}

function parseCodexStructuredInputOption(value: unknown, index: number): AgentStructuredInputOption | undefined {
  const raw = asRecord(value);
  if (!raw) {
    if (typeof value === "string" && value.trim()) {
      return { id: value.trim(), label: value.trim() };
    }
    return undefined;
  }
  const label = firstString(raw, ["label", "title", "text", "value", "id"]);
  if (!label) return undefined;
  return {
    id: firstString(raw, ["id", "optionId", "value", "label"]) ?? `option-${index + 1}`,
    label,
    description: firstString(raw, ["description", "detail", "subtitle"]),
  };
}

function parseCodexStructuredInputQuestion(value: unknown, index: number): AgentStructuredInputQuestion | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const question = firstString(raw, ["question", "prompt", "message", "text", "label"]);
  if (!question) return undefined;
  const options = arrayFromKeys(raw, ["options", "choices", "items"])
    .map(parseCodexStructuredInputOption)
    .filter((option): option is AgentStructuredInputOption => Boolean(option));
  return {
    id: firstString(raw, ["id", "questionId", "key", "name"]) ?? `question-${index + 1}`,
    header: firstString(raw, ["header", "title"]),
    question,
    isOther: raw.isOther === true,
    isSecret: raw.isSecret === true || raw.secret === true,
    selectionLimit: firstNumber(raw, ["selectionLimit", "maxSelections"]),
    options: options.length > 0 ? options : undefined,
  };
}

function decodeCodexStructuredInput(
  params: unknown,
  requestId: string,
): AgentStructuredInput | undefined {
  const raw = asRecord(params) ?? {};
  const input = asRecord(raw.input);
  const source = input ?? raw;
  const questions = [
    ...arrayFromKeys(raw, ["questions", "items", "prompts"]),
    ...arrayFromKeys(input, ["questions", "items", "prompts"]),
  ]
    .map(parseCodexStructuredInputQuestion)
    .filter((question): question is AgentStructuredInputQuestion => Boolean(question));
  if (questions.length === 0) {
    const single = parseCodexStructuredInputQuestion(source, 0);
    if (single) questions.push(single);
  }
  if (questions.length === 0) return undefined;
  return { requestId, questions };
}

function isCodexStructuredInputRequest(method: string): boolean {
  return (
    method === "item/tool/requestUserInput" ||
    method === "tool/requestUserInput" ||
    method === "mcpServer/elicitation/request"
  );
}

function isCodexApprovalRequest(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "applyPatchApproval" ||
    method === "execCommandApproval" ||
    method.includes("requestApproval")
  );
}

function codexApprovalToolName(method: string, params: unknown): string {
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") return "文件修改";
  if (method === "item/permissions/requestApproval") return "请求更多权限";
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") return "运行命令";
  return firstString(params, ["toolName", "name"]) ?? "Codex 权限";
}

function codexApprovalToolInput(method: string, params: unknown): string | undefined {
  const raw = asRecord(params);
  if (!raw) return undefined;
  if (method === "item/commandExecution/requestApproval") {
    return firstString(raw, ["command"]);
  }
  if (method === "execCommandApproval") {
    const command = raw.command;
    if (Array.isArray(command)) return command.map(String).join(" ");
    return firstString(raw, ["command"]);
  }
  if (method === "item/fileChange/requestApproval") {
    return [
      firstString(raw, ["grantRoot"]) ? `允许写入：${firstString(raw, ["grantRoot"])}` : undefined,
      firstString(raw, ["itemId"]) ? `item: ${firstString(raw, ["itemId"])}` : undefined,
    ].filter(Boolean).join("\n") || undefined;
  }
  if (method === "applyPatchApproval") {
    const changes = asRecord(raw.fileChanges);
    const files = changes ? Object.keys(changes) : [];
    return files.length > 0 ? files.join("\n") : codexText(raw.fileChanges);
  }
  if (method === "item/permissions/requestApproval") {
    const text = codexText(raw.permissions);
    if (text) return text;
    try {
      return JSON.stringify(raw.permissions ?? {}, null, 2);
    } catch {
      return undefined;
    }
  }
  return codexText(raw.command ?? raw.fileChanges ?? raw.permissions ?? raw);
}

function codexApprovalContext(params: unknown): string | undefined {
  const raw = asRecord(params);
  if (!raw) return undefined;
  return firstString(raw, ["reason", "context", "message"]) ??
    firstString(raw.networkApprovalContext, ["description", "reason", "message", "target", "host"]);
}

function hasJsonRpcId(message: CodexRpcMessage): message is CodexRpcMessage & { id: CodexRpcId } {
  return Object.prototype.hasOwnProperty.call(message, "id") &&
    (typeof message.id === "string" || typeof message.id === "number");
}

function isCodexJsonRpcResponse(message: CodexRpcMessage): message is CodexRpcMessage & { id: CodexRpcId } {
  return hasJsonRpcId(message) &&
    typeof message.method !== "string" &&
    (
      Object.prototype.hasOwnProperty.call(message, "result") ||
      Object.prototype.hasOwnProperty.call(message, "error")
    );
}

function isCodexJsonRpcRequest(message: CodexRpcMessage): message is CodexRpcMessage & { id: CodexRpcId; method: string } {
  return hasJsonRpcId(message) && typeof message.method === "string";
}

function parseCodexReasoningEffort(value: unknown): AgentReasoningEffort | undefined {
  return value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : undefined;
}

function parseCodexServiceTier(value: unknown): AgentServiceTier | undefined {
  return value === "standard" || value === "fast" ? value : undefined;
}

const CODEX_REASONING_EFFORTS: AgentReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
const CODEX_PERMISSION_MODES: AgentPermissionMode[] = ["read_only", "workspace_write", "full_access"];
const CODEX_DEFAULT_SPEED_TIERS: AgentServiceTier[] = ["standard"];
const CODEX_TIMELINE_CACHE_ENABLED = true;
const CODEX_STREAMING_DELTA_FLUSH_MS = 16;
const CODEX_RPC_COMMANDS: AgentCommandDescriptor[] = [
  {
    id: "codex:rpc:plan",
    name: "plan",
    title: "/plan",
    description: "Enter Codex Plan mode for the next turn",
    provider: "codex",
    source: "built_in",
    category: "Codex",
    argsMode: "none",
    executionKind: "local_ui",
  },
  {
    id: "codex:rpc:exit-plan",
    name: "exit-plan",
    title: "/exit-plan",
    description: "Exit Codex Plan mode",
    provider: "codex",
    source: "built_in",
    category: "Codex",
    argsMode: "none",
    executionKind: "local_ui",
  },
  {
    id: "codex:rpc:review",
    name: "review",
    title: "/review",
    description: "Review current changes with Codex",
    provider: "codex",
    source: "built_in",
    category: "Codex",
    argsMode: "optional",
    executionKind: "native",
  },
  {
    id: "codex:rpc:compact",
    name: "compact",
    title: "/compact",
    description: "Compact the current Codex thread",
    provider: "codex",
    source: "built_in",
    category: "Codex",
    argsMode: "none",
    requiresIdle: true,
    executionKind: "native",
  },
  {
    id: "codex:rpc:new",
    name: "new",
    title: "/new",
    description: "Start a fresh Codex thread",
    provider: "codex",
    source: "built_in",
    category: "Codex",
    argsMode: "none",
    destructive: true,
    executionKind: "native",
  },
];

function codexRpcCommands(supportsPlan: boolean): AgentCommandDescriptor[] {
  return supportsPlan
    ? CODEX_RPC_COMMANDS
    : CODEX_RPC_COMMANDS.filter((command) => command.name !== "plan" && command.name !== "exit-plan");
}

function codexSandboxPolicy(mode: AgentPermissionMode | undefined, cwd: string): unknown {
  if (mode === "full_access") return { type: "dangerFullAccess" };
  if (mode === "read_only") return { type: "readOnly", networkAccess: false };
  if (mode === "workspace_write") {
    return {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return undefined;
}

function codexApprovalPolicy(mode: AgentPermissionMode | undefined): unknown {
  if (mode === "full_access") return "never";
  if (mode === "read_only" || mode === "workspace_write") return "on-request";
  return undefined;
}

function codexSandboxMode(mode: AgentPermissionMode | undefined): string | undefined {
  if (mode === "full_access") return "danger-full-access";
  if (mode === "read_only") return "read-only";
  if (mode === "workspace_write") return "workspace-write";
  return undefined;
}

function codexThreadStartParams(input: {
  cwd: string;
  model?: string;
  serviceTier?: AgentServiceTier;
  permissionMode?: AgentPermissionMode;
}) {
  return {
    cwd: input.cwd,
    sessionStartSource: "startup",
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier === "fast" ? { serviceTier: input.serviceTier } : {}),
    ...(codexApprovalPolicy(input.permissionMode) ? { approvalPolicy: codexApprovalPolicy(input.permissionMode) } : {}),
    ...(codexSandboxMode(input.permissionMode) ? { sandbox: codexSandboxMode(input.permissionMode) } : {}),
  };
}

function codexTurnStartParams(input: {
  threadId: string;
  cwd: string;
  contentBlocks: AgentContentBlock[];
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  serviceTier?: AgentServiceTier;
  permissionMode?: AgentPermissionMode;
  collaborationMode?: AgentCollaborationMode;
  includeCollaborationMode?: boolean;
}) {
  const collaborationMode = input.includeCollaborationMode === false || !input.collaborationMode || !input.model
    ? undefined
    : {
        mode: input.collaborationMode,
        settings: {
          model: input.model,
          reasoning_effort: input.reasoningEffort ?? null,
          developer_instructions: null,
        },
      };
  return {
    threadId: input.threadId,
    cwd: input.cwd,
    input: codexInputBlocks(input.contentBlocks),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
    ...(input.serviceTier === "fast" ? { serviceTier: input.serviceTier } : {}),
    ...(codexApprovalPolicy(input.permissionMode) ? { approvalPolicy: codexApprovalPolicy(input.permissionMode) } : {}),
    ...(codexSandboxPolicy(input.permissionMode, input.cwd) ? { sandboxPolicy: codexSandboxPolicy(input.permissionMode, input.cwd) } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  };
}

function codexResponseContainsPlanCollaborationMode(value: unknown): boolean {
  const raw = asRecord(value);
  const candidates = [
    Array.isArray(value) ? value : undefined,
    Array.isArray(raw?.data) ? raw.data : undefined,
    Array.isArray(raw?.modes) ? raw.modes : undefined,
    Array.isArray(raw?.collaborationModes) ? raw.collaborationModes : undefined,
    Array.isArray(raw?.items) ? raw.items : undefined,
  ].filter((entry): entry is unknown[] => Array.isArray(entry));

  return candidates.some((entries) => entries.some((entry) => {
    if (typeof entry === "string") return entry === "plan";
    const record = asRecord(entry);
    return firstString(record, ["mode", "name", "id"]) === "plan";
  }));
}

function codexShouldRetryWithoutCollaborationMode(error: unknown): boolean {
  const message = codexRpcErrorMessage(error).toLowerCase();
  if (!message.includes("collaborationmode") && !message.includes("collaboration_mode")) return false;
  return (
    message.includes("experimentalapi") ||
    message.includes("unsupported") ||
    message.includes("unknown") ||
    message.includes("unexpected") ||
    message.includes("unrecognized") ||
    message.includes("invalid") ||
    message.includes("field") ||
    message.includes("mode")
  );
}

function parseCodexModelList(value: unknown): {
  models: AgentModelOption[];
  defaultModel?: string;
  reasoningEfforts: AgentReasoningEffort[];
  speedTiers: AgentServiceTier[];
  supportsImages: boolean;
} {
  const raw = asRecord(value);
  const entries = Array.isArray(raw?.data)
    ? raw.data
    : Array.isArray(raw?.models)
    ? raw.models
    : Array.isArray(value)
    ? value
    : [];
  const effortSet = new Set<AgentReasoningEffort>();
  const speedTierSet = new Set<AgentServiceTier>(CODEX_DEFAULT_SPEED_TIERS);
  let defaultModel: string | undefined;
  let supportsImages = false;
  const models = entries
    .map((entry): AgentModelOption | undefined => {
      const item = asRecord(entry);
      if (!item || item.hidden === true) return undefined;
      const id = firstString(item, ["id", "model", "name"]);
      if (!id) return undefined;
      const efforts = arrayFromKeys(item, ["supportedReasoningEfforts", "reasoningEfforts"])
        .map((effort) => parseCodexReasoningEffort(
          asRecord(effort)?.reasoningEffort ?? asRecord(effort)?.id ?? effort,
        ))
        .filter((effort): effort is AgentReasoningEffort => Boolean(effort));
      efforts.forEach((effort) => effortSet.add(effort));
      const defaultReasoningEffort = parseCodexReasoningEffort(item.defaultReasoningEffort);
      if (defaultReasoningEffort) effortSet.add(defaultReasoningEffort);
      const inputModalities = arrayFromKeys(item, ["inputModalities", "modalities"]);
      const speedTiers = arrayFromKeys(item, ["additionalSpeedTiers", "additional_speed_tiers", "serviceTiers", "service_tiers"])
        .map(parseCodexServiceTier)
        .filter((tier): tier is AgentServiceTier => Boolean(tier));
      speedTiers.forEach((tier) => speedTierSet.add(tier));
      const modelSupportsImages = inputModalities.includes("image");
      supportsImages = supportsImages || modelSupportsImages;
      if (item.isDefault === true) defaultModel = id;
      return {
        id,
        label: firstString(item, ["displayName", "label", "title", "model"]) ?? id,
        reasoningEfforts: efforts.length > 0 ? efforts : undefined,
        defaultReasoningEffort,
        speedTiers: speedTiers.length > 0 ? ["standard", ...speedTiers.filter((tier) => tier !== "standard")] : undefined,
        supportsImages: modelSupportsImages,
        description: firstString(item, ["description"]),
      };
    })
    .filter((model): model is AgentModelOption => Boolean(model));
  return {
    models,
    defaultModel,
    reasoningEfforts: [...effortSet],
    speedTiers: [...speedTierSet],
    supportsImages,
  };
}

function codexConfigModel(value: unknown): string | undefined {
  const config = asRecord(asRecord(value)?.config);
  return firstString(config, ["model"]);
}

function codexConfigReasoningEffort(value: unknown): AgentReasoningEffort | undefined {
  const config = asRecord(asRecord(value)?.config);
  return parseCodexReasoningEffort(config?.model_reasoning_effort ?? config?.reasoningEffort);
}

function codexConfigServiceTier(value: unknown): AgentServiceTier | undefined {
  const config = asRecord(asRecord(value)?.config);
  return parseCodexServiceTier(config?.service_tier ?? config?.serviceTier);
}

function codexRpcErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = asRecord(error);
  return firstString(record, ["message", "error"]) ?? "Codex runtime request failed";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function humanizeCodexRpcError(message: string): string {
  if (
    message.includes("TokenRefreshFailed") ||
    message.includes("Failed to parse server response") ||
    message.includes("Transport channel closed")
  ) {
    return "Codex 登录状态已失效或刷新失败，请在主机端重新运行 codex login 后重试。";
  }
  return message;
}

function failPendingCodexRequestsForSession(
  pendingMap: Map<CodexRpcId, PendingCodexRequest>,
  sessionId: string,
  message: string,
): Array<{ conversationId?: string; clientMessageId?: string }> {
  const failed: Array<{ conversationId?: string; clientMessageId?: string }> = [];
  for (const [id, pending] of pendingMap) {
    if (pending.sessionId !== sessionId) continue;
    pendingMap.delete(id);
    clearTimeout(pending.timer);
    failed.push({
      conversationId: pending.conversationId,
      clientMessageId: pending.clientMessageId,
    });
    pending.reject?.(message);
  }
  return failed;
}

function mergeAgentCapabilities(existing: AgentCapabilities | undefined, incoming: AgentCapabilities): AgentCapabilities {
  const existingCodex = existing?.providers?.find((provider) => provider.id === "codex");
  if (
    existingCodex?.modelsSource === "runtime" &&
    existingCodex.models?.length &&
    incoming.providers?.some((provider) =>
      provider.id === "codex" &&
      (provider.modelsSource === "fallback" || provider.modelsSource === "unavailable" || !provider.models?.length)
    )
  ) {
    const providers = incoming.providers.map((provider) =>
      provider.id === "codex" ? { ...provider, ...existingCodex } : provider,
    );
    return {
      ...incoming,
      providers,
      supportsImages: providers.some((provider) => Boolean(provider.supportsImages)),
      supportsPermission: providers.some((provider) => Boolean(provider.supportsPermission)),
      supportsPlan: providers.some((provider) => Boolean(provider.supportsPlan)),
      supportsCancel: providers.some((provider) => Boolean(provider.supportsCancel)),
    };
  }
  return incoming;
}

function formatCodexStructuredInputResult(
  item: CodexMessageItem,
  answers: Record<string, string[]>,
): unknown {
  if (item.requestMethod === "mcpServer/elicitation/request") {
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
  return { answers };
}

function codexMessageToTimeline(item: CodexMessageItem, conversationId: string): AgentTimelineItem {
  if (item.type === "structured_input" && item.structuredInput) {
    const requestId = item.requestId ?? item.structuredInput.requestId;
    return {
      id: `input:${requestId}`,
      conversationId,
      type: "tool_call",
      kind: "user_input_prompt",
      turnId: item.turnId,
      itemId: item.itemId,
      role: "system",
      text: item.text,
      structuredInput: item.structuredInput,
      metadata: {
        provider: "codex",
        codexRpcId: item.rpcId ?? requestId,
        codexRequestMethod: item.requestMethod,
        deliveryState: item.deliveryState,
        inputPending: item.deliveryState === "pending",
        inputSubmitting: item.deliveryState === "pending" && Boolean(item.answers),
        inputSubmitted: item.deliveryState === "confirmed",
        inputError: item.deliveryState === "failed" ? item.output : undefined,
        answers: item.answers,
      },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.type === "approval") {
    return {
      id: item.itemId,
      conversationId,
      type: "permission",
      kind: "tool_activity",
      turnId: item.turnId,
      itemId: item.itemId,
      permission: {
        requestId: item.requestId ?? item.itemId,
        toolName: item.command ?? item.requestMethod ?? "Codex",
        toolInput: item.text,
        context: item.output,
        options: [
          { id: "allow", label: "允许", kind: "allow" },
          { id: "deny", label: "拒绝", kind: "deny" },
        ],
      },
      metadata: {
        provider: "codex",
        codexRpcId: item.rpcId ?? item.requestId,
        codexRequestMethod: item.requestMethod,
        deliveryState: item.deliveryState,
        permissionLive: item.deliveryState !== "confirmed" && item.deliveryState !== "failed",
        permissionExpired: false,
        permissionPending: item.permissionSubmitting === true,
        permissionOutcome: item.permissionOutcome,
        permissionError: item.permissionError,
      },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
  if (item.type === "command") {
    return {
      id: codexTimelineItemId(item),
      conversationId,
      type: "tool_call",
      kind: "command_execution",
      turnId: item.turnId,
      itemId: item.itemId,
      commandExecution: {
        command: item.command ?? item.text,
        output: item.output,
        status: item.isStreaming ? "running" : item.deliveryState === "failed" ? "failed" : "completed",
      },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.type === "file_change") {
    return {
      id: codexTimelineItemId(item),
      conversationId,
      type: "tool_call",
      kind: "file_change",
      turnId: item.turnId,
      itemId: item.itemId,
      fileChange: {
        entries: item.fileChange?.entries ?? [],
        diff: item.fileChange?.diff ?? item.diff ?? item.text,
        summary: item.fileChange?.summary ?? item.output,
        changeSetId: item.fileChange?.changeSetId,
        status: item.isStreaming ? "running" : item.deliveryState === "failed" ? "failed" : "completed",
      },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.type === "error") {
    return {
      id: codexTimelineItemId(item),
      conversationId,
      type: "error",
      error: item.text ?? "Codex request failed",
      metadata: { deliveryState: item.deliveryState },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
  if (item.type === "reasoning") {
    return {
      id: codexTimelineItemId(item),
      conversationId,
      type: "status",
      kind: "thinking",
      turnId: item.turnId,
      itemId: item.itemId,
      role: "system",
      text: item.text,
      metadata: { provider: "codex", deliveryState: item.deliveryState },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.type === "plan") {
    const plan = codexPlanStepsFromValue(asRecord(item.raw)?.plan ?? item.raw ?? item.text);
    return {
      id: codexTimelineItemId(item),
      conversationId,
      type: plan ? "plan" : "status",
      kind: "plan",
      turnId: item.turnId,
      itemId: item.itemId,
      role: "assistant",
      text: item.text,
      plan,
      metadata: { provider: "codex", deliveryState: item.deliveryState },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.type === "review" || item.type === "context_compaction" || item.type === "status") {
    return {
      id: codexTimelineItemId(item),
      conversationId,
      type: "status",
      kind: item.type === "context_compaction" ? "context_compaction" : item.type === "review" ? "review" : "tool_activity",
      turnId: item.turnId,
      itemId: item.itemId,
      role: "system",
      text: item.text,
      metadata: { provider: "codex", deliveryState: item.deliveryState },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.type === "tool") {
    return {
      id: codexTimelineItemId(item),
      conversationId,
      type: "tool_call",
      kind: "tool_activity",
      turnId: item.turnId,
      itemId: item.itemId,
      text: item.text || item.output || item.command,
      toolCall: {
        id: item.itemId,
        name: item.command ?? "工具",
        input: item.text,
        output: item.output,
        createdAt: item.createdAt,
        status: item.isStreaming ? "running" : item.deliveryState === "failed" ? "failed" : "completed",
      },
      metadata: { provider: "codex", deliveryState: item.deliveryState },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  return {
    id: codexTimelineItemId(item),
    conversationId,
    type: "message",
    kind: "chat",
    turnId: item.turnId,
    itemId: item.itemId,
    role: item.role,
    content: item.content ?? (item.text ? [{ type: "text", text: item.text }] : []),
    text: item.text,
    metadata: { provider: "codex", deliveryState: item.deliveryState },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    isStreaming: item.isStreaming,
  };
}

function codexTimelineToMessage(
  item: AgentTimelineItem,
  threadId: string,
  index: number,
): CodexMessageItem | undefined {
  const metadata = item.metadata ?? {};
  const rpcId = typeof metadata.codexRpcId === "string" || typeof metadata.codexRpcId === "number"
    ? metadata.codexRpcId
    : undefined;
  const requestId = typeof metadata.codexRpcId === "string"
    ? metadata.codexRpcId
    : typeof metadata.codexRpcId === "number"
    ? String(metadata.codexRpcId)
    : undefined;
  const requestMethod = typeof metadata.codexRequestMethod === "string" ? metadata.codexRequestMethod : undefined;
  const deliveryState = metadata.deliveryState === "pending" ||
    metadata.deliveryState === "confirmed" ||
    metadata.deliveryState === "failed"
    ? metadata.deliveryState
    : item.metadata?.inputPending === true || item.metadata?.inputSubmitting === true || item.metadata?.permissionPending === true
    ? "pending"
    : item.metadata?.inputSubmitted === true || item.metadata?.permissionOutcome
    ? "confirmed"
    : item.metadata?.inputError || item.metadata?.permissionError || item.error
    ? "failed"
    : "confirmed";
  if (item.kind === "user_input_prompt" && item.structuredInput) {
    return {
      threadId,
      turnId: item.turnId,
      itemId: item.itemId ?? `input:${item.structuredInput.requestId}`,
      orderIndex: index + 1,
      role: "system",
      type: "structured_input",
      text: item.text,
      output: typeof metadata.inputError === "string" ? metadata.inputError : undefined,
      requestId: requestId ?? item.structuredInput.requestId,
      rpcId,
      requestMethod,
      structuredInput: item.structuredInput,
      answers: asAnswers(metadata.answers),
      deliveryState,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.type === "permission" && item.permission) {
    return {
      threadId,
      turnId: item.turnId,
      itemId: item.itemId ?? item.id,
      orderIndex: index + 1,
      type: "approval",
      command: item.permission.toolName,
      text: item.permission.toolInput,
      output: item.permission.context,
      requestId: requestId ?? item.permission.requestId,
      rpcId,
      requestMethod,
      permissionOutcome: metadata.permissionOutcome === "allow" || metadata.permissionOutcome === "deny" || metadata.permissionOutcome === "cancelled"
        ? metadata.permissionOutcome
        : undefined,
      permissionSubmitting: metadata.permissionPending === true,
      permissionError: typeof metadata.permissionError === "string" ? metadata.permissionError : undefined,
      deliveryState,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.kind === "command_execution") {
    return {
      threadId,
      turnId: item.turnId,
      itemId: item.itemId ?? item.id,
      orderIndex: index + 1,
      type: "command",
      command: item.commandExecution?.command,
      output: item.commandExecution?.output,
      deliveryState,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.kind === "file_change") {
    return {
      threadId,
      turnId: item.turnId,
      itemId: item.itemId ?? item.id,
      orderIndex: index + 1,
      type: "file_change",
      text: item.fileChange?.summary,
      diff: item.fileChange?.diff,
      fileChange: item.fileChange,
      deliveryState,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.kind === "thinking") {
    return {
      threadId,
      turnId: item.turnId,
      itemId: item.itemId ?? item.id,
      orderIndex: index + 1,
      role: "system",
      type: "reasoning",
      text: item.text,
      deliveryState,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.type === "plan" || item.kind === "plan") {
    return {
      threadId,
      turnId: item.turnId,
      itemId: item.itemId ?? item.id,
      orderIndex: index + 1,
      role: "assistant",
      type: "plan",
      text: item.text,
      raw: { plan: item.plan },
      deliveryState,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.kind === "review" || item.kind === "context_compaction") {
    return {
      threadId,
      turnId: item.turnId,
      itemId: item.itemId ?? item.id,
      orderIndex: index + 1,
      role: "system",
      type: item.kind === "review" ? "review" : "context_compaction",
      text: item.text,
      deliveryState,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.kind === "tool_activity" && item.toolCall) {
    return {
      threadId,
      turnId: item.turnId,
      itemId: item.itemId ?? item.id,
      orderIndex: index + 1,
      type: "tool",
      command: item.toolCall.name,
      text: item.toolCall.input,
      output: item.toolCall.output,
      deliveryState,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.type === "error") {
    return {
      threadId,
      turnId: item.turnId,
      itemId: item.itemId ?? item.id,
      orderIndex: index + 1,
      type: "error",
      text: item.error,
      deliveryState: "failed",
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
  if (item.type === "message") {
    return {
      threadId,
      turnId: item.turnId,
      itemId: item.itemId ?? item.id,
      orderIndex: index + 1,
      role: item.role,
      type: "message",
      text: item.text ?? textFromBlocks(item.content),
      content: item.content,
      deliveryState,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  return undefined;
}

function asAnswers(value: unknown): Record<string, string[]> | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const answers: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (Array.isArray(entry)) {
      answers[key] = entry.filter((item): item is string => typeof item === "string");
    } else if (typeof entry === "string") {
      answers[key] = [entry];
    }
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function normalizeSnapshotItems(items: AgentTimelineItem[]): AgentTimelineItem[] {
  return items.map((item) => {
    if (item.type === "permission" && !item.metadata?.permissionOutcome) {
      return {
        ...item,
        metadata: {
          ...(item.metadata ?? {}),
          permissionLive: false,
          permissionPending: false,
          permissionExpired: true,
          permissionError: undefined,
        },
      };
    }
    if (item.kind === "user_input_prompt" && !item.metadata?.inputSubmitted) {
      return {
        ...item,
        metadata: {
          ...(item.metadata ?? {}),
          inputSubmitting: false,
          inputPending: item.metadata?.inputPending ?? true,
          inputError: undefined,
        },
      };
    }
    return item;
  });
}

function completedIfStale(status: AgentToolCall["status"] | undefined): AgentToolCall["status"] | undefined {
  return status === "running" || status === "pending" ? "completed" : status;
}

function normalizeCachedCodexTimelineItems(items: AgentTimelineItem[]): AgentTimelineItem[] {
  return normalizeSnapshotItems(items).map((item) => {
    if (item.type === "permission" || item.kind === "user_input_prompt") return item;
    if (
      item.isStreaming !== true &&
      item.commandExecution?.status !== "running" &&
      item.commandExecution?.status !== "pending" &&
      item.toolCall?.status !== "running" &&
      item.toolCall?.status !== "pending" &&
      item.fileChange?.status !== "running" &&
      item.fileChange?.status !== "pending"
    ) {
      return item;
    }
    return {
      ...item,
      isStreaming: false,
      commandExecution: item.commandExecution
        ? { ...item.commandExecution, status: completedIfStale(item.commandExecution.status) }
        : item.commandExecution,
      toolCall: item.toolCall
        ? { ...item.toolCall, status: completedIfStale(item.toolCall.status) ?? "completed" }
        : item.toolCall,
      fileChange: item.fileChange
        ? { ...item.fileChange, status: completedIfStale(item.fileChange.status) ?? "completed" }
        : item.fileChange,
      metadata: {
        ...(item.metadata ?? {}),
        deliveryState: item.metadata?.deliveryState === "pending" ? "confirmed" : item.metadata?.deliveryState,
      },
      updatedAt: item.updatedAt ?? Date.now(),
    };
  });
}

function codexShouldPreserveLocalItem(item: CodexMessageItem): boolean {
  return item.deliveryState === "pending" ||
    item.deliveryState === "failed" ||
    item.isStreaming === true ||
    item.type === "approval" ||
    item.type === "structured_input";
}

function mergeCodexMessageItem(existing: CodexMessageItem | undefined, incoming: CodexMessageItem): CodexMessageItem {
  if (!existing) return incoming;
  if (codexShouldPreserveLocalItem(existing) && incoming.deliveryState === "confirmed" && incoming.type !== existing.type) {
    return existing;
  }
  return {
    ...existing,
    ...incoming,
    text: incoming.text ?? existing.text,
    content: incoming.content ?? existing.content,
    command: incoming.command ?? existing.command,
    output: incoming.output ?? existing.output,
    diff: incoming.diff ?? existing.diff,
    structuredInput: incoming.structuredInput ?? existing.structuredInput,
    answers: incoming.answers ?? existing.answers,
    permissionOutcome: incoming.permissionOutcome ?? existing.permissionOutcome,
    permissionSubmitting: incoming.permissionSubmitting ?? existing.permissionSubmitting,
    permissionError: incoming.permissionError ?? existing.permissionError,
    raw: incoming.raw ?? existing.raw,
    isStreaming: incoming.isStreaming === true
      ? true
      : incoming.deliveryState === "confirmed"
        ? false
        : existing.isStreaming,
    fileChange: incoming.fileChange
      ? {
          ...incoming.fileChange,
          status: incoming.isStreaming === true
            ? "running"
            : incoming.deliveryState === "confirmed"
              ? completedIfStale(incoming.fileChange.status) ?? "completed"
              : incoming.fileChange.status,
        }
      : existing.fileChange,
    createdAt: Math.min(existing.createdAt, incoming.createdAt),
    updatedAt: incoming.updatedAt ?? existing.updatedAt,
  };
}

function canonicalCodexMerge(
  existingItems: CodexMessageItem[],
  incomingItems: CodexMessageItem[],
): CodexMessageItem[] {
  const byKey = new Map<string, CodexMessageItem>();
  for (const item of existingItems) {
    byKey.set(codexMessageMergeKey(item), item);
  }
  for (const item of incomingItems) {
    const key = codexMessageMergeKey(item);
    byKey.set(key, mergeCodexMessageItem(byKey.get(key), item));
  }
  return [...byKey.values()]
    .sort((a, b) =>
      a.createdAt - b.createdAt ||
      a.orderIndex - b.orderIndex ||
      codexMessageMergeKey(a).localeCompare(codexMessageMergeKey(b))
    )
    .map((entry, index) => ({ ...entry, orderIndex: index + 1 }));
}

function finalizeCodexThreadItems(items: CodexMessageItem[], turnId?: string): CodexMessageItem[] {
  return items.map((item) => {
    if (turnId && item.turnId && item.turnId !== turnId) return item;
    if (!item.isStreaming && item.deliveryState !== "pending") return item;
    return {
      ...item,
      isStreaming: false,
      deliveryState: item.deliveryState === "pending" ? "confirmed" : item.deliveryState,
      fileChange: item.fileChange
        ? { ...item.fileChange, status: completedIfStale(item.fileChange.status) ?? "completed" }
        : item.fileChange,
      updatedAt: item.updatedAt ?? Date.now(),
    };
  });
}

export function useAgentWorkspace(
  manager: SessionManagerHandle,
): AgentWorkspaceHandle {
  const [conversations, setConversations] = useState<AgentConversationRecord[]>([]);
  const [timelineById, setTimelineById] = useState<Map<string, AgentTimelineItem[]>>(new Map());
  const [codexThreadsByConversationId, setCodexThreadsByConversationId] = useState<Map<string, CodexThreadState>>(new Map());
  const [capabilitiesBySessionId, setCapabilitiesBySessionId] = useState<Map<string, AgentCapabilities>>(new Map());
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const managerRef = useRef(manager);
  const conversationsRef = useRef(conversations);
  const timelineRef = useRef(timelineById);
  const codexThreadsRef = useRef(codexThreadsByConversationId);
  const codexTimelineItemCacheRef = useRef(new WeakMap<CodexMessageItem, AgentTimelineItem>());
  const codexThreadConversationRef = useRef(new Map<string, string>());
  const pendingCodexRef = useRef(new Map<CodexRpcId, PendingCodexRequest>());
  const initializedCodexSessionsRef = useRef(new Set<string>());
  const initializingCodexSessionsRef = useRef(new Map<string, Promise<void>>());
  const codexPlanUnsupportedSessionsRef = useRef(new Set<string>());
  const codexRpcSeqRef = useRef(1);
  const pendingOpenRef = useRef(new Map<string, {
    resolve: (result: OpenConversationResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  const pendingBrowseRef = useRef(new Map<string, {
    resolve: (result: AgentFileBrowseResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  const pendingReadRef = useRef(new Map<string, {
    resolve: (result: AgentFileReadResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  const historyCursorRef = useRef(new Map<string, string | undefined>());
  const historyHasMoreRef = useRef(new Map<string, boolean>());
  const pendingHistoryRef = useRef(new Set<string>());
  const historyPageSignatureRef = useRef(new Map<string, string>());
  const pendingCodexDeltaRef = useRef(new Map<string, PendingCodexDelta>());
  const pendingCodexDeltaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSyncTokenRef = useRef(new Map<string, string>());
  const appStateRef = useRef(AppState.currentState);
  const lastRunningSyncRef = useRef(new Map<string, number>());

  useEffect(() => {
    managerRef.current = manager;
  }, [manager]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    timelineRef.current = timelineById;
  }, [timelineById]);

  useEffect(() => {
    codexThreadsRef.current = codexThreadsByConversationId;
  }, [codexThreadsByConversationId]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      appStateRef.current = state;
    });
    return () => subscription.remove();
  }, []);

  const connectedSessions = useMemo(
    () =>
      [...manager.sessions.values()].filter((session) =>
        session.status === "connected" ||
        session.status === "reconnecting" ||
        session.status === "connecting" ||
        session.status === "host_disconnected",
      ),
    [manager.sessions],
  );

  const refresh = useCallback(async () => {
    const stored = (await loadAgentConversations()).map((conversation) =>
      conversation.provider === "codex" && conversation.status === "running"
        ? { ...conversation, status: "idle" as const, runningTurnId: undefined }
        : conversation
    );
    setConversations(stored);
    const pairs = await Promise.all(
      stored.slice(0, 20).map(async (conversation) => [
        conversation.id,
        conversation.provider === "codex" && !CODEX_TIMELINE_CACHE_ENABLED
          ? []
          : conversation.provider === "codex"
            ? normalizeCachedCodexTimelineItems(await loadAgentTimeline(conversation.id))
            : await loadAgentTimeline(conversation.id),
      ] as const),
    );
    const timelineMap = new Map(pairs);
    setTimelineById(timelineMap);
    timelineRef.current = timelineMap;
    const restoredCodexThreads = new Map<string, CodexThreadState>();
    for (const conversation of stored) {
      if (conversation.provider !== "codex") continue;
      if (!CODEX_TIMELINE_CACHE_ENABLED) {
        saveAgentTimeline(conversation.id, []).catch(() => {});
        historyHasMoreRef.current.delete(conversation.id);
        continue;
      }
      const historyPageState = await loadAgentHistoryPageState(conversation.id);
      historyCursorRef.current.set(conversation.id, historyPageState.nextCursor);
      if (typeof historyPageState.hasMore === "boolean") {
        historyHasMoreRef.current.set(conversation.id, historyPageState.hasMore);
      }
      const timeline = timelineMap.get(conversation.id) ?? [];
      const threadId = conversation.agentSessionId ?? conversation.id;
      const items = timeline
        .map((item, index) => codexTimelineToMessage(item, threadId, index))
        .filter((item): item is CodexMessageItem => Boolean(item));
      if (items.length === 0) continue;
      restoredCodexThreads.set(conversation.id, {
        conversationId: conversation.id,
        threadId,
        nextCursor: historyPageState.nextCursor,
        activeTurnId: undefined,
        isRunning: false,
        items,
      });
      codexThreadConversationRef.current.set(threadId, conversation.id);
    }
    setCodexThreadsByConversationId(restoredCodexThreads);
    codexThreadsRef.current = restoredCodexThreads;
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const persistConversation = useCallback(async (
    record: AgentConversationRecord,
    options?: { preserveLocalArchived?: boolean },
  ) => {
    const saved = await upsertAgentConversation(record, options);
    setConversations((prev) => {
      const next = prev.filter((item) => item.id !== saved.id);
      next.unshift(saved);
      return next.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    });
  }, []);

  const persistTimelineItem = useCallback(async (item: AgentTimelineItem) => {
    setTimelineById((prev) => {
      const next = new Map(prev);
      next.set(item.conversationId, mergeTimeline(next.get(item.conversationId) ?? [], [item]));
      return next;
    });
    await upsertAgentTimelineItem(item);
  }, []);

  const persistCodexThread = useCallback((conversationId: string, threadState: CodexThreadState) => {
    const cache = codexTimelineItemCacheRef.current;
    const items = threadState.items.map((item) => {
      const cached = cache.get(item);
      if (cached) return cached;
      const timelineItem = codexMessageToTimeline(item, conversationId);
      cache.set(item, timelineItem);
      return timelineItem;
    });
    const nextTimeline = new Map(timelineRef.current);
    nextTimeline.set(conversationId, items);
    timelineRef.current = nextTimeline;
    setTimelineById(nextTimeline);
    if (CODEX_TIMELINE_CACHE_ENABLED) {
      saveAgentTimeline(conversationId, items).catch(() => {});
    }
  }, []);

  const sessionForConversation = useCallback(
    (conversationId: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return undefined;
      return findSessionForConversation(conversation, manager.sessions);
    },
    [manager.sessions],
  );

  const upsertCodexItem = useCallback((conversationId: string, item: CodexMessageItem) => {
    const next = new Map(codexThreadsRef.current);
    const existing = next.get(conversationId) ?? {
      conversationId,
      threadId: item.threadId,
      isRunning: false,
      items: [],
    };
    const items = [...existing.items];
    const incomingKey = codexMessageMergeKey(item);
    const index = items.findIndex((entry) => codexMessageMergeKey(entry) === incomingKey);
    if (index >= 0) {
      items[index] = mergeCodexMessageItem(items[index], { ...item, updatedAt: item.updatedAt ?? Date.now() });
    } else {
      items.push(item);
    }
    items.sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt - b.createdAt);
    const nextThread = { ...existing, threadId: item.threadId, items };
    next.set(conversationId, nextThread);
    codexThreadConversationRef.current.set(item.threadId, conversationId);
    codexThreadsRef.current = next;
    setCodexThreadsByConversationId(next);
    persistCodexThread(conversationId, nextThread);
  }, [persistCodexThread]);

  const flushPendingCodexDeltas = useCallback(() => {
    pendingCodexDeltaTimerRef.current = null;
    const pending = [...pendingCodexDeltaRef.current.values()];
    pendingCodexDeltaRef.current.clear();
    for (const entry of pending) {
      upsertCodexItem(entry.conversationId, entry.item);
    }
  }, [upsertCodexItem]);

  const queueCodexDeltaItem = useCallback((conversationId: string, item: CodexMessageItem) => {
    pendingCodexDeltaRef.current.set(`${conversationId}:${codexMessageMergeKey(item)}`, { conversationId, item });
    if (pendingCodexDeltaTimerRef.current) return;
    pendingCodexDeltaTimerRef.current = setTimeout(flushPendingCodexDeltas, CODEX_STREAMING_DELTA_FLUSH_MS);
  }, [flushPendingCodexDeltas]);

  useEffect(() => () => {
    if (pendingCodexDeltaTimerRef.current) {
      clearTimeout(pendingCodexDeltaTimerRef.current);
      pendingCodexDeltaTimerRef.current = null;
    }
  }, []);

  const replaceCodexHistory = useCallback((
    conversationId: string,
    threadId: string,
    items: CodexMessageItem[],
    nextCursor?: string,
    mode: "replace" | "prepend" = "replace",
    activeTurnId?: string | null,
  ) => {
    const next = new Map(codexThreadsRef.current);
    const existing = next.get(conversationId);
    const shouldResetForThreadSwitch = mode === "replace" && Boolean(existing?.threadId && existing.threadId !== threadId);
    const merged = canonicalCodexMerge(shouldResetForThreadSwitch ? [] : existing?.items ?? [], items);
    const nextThread = {
      conversationId,
      threadId,
      nextCursor,
      activeTurnId: activeTurnId === undefined ? existing?.activeTurnId : activeTurnId ?? undefined,
      isRunning: activeTurnId === undefined ? (existing?.isRunning ?? false) : Boolean(activeTurnId),
      items: merged,
    };
    next.set(conversationId, nextThread);
    codexThreadConversationRef.current.set(threadId, conversationId);
    codexThreadsRef.current = next;
    setCodexThreadsByConversationId(next);
    persistCodexThread(conversationId, nextThread);
  }, [persistCodexThread]);

  const sendCodexRpc = useCallback((
    sessionId: string,
    message: CodexRpcMessage,
    options?: {
      conversationId?: string;
      clientMessageId?: string;
      timeoutMs?: number;
      queue?: boolean;
    },
  ) => {
    const session = managerRef.current.sessions.get(sessionId);
    if (!session) return false;
    return managerRef.current.sendAgentWorkspaceEnvelope(
      sessionId,
      "agent.codex.rpc" as any,
      { jsonrpc: "2.0", ...message },
      { queue: options?.queue ?? true },
    );
  }, []);

  const requestCodexRpc = useCallback((
    sessionId: string,
    method: string,
    params: unknown,
    options?: {
      conversationId?: string;
      clientMessageId?: string;
      timeoutMs?: number;
    },
  ) => {
    const id = `codex-${Date.now().toString(36)}-${codexRpcSeqRef.current++}`;
    return new Promise<CodexRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCodexRef.current.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, options?.timeoutMs ?? 30_000);
      pendingCodexRef.current.set(id, {
        sessionId,
        method,
        conversationId: options?.conversationId,
        clientMessageId: options?.clientMessageId,
        resolve,
        reject: (message) => reject(new Error(message)),
        timer,
      });
      const accepted = sendCodexRpc(sessionId, { id, method, params }, {
        conversationId: options?.conversationId,
        clientMessageId: options?.clientMessageId,
      });
      if (!accepted) {
        clearTimeout(timer);
        pendingCodexRef.current.delete(id);
        reject(new Error("Codex connection is not ready"));
      }
    });
  }, [sendCodexRpc]);

  const updateCodexRuntimeCapabilities = useCallback((
    sessionId: string,
    update: (previous?: AgentProviderCapability) => AgentProviderCapability,
  ) => {
    const session = managerRef.current.sessions.get(sessionId);
    const keys = Array.from(new Set([sessionId, session?.hostDeviceId].filter((key): key is string => Boolean(key))));
    setCapabilitiesBySessionId((prev) => {
      const existing = keys
        .map((key) => prev.get(key))
        .find((capability): capability is AgentCapabilities => Boolean(capability));
      const previousProviders = existing?.providers ?? [];
      const codexProvider = update(previousProviders.find((provider) => provider.id === "codex"));
      const providers = [
        ...previousProviders.filter((provider) => provider.id !== "codex"),
        codexProvider,
      ];
      const nextCapability: AgentCapabilities = {
        enabled: true,
        provider: existing?.provider ?? "codex",
        machineId: existing?.machineId ?? session?.machineId ?? undefined,
        providers,
        protocolVersion: existing?.protocolVersion,
        workspaceProtocolVersion: existing?.workspaceProtocolVersion ?? 2,
        capabilitiesRevision: (existing?.capabilitiesRevision ?? 0) + 1,
        error: existing?.error,
        supportsSessionList: existing?.supportsSessionList ?? true,
        supportsSessionLoad: existing?.supportsSessionLoad ?? true,
        supportsImages: providers.some((provider) => Boolean(provider.supportsImages)),
        supportsAudio: existing?.supportsAudio ?? false,
        supportsPermission: providers.some((provider) => Boolean(provider.supportsPermission)),
        supportsPlan: providers.some((provider) => Boolean(provider.supportsPlan)),
        supportsCancel: providers.some((provider) => Boolean(provider.supportsCancel)),
      };
      const next = new Map(prev);
      keys.forEach((key) => next.set(key, nextCapability));
      return next;
    });
  }, []);

  const refreshCodexRuntimeCapabilities = useCallback(async (sessionId: string) => {
    const [modelListResult, configResult, collaborationModeResult] = await Promise.allSettled([
      requestCodexRpc(sessionId, "model/list", {}, { timeoutMs: 15_000 }),
      requestCodexRpc(sessionId, "config/read", {}, { timeoutMs: 15_000 }),
      requestCodexRpc(sessionId, "collaborationMode/list", {}, { timeoutMs: 5_000 }),
    ]);
    if (collaborationModeResult.status === "fulfilled") {
      codexResponseContainsPlanCollaborationMode(collaborationModeResult.value.result);
    }
    // Remodex keeps plan enabled after experimental initialize even when the
    // metadata probe is inconclusive, and only disables it after turn/start
    // rejects collaborationMode.
    const supportsPlan = !codexPlanUnsupportedSessionsRef.current.has(sessionId);

    if (modelListResult.status === "rejected") {
      const error = codexRpcErrorMessage(modelListResult.reason);
      updateCodexRuntimeCapabilities(sessionId, (previous) => ({
        id: "codex",
        label: previous?.label ?? "Codex",
        enabled: true,
        supportsImages: previous?.supportsImages ?? true,
        supportsPermission: true,
        supportsPlan,
        supportsCancel: true,
        providerProtocol: "codex-app-server",
        modelsSource: previous?.models?.length ? previous.modelsSource : "unavailable",
        modelListError: error,
        models: previous?.models,
        defaultModel: previous?.defaultModel,
        reasoningEfforts: previous?.reasoningEfforts ?? CODEX_REASONING_EFFORTS,
        speedTiers: previous?.speedTiers ?? CODEX_DEFAULT_SPEED_TIERS,
        defaultServiceTier: previous?.defaultServiceTier,
        permissionModes: previous?.permissionModes ?? CODEX_PERMISSION_MODES,
        commands: codexRpcCommands(supportsPlan),
        modes: previous?.modes,
        currentMode: previous?.currentMode,
        features: {
          ...(previous?.features ?? {}),
          images: previous?.supportsImages ?? true,
          permissions: true,
          plan: supportsPlan,
          cancel: true,
          reasoningEffort: true,
          serviceTier: true,
        },
      }));
      return;
    }

    const parsed = parseCodexModelList(modelListResult.value.result);
    const config = configResult.status === "fulfilled" ? configResult.value.result : undefined;
    const configModel = codexConfigModel(config);
    const configReasoningEffort = codexConfigReasoningEffort(config);
    const configServiceTier = codexConfigServiceTier(config);
    const reasoningEfforts = parsed.reasoningEfforts.length > 0
      ? parsed.reasoningEfforts
      : CODEX_REASONING_EFFORTS;
    const speedTiers = parsed.speedTiers.length > 0
      ? parsed.speedTiers
      : CODEX_DEFAULT_SPEED_TIERS;
    const defaultReasoningEffort = configReasoningEffort ?? parsed.models.find((model) =>
      model.id === (configModel ?? parsed.defaultModel),
    )?.defaultReasoningEffort;
    const supportsImages = parsed.supportsImages || parsed.models.length === 0;

    updateCodexRuntimeCapabilities(sessionId, (previous) => ({
      id: "codex",
      label: previous?.label ?? "Codex",
      enabled: true,
      supportsImages,
      supportsPermission: true,
      supportsPlan,
      supportsCancel: true,
      providerProtocol: "codex-app-server",
      modelsSource: parsed.models.length > 0 ? "runtime" : "unavailable",
      modelListError: parsed.models.length > 0 ? undefined : "Codex runtime returned no models",
      models: parsed.models.length > 0 ? parsed.models : previous?.models,
      defaultModel: configModel ?? parsed.defaultModel ?? parsed.models[0]?.id ?? previous?.defaultModel,
      reasoningEfforts,
      speedTiers,
      defaultServiceTier: configServiceTier ?? previous?.defaultServiceTier,
      permissionModes: previous?.permissionModes ?? CODEX_PERMISSION_MODES,
      commands: codexRpcCommands(supportsPlan),
      modes: previous?.modes,
      currentMode: previous?.currentMode,
      features: {
        ...(previous?.features ?? {}),
        images: supportsImages,
        permissions: true,
        plan: supportsPlan,
        cancel: true,
        reasoningEffort: true,
        serviceTier: speedTiers.length > 1,
        ...(defaultReasoningEffort ? { defaultReasoningEffort: true } : {}),
      },
    }));
  }, [requestCodexRpc, updateCodexRuntimeCapabilities]);

  const ensureCodexInitialized = useCallback(async (sessionId: string) => {
    if (initializedCodexSessionsRef.current.has(sessionId)) return;
    const existing = initializingCodexSessionsRef.current.get(sessionId);
    if (existing) return existing;
    const initializing = (async () => {
      try {
        await requestCodexRpc(sessionId, "initialize", {
          clientInfo: { name: "linkshell_mobile", title: null, version: "0.1" },
          capabilities: { experimentalApi: true },
        }, { timeoutMs: 30_000 });
      } catch (error) {
        if (!codexInitializeErrorIsBenign(error)) throw error;
      }
      sendCodexRpc(sessionId, { method: "initialized", params: {} });
      initializedCodexSessionsRef.current.add(sessionId);
      refreshCodexRuntimeCapabilities(sessionId).catch((error) => {
        updateCodexRuntimeCapabilities(sessionId, (previous) => ({
          id: "codex",
          label: previous?.label ?? "Codex",
          enabled: true,
            supportsImages: previous?.supportsImages ?? true,
            supportsPermission: true,
            supportsPlan: !codexPlanUnsupportedSessionsRef.current.has(sessionId),
            supportsCancel: true,
            providerProtocol: "codex-app-server",
          modelsSource: previous?.models?.length ? previous.modelsSource : "unavailable",
          modelListError: codexRpcErrorMessage(error),
          models: previous?.models,
          defaultModel: previous?.defaultModel,
          reasoningEfforts: previous?.reasoningEfforts ?? CODEX_REASONING_EFFORTS,
          speedTiers: previous?.speedTiers ?? CODEX_DEFAULT_SPEED_TIERS,
          defaultServiceTier: previous?.defaultServiceTier,
          permissionModes: previous?.permissionModes ?? CODEX_PERMISSION_MODES,
            commands: codexRpcCommands(!codexPlanUnsupportedSessionsRef.current.has(sessionId)),
            modes: previous?.modes,
            currentMode: previous?.currentMode,
            features: {
              ...(previous?.features ?? {}),
              images: previous?.supportsImages ?? true,
              permissions: true,
              plan: !codexPlanUnsupportedSessionsRef.current.has(sessionId),
              cancel: true,
            reasoningEffort: true,
            serviceTier: true,
          },
        }));
      });
    })();
    initializingCodexSessionsRef.current.set(sessionId, initializing);
    try {
      await initializing;
    } finally {
      initializingCodexSessionsRef.current.delete(sessionId);
    }
  }, [refreshCodexRuntimeCapabilities, requestCodexRpc, sendCodexRpc, updateCodexRuntimeCapabilities]);

  const requestCodexTurns = useCallback(async (
    sessionId: string,
    conversationId: string,
    threadId: string,
    cursor?: string,
  ) => {
    let response: CodexRpcMessage;
    try {
      response = await requestCodexRpc(sessionId, "thread/turns/list", {
        threadId,
        sortDirection: "desc",
        itemsView: "summary",
        limit: 5,
        cursor,
      }, { conversationId, timeoutMs: 30_000 });
    } catch (error) {
      if (isCodexUnmaterializedThreadError(error)) {
        historyCursorRef.current.delete(conversationId);
        historyHasMoreRef.current.set(conversationId, false);
        saveAgentHistoryPageState(conversationId, { hasMore: false }).catch(() => {});
        if (!codexThreadsRef.current.has(conversationId)) {
          replaceCodexHistory(conversationId, threadId, [], undefined, cursor ? "prepend" : "replace");
        }
        return;
      }
      throw error;
    }
    const raw = asRecord(response.result);
    const turns = Array.isArray(raw?.turns)
      ? raw.turns
      : Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.data)
      ? raw.data
      : [];
    const nextCursor = typeof raw?.nextCursor === "string" ? raw.nextCursor : undefined;
    const items: CodexMessageItem[] = [];
    const activeTurnId = turns
      .map((turn) => codexTurnStatusIsRunning(codexTurnStatus(turn)) ? codexTurnId(turn) : undefined)
      .find((id): id is string => Boolean(id));
    const latestTurnStatus = turns.length > 0 ? codexTurnStatus(turns[0]) : undefined;
    turns.slice().reverse().forEach((turn, turnIndex) => {
      items.push(...codexTurnToMessages(turn, threadId, turnIndex));
    });
    const pageSignature = items.map(codexMessageMergeKey).join("|");
    const signatureKey = `${conversationId}:${cursor ?? "initial"}`;
    if (cursor && pageSignature && historyPageSignatureRef.current.get(signatureKey) === pageSignature) {
      historyHasMoreRef.current.set(conversationId, false);
      return;
    }
    historyPageSignatureRef.current.set(signatureKey, pageSignature);
    historyCursorRef.current.set(conversationId, nextCursor);
    historyHasMoreRef.current.set(conversationId, Boolean(nextCursor));
    saveAgentHistoryPageState(conversationId, { nextCursor, hasMore: Boolean(nextCursor) }).catch(() => {});
    replaceCodexHistory(
      conversationId,
      threadId,
      items,
      nextCursor,
      cursor ? "prepend" : "replace",
      activeTurnId ?? (cursor ? undefined : null),
    );
    if (!cursor) {
      setConversations((prev) => prev.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        if (activeTurnId) {
          const unchanged = conversation.status === "running" && conversation.runningTurnId === activeTurnId;
          return {
            ...conversation,
            status: "running",
            runningTurnId: activeTurnId,
            lastActivityAt: unchanged ? conversation.lastActivityAt : Date.now(),
          };
        }
        if (conversation.status !== "running" && conversation.status !== "waiting_permission") {
          return conversation;
        }
        const nextStatus = codexTurnStatusIsFailed(latestTurnStatus) ? "error" : "idle";
        return {
          ...conversation,
          status: nextStatus,
          runningTurnId: undefined,
          lastActivityAt: Date.now(),
        };
      }));
    }
  }, [replaceCodexHistory, requestCodexRpc]);

  const resumeCodexThread = useCallback(async (
    sessionId: string,
    threadId: string,
    cwd?: string,
    conversationId?: string,
  ): Promise<string> => {
    const response = await requestCodexRpc(sessionId, "thread/resume", {
      threadId,
      cwd,
      excludeTurns: true,
    }, { conversationId, timeoutMs: 30_000 });
    return codexThreadId(response.result) ?? threadId;
  }, [requestCodexRpc]);

  const ensureConversationSession = useCallback(
    (conversationId: string, preferredSessionId?: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) {
        console.warn("[LiveActivityAction] workspace ensureSession missing conversation", { conversationId, preferredSessionId });
        return false;
      }
      const isUsable = (session: SessionInfo | undefined) =>
        Boolean(session) &&
        (
          session!.status === "connected" ||
          session!.status === "reconnecting" ||
          session!.status === "connecting" ||
          session!.status === "host_disconnected"
        );

      const preferred = preferredSessionId ? manager.sessions.get(preferredSessionId) : undefined;
      if (isUsable(preferred)) {
        console.log("[LiveActivityAction] workspace ensureSession preferred usable", {
          conversationId,
          preferredSessionId,
          status: preferred?.status,
          controllerId: preferred?.controllerId,
        });
        return true;
      }

      const resolved = findSessionForConversation(conversation, manager.sessions);
      if (isUsable(resolved)) {
        console.log("[LiveActivityAction] workspace ensureSession resolved usable", {
          conversationId,
          preferredSessionId,
          resolvedSessionId: resolved?.sessionId,
          status: resolved?.status,
          controllerId: resolved?.controllerId,
        });
        return true;
      }

      const sessionId = preferredSessionId || conversation.sessionId;
      if (sessionId && conversation.serverUrl) {
        console.warn("[LiveActivityAction] workspace ensureSession reconnect", {
          conversationId,
          preferredSessionId,
          sessionId,
          serverUrl: conversation.serverUrl,
          knownSessions: [...manager.sessions.values()].map((session) => ({
            sessionId: session.sessionId,
            status: session.status,
            gatewayUrl: session.gatewayUrl,
            controllerId: session.controllerId,
          })),
        });
        manager.connectToSession(sessionId, conversation.serverUrl);
      } else {
        console.warn("[LiveActivityAction] workspace ensureSession cannot reconnect", {
          conversationId,
          preferredSessionId,
          sessionId,
          serverUrl: conversation.serverUrl,
        });
      }
      return false;
    },
    [ensureCodexInitialized, manager, persistConversation, replaceCodexHistory, requestCodexRpc],
  );

  function findSessionForConversation(
    conversation: AgentConversationRecord,
    sessions: Map<string, SessionInfo>,
  ): SessionInfo | undefined {
    const matchesMachine = (session: SessionInfo | undefined) =>
      Boolean(session) &&
      (!conversation.machineId || !session!.machineId || session!.machineId === conversation.machineId);
    const sessionIsUsable = (session: SessionInfo | undefined) =>
      Boolean(session) &&
      session!.status !== "session_exited" &&
      !session!.status.startsWith("error:");

    const exact = sessions.get(conversation.sessionId) ?? sessions.get(conversation.hostDeviceId ?? "");
    if (sessionIsUsable(exact) && matchesMachine(exact)) {
      return exact;
    }
    const serverUrl = normalizeServerUrl(conversation.serverUrl);
    const sameGateway = [...sessions.values()].filter((session) =>
      sessionIsUsable(session) && normalizeServerUrl(session.gatewayUrl) === serverUrl
    );
    if (conversation.machineId) {
      const machineMatch = sameGateway.find((session) => session.machineId === conversation.machineId);
      if (machineMatch) return machineMatch;
    }
    return sameGateway.find((session) =>
      session.cwd === conversation.cwd ||
      [...session.terminals.values()].some((terminal) => terminal.cwd === conversation.cwd)
    ) ?? sameGateway[0];
  }

  const requestCapabilities = useCallback(
    (sessionId?: string) => {
      const currentManager = managerRef.current;
      const targets = sessionId
        ? [currentManager.sessions.get(sessionId)].filter((item): item is SessionInfo => Boolean(item))
        : [...currentManager.sessions.values()];
      for (const session of targets) {
        const hasCodexConversation = conversationsRef.current.some((conversation) =>
          conversation.provider === "codex" &&
          findSessionForConversation(conversation, currentManager.sessions)?.sessionId === session.sessionId
        );
        if (session.provider === "codex" || hasCodexConversation) {
          ensureCodexInitialized(session.sessionId)
            .then(() => refreshCodexRuntimeCapabilities(session.sessionId))
            .catch(() => {});
          continue;
        }
        currentManager.sendAgentWorkspaceEnvelope(
          session.sessionId,
          "agent.v2.capabilities.request",
          {},
          { queue: true, dedupeKey: "agent-v2-capabilities" },
        );
      }
    },
    [ensureCodexInitialized, refreshCodexRuntimeCapabilities],
  );

  const requestConversationList = useCallback(
    (sessionId?: string) => {
      const currentManager = managerRef.current;
      const targets = sessionId
        ? [currentManager.sessions.get(sessionId)].filter((item): item is SessionInfo => Boolean(item))
        : [...currentManager.sessions.values()];
      for (const session of targets) {
        const hasCodexConversation = conversationsRef.current.some((conversation) =>
          conversation.provider === "codex" &&
          findSessionForConversation(conversation, currentManager.sessions)?.sessionId === session.sessionId
        );
        if (session.provider === "codex" || hasCodexConversation) {
          ensureCodexInitialized(session.sessionId)
            .then(() => Promise.all([
              requestCodexRpc(session.sessionId, "thread/list", {
                limit: 50,
                archived: false,
                sortKey: "updated_at",
                sortDirection: "desc",
              }, { timeoutMs: 30_000 }),
              requestCodexRpc(session.sessionId, "thread/list", {
                limit: 50,
                archived: true,
                sortKey: "updated_at",
                sortDirection: "desc",
              }, { timeoutMs: 30_000 }).catch(() => undefined),
            ]))
            .then((responses) => {
              const threads = responses.flatMap((response, index) => {
                const raw = asRecord(response?.result);
                const archived = index === 1;
                const entries = Array.isArray(raw?.threads)
                  ? raw.threads
                  : Array.isArray(raw?.items)
                  ? raw.items
                  : Array.isArray(raw?.data)
                  ? raw.data
                  : Array.isArray(raw?.sessions)
                  ? raw.sessions
                  : [];
                return entries.map((thread) => ({ thread, archived }));
              });
              const seenThreadIds = new Set<string>();
              const records = threads
                .map(({ thread, archived }): AgentConversationRecord | undefined => {
                  const threadId = codexThreadId(thread) ?? firstString(thread, ["id", "threadId"]);
                  const record = asRecord(thread);
                  if (!threadId) return undefined;
                  if (seenThreadIds.has(threadId)) return undefined;
                  seenThreadIds.add(threadId);
                  const cwd = firstString(record, ["cwd", "workingDirectory", "workspacePath"]) ?? session.cwd ?? "";
                  const conversationId = makeAgentConversationId({
                    serverUrl: normalizeServerUrl(session.gatewayUrl),
                    hostDeviceId: session.hostDeviceId,
                    sessionId: session.sessionId,
                    agentSessionId: threadId,
                    cwd,
                    provider: "codex",
                  });
                  const previous = conversationsRef.current.find((item) => item.id === conversationId);
                  const serverLastActivityAt = codexOptionalTimestamp(
                    record?.lastActivityAt ?? record?.updatedAt ?? record?.modifiedAt,
                  );
                  const serverCreatedAt = codexOptionalTimestamp(record?.createdAt);
                  codexThreadConversationRef.current.set(threadId, conversationId);
                  return {
                    id: conversationId,
                    serverUrl: normalizeServerUrl(session.gatewayUrl),
                    hostDeviceId: session.hostDeviceId,
                    sessionId: session.sessionId,
                    machineId: session.machineId ?? undefined,
                    agentSessionId: threadId,
                    provider: "codex",
                    cwd,
                    title: stableCodexTitle(firstString(record, ["title", "name"]), previous?.title, cwd),
                    status: codexThreadIsWaitingForUser(record)
                      ? "waiting_permission"
                      : codexThreadIsRunning(record) ? "running" : "idle",
                    archived: typeof record?.archived === "boolean" ? record.archived : archived,
                    runningTurnId: codexRunningTurnId(record),
                    syncStatus: "complete",
                    source: "app-server",
                    lastMessagePreview: firstString(record, ["preview", "lastMessagePreview", "summary"]),
                    lastActivityAt: serverLastActivityAt ?? previous?.lastActivityAt ?? serverCreatedAt ?? Date.now(),
                    createdAt: serverCreatedAt ?? previous?.createdAt ?? serverLastActivityAt ?? Date.now(),
                    schemaVersion: 2,
                  };
                })
                .filter((record): record is AgentConversationRecord => Boolean(record));
              setConversations((prev) => {
                const byId = new Map(prev.map((item) => [item.id, item]));
                for (const record of records) {
                  const previous = byId.get(record.id);
                  byId.set(record.id, {
                    ...previous,
                    ...record,
                    title: stableCodexTitle(record.title, previous?.title, record.cwd),
                    lastMessagePreview: record.lastMessagePreview ??
                      (codexPreviewIsControlNoise(previous?.lastMessagePreview) ? undefined : previous?.lastMessagePreview),
                    lastActivityAt: Math.max(previous?.lastActivityAt ?? 0, record.lastActivityAt),
                  });
                }
                return [...byId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
              });
              replaceAgentConversationsForDevice({
                serverUrl: normalizeServerUrl(session.gatewayUrl),
                hostDeviceId: session.hostDeviceId,
                conversations: records,
                providers: ["codex"],
              }).catch(() => {});
              records
                .filter((record) => record.agentSessionId && record.status === "running")
                .slice(0, 6)
                .forEach((record) => {
                  requestCodexTurns(session.sessionId, record.id, record.agentSessionId!).catch(() => {});
                });
            })
            .catch(() => {});
          continue;
        }
        currentManager.sendAgentWorkspaceEnvelope(
          session.sessionId,
          "agent.v2.conversation.list",
          { includeArchived: true },
          { queue: true, dedupeKey: "agent-v2-conversation-list" },
        );
      }
    },
    [ensureCodexInitialized, requestCodexRpc, requestCodexTurns],
  );

  const markConversationSync = useCallback(
    (conversationId: string, syncStatus: AgentConversationRecord["syncStatus"]) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation || conversation.syncStatus === syncStatus) return;
      persistConversation({ ...conversation, syncStatus }).catch(() => {});
    },
    [persistConversation],
  );

  const requestHistoryPage = useCallback(
    (conversationId: string, cursor?: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return false;
      const session = findSessionForConversation(conversation, managerRef.current.sessions);
      if (!session) {
        markConversationSync(conversationId, "deferred");
        return false;
      }
      if (conversation.provider === "codex" && conversation.agentSessionId) {
        const pendingKey = `${conversationId}:${cursor ?? "latest"}`;
        if (pendingHistoryRef.current.has(pendingKey)) return true;
        pendingHistoryRef.current.add(pendingKey);
        markConversationSync(conversationId, "syncing");
        ensureCodexInitialized(session.sessionId)
          .then(() => requestCodexTurns(session.sessionId, conversationId, conversation.agentSessionId!, cursor))
          .then(() => markConversationSync(conversationId, "complete"))
          .catch(() => markConversationSync(conversationId, "stale"))
          .finally(() => pendingHistoryRef.current.delete(pendingKey));
        return true;
      }
      const pendingKey = `${conversationId}:${cursor ?? "latest"}`;
      if (pendingHistoryRef.current.has(pendingKey)) return true;
      pendingHistoryRef.current.add(pendingKey);
      markConversationSync(conversationId, "syncing");
      const accepted = managerRef.current.sendAgentWorkspaceEnvelope(
        session.sessionId,
        "agent.v2.history.request",
        {
          conversationId,
          cursor,
          limit: 80,
          direction: "older",
        },
        { queue: true, dedupeKey: `agent-v2-history:${conversationId}:${cursor ?? "latest"}` },
      );
      if (!accepted) {
        pendingHistoryRef.current.delete(pendingKey);
        markConversationSync(conversationId, "stale");
      }
      return accepted;
    },
    [ensureCodexInitialized, markConversationSync, requestCodexTurns],
  );

  const requestDelta = useCallback(
    (conversationId: string, sinceRevision: number) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return false;
      const session = findSessionForConversation(conversation, managerRef.current.sessions);
      if (!session) {
        markConversationSync(conversationId, "deferred");
        return false;
      }
      if (conversation.provider === "codex" && conversation.agentSessionId) {
        const pendingKey = `${conversationId}:latest`;
        if (pendingHistoryRef.current.has(pendingKey)) return true;
        pendingHistoryRef.current.add(pendingKey);
        markConversationSync(conversationId, "syncing");
        ensureCodexInitialized(session.sessionId)
          .then(() => requestCodexTurns(session.sessionId, conversationId, conversation.agentSessionId!))
          .then(() => markConversationSync(conversationId, "complete"))
          .catch(() => markConversationSync(conversationId, "stale"))
          .finally(() => pendingHistoryRef.current.delete(pendingKey));
        return true;
      }
      markConversationSync(conversationId, "syncing");
      const accepted = managerRef.current.sendAgentWorkspaceEnvelope(
        session.sessionId,
        "agent.v2.delta.request",
        {
          conversationId,
          sinceRevision,
          limit: 100,
        },
        { queue: true, dedupeKey: `agent-v2-delta:${conversationId}:${sinceRevision}` },
      );
      if (!accepted) markConversationSync(conversationId, "stale");
      return accepted;
    },
    [ensureCodexInitialized, markConversationSync, requestCodexTurns],
  );

  useEffect(() => {
    if (connectedSessions.length === 0) return;
    requestCapabilities();
    requestConversationList();
  }, [connectedSessions.length, requestCapabilities, requestConversationList]);

  useEffect(() => {
    if (connectedSessions.length === 0) return;
    const timer = setInterval(() => {
      const foreground = appStateRef.current === "active";
      for (const session of managerRef.current.sessions.values()) {
        if (session.status !== "connected") continue;
        const hasCodexConversation = conversationsRef.current.some((conversation) =>
          conversation.provider === "codex" &&
          !conversation.archived &&
          findSessionForConversation(conversation, managerRef.current.sessions)?.sessionId === session.sessionId
        );
        if (session.provider !== "codex" && !hasCodexConversation) continue;
        requestConversationList(session.sessionId);
        if (!foreground) break;
      }
    }, appStateRef.current === "active" ? 5_000 : 20_000);
    return () => clearInterval(timer);
  }, [connectedSessions.length, requestConversationList]);

  useEffect(() => {
    for (const session of connectedSessions) {
      if (session.status !== "connected") continue;
      const token = `${session.sessionId}:${session.machineId ?? ""}:${session.cwd ?? ""}`;
      if (sessionSyncTokenRef.current.get(session.sessionId) === token) continue;
      sessionSyncTokenRef.current.set(session.sessionId, token);
      for (const conversation of conversationsRef.current) {
        if (conversation.archived) continue;
        const resolved = findSessionForConversation(conversation, managerRef.current.sessions);
        if (resolved?.sessionId !== session.sessionId) continue;
        const revision = conversation.timelineRevision ?? 0;
        if (revision > 0) requestDelta(conversation.id, revision);
        else requestHistoryPage(conversation.id);
      }
    }
  }, [connectedSessions, requestDelta, requestHistoryPage]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const foreground = appStateRef.current === "active";
      for (const conversation of conversationsRef.current) {
        if (conversation.archived) continue;
        const running =
          conversation.status === "running" ||
          conversation.status === "waiting_permission";
        const needsRecovery =
          conversation.syncStatus === "stale" ||
          conversation.syncStatus === "deferred";
        if (!running && !needsRecovery) continue;
        const session = findSessionForConversation(conversation, managerRef.current.sessions);
        if (!session || session.status !== "connected") continue;
        const isActive = activeConversationId === conversation.id;
        const isCodex = conversation.provider === "codex";
        const interval = running
          ? foreground && isActive
            ? isCodex ? 8_000 : 2_500
            : foreground
            ? isCodex ? 20_000 : 12_000
            : isCodex ? 30_000 : 15_000
          : 45_000;
        const last = lastRunningSyncRef.current.get(conversation.id) ?? 0;
        if (now - last < interval) continue;
        lastRunningSyncRef.current.set(conversation.id, now);
        if (conversation.provider === "codex" && conversation.agentSessionId) {
          ensureCodexInitialized(session.sessionId)
            .then(() => requestCodexTurns(session.sessionId, conversation.id, conversation.agentSessionId!))
            .catch(() => {});
          continue;
        }
        const revision = conversation.timelineRevision ?? 0;
        if (revision > 0) requestDelta(conversation.id, revision);
        else requestHistoryPage(conversation.id);
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [activeConversationId, ensureCodexInitialized, requestCodexTurns, requestDelta, requestHistoryPage]);

  const handleEnvelope = useCallback(
    (envelope: Envelope) => {
      const serverSession = managerRef.current.sessions.get(envelope.hostDeviceId);
      const serverUrl = normalizeServerUrl(serverSession?.gatewayUrl ?? "");
      const toRecord = (conversation: any): AgentConversationRecord => {
        const previous = conversationsRef.current.find((item) => item.id === conversation.id);
        const rawRevision = typeof conversation.timelineRevision === "number" ? conversation.timelineRevision : undefined;
        return {
          id: conversation.id,
          serverUrl,
          hostDeviceId: serverSession?.hostDeviceId ?? envelope.hostDeviceId ?? envelope.hostDeviceId,
          sessionId: serverSession?.hostDeviceId ?? envelope.hostDeviceId ?? envelope.hostDeviceId,
          machineId: serverSession?.machineId ?? conversation.machineId,
          agentSessionId: conversation.agentSessionId,
          provider: conversation.provider ?? "codex",
          cwd: conversation.cwd ?? serverSession?.cwd ?? "",
          title: conversation.title,
          model: conversation.model,
          reasoningEffort: conversation.reasoningEffort,
          serviceTier: conversation.serviceTier,
          permissionMode: conversation.permissionMode,
          collaborationMode: conversation.collaborationMode,
          status: conversation.status ?? "idle",
          archived: Boolean(conversation.archived),
          timelineRevision: rawRevision === undefined
            ? previous?.timelineRevision
            : Math.max(previous?.timelineRevision ?? 0, rawRevision),
          historyComplete: typeof conversation.historyComplete === "boolean" ? conversation.historyComplete : previous?.historyComplete,
          runningTurnId: typeof conversation.runningTurnId === "string" ? conversation.runningTurnId : undefined,
          syncStatus: conversation.syncStatus ?? previous?.syncStatus ?? "deferred",
          source: conversation.source ?? previous?.source,
          canonical: typeof conversation.canonical === "boolean" ? conversation.canonical : previous?.canonical,
          lastMessagePreview: conversation.lastMessagePreview,
          lastActivityAt: conversation.lastActivityAt ?? Date.now(),
          createdAt: conversation.createdAt ?? Date.now(),
          schemaVersion: 2,
        };
      };

      if (envelope.type === "agent.v2.capabilities") {
        const payload = parseTypedPayload("agent.v2.capabilities", envelope.payload) as AgentCapabilities;
        if (serverSession && typeof payload.machineId === "string") {
          serverSession.machineId = payload.machineId;
        }
        setCapabilitiesBySessionId((prev) => {
          const next = new Map(prev);
          next.set(envelope.hostDeviceId, mergeAgentCapabilities(prev.get(envelope.hostDeviceId), payload));
          return next;
        });
        return;
      }

      if (envelope.type === "agent.codex.rpc") {
        const payload = parseTypedPayload("agent.codex.rpc" as any, envelope.payload) as CodexRpcMessage;
        if (isCodexJsonRpcResponse(payload)) {
          const pending = pendingCodexRef.current.get(payload.id);
          if (pending) {
            pendingCodexRef.current.delete(payload.id);
            clearTimeout(pending.timer);
            if (payload.error) {
              const message = humanizeCodexRpcError(payload.error.message ?? "Codex request failed");
              if (pending.clientMessageId && pending.conversationId) {
                const existing = codexThreadsRef.current.get(pending.conversationId);
                const failed = existing?.items.find((item) => item.itemId === pending.clientMessageId);
                if (failed) {
                  upsertCodexItem(pending.conversationId, {
                    ...failed,
                    deliveryState: "failed",
                    isStreaming: false,
                    updatedAt: Date.now(),
                  });
                }
                upsertCodexItem(pending.conversationId, {
                  threadId: codexThreadsRef.current.get(pending.conversationId)?.threadId ?? pending.conversationId,
                  itemId: `error:${pending.clientMessageId}`,
                  orderIndex: (codexThreadsRef.current.get(pending.conversationId)?.items.length ?? 0) + 1,
                  type: "error",
                  text: message,
                  deliveryState: "failed",
                  createdAt: Date.now(),
                });
                setConversations((prev) => prev.map((conversation) =>
                  conversation.id === pending.conversationId
                    ? { ...conversation, status: "error", lastActivityAt: Date.now() }
                  : conversation
                ));
              }
              pending.reject?.(message);
            } else {
              if (pending.clientMessageId && pending.conversationId) {
                const existing = codexThreadsRef.current.get(pending.conversationId);
                const confirmed = existing?.items.find((item) => item.itemId === pending.clientMessageId);
                if (confirmed) {
                  upsertCodexItem(pending.conversationId, {
                    ...confirmed,
                    deliveryState: "confirmed",
                    updatedAt: Date.now(),
                  });
                }
              }
              pending.resolve?.(payload);
            }
          }
          if (!pending) {
            if (payload.error && payload.id === "linkshell-codex-rpc-error") {
              const message = humanizeCodexRpcError(payload.error.message ?? "Codex app-server transport failed");
              const failed = failPendingCodexRequestsForSession(pendingCodexRef.current, envelope.hostDeviceId, message);
              for (const item of failed) {
                if (!item.conversationId) continue;
                if (item.clientMessageId) {
                  const existing = codexThreadsRef.current.get(item.conversationId);
                  const failedMessage = existing?.items.find((entry) => entry.itemId === item.clientMessageId);
                  if (failedMessage) {
                    upsertCodexItem(item.conversationId, {
                      ...failedMessage,
                      deliveryState: "failed",
                      isStreaming: false,
                      updatedAt: Date.now(),
                    });
                  }
                  upsertCodexItem(item.conversationId, {
                    threadId: existing?.threadId ?? item.conversationId,
                    itemId: `error:${item.clientMessageId}`,
                    orderIndex: (existing?.items.length ?? 0) + 1,
                    type: "error",
                    text: message,
                    deliveryState: "failed",
                    createdAt: Date.now(),
                  });
                }
                if (item.clientMessageId) {
                  setConversations((prev) => prev.map((conversation) =>
                    conversation.id === item.conversationId
                      ? { ...conversation, status: "error", lastMessagePreview: message, lastActivityAt: Date.now() }
                      : conversation
                  ));
                }
              }
              return;
            }
            for (const [conversationId, thread] of codexThreadsRef.current) {
              const matching = thread.items.find((item) =>
                (item.type === "approval" || item.type === "structured_input") &&
                item.requestId === String(payload.id)
              );
              if (!matching) continue;
              upsertCodexItem(conversationId, {
                ...matching,
                deliveryState: payload.error ? "failed" : "confirmed",
                output: payload.error?.message ?? matching.output,
                permissionSubmitting: matching.type === "approval" ? false : matching.permissionSubmitting,
                permissionError: matching.type === "approval" ? payload.error?.message : matching.permissionError,
                isStreaming: false,
                updatedAt: Date.now(),
              });
              break;
            }
          }
          return;
        }

        const params = asRecord(payload.params);
        const threadId = codexThreadId(params) ?? codexThreadId(payload.result);
        const turnId = codexTurnId(params);
        let conversationId = threadId ? codexThreadConversationRef.current.get(threadId) : undefined;
        conversationId = conversationId ?? firstString(params, ["conversationId"]);
        if (!conversationId && threadId) {
          conversationId = conversationsRef.current.find((item) =>
            item.provider === "codex" &&
            !item.archived &&
            (item.agentSessionId === threadId || item.id === threadId)
          )?.id;
        }
        if (!conversationId && turnId) {
          for (const [candidateId, thread] of codexThreadsRef.current) {
            if (thread.activeTurnId === turnId || thread.items.some((item) => item.turnId === turnId)) {
              conversationId = candidateId;
              break;
            }
          }
        }
        if (!conversationId && activeConversationId) {
          const active = conversationsRef.current.find((item) => item.id === activeConversationId);
          if (active?.provider === "codex" && (!serverSession || findSessionForConversation(active, managerRef.current.sessions)?.sessionId === serverSession.sessionId)) {
            conversationId = activeConversationId;
          }
        }
        if (!conversationId) {
          conversationId = conversationsRef.current.find((item) => {
            if (item.provider !== "codex" || item.archived) return false;
            if (item.status !== "running" && item.status !== "waiting_permission") return false;
            const session = findSessionForConversation(item, managerRef.current.sessions);
            return !serverSession || session?.sessionId === serverSession.sessionId;
          })?.id;
        }
        const itemId = codexItemId(params) ?? (payload.id !== undefined ? String(payload.id) : undefined);
        const method = payload.method ?? "";
        const isServerRequest = isCodexJsonRpcRequest(payload);

        const sendServerRequestError = (message: string, code = -32000) => {
          if (!isServerRequest) return;
          sendCodexRpc(envelope.hostDeviceId, {
            id: payload.id,
            error: { code, message },
          });
        };

        if (method === "thread/status/changed" && conversationId && threadId) {
          const isRunning = codexThreadIsRunning(params);
          const isWaiting = codexThreadIsWaitingForUser(params);
          const activeTurnIdFromStatus = codexRunningTurnId(params);
          setCodexThreadsByConversationId((prev) => {
            const next = new Map(prev);
            const existing = next.get(conversationId) ?? { conversationId, threadId, items: [], isRunning };
            const activeTurnId = activeTurnIdFromStatus ?? existing.activeTurnId;
            next.set(conversationId, {
              ...existing,
              threadId,
              isRunning,
              activeTurnId: isRunning ? activeTurnId : undefined,
            });
            return next;
          });
          setConversations((prev) => prev.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  status: isWaiting ? "waiting_permission" : isRunning ? "running" : "idle",
                  runningTurnId: isRunning
                    ? activeTurnIdFromStatus ?? conversation.runningTurnId
                    : undefined,
                  lastActivityAt: Date.now(),
                }
              : conversation
          ));
          if (isRunning && serverSession) {
            requestCodexTurns(serverSession.sessionId, conversationId, threadId).catch(() => {});
          }
          return;
        }

        if (method === "turn/started" && conversationId && threadId) {
          const activeTurnId = turnId ?? `turn-${Date.now().toString(36)}`;
          setCodexThreadsByConversationId((prev) => {
            const next = new Map(prev);
            const existing = next.get(conversationId) ?? { conversationId, threadId, isRunning: true, items: [] };
            next.set(conversationId, { ...existing, threadId, activeTurnId, isRunning: true });
            return next;
          });
          setConversations((prev) => prev.map((conversation) =>
            conversation.id === conversationId
              ? { ...conversation, status: "running", runningTurnId: activeTurnId, lastActivityAt: Date.now() }
              : conversation
          ));
          return;
        }

        if (method === "turn/completed" && conversationId && threadId) {
          flushPendingCodexDeltas();
          const status = firstString(params, ["status"]);
          setCodexThreadsByConversationId((prev) => {
            const next = new Map(prev);
            const existing = next.get(conversationId);
            if (existing) {
              const nextThread = {
                ...existing,
                items: finalizeCodexThreadItems(existing.items, turnId ?? existing.activeTurnId),
                isRunning: false,
                activeTurnId: undefined,
              };
              next.set(conversationId, nextThread);
              codexThreadsRef.current = next;
              persistCodexThread(conversationId, nextThread);
            }
            return next;
          });
          setConversations((prev) => prev.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  status: status === "failed" ? "error" : "idle",
                  runningTurnId: undefined,
                  lastActivityAt: Date.now(),
                }
              : conversation
          ));
          return;
        }

        if (method === "item/agentMessage/delta" && conversationId && threadId) {
          const id = itemId ?? `assistant:${turnId ?? "active"}`;
          const existing = codexThreadsRef.current.get(conversationId)?.items.find((item) => item.itemId === id);
          const delta = firstString(params, ["delta", "text", "content"]) ?? codexText(params?.delta);
          queueCodexDeltaItem(conversationId, {
            threadId,
            turnId: turnId ?? existing?.turnId,
            itemId: id,
            orderIndex: existing?.orderIndex ?? (codexThreadsRef.current.get(conversationId)?.items.length ?? 0) + 1,
            role: "assistant",
            type: "message",
            text: `${existing?.text ?? ""}${delta}`,
            isStreaming: true,
            deliveryState: "confirmed",
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          });
          return;
        }

        if (method === "item/started" && conversationId && threadId) {
          const rawItem = asRecord(params?.item) ?? params;
          const type = firstString(rawItem, ["type", "kind"]) ?? "tool";
          if (type.toLowerCase().includes("message")) return;
          const isFileChange = type.toLowerCase().includes("file");
          const fileChange = isFileChange ? codexFileChangeFromValue(rawItem, "running") : undefined;
          upsertCodexItem(conversationId, {
            threadId,
            turnId,
            itemId: itemId ?? `item:${Date.now().toString(36)}`,
            orderIndex: (codexThreadsRef.current.get(conversationId)?.items.length ?? 0) + 1,
            type: isFileChange ? "file_change" : type.toLowerCase().includes("command") ? "command" : "tool",
            text: fileChange?.summary ?? codexText(rawItem),
            fileChange,
            command: firstString(rawItem, ["command", "name", "toolName"]),
            raw: rawItem,
            isStreaming: true,
            deliveryState: "confirmed",
            createdAt: Date.now(),
          });
          return;
        }

        if ((method === "item/completed" || method.endsWith("/completed")) && conversationId && itemId) {
          flushPendingCodexDeltas();
          const existing = codexThreadsRef.current.get(conversationId)?.items.find((item) => item.itemId === itemId);
          if (existing) {
            const completedContent = codexContentBlocks(params?.item ?? params);
            const completedStatus = existing.type === "file_change"
              ? existing.deliveryState === "failed" ? "failed" : "completed"
              : undefined;
            const completedFileChange = completedStatus
              ? codexFileChangeFromValue(params?.item ?? params, completedStatus, existing.diff)
              : undefined;
            upsertCodexItem(conversationId, {
              ...existing,
              text: existing.text ?? (textFromBlocks(completedContent) || codexText(params)),
              content: completedContent.length > 0 ? completedContent : existing.content,
              fileChange: completedFileChange ?? (
                existing.fileChange
                  ? { ...existing.fileChange, status: completedStatus }
                  : existing.fileChange
              ),
              isStreaming: false,
              deliveryState: "confirmed",
              updatedAt: Date.now(),
            });
          }
          return;
        }

        if ((method.includes("outputDelta") || method.endsWith("/progress")) && conversationId && threadId) {
          const id = itemId ?? `tool:${turnId ?? "active"}`;
          const existing = codexThreadsRef.current.get(conversationId)?.items.find((item) => item.itemId === id);
          const delta = firstString(params, ["delta", "text", "output"]) ?? codexText(params);
          queueCodexDeltaItem(conversationId, {
            threadId,
            turnId: turnId ?? existing?.turnId,
            itemId: id,
            orderIndex: existing?.orderIndex ?? (codexThreadsRef.current.get(conversationId)?.items.length ?? 0) + 1,
            type: method.includes("commandExecution") ? "command" : method.includes("fileChange") ? "file_change" : "tool",
            command: existing?.command ?? firstString(params, ["command", "toolName", "name"]),
            output: `${existing?.output ?? ""}${delta}`,
            isStreaming: true,
            deliveryState: "confirmed",
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          });
          return;
        }

        if (method === "item/fileChange/patchUpdated" && conversationId && threadId) {
          const id = itemId ?? `file:${turnId ?? "active"}`;
          const existing = codexThreadsRef.current.get(conversationId)?.items.find((item) => item.itemId === id);
          const diff = firstString(params, ["patch", "diff", "unified_diff"]) ?? codexDiffText(params) ?? codexText(params);
          const fileChange = codexFileChangeFromValue(params, "running", diff);
          queueCodexDeltaItem(conversationId, {
            threadId,
            turnId: turnId ?? existing?.turnId,
            itemId: id,
            orderIndex: existing?.orderIndex ?? (codexThreadsRef.current.get(conversationId)?.items.length ?? 0) + 1,
            type: "file_change",
            text: fileChange?.summary ?? existing?.text,
            diff,
            fileChange: fileChange ?? existing?.fileChange,
            isStreaming: true,
            deliveryState: "confirmed",
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          });
          return;
        }

        if (method === "serverRequest/resolved") {
          const rawRequestId = params?.requestId ?? params?.id;
          const requestId = typeof rawRequestId === "string" || typeof rawRequestId === "number"
            ? String(rawRequestId)
            : undefined;
          if (!requestId) return;
          const targetEntries = conversationId
            ? [[conversationId, codexThreadsRef.current.get(conversationId)] as const]
            : [...codexThreadsRef.current.entries()];
          for (const [candidateId, thread] of targetEntries) {
            const matching = thread?.items.find((item) =>
              (item.type === "approval" || item.type === "structured_input") &&
              (item.requestId === requestId || String(item.rpcId ?? "") === requestId)
            );
            if (!matching) continue;
            upsertCodexItem(candidateId, {
              ...matching,
              deliveryState: "confirmed",
              permissionSubmitting: matching.type === "approval" ? false : matching.permissionSubmitting,
              isStreaming: false,
              updatedAt: Date.now(),
            });
            const existingConversation = conversationsRef.current.find((item) => item.id === candidateId);
            if (existingConversation) {
              persistConversation({
                ...existingConversation,
                status: "running",
                lastActivityAt: Date.now(),
              }).catch(() => {});
            }
            break;
          }
          return;
        }

        if (payload.id !== undefined && isCodexStructuredInputRequest(method) && conversationId) {
          const requestId = String(payload.id);
          const rpcId = payload.id;
          const structuredInput = decodeCodexStructuredInput(params, requestId);
          if (!structuredInput) return;
          const existingThread = codexThreadsRef.current.get(conversationId);
          const conversation = conversationsRef.current.find((item) => item.id === conversationId);
          const resolvedThreadId = threadId ?? existingThread?.threadId ?? conversation?.agentSessionId ?? conversationId;
          codexThreadConversationRef.current.set(resolvedThreadId, conversationId);
          upsertCodexItem(conversationId, {
            threadId: resolvedThreadId,
            turnId,
            itemId: `input:${requestId}`,
            orderIndex: (existingThread?.items.length ?? 0) + 1,
            role: "system",
            type: "structured_input",
            requestId,
            rpcId,
            requestMethod: method,
            structuredInput,
            text: structuredInput.questions.map((question) => question.question).join("\n"),
            raw: params,
            deliveryState: "pending",
            isStreaming: false,
            createdAt: Date.now(),
          });
          if (conversation) {
            persistConversation({
              ...conversation,
              status: "waiting_permission",
              lastMessagePreview: "Agent 需要补充信息",
              lastActivityAt: Date.now(),
            }).catch(() => {});
          }
          return;
        }

        if (isServerRequest && isCodexStructuredInputRequest(method) && !conversationId) {
          sendServerRequestError("Cannot route Codex structured input request to a conversation.");
          return;
        }

        if (payload.id !== undefined && isCodexApprovalRequest(method) && conversationId) {
          const existingThread = codexThreadsRef.current.get(conversationId);
          const conversation = conversationsRef.current.find((item) => item.id === conversationId);
          const resolvedThreadId = threadId ?? existingThread?.threadId ?? conversation?.agentSessionId ?? conversationId;
          codexThreadConversationRef.current.set(resolvedThreadId, conversationId);
          upsertCodexItem(conversationId, {
            threadId: resolvedThreadId,
            turnId,
            itemId: `approval:${String(payload.id)}`,
            orderIndex: (codexThreadsRef.current.get(conversationId)?.items.length ?? 0) + 1,
            type: "approval",
            requestId: String(payload.id),
            rpcId: payload.id,
            requestMethod: method,
            command: codexApprovalToolName(method, params),
            text: codexApprovalToolInput(method, params),
            output: codexApprovalContext(params),
            raw: params,
            deliveryState: "pending",
            createdAt: Date.now(),
          });
          if (conversation) {
            persistConversation({
              ...conversation,
              status: "waiting_permission",
              lastMessagePreview: "Codex 需要授权",
              lastActivityAt: Date.now(),
            }).catch(() => {});
          }
          return;
        }

        if (isServerRequest && isCodexApprovalRequest(method) && !conversationId) {
          sendServerRequestError("Cannot route Codex approval request to a conversation.");
          return;
        }

        if (isServerRequest) {
          sendServerRequestError(`Unsupported Codex server request: ${method}`, -32601);
          return;
        }

        if ((method === "thread/archived" || method === "thread/unarchived") && threadId) {
          const archived = method === "thread/archived";
          setConversations((prev) => prev.map((conversation) =>
            conversation.provider === "codex" && conversation.agentSessionId === threadId
              ? { ...conversation, archived, lastActivityAt: Date.now(), syncStatus: "complete" }
              : conversation
          ));
          return;
        }

        if (method === "thread/name/updated" && threadId) {
          const name = firstString(params, ["name", "title"]);
          if (!name) return;
          setConversations((prev) => prev.map((conversation) =>
            conversation.provider === "codex" && conversation.agentSessionId === threadId
              ? { ...conversation, title: name, lastActivityAt: Date.now(), syncStatus: "complete" }
              : conversation
          ));
          return;
        }

        return;
      }

      if (envelope.type === "terminal.browse.result") {
        const payload = parseTypedPayload("terminal.browse.result", envelope.payload) as AgentFileBrowseResult & {
          requestId?: string;
        };
        if (!payload.requestId) return;
        const pending = pendingBrowseRef.current.get(payload.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingBrowseRef.current.delete(payload.requestId);
        pending.resolve({
          path: payload.path,
          entries: payload.entries,
          error: payload.error,
        });
        return;
      }

      if (envelope.type === "terminal.file.read.result") {
        const payload = parseTypedPayload("terminal.file.read.result", envelope.payload) as AgentFileReadResult & {
          requestId?: string;
        };
        if (!payload.requestId) return;
        const pending = pendingReadRef.current.get(payload.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingReadRef.current.delete(payload.requestId);
        pending.resolve({
          path: payload.path,
          content: payload.content,
          encoding: payload.encoding,
          size: payload.size,
          truncated: payload.truncated,
          error: payload.error,
        });
        return;
      }

      if (envelope.type === "agent.v2.conversation.opened") {
        const payload = parseTypedPayload("agent.v2.conversation.opened", envelope.payload) as any;
        const record = {
          ...toRecord(payload.conversation),
          timelineRevision: typeof payload.revision === "number"
            ? payload.revision
            : payload.conversation?.timelineRevision,
          historyComplete: payload.hasMore === true ? false : payload.conversation?.historyComplete,
          syncStatus: "complete" as const,
          source: payload.source ?? payload.conversation?.source,
          canonical: typeof payload.canonical === "boolean" ? payload.canonical : payload.conversation?.canonical,
        };
        historyCursorRef.current.set(record.id, payload.cursor);
        historyHasMoreRef.current.set(record.id, Boolean(payload.hasMore));
        persistConversation(record).catch(() => {});
        setActiveConversationId(record.id);
        const pending = pendingOpenRef.current.get(record.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingOpenRef.current.delete(record.id);
          pending.resolve({
            conversationId: record.status === "error" ? null : record.id,
            status: record.status,
            error: record.status === "error"
              ? record.lastMessagePreview || "Agent 对话创建失败。"
              : undefined,
          });
        }
        const items = normalizeSnapshotItems((payload.snapshot ?? []) as AgentTimelineItem[]);
        if (items.length > 0) {
          saveAgentTimeline(record.id, items).catch(() => {});
          setTimelineById((prev) => {
            const next = new Map(prev);
            next.set(record.id, mergeTimeline(next.get(record.id) ?? [], items));
            return next;
          });
        }
        requestHistoryPage(record.id);
        return;
      }

      if (envelope.type === "agent.v2.conversation.list.result") {
        const payload = parseTypedPayload("agent.v2.conversation.list.result", envelope.payload) as any;
        const records: AgentConversationRecord[] = (payload.conversations ?? [])
          .map((conversation: any) => ({
            ...toRecord(conversation),
            syncStatus: "complete" as const,
          }))
          .filter((conversation: AgentConversationRecord) =>
            conversation.id && conversation.cwd && conversation.provider !== "codex"
          );
        const providers = records.length > 0
          ? [...new Set(records.map((record) => record.provider))]
          : ["claude", "custom"] as AgentProvider[];
        replaceAgentConversationsForDevice({
          serverUrl,
          hostDeviceId: serverSession?.hostDeviceId ?? envelope.hostDeviceId,
          conversations: records,
          providers,
          preserveLocalArchived: true,
        })
          .then((nextConversations) => {
            setConversations((prev) => {
              const byId = new Map(prev.map((item) => [item.id, item]));
              for (const conversation of nextConversations) {
                byId.set(conversation.id, { ...byId.get(conversation.id), ...conversation });
              }
              return [...byId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
            });
          })
          .catch(() => {
            for (const record of records) {
              persistConversation(record).catch(() => {});
            }
          });
        return;
      }

      if (envelope.type === "agent.v2.snapshot") {
        const payload = parseTypedPayload("agent.v2.snapshot", envelope.payload) as any;
        if (payload.activeConversationId) setActiveConversationId(payload.activeConversationId);
        for (const conversation of payload.conversations ?? []) {
          persistConversation({
            ...toRecord(conversation),
            syncStatus: "complete",
          }).catch(() => {});
        }
        if (payload.activeConversationId || typeof payload.revision === "number") {
          const snapshotConversationId = payload.activeConversationId as string | undefined;
          if (snapshotConversationId) {
            historyCursorRef.current.set(snapshotConversationId, payload.cursor);
            historyHasMoreRef.current.set(snapshotConversationId, Boolean(payload.hasMore));
          }
        }
        const grouped = new Map<string, AgentTimelineItem[]>();
        for (const item of normalizeSnapshotItems((payload.items ?? []) as AgentTimelineItem[])) {
          grouped.set(item.conversationId, [...(grouped.get(item.conversationId) ?? []), item]);
        }
        setTimelineById((prev) => {
          const next = new Map(prev);
          for (const [conversationId, items] of grouped) {
            const merged = mergeTimeline(next.get(conversationId) ?? [], items);
            next.set(conversationId, merged);
            saveAgentTimeline(conversationId, merged).catch(() => {});
          }
          return next;
        });
        return;
      }

      if (envelope.type === "agent.v2.history.page") {
        const payload = parseTypedPayload("agent.v2.history.page", envelope.payload) as any;
        for (const pendingKey of pendingHistoryRef.current) {
          if (pendingKey.startsWith(`${payload.conversationId}:`)) {
            pendingHistoryRef.current.delete(pendingKey);
          }
        }
        historyCursorRef.current.set(payload.conversationId, payload.cursor);
        historyHasMoreRef.current.set(payload.conversationId, Boolean(payload.hasMore));
        if (payload.conversation) {
          persistConversation({
            ...toRecord(payload.conversation),
            timelineRevision: payload.revision,
            historyComplete: !payload.hasMore,
            syncStatus: "complete",
            source: payload.source,
            canonical: payload.canonical,
          }).catch(() => {});
        }
        const items = normalizeSnapshotItems((payload.items ?? []) as AgentTimelineItem[]);
        setTimelineById((prev) => {
          const next = new Map(prev);
          const merged = mergeTimeline(next.get(payload.conversationId) ?? [], items);
          next.set(payload.conversationId, merged);
          saveAgentTimeline(payload.conversationId, merged).catch(() => {});
          return next;
        });
        return;
      }

      if (envelope.type === "agent.v2.delta") {
        const payload = parseTypedPayload("agent.v2.delta", envelope.payload) as any;
        historyCursorRef.current.set(payload.conversationId, payload.cursor);
        historyHasMoreRef.current.set(payload.conversationId, Boolean(payload.hasMore));
        if (payload.conversation) {
          persistConversation({
            ...toRecord(payload.conversation),
            timelineRevision: payload.revision,
            historyComplete: payload.hasMore ? false : payload.conversation.historyComplete,
            syncStatus: "complete",
            source: payload.source,
            canonical: payload.canonical,
          }).catch(() => {});
        }
        const items = normalizeSnapshotItems((payload.items ?? []) as AgentTimelineItem[]);
        if (items.length > 0 || payload.reset) {
          setTimelineById((prev) => {
            const next = new Map(prev);
            const base = payload.reset ? [] : next.get(payload.conversationId) ?? [];
            const merged = mergeTimeline(base, items);
            next.set(payload.conversationId, merged);
            saveAgentTimeline(payload.conversationId, merged).catch(() => {});
            return next;
          });
        }
        return;
      }

      if (envelope.type === "agent.v2.running_state") {
        const payload = parseTypedPayload("agent.v2.running_state", envelope.payload) as any;
        const existing = conversationsRef.current.find((item) => item.id === payload.conversationId);
        if (existing) {
          const localRevision = existing.timelineRevision ?? 0;
          const hasRevisionGap = typeof payload.revision === "number" && localRevision > 0 && payload.revision > localRevision + 1;
          if (hasRevisionGap) {
            requestDelta(payload.conversationId, localRevision);
          }
          persistConversation({
            ...existing,
            status: payload.status,
            runningTurnId: payload.runningTurnId,
            timelineRevision: typeof payload.revision === "number"
              ? Math.max(localRevision, payload.revision)
              : existing.timelineRevision,
            syncStatus: hasRevisionGap ? "stale" : "complete",
            lastActivityAt: payload.updatedAt ?? Date.now(),
          }).catch(() => {});
        }
        return;
      }

      if (envelope.type === "agent.v2.event") {
        const payload = parseTypedPayload("agent.v2.event", envelope.payload) as any;
        const incomingRevision =
          typeof payload.revision === "number"
            ? payload.revision
            : typeof payload.item?.revision === "number"
            ? payload.item.revision
            : typeof payload.conversation?.timelineRevision === "number"
            ? payload.conversation.timelineRevision
            : undefined;
        const existingConversation = conversationsRef.current.find((item) => item.id === payload.conversationId);
        const localRevision = existingConversation?.timelineRevision ?? 0;
        if (incomingRevision && localRevision > 0 && incomingRevision > localRevision + 1) {
          requestDelta(payload.conversationId, localRevision);
        }
        if (payload.conversation) {
          persistConversation({
            ...toRecord(payload.conversation),
            timelineRevision: incomingRevision ?? payload.conversation.timelineRevision,
            syncStatus: incomingRevision && localRevision > 0 && incomingRevision > localRevision + 1 ? "stale" : "complete",
          }).catch(() => {});
        }
        if (payload.item) {
          persistTimelineItem(payload.item as AgentTimelineItem).catch(() => {});
          const preview = previewFromItem(payload.item as AgentTimelineItem);
          if (preview) {
            const existing = conversationsRef.current.find((item) => item.id === payload.conversationId);
            if (existing) {
              persistConversation({
                ...existing,
                lastMessagePreview: preview,
                lastActivityAt: Date.now(),
                status: payload.item.status ?? existing.status,
                timelineRevision: incomingRevision
                  ? Math.max(existing.timelineRevision ?? 0, incomingRevision)
                  : existing.timelineRevision,
                syncStatus: incomingRevision && (existing.timelineRevision ?? 0) > 0 && incomingRevision > (existing.timelineRevision ?? 0) + 1
                  ? "stale"
                  : "complete",
              }).catch(() => {});
            }
          }
        }
        if (payload.patch) {
          const patch = payload.patch as {
            itemId: string;
            kind?: AgentTimelineItem["kind"];
            role?: AgentTimelineItem["role"];
            content?: AgentTimelineItem["content"];
            text?: string;
            textDelta?: string;
            status?: AgentTimelineItem["status"];
            toolCall?: AgentTimelineItem["toolCall"];
            commandExecution?: AgentTimelineItem["commandExecution"];
            fileChange?: AgentTimelineItem["fileChange"];
            subagent?: AgentTimelineItem["subagent"];
            structuredInput?: AgentTimelineItem["structuredInput"];
            plan?: AgentTimelineItem["plan"];
            permission?: AgentTimelineItem["permission"];
            error?: AgentTimelineItem["error"];
            metadata?: AgentTimelineItem["metadata"];
            updatedAt?: number;
            isStreaming?: boolean;
          };
          setTimelineById((prev) => {
            const items = prev.get(payload.conversationId);
            if (!items) return prev;
            let patchedItem: AgentTimelineItem | undefined;
            const nextItems = items.map((item) => {
              if (item.id !== patch.itemId && item.itemId !== patch.itemId) return item;
              patchedItem = {
                ...item,
                kind: patch.kind ?? item.kind,
                role: patch.role ?? item.role,
                content: patch.content ?? item.content,
                text: patch.textDelta ? `${patch.text ?? item.text ?? ""}${patch.textDelta}` : patch.text ?? item.text,
                status: patch.status ?? item.status,
                toolCall: patch.toolCall ? { ...(item.toolCall ?? patch.toolCall), ...patch.toolCall } : item.toolCall,
                commandExecution: patch.commandExecution
                  ? { ...(item.commandExecution ?? {}), ...patch.commandExecution }
                  : item.commandExecution,
                fileChange: patch.fileChange
                  ? { ...(item.fileChange ?? {}), ...patch.fileChange }
                  : item.fileChange,
                subagent: patch.subagent
                  ? { ...(item.subagent ?? {}), ...patch.subagent }
                  : item.subagent,
                structuredInput: patch.structuredInput ?? item.structuredInput,
                plan: patch.plan ?? item.plan,
                permission: patch.permission
                  ? { ...(item.permission ?? {}), ...patch.permission }
                  : item.permission,
                error: patch.error ?? item.error,
                metadata: patch.metadata
                  ? { ...(item.metadata ?? {}), ...patch.metadata }
                  : item.metadata,
                updatedAt: patch.updatedAt ?? Date.now(),
                isStreaming: patch.isStreaming ?? item.isStreaming,
              };
              return patchedItem;
            });
            if (!patchedItem) return prev;
            saveAgentTimeline(payload.conversationId, nextItems).catch(() => {});
            const existing = conversationsRef.current.find((item) => item.id === payload.conversationId);
            const preview = previewFromItem(patchedItem);
            if (existing && preview) {
              persistConversation({
                ...existing,
                lastMessagePreview: preview,
                lastActivityAt: Date.now(),
                status: patchedItem.status ?? existing.status,
                timelineRevision: incomingRevision
                  ? Math.max(existing.timelineRevision ?? 0, incomingRevision)
                  : existing.timelineRevision,
                syncStatus: incomingRevision && (existing.timelineRevision ?? 0) > 0 && incomingRevision > (existing.timelineRevision ?? 0) + 1
                  ? "stale"
                  : "complete",
              }).catch(() => {});
            }
            const next = new Map(prev);
            next.set(payload.conversationId, nextItems);
            return next;
          });
        }
        return;
      }

      if (envelope.type === "device.error") {
        const payload = parseTypedPayload("device.error", envelope.payload) as any;
        if (payload.code !== "control_conflict") return;
        setTimelineById((prev) => {
          const next = new Map(prev);
          for (const [conversationId, items] of prev) {
            const conversation = conversationsRef.current.find((item) => item.id === conversationId);
            if (conversation?.sessionId !== envelope.hostDeviceId) continue;
            let changed = false;
            const nextItems = items.map((item) => {
              if (item.type === "permission" && item.metadata?.permissionPending === true) {
                changed = true;
                return {
                  ...item,
                  metadata: {
                    ...(item.metadata ?? {}),
                    permissionPending: false,
                    permissionError: "授权未发送：未获得控制权，请重试。",
                  },
                  updatedAt: Date.now(),
                };
              }
              if (item.kind === "user_input_prompt" && item.metadata?.inputSubmitting === true) {
                changed = true;
                return {
                  ...item,
                  metadata: {
                    ...(item.metadata ?? {}),
                    inputSubmitting: false,
                    inputError: "回答未发送：未获得控制权，请重试。",
                  },
                  updatedAt: Date.now(),
                };
              }
              return item;
            });
            if (changed) {
              next.set(conversationId, nextItems);
              saveAgentTimeline(conversationId, nextItems).catch(() => {});
            }
          }
          return next;
        });
        return;
      }

      if (envelope.type === "agent.v2.permission.request") {
        const payload = parseTypedPayload("agent.v2.permission.request", envelope.payload) as any;
        const rawPermissionItem = (payload.item ?? {
          id: `permission:${payload.requestId}`,
          conversationId: payload.conversationId,
          type: "permission",
          permission: {
            requestId: payload.requestId,
            toolName: payload.toolName,
            toolInput: payload.toolInput,
            context: payload.context,
            options: payload.options ?? [],
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }) as AgentTimelineItem;
        const permissionItem: AgentTimelineItem = {
          ...rawPermissionItem,
          metadata: {
            ...(rawPermissionItem.metadata ?? {}),
            protocol: "v2",
            sessionId: envelope.hostDeviceId,
            permissionLive: true,
            permissionExpired: false,
            permissionPending: false,
          },
        };
        persistTimelineItem(permissionItem).catch(() => {});
        const existing = conversationsRef.current.find((item) => item.id === payload.conversationId);
        if (existing) {
          persistConversation({
            ...existing,
            status: "waiting_permission",
            lastMessagePreview: previewFromItem(permissionItem) ?? "需要授权",
            lastActivityAt: Date.now(),
          }).catch(() => {});
        }
      }

      if (envelope.type === "terminal.status") {
        const payload = envelope.payload as {
          phase?: string;
          summary?: string;
          pendingPermissionCount?: number;
          permissionResolution?: {
            requestId?: string;
            outcome?: "allow" | "deny" | "cancelled";
            source?: string;
            delivered?: boolean;
          };
          topPermission?: {
            requestId?: string;
            toolName?: string;
            toolInput?: string;
            permissionRequest?: string;
            timestamp?: number;
          };
        };
        const topPermission = payload.topPermission;
        const permissionResolution = payload.permissionResolution;
        const terminalId = typeof (envelope as any).terminalId === "string"
          ? (envelope as any).terminalId
          : "default";
        const resolvedConversation = permissionResolution?.requestId
          ? conversationsRef.current.find((item) =>
              timelineRef.current.get(item.id)?.some((timelineItem) =>
                timelineItem.type === "permission" &&
                timelineItem.permission?.requestId === permissionResolution.requestId &&
                timelineItem.metadata?.sessionId === envelope.hostDeviceId,
              ),
            )
          : undefined;
        const conversation =
          resolvedConversation ??
          conversationsRef.current.find((item) => item.id === activeConversationId && item.sessionId === envelope.hostDeviceId) ??
          conversationsRef.current.find((item) =>
            item.sessionId === envelope.hostDeviceId &&
            !item.archived &&
            (item.status === "running" || item.status === "waiting_permission"),
          ) ??
          conversationsRef.current.find((item) => item.sessionId === envelope.hostDeviceId && !item.archived);
        if (!conversation) return;
        if (permissionResolution?.requestId) {
          const delivered = permissionResolution.delivered === true;
          const outcome = permissionResolution.outcome;
          setTimelineById((prev) => {
            const items = prev.get(conversation.id);
            if (!items) return prev;
            let changed = false;
            const nextItems = items.map((item) => {
              if (item.type === "permission" && item.permission?.requestId === permissionResolution.requestId) {
                changed = true;
                return {
                  ...item,
                  metadata: {
                    ...(item.metadata ?? {}),
                    permissionLive: false,
                    permissionPending: false,
                    permissionExpired: false,
                    permissionDelivered: delivered,
                    permissionResolutionSource: permissionResolution.source,
                    ...(outcome ? { permissionOutcome: outcome } : {}),
                    permissionError: delivered
                      ? undefined
                      : "授权没有送达 Agent：这条请求可能已经过期或被其它入口处理。",
                  },
                  updatedAt: Date.now(),
                };
              }
              return item;
            });
            if (!changed) return prev;
            saveAgentTimeline(conversation.id, nextItems).catch(() => {});
            const next = new Map(prev);
            next.set(conversation.id, nextItems);
            return next;
          });
          if (!topPermission?.requestId) return;
        }
        if (!topPermission?.requestId) {
          const pendingCount = payload.pendingPermissionCount ?? 0;
          const shouldClearPermissions =
            pendingCount === 0 &&
            (payload.phase !== "waiting" || payload.summary === "permission allowed" || payload.summary === "permission denied");
          if (!shouldClearPermissions) return;
          const outcome = payload.summary === "permission denied"
            ? "deny"
            : payload.summary === "permission allowed"
              ? "allow"
              : undefined;
          setTimelineById((prev) => {
            const items = prev.get(conversation.id);
            if (!items) return prev;
            let changed = false;
            const nextItems = items.map((item) => {
              if (
                item.type === "permission" &&
                item.metadata?.protocol === "terminal" &&
                item.metadata?.sessionId === envelope.hostDeviceId &&
                (item.metadata?.terminalId ?? "default") === terminalId &&
                item.metadata?.permissionLive === true &&
                !item.metadata?.permissionOutcome
              ) {
                changed = true;
                return {
                  ...item,
                  metadata: {
                    ...(item.metadata ?? {}),
                    permissionLive: false,
                    permissionPending: false,
                    permissionExpired: false,
                    ...(outcome ? { permissionOutcome: outcome } : {}),
                    permissionError: undefined,
                  },
                  updatedAt: Date.now(),
                };
              }
              return item;
            });
            if (!changed) return prev;
            saveAgentTimeline(conversation.id, nextItems).catch(() => {});
            const next = new Map(prev);
            next.set(conversation.id, nextItems);
            return next;
          });
          return;
        }
        const permissionItem: AgentTimelineItem = {
          id: `permission:${topPermission.requestId}`,
          conversationId: conversation.id,
          type: "permission",
          permission: {
            requestId: topPermission.requestId,
            toolName: topPermission.toolName,
            toolInput: topPermission.toolInput || topPermission.permissionRequest,
            context: topPermission.permissionRequest,
            options: [
              { id: "deny", label: "拒绝", kind: "deny" },
              { id: "allow_once", label: "允许一次", kind: "allow" },
            ],
          },
          metadata: {
            protocol: "terminal",
            sessionId: envelope.hostDeviceId,
            terminalId,
            permissionLive: true,
            permissionExpired: false,
            permissionPending: false,
          },
          createdAt: topPermission.timestamp ?? Date.now(),
          updatedAt: Date.now(),
        };
        persistTimelineItem(permissionItem).catch(() => {});
        persistConversation({
          ...conversation,
          status: "waiting_permission",
          lastMessagePreview: previewFromItem(permissionItem) ?? "需要授权",
          lastActivityAt: Date.now(),
        }).catch(() => {});
      }
    },
    [activeConversationId, flushPendingCodexDeltas, persistCodexThread, persistConversation, persistTimelineItem, queueCodexDeltaItem, requestCodexTurns, requestDelta, requestHistoryPage, sendCodexRpc, upsertCodexItem],
  );

  useEffect(() => {
    manager.onAgentWorkspaceEnvelope(handleEnvelope);
    return () => manager.onAgentWorkspaceEnvelope(null);
  }, [handleEnvelope, manager]);

  const openConversation = useCallback(
    async (input: OpenConversationInput) => {
      let session = manager.sessions.get(input.sessionId);
      if (!session && input.serverUrl) {
        manager.connectToSession(input.sessionId, input.serverUrl);
        session = manager.sessions.get(input.sessionId);
      }
      const serverUrl = normalizeServerUrl(session?.gatewayUrl ?? input.serverUrl ?? "");
      if (!serverUrl) {
        return { conversationId: null, error: "缺少 gateway 地址，无法连接这个会话。" };
      }
      const conversationId =
        input.conversationId ??
        makeAgentConversationId({
          serverUrl,
          hostDeviceId: session?.hostDeviceId ?? input.hostDeviceId ?? input.sessionId,
          sessionId: input.sessionId,
          agentSessionId: input.agentSessionId,
          cwd: input.cwd,
          provider: input.provider,
        });
      setActiveConversationId(conversationId);
      if (session) manager.setActiveSessionId(session.sessionId);
      if ((input.provider ?? "codex") === "codex") {
        const now = Date.now();
        const existing = conversationsRef.current.find((item) => item.id === conversationId);
        const baseRecord: AgentConversationRecord = {
          id: conversationId,
          serverUrl,
          hostDeviceId: session?.hostDeviceId ?? input.hostDeviceId ?? input.sessionId,
          sessionId: session?.sessionId ?? input.sessionId,
          machineId: session?.machineId ?? input.machineId,
          agentSessionId: input.agentSessionId ?? existing?.agentSessionId,
          provider: "codex",
          cwd: input.cwd,
          title: input.title || existing?.title || input.cwd.split("/").filter(Boolean).pop() || "Codex",
          model: input.model ?? existing?.model,
          reasoningEffort: input.reasoningEffort ?? existing?.reasoningEffort,
          serviceTier: input.serviceTier ?? existing?.serviceTier,
          permissionMode: input.permissionMode ?? existing?.permissionMode,
          collaborationMode: input.collaborationMode ?? existing?.collaborationMode ?? "default",
          status: existing?.status === "waiting_permission" ? "waiting_permission" : "idle",
          archived: false,
          runningTurnId: undefined,
          syncStatus: session ? "syncing" : "deferred",
          source: existing?.source ?? "cache",
          lastMessagePreview: codexPreviewIsControlNoise(existing?.lastMessagePreview) ? undefined : existing?.lastMessagePreview,
          lastActivityAt: existing?.lastActivityAt ?? now,
          createdAt: existing?.createdAt ?? now,
          schemaVersion: 2,
        };
        await persistConversation(baseRecord, { preserveLocalArchived: false });
        if (CODEX_TIMELINE_CACHE_ENABLED) {
          const cachedTimeline = normalizeCachedCodexTimelineItems(await loadAgentTimeline(conversationId));
          const cachedThreadId = baseRecord.agentSessionId ?? conversationId;
          const cachedItems = cachedTimeline
            .map((item, index) => codexTimelineToMessage(item, cachedThreadId, index))
            .filter((item): item is CodexMessageItem => Boolean(item));
          if (cachedItems.length > 0) {
            const cachedThread: CodexThreadState = {
              conversationId,
              threadId: cachedThreadId,
              activeTurnId: undefined,
              isRunning: false,
              items: cachedItems,
            };
            const next = new Map(codexThreadsRef.current);
            next.set(conversationId, cachedThread);
            codexThreadsRef.current = next;
            codexThreadConversationRef.current.set(cachedThreadId, conversationId);
            setCodexThreadsByConversationId(next);
            const timelineNext = new Map(timelineRef.current);
            timelineNext.set(conversationId, cachedTimeline);
            timelineRef.current = timelineNext;
            setTimelineById(timelineNext);
            historyHasMoreRef.current.delete(conversationId);
          }
        } else {
          saveAgentTimeline(conversationId, []).catch(() => {});
        }
        if (!session) return { conversationId, status: baseRecord.status };
        try {
          await ensureCodexInitialized(session.sessionId);
          const response = input.agentSessionId
            ? await requestCodexRpc(session.sessionId, "thread/resume", {
                threadId: input.agentSessionId,
                cwd: input.cwd,
                excludeTurns: true,
              }, { conversationId, timeoutMs: 30_000 })
            : await requestCodexRpc(session.sessionId, "thread/start", codexThreadStartParams({
                cwd: input.cwd,
                model: input.model,
                serviceTier: input.serviceTier,
                permissionMode: input.permissionMode,
              }), { conversationId, timeoutMs: 30_000 });
          const threadId = codexThreadId(response.result) ?? input.agentSessionId ?? conversationId;
          const stableConversationId = input.conversationId
            ? conversationId
            : makeAgentConversationId({
                serverUrl,
                hostDeviceId: session.hostDeviceId,
                sessionId: session.sessionId,
                agentSessionId: threadId,
                cwd: input.cwd,
                provider: "codex",
              });
          if (stableConversationId !== conversationId) {
            const codexThreadsNext = new Map(codexThreadsRef.current);
            const existingThread = codexThreadsNext.get(conversationId);
            if (existingThread) {
              codexThreadsNext.delete(conversationId);
              codexThreadsNext.set(stableConversationId, {
                ...existingThread,
                conversationId: stableConversationId,
                threadId,
              });
              codexThreadsRef.current = codexThreadsNext;
              setCodexThreadsByConversationId(codexThreadsNext);
            }
            const timelineNext = new Map(timelineRef.current);
            const existingTimeline = timelineNext.get(conversationId);
            if (existingTimeline) {
              const migratedTimeline = existingTimeline.map((item) => ({
                ...item,
                conversationId: stableConversationId,
              }));
              timelineNext.delete(conversationId);
              timelineNext.set(stableConversationId, migratedTimeline);
              timelineRef.current = timelineNext;
              setTimelineById(timelineNext);
              saveAgentTimeline(stableConversationId, migratedTimeline).catch(() => {});
            }
            setConversations((prev) => prev.filter((item) => item.id !== conversationId));
            setActiveConversationId(stableConversationId);
            archiveAgentConversation(conversationId, true).catch(() => {});
          }
          codexThreadConversationRef.current.set(threadId, stableConversationId);
          await persistConversation({
            ...baseRecord,
            id: stableConversationId,
            agentSessionId: threadId,
            syncStatus: "complete",
            source: "app-server",
            lastActivityAt: Date.now(),
          }, { preserveLocalArchived: false });
          requestCodexTurns(session.sessionId, stableConversationId, threadId).catch(() => {});
          return { conversationId: stableConversationId, status: "idle" as const };
        } catch (error) {
          if (codexInitializeErrorIsBenign(error)) {
            await persistConversation({
              ...baseRecord,
              syncStatus: "stale",
              source: "cache",
              lastMessagePreview: codexPreviewIsControlNoise(baseRecord.lastMessagePreview)
                ? undefined
                : baseRecord.lastMessagePreview,
              lastActivityAt: existing?.lastActivityAt ?? Date.now(),
            }, { preserveLocalArchived: false });
            return { conversationId, status: baseRecord.status };
          }
          await persistConversation({
            ...baseRecord,
            status: "error",
            syncStatus: "stale",
            lastMessagePreview: error instanceof Error ? error.message : String(error),
            lastActivityAt: Date.now(),
          }, { preserveLocalArchived: false });
          return { conversationId, status: "error" as const, error: error instanceof Error ? error.message : String(error) };
        }
      }
      return await new Promise<OpenConversationResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingOpenRef.current.delete(conversationId);
          resolve({
            conversationId: null,
            error: "CLI 没有在 12 秒内确认对话，请确认主机端 linkshell 仍在线。",
          });
        }, 12_000);
        pendingOpenRef.current.set(conversationId, { resolve, timer });
        manager.sendAgentWorkspaceEnvelope(
          session?.sessionId ?? input.sessionId,
          "agent.v2.conversation.open",
          {
            conversationId,
            agentSessionId: input.agentSessionId,
            cwd: input.cwd,
            provider: input.provider ?? "codex",
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            serviceTier: input.serviceTier,
            permissionMode: input.permissionMode,
            collaborationMode: input.collaborationMode,
            title: input.title || input.cwd.split("/").filter(Boolean).pop() || "Agent",
          },
          { queue: true, dedupeKey: `agent-v2-open:${conversationId}` },
        );
      });
    },
    [ensureCodexInitialized, manager, persistConversation, requestCodexRpc, requestCodexTurns],
  );

  const openProject = useCallback(
    (record: ProjectRecord) => {
      const session = record.machineId
        ? [...manager.sessions.values()].find((item) =>
            normalizeServerUrl(item.gatewayUrl) === normalizeServerUrl(record.serverUrl) &&
            item.machineId === record.machineId
          )
        : manager.sessions.get(record.sessionId);
      if (!session && record.machineId) {
        return Promise.resolve(null);
      }
      if (!session) {
        manager.connectToSession(record.sessionId, record.serverUrl);
      } else {
        manager.setActiveSessionId(session.sessionId);
      }
      return openConversation({
        sessionId: session?.sessionId ?? record.sessionId,
        hostDeviceId: session?.hostDeviceId ?? record.hostDeviceId,
        machineId: session?.machineId ?? record.machineId,
        serverUrl: session?.gatewayUrl ?? record.serverUrl,
        cwd: record.cwd,
        provider: (record.provider === "claude" || record.provider === "codex" || record.provider === "custom")
          ? record.provider
          : "codex",
        title: record.projectName,
      }).then((result) => result.conversationId);
    },
    [manager, openConversation],
  );

  const resumeConversation = useCallback(
    async (conversationId: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return null;
      const session = findSessionForConversation(conversation, manager.sessions);
      if (!session) {
        return null;
      }
      manager.setActiveSessionId(session.sessionId);
      await persistConversation({
        ...conversation,
        hostDeviceId: session.hostDeviceId,
        sessionId: session.sessionId,
        machineId: session.machineId ?? conversation.machineId,
        archived: false,
        lastActivityAt: Date.now(),
      }, { preserveLocalArchived: false });
      const result = await openConversation({
        conversationId: conversation.id,
        agentSessionId: conversation.agentSessionId,
        sessionId: session.sessionId,
        hostDeviceId: session.hostDeviceId,
        machineId: session.machineId ?? conversation.machineId,
        serverUrl: session.gatewayUrl,
        cwd: conversation.cwd,
        provider: conversation.provider,
        model: conversation.model,
        reasoningEffort: conversation.reasoningEffort,
        serviceTier: conversation.serviceTier,
        permissionMode: conversation.permissionMode,
        collaborationMode: conversation.collaborationMode,
        title: conversation.title,
      });
      return result.conversationId;
    },
    [manager, openConversation, persistConversation],
  );

  const sendPrompt = useCallback(
    (
      conversationId: string,
      text: string,
      options?: {
        model?: string;
        reasoningEffort?: AgentReasoningEffort;
        serviceTier?: AgentServiceTier;
        permissionMode?: AgentPermissionMode;
        collaborationMode?: AgentCollaborationMode;
        attachments?: AgentContentBlock[];
        forceSteer?: boolean;
      },
    ) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      const trimmed = text.trim();
      const attachments = (options?.attachments ?? []).filter((block) => block.type === "image" && block.data);
      if (!conversation || (!trimmed && attachments.length === 0)) return;
      const clientMessageId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const fileBlocks = trimmed ? extractPromptFileBlocks(trimmed, conversation.cwd) : [];
      const contentBlocks: AgentContentBlock[] = [
        ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
        ...fileBlocks,
        ...attachments,
      ];

      const now = Date.now();
      const optimisticItem: AgentTimelineItem = {
        id: clientMessageId,
        conversationId,
        type: "message",
        kind: "chat",
        role: "user",
        content: contentBlocks,
        text: textFromBlocks(contentBlocks),
        metadata: { optimistic: true },
        createdAt: now,
      };
      const session = findSessionForConversation(conversation, manager.sessions);
      const useGenericOptimisticTimeline = conversation.provider !== "codex" || !session;
      if (useGenericOptimisticTimeline) {
        setTimelineById((prev) => {
          const next = new Map(prev);
          next.set(conversationId, mergeTimeline(next.get(conversationId) ?? [], [optimisticItem]));
          return next;
        });
        upsertAgentTimelineItem(optimisticItem).catch(() => {});
      }

      const hasModel = Object.prototype.hasOwnProperty.call(options ?? {}, "model");
      const hasEffort = Object.prototype.hasOwnProperty.call(options ?? {}, "reasoningEffort");
      const hasServiceTier = Object.prototype.hasOwnProperty.call(options ?? {}, "serviceTier");
      const hasPermission = Object.prototype.hasOwnProperty.call(options ?? {}, "permissionMode");
      const hasCollaboration = Object.prototype.hasOwnProperty.call(options ?? {}, "collaborationMode");
      const nextConversation: AgentConversationRecord = {
        ...conversation,
        model: hasModel ? options?.model : conversation.model,
        reasoningEffort: hasEffort ? options?.reasoningEffort : conversation.reasoningEffort,
        serviceTier: hasServiceTier ? options?.serviceTier : conversation.serviceTier,
        permissionMode: hasPermission ? options?.permissionMode : conversation.permissionMode,
        collaborationMode: hasCollaboration ? options?.collaborationMode : conversation.collaborationMode,
        status: "running",
        lastMessagePreview: previewFromItem(optimisticItem) ?? conversation.lastMessagePreview,
        lastActivityAt: now,
      };
      setConversations((prev) => {
        const next = prev.filter((item) => item.id !== conversationId);
        next.unshift(nextConversation);
        return next.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      });
      upsertAgentConversation(nextConversation).catch(() => {});

      if (!session) {
        const failedItem: AgentTimelineItem = {
          id: `error:${clientMessageId}`,
          conversationId,
          type: "error",
          error: "消息已记录，但当前主机不在线，暂未发送。",
          createdAt: Date.now(),
        };
        setTimelineById((prev) => {
          const next = new Map(prev);
          next.set(conversationId, mergeTimeline(next.get(conversationId) ?? [], [failedItem]));
          return next;
        });
        upsertAgentTimelineItem(failedItem).catch(() => {});
        return;
      }

      if (conversation.provider === "codex") {
        const existingThread = codexThreadsRef.current.get(conversationId);
        const threadId = existingThread?.threadId ?? conversation.agentSessionId ?? conversation.id;
        const activeTurnId = conversation.runningTurnId ?? existingThread?.activeTurnId;
        const steerTurnId = conversation.status === "running" && activeTurnId ? activeTurnId : undefined;
        const shouldSteerActiveTurn = Boolean(steerTurnId);
        const mustSteerActiveTurn = options?.forceSteer === true;
        const capability = capabilitiesBySessionId.get(session.sessionId) ?? capabilitiesBySessionId.get(session.hostDeviceId);
        const codexProvider = capability?.providers?.find((provider) => provider.id === "codex");
        const effectiveModel = hasModel
          ? options?.model ?? undefined
          : conversation.model ?? codexProvider?.defaultModel ?? codexProvider?.models?.[0]?.id;
        const effectiveReasoningEffort = hasEffort
          ? options?.reasoningEffort ?? undefined
          : conversation.reasoningEffort ?? codexProvider?.models?.find((model) => model.id === effectiveModel)?.defaultReasoningEffort;
        const effectiveCollaborationMode = hasCollaboration
          ? options?.collaborationMode ?? undefined
          : conversation.collaborationMode;
        codexThreadConversationRef.current.set(threadId, conversationId);
        if (mustSteerActiveTurn && !shouldSteerActiveTurn) {
          upsertCodexItem(conversationId, {
            threadId,
            itemId: clientMessageId,
            orderIndex: (codexThreadsRef.current.get(conversationId)?.items.length ?? 0) + 1,
            role: "user",
            type: "message",
            text: textFromBlocks(contentBlocks),
            deliveryState: "failed",
            createdAt: now,
            updatedAt: Date.now(),
          });
          upsertCodexItem(conversationId, {
            threadId,
            itemId: `error:${clientMessageId}`,
            orderIndex: (codexThreadsRef.current.get(conversationId)?.items.length ?? 0) + 2,
            type: "error",
            text: "当前任务还没有可引导的 turn id，请稍后重试。",
            deliveryState: "failed",
            createdAt: Date.now(),
          });
          setConversations((prev) => prev.map((item) =>
            item.id === conversationId ? { ...item, status: conversation.status } : item
          ));
          return;
        }
        upsertCodexItem(conversationId, {
          threadId,
          turnId: steerTurnId,
          itemId: clientMessageId,
          orderIndex: (codexThreadsRef.current.get(conversationId)?.items.length ?? 0) + 1,
          role: "user",
          type: "message",
          text: textFromBlocks(contentBlocks),
          deliveryState: "pending",
          createdAt: now,
        });
        ensureCodexInitialized(session.sessionId)
          .then(() => {
            const sendCodexTurn = (includeCollaborationMode: boolean): Promise<CodexRpcMessage> => {
              const params = codexTurnStartParams({
                threadId,
                cwd: conversation.cwd,
                contentBlocks,
                model: effectiveModel,
                reasoningEffort: effectiveReasoningEffort,
                serviceTier: hasServiceTier ? options?.serviceTier ?? undefined : conversation.serviceTier,
                permissionMode: hasPermission ? options?.permissionMode ?? undefined : conversation.permissionMode,
                collaborationMode: effectiveCollaborationMode,
                includeCollaborationMode: includeCollaborationMode && !codexPlanUnsupportedSessionsRef.current.has(session.sessionId),
              });
              return shouldSteerActiveTurn
                ? requestCodexRpc(session.sessionId, "turn/steer", {
                    threadId,
                    expectedTurnId: steerTurnId!,
                    input: params.input,
                    ...(params.collaborationMode ? { collaborationMode: params.collaborationMode } : {}),
                  }, {
                    conversationId,
                    clientMessageId,
                    timeoutMs: 60_000,
                  })
                : requestCodexRpc(session.sessionId, "turn/start", params, {
                    conversationId,
                    clientMessageId,
                    timeoutMs: 60_000,
                  });
            };
            return sendCodexTurn(true).catch((error) => {
              if (!codexShouldRetryWithoutCollaborationMode(error)) throw error;
              codexPlanUnsupportedSessionsRef.current.add(session.sessionId);
              if (session.hostDeviceId) codexPlanUnsupportedSessionsRef.current.add(session.hostDeviceId);
              updateCodexRuntimeCapabilities(session.sessionId, (previous) => ({
                id: "codex",
                label: previous?.label ?? "Codex",
                enabled: true,
                supportsImages: previous?.supportsImages ?? true,
                supportsPermission: true,
                supportsPlan: false,
                supportsCancel: true,
                providerProtocol: "codex-app-server",
                modelsSource: previous?.modelsSource,
                modelListError: previous?.modelListError,
                models: previous?.models,
                defaultModel: previous?.defaultModel,
                reasoningEfforts: previous?.reasoningEfforts ?? CODEX_REASONING_EFFORTS,
                speedTiers: previous?.speedTiers ?? CODEX_DEFAULT_SPEED_TIERS,
                defaultServiceTier: previous?.defaultServiceTier,
                permissionModes: previous?.permissionModes ?? CODEX_PERMISSION_MODES,
                commands: codexRpcCommands(false),
                modes: previous?.modes,
                currentMode: "default",
                features: {
                  ...(previous?.features ?? {}),
                  plan: false,
                },
              }));
              setConversations((prev) => prev.map((item) =>
                item.id === conversationId ? { ...item, collaborationMode: "default" } : item
              ));
              return sendCodexTurn(false);
            });
          })
          .then((response) => {
            const startedThreadId = codexThreadId(response.result) ?? threadId;
            const turnId = codexTurnId(response.result) ?? steerTurnId;
            if (startedThreadId !== threadId) {
              codexThreadConversationRef.current.set(startedThreadId, conversationId);
            }
            upsertCodexItem(conversationId, {
              threadId: startedThreadId,
              turnId,
              itemId: clientMessageId,
              orderIndex: (codexThreadsRef.current.get(conversationId)?.items.find((item) => item.itemId === clientMessageId)?.orderIndex) ?? 1,
              role: "user",
              type: "message",
              text: textFromBlocks(contentBlocks),
              deliveryState: "confirmed",
              createdAt: now,
              updatedAt: Date.now(),
            });
            setConversations((prev) => prev.map((item) =>
              item.id === conversationId
                ? { ...item, agentSessionId: startedThreadId, runningTurnId: turnId ?? item.runningTurnId, status: "running" }
                : item
            ));
          })
          .catch((error) => {
            upsertCodexItem(conversationId, {
              threadId,
              turnId: steerTurnId,
              itemId: clientMessageId,
              orderIndex: (codexThreadsRef.current.get(conversationId)?.items.find((item) => item.itemId === clientMessageId)?.orderIndex) ?? 1,
              role: "user",
              type: "message",
              text: textFromBlocks(contentBlocks),
              deliveryState: "failed",
              createdAt: now,
              updatedAt: Date.now(),
            });
            upsertCodexItem(conversationId, {
              threadId,
              itemId: `error:${clientMessageId}`,
              orderIndex: (codexThreadsRef.current.get(conversationId)?.items.length ?? 0) + 1,
              type: "error",
              text: error instanceof Error ? error.message : String(error),
              deliveryState: "failed",
              createdAt: Date.now(),
            });
            setConversations((prev) => prev.map((item) =>
              item.id === conversationId ? { ...item, status: shouldSteerActiveTurn ? "running" : "error" } : item
            ));
          });
        return;
      }

      const accepted = manager.sendAgentWorkspaceEnvelope(
        session.sessionId,
        "agent.v2.prompt",
        {
          conversationId,
          clientMessageId,
          contentBlocks,
          model: hasModel ? options?.model ?? null : undefined,
          reasoningEffort: hasEffort ? options?.reasoningEffort ?? null : undefined,
          serviceTier: hasServiceTier ? options?.serviceTier ?? null : undefined,
          permissionMode: hasPermission ? options?.permissionMode ?? null : undefined,
          collaborationMode: hasCollaboration ? options?.collaborationMode ?? null : undefined,
        },
        { queue: true },
      );
      if (!accepted) {
        const failedItem: AgentTimelineItem = {
          id: `error:${clientMessageId}`,
          conversationId,
          type: "error",
          error: "消息未发送：连接未就绪，请稍后重试。",
          createdAt: Date.now(),
        };
        setTimelineById((prev) => {
          const next = new Map(prev);
          next.set(conversationId, mergeTimeline(next.get(conversationId) ?? [], [failedItem]));
          return next;
        });
        upsertAgentTimelineItem(failedItem).catch(() => {});
      }
    },
    [capabilitiesBySessionId, ensureCodexInitialized, manager, requestCodexRpc, updateCodexRuntimeCapabilities, upsertCodexItem],
  );

  const executeCommand = useCallback(
    (
      conversationId: string,
      command: AgentCommandDescriptor,
      rawText: string,
      args?: string,
    ) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return;
      const session = findSessionForConversation(conversation, manager.sessions);
      if (!session) return;
      const clientMessageId = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      if (conversation.provider === "codex") {
        if (command.name === "plan" || command.name === "exit-plan") {
          const nextMode: AgentCollaborationMode = command.name === "plan" ? "plan" : "default";
          const statusItem: AgentTimelineItem = {
            id: clientMessageId,
            conversationId,
            type: "status",
            kind: "chat",
            status: "idle",
            text: nextMode === "plan"
              ? "已进入 Plan mode。下一条消息会通过 Codex collaborationMode=plan 发送。"
              : "已退出 Plan mode。",
            metadata: {
              commandId: command.id,
              commandExecutionKind: command.executionKind,
              protocol: "codex-app-server",
            },
            createdAt: now,
          };
          const nextConversation = {
            ...conversation,
            collaborationMode: nextMode,
            status: "idle" as const,
            lastMessagePreview: nextMode === "plan" ? "已进入 Plan mode" : "已退出 Plan mode",
            lastActivityAt: now,
          };
          setConversations((prev) => prev.map((item) => item.id === conversationId ? nextConversation : item));
          upsertAgentConversation(nextConversation).catch(() => {});
          setTimelineById((prev) => {
            const next = new Map(prev);
            next.set(conversationId, mergeTimeline(next.get(conversationId) ?? [], [statusItem]));
            return next;
          });
          upsertAgentTimelineItem(statusItem).catch(() => {});
          return;
        }
        const threadId = codexThreadsRef.current.get(conversationId)?.threadId ?? conversation.agentSessionId;
        if (!threadId) return;
        const optimisticItem: AgentTimelineItem = {
          id: clientMessageId,
          conversationId,
          type: "message",
          kind: command.name === "compact" ? "context_compaction" : command.name === "review" ? "review" : "chat",
          role: "user",
          content: [{ type: "text", text: rawText }],
          text: rawText,
          metadata: {
            optimistic: true,
            commandId: command.id,
            commandExecutionKind: command.executionKind,
            protocol: "codex-app-server",
          },
          createdAt: now,
        };
        setTimelineById((prev) => {
          const next = new Map(prev);
          next.set(conversationId, mergeTimeline(next.get(conversationId) ?? [], [optimisticItem]));
          return next;
        });
        upsertAgentTimelineItem(optimisticItem).catch(() => {});
        setConversations((prev) => prev.map((item) =>
          item.id === conversationId
            ? {
                ...item,
                status: command.name === "new" ? "idle" : "running",
                lastMessagePreview: previewFromItem(optimisticItem) ?? item.lastMessagePreview,
                lastActivityAt: now,
              }
            : item
        ));

        const fail = (message: string) => {
          const failedItem: AgentTimelineItem = {
            id: `error:${clientMessageId}`,
            conversationId,
            type: "error",
            error: message,
            createdAt: Date.now(),
          };
          setTimelineById((prev) => {
            const next = new Map(prev);
            next.set(conversationId, mergeTimeline(next.get(conversationId) ?? [], [failedItem]));
            return next;
          });
          upsertAgentTimelineItem(failedItem).catch(() => {});
          setConversations((prev) => prev.map((item) =>
            item.id === conversationId ? { ...item, status: "error", lastActivityAt: Date.now() } : item
          ));
        };

        ensureCodexInitialized(session.sessionId)
          .then(() => {
            if (command.name === "compact") {
              return requestCodexRpc(session.sessionId, "thread/compact/start", { threadId }, {
                conversationId,
                clientMessageId,
                timeoutMs: 60_000,
              }).then(() => {
                setConversations((prev) => prev.map((item) =>
                  item.id === conversationId ? { ...item, status: "idle", lastActivityAt: Date.now() } : item
                ));
              });
            }
            if (command.name === "new") {
              return requestCodexRpc(session.sessionId, "thread/start", codexThreadStartParams({
                cwd: conversation.cwd,
                model: conversation.model,
                serviceTier: conversation.serviceTier,
                permissionMode: conversation.permissionMode,
              }), {
                conversationId,
                clientMessageId,
                timeoutMs: 30_000,
              }).then((response) => {
                const nextThreadId = codexThreadId(response.result);
                if (!nextThreadId) throw new Error("Codex did not return a new thread id.");
                codexThreadConversationRef.current.set(nextThreadId, conversationId);
                historyCursorRef.current.delete(conversationId);
                historyHasMoreRef.current.set(conversationId, false);
                saveAgentHistoryPageState(conversationId, { hasMore: false }).catch(() => {});
                replaceCodexHistory(conversationId, nextThreadId, [], undefined, "replace", null);
                persistConversation({
                  ...conversation,
                  agentSessionId: nextThreadId,
                  runningTurnId: undefined,
                  status: "idle",
                  lastMessagePreview: "新 Codex thread 已创建",
                  lastActivityAt: Date.now(),
                  syncStatus: "complete",
                  source: "app-server",
                }, { preserveLocalArchived: false }).catch(() => {});
              });
            }
            if (command.name === "review") {
              return requestCodexRpc(session.sessionId, "review/start", {
                threadId,
                target: args?.trim()
                  ? { type: "custom", instructions: args.trim() }
                  : { type: "uncommittedChanges" },
                delivery: "inline",
              }, {
                conversationId,
                clientMessageId,
                timeoutMs: 60_000,
              }).then((response) => {
                const turnId = codexTurnId(response.result) ?? firstString(asRecord(response.result)?.turn, ["id"]);
                if (turnId) {
                  setConversations((prev) => prev.map((item) =>
                    item.id === conversationId
                      ? { ...item, status: "running", runningTurnId: turnId, lastActivityAt: Date.now() }
                      : item
                  ));
                }
              });
            }
            throw new Error(`Codex app-server 不支持命令：/${command.name}`);
          })
          .catch((error) => fail(error instanceof Error ? error.message : String(error)));
        return;
      }
      const accepted = manager.sendAgentWorkspaceEnvelope(
        session.sessionId,
        "agent.v2.command.execute",
        {
          conversationId,
          commandId: command.id,
          rawText,
          args,
          clientMessageId,
        },
        { queue: true },
      );
      if (accepted) {
        const optimisticItem: AgentTimelineItem = {
          id: clientMessageId,
          conversationId,
          type: "message",
          kind: "chat",
          role: "user",
          content: [{ type: "text", text: rawText }],
          text: rawText,
          metadata: {
            optimistic: true,
            commandId: command.id,
            commandExecutionKind: command.executionKind,
          },
          createdAt: now,
        };
        setTimelineById((prev) => {
          const next = new Map(prev);
          next.set(conversationId, mergeTimeline(next.get(conversationId) ?? [], [optimisticItem]));
          return next;
        });
        upsertAgentTimelineItem(optimisticItem).catch(() => {});
        const nextConversation: AgentConversationRecord = {
          ...conversation,
          status: command.executionKind === "prompt" ? "running" : conversation.status,
          lastMessagePreview: previewFromItem(optimisticItem) ?? conversation.lastMessagePreview,
          lastActivityAt: now,
        };
        setConversations((prev) => {
          const next = prev.filter((item) => item.id !== conversationId);
          next.unshift(nextConversation);
          return next.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        });
        upsertAgentConversation(nextConversation).catch(() => {});
        return;
      }
      if (!accepted) {
        const failedItem: AgentTimelineItem = {
          id: `error:${clientMessageId}`,
          conversationId,
          type: "error",
          error: "命令未发送：连接未就绪，请稍后重试。",
          createdAt: Date.now(),
        };
        setTimelineById((prev) => {
          const next = new Map(prev);
          next.set(conversationId, mergeTimeline(next.get(conversationId) ?? [], [failedItem]));
          return next;
        });
        upsertAgentTimelineItem(failedItem).catch(() => {});
      }
    },
    [ensureCodexInitialized, manager, persistConversation, replaceCodexHistory, requestCodexRpc],
  );

  const updateConversationSettings = useCallback(
    async (
      conversationId: string,
      settings: {
        model?: string;
        reasoningEffort?: AgentReasoningEffort;
        serviceTier?: AgentServiceTier;
        permissionMode?: AgentPermissionMode;
        collaborationMode?: AgentCollaborationMode;
      },
    ) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return;
      const hasModel = Object.prototype.hasOwnProperty.call(settings, "model");
      const hasEffort = Object.prototype.hasOwnProperty.call(settings, "reasoningEffort");
      const hasServiceTier = Object.prototype.hasOwnProperty.call(settings, "serviceTier");
      const hasPermission = Object.prototype.hasOwnProperty.call(settings, "permissionMode");
      const hasCollaboration = Object.prototype.hasOwnProperty.call(settings, "collaborationMode");
      await persistConversation({
        ...conversation,
        model: hasModel ? settings.model : conversation.model,
        reasoningEffort: hasEffort ? settings.reasoningEffort : conversation.reasoningEffort,
        serviceTier: hasServiceTier ? settings.serviceTier : conversation.serviceTier,
        permissionMode: hasPermission ? settings.permissionMode : conversation.permissionMode,
        collaborationMode: hasCollaboration ? settings.collaborationMode : conversation.collaborationMode,
        lastActivityAt: conversation.lastActivityAt,
      });
    },
    [persistConversation],
  );

  const cancel = useCallback(
    (conversationId: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return;
      const session = findSessionForConversation(conversation, manager.sessions);
      if (!session) return;
      if (conversation.provider === "codex") {
        const existingThread = codexThreadsRef.current.get(conversationId);
        const threadId = existingThread?.threadId ?? conversation.agentSessionId;
        const turnId = conversation.runningTurnId ?? existingThread?.activeTurnId;
        if (!threadId || !turnId) return;
        ensureCodexInitialized(session.sessionId)
          .then(() => requestCodexRpc(session.sessionId, "turn/interrupt", { threadId, turnId }, {
            conversationId,
            timeoutMs: 15_000,
          }))
          .catch(() => {});
        return;
      }
      manager.sendAgentWorkspaceEnvelope(
        session.sessionId,
        "agent.v2.cancel",
        { conversationId },
        { queue: true, dedupeKey: `agent-v2-cancel:${conversationId}` },
      );
    },
    [ensureCodexInitialized, manager, requestCodexRpc],
  );

  const resolvePermissionSessionId = useCallback(
    (
      conversation: AgentConversationRecord,
      permissionItem: AgentTimelineItem | undefined,
    ): string | null => {
      const metadataSessionId = typeof permissionItem?.metadata?.sessionId === "string"
        ? permissionItem.metadata.sessionId
        : undefined;
      if (metadataSessionId && manager.sessions.has(metadataSessionId)) return metadataSessionId;
      const resolved = findSessionForConversation(conversation, manager.sessions);
      if (resolved) return resolved.sessionId;

      const serverUrl = normalizeServerUrl(conversation.serverUrl);
      const candidates = [...manager.sessions.values()].filter((session) =>
        normalizeServerUrl(session.gatewayUrl) === serverUrl
      );
      const cwdMatch = candidates.find((session) =>
        session.cwd === conversation.cwd ||
        [...session.terminals.values()].some((terminal) => terminal.cwd === conversation.cwd)
      );
      return cwdMatch?.sessionId ?? candidates[0]?.sessionId ?? null;
    },
    [manager.sessions],
  );

  const updatePermissionMetadata = useCallback(
    (
      conversationId: string,
      requestId: string,
      metadata: Record<string, unknown>,
    ) => {
      setTimelineById((prev) => {
        const items = prev.get(conversationId);
        if (!items) return prev;
        const nextItems = items.map((item) =>
          item.type === "permission" && item.permission?.requestId === requestId
            ? {
                ...item,
                metadata: { ...(item.metadata ?? {}), ...metadata },
                updatedAt: Date.now(),
              }
            : item,
        );
        saveAgentTimeline(conversationId, nextItems).catch(() => {});
        const next = new Map(prev);
        next.set(conversationId, nextItems);
        return next;
      });
    },
    [],
  );

  const updateTimelineItemMetadata = useCallback(
    (
      conversationId: string,
      itemId: string,
      metadata: Record<string, unknown>,
    ) => {
      setTimelineById((prev) => {
        const items = prev.get(conversationId);
        if (!items) return prev;
        const nextItems = items.map((item) =>
          item.id === itemId
            ? {
                ...item,
                metadata: { ...(item.metadata ?? {}), ...metadata },
                updatedAt: Date.now(),
              }
            : item,
        );
        saveAgentTimeline(conversationId, nextItems).catch(() => {});
        const next = new Map(prev);
        next.set(conversationId, nextItems);
        return next;
      });
    },
    [],
  );

  const respondPermission = useCallback(
    (
      conversationId: string,
      requestId: string,
      outcome: "allow" | "deny" | "cancelled",
      optionId?: string,
    ) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) {
        console.warn("[LiveActivityAction] workspace respond missing conversation", { conversationId, requestId, outcome, optionId });
        return false;
      }
      if (conversation.provider === "codex") {
        const session = findSessionForConversation(conversation, manager.sessions);
        if (!session) return false;
        const codexItem = codexThreadsRef.current
          .get(conversationId)
          ?.items.find((item) => item.type === "approval" && item.requestId === requestId);
        const method = codexItem?.requestMethod ?? "";
        const decision = outcome === "allow" ? "accept" : outcome === "cancelled" ? "cancel" : "decline";
        const legacyDecision = outcome === "allow" ? "approved" : outcome === "cancelled" ? "abort" : "denied";
        const result = method.includes("permissions")
          ? {
              permissions: outcome === "allow" ? {} : { network: {}, fileSystem: {} },
              scope: "turn",
            }
          : method === "applyPatchApproval" || method === "execCommandApproval"
            ? { decision: legacyDecision }
          : { decision };
        const accepted = sendCodexRpc(session.sessionId, {
          id: codexItem?.rpcId ?? requestId,
          result,
        });
        if (codexItem) {
          upsertCodexItem(conversationId, {
            ...codexItem,
            permissionOutcome: outcome,
            permissionSubmitting: accepted,
            permissionError: accepted ? undefined : "授权未发送：连接未就绪，请稍后重试。",
            deliveryState: accepted ? "pending" : "failed",
            updatedAt: Date.now(),
          });
        }
        if (accepted) {
          persistConversation({
            ...conversation,
            status: "running",
            lastActivityAt: Date.now(),
          }).catch(() => {});
        }
        return accepted;
      }
      const permissionItem = timelineRef.current
        .get(conversationId)
        ?.find((item) => item.type === "permission" && item.permission?.requestId === requestId);
      const sourceSessionId = resolvePermissionSessionId(conversation, permissionItem);
      if (!sourceSessionId) {
        console.warn("[LiveActivityAction] workspace respond no source session", {
          conversationId,
          requestId,
          outcome,
          optionId,
          protocol: permissionItem?.metadata?.protocol,
          conversationSessionId: conversation.sessionId,
        });
        updatePermissionMetadata(conversationId, requestId, {
          permissionLive: false,
          permissionExpired: true,
          permissionPending: false,
          permissionError: "授权未发送：设备连接已失效，请重新打开会话。",
        });
        return false;
      }
      let accepted = false;
      const protocol = permissionItem?.metadata?.protocol ?? "v2";
      console.log("[LiveActivityAction] workspace respond route", {
        conversationId,
        requestId,
        outcome,
        optionId,
        sourceSessionId,
        protocol,
      });
      if (permissionItem?.metadata?.protocol === "terminal") {
        const terminalId = typeof permissionItem.metadata.terminalId === "string"
          ? permissionItem.metadata.terminalId
          : "default";
        accepted = manager.sendPermissionDecision(
          sourceSessionId,
          terminalId,
          requestId,
          outcome === "allow" ? "allow" : "deny",
        );
      } else {
        accepted = manager.sendAgentWorkspaceEnvelope(
          sourceSessionId,
          "agent.v2.permission.respond",
          { conversationId, requestId, outcome, optionId },
          { queue: true, dedupeKey: `agent-v2-permission:${requestId}`, claimControl: true },
        );
      }
      if (!accepted) {
        console.warn("[LiveActivityAction] workspace respond not accepted", {
          conversationId,
          requestId,
          outcome,
          optionId,
          sourceSessionId,
          protocol,
        });
        updatePermissionMetadata(conversationId, requestId, {
          permissionPending: false,
          permissionError: "授权未发送：连接未就绪，请稍后重试。",
        });
        return false;
      }
      console.log("[LiveActivityAction] workspace respond accepted", {
        conversationId,
        requestId,
        outcome,
        optionId,
        sourceSessionId,
        protocol,
      });
      updatePermissionMetadata(conversationId, requestId, {
        permissionPending: true,
        permissionLive: true,
        permissionExpired: false,
        pendingOutcome: outcome,
        optionId,
        permissionError: undefined,
      });
      persistConversation({
        ...conversation,
        status: "running",
        lastActivityAt: Date.now(),
      }).catch(() => {});
      return true;
    },
    [manager, persistConversation, resolvePermissionSessionId, sendCodexRpc, updatePermissionMetadata, upsertCodexItem],
  );

  const suppressPermissionRequest = useCallback(
    (
      conversationId: string,
      requestId: string,
      outcome?: "allow" | "deny" | "cancelled",
      optionId?: string,
    ) => {
      updatePermissionMetadata(conversationId, requestId, {
        permissionPending: true,
        permissionLive: false,
        permissionExpired: false,
        pendingOutcome: outcome,
        optionId,
        permissionError: undefined,
      });
    },
    [updatePermissionMetadata],
  );

  const respondStructuredInput = useCallback(
    (
      conversationId: string,
      requestId: string,
      answers: Record<string, string[]>,
    ) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return;
      if (conversation.provider === "codex") {
        const session = findSessionForConversation(conversation, manager.sessions);
        const codexItem = codexThreadsRef.current
          .get(conversationId)
          ?.items.find((item) => item.type === "structured_input" && item.requestId === requestId);
        if (!session || !codexItem) {
          if (codexItem) {
            upsertCodexItem(conversationId, {
              ...codexItem,
              answers,
              deliveryState: "failed",
              output: "回答未发送：连接未就绪，请稍后重试。",
              updatedAt: Date.now(),
            });
          }
          return;
        }
        const accepted = sendCodexRpc(session.sessionId, {
          id: codexItem.rpcId ?? requestId,
          result: formatCodexStructuredInputResult(codexItem, answers),
        });
        upsertCodexItem(conversationId, {
          ...codexItem,
          answers,
          deliveryState: accepted ? "pending" : "failed",
          output: accepted ? undefined : "回答未发送：连接未就绪，请稍后重试。",
          updatedAt: Date.now(),
        });
        if (accepted) {
          persistConversation({
            ...conversation,
            status: "running",
            lastActivityAt: Date.now(),
          }).catch(() => {});
        }
        return;
      }
      const accepted = manager.sendAgentWorkspaceEnvelope(
        conversation.sessionId,
        "agent.v2.structured_input.respond" as any,
        { conversationId, requestId, answers },
        { queue: true, dedupeKey: `agent-v2-input:${requestId}` },
      );
      updateTimelineItemMetadata(conversationId, `input:${requestId}`, accepted
        ? { inputSubmitting: true, inputError: undefined, answers }
        : { inputSubmitting: false, inputError: "回答未发送：连接未就绪，请稍后重试。" });
    },
    [manager, persistConversation, sendCodexRpc, updateTimelineItemMetadata, upsertCodexItem],
  );

  const browseFiles = useCallback(
    (conversationId: string, path: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      const session = conversation ? findSessionForConversation(conversation, manager.sessions) : undefined;
      if (!conversation || !session) {
        return Promise.resolve({
          path,
          entries: [],
          error: "设备连接已失效，请重新打开会话。",
        });
      }
      if (conversation.provider === "codex") {
        return withTimeout(
          ensureCodexInitialized(session.sessionId),
          5_000,
          "Codex 初始化超时：无法读取目录，请确认主机端 codex app-server 仍在响应。",
        )
          .then(() => requestCodexRpc(session.sessionId, "fs/readDirectory", { path }, {
            conversationId,
            timeoutMs: 12_000,
          }))
          .then((response): AgentFileBrowseResult => {
            const raw = asRecord(response.result);
            const entries = (Array.isArray(raw?.entries) ? raw.entries : [])
              .map((entry): AgentFileEntry | undefined => {
                const item = asRecord(entry);
                const name = firstString(item, ["fileName", "name"]);
                if (!name) return undefined;
                const isDirectory = item?.isDirectory === true;
                const childPath = path.endsWith("/") ? `${path}${name}` : `${path}/${name}`;
                return {
                  name,
                  path: childPath,
                  isDirectory,
                };
              })
              .filter((entry): entry is AgentFileEntry => Boolean(entry))
              .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
            return { path, entries };
          })
          .catch((error): AgentFileBrowseResult => ({
            path,
            entries: [],
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      const requestId = `browse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<AgentFileBrowseResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingBrowseRef.current.delete(requestId);
          resolve({ path, entries: [], error: "读取目录超时，请确认主机端仍在线。" });
        }, 12_000);
        pendingBrowseRef.current.set(requestId, { resolve, timer });
        const accepted = manager.sendAgentWorkspaceEnvelope(
          session.sessionId,
          "terminal.browse",
          { path, includeFiles: true, requestId },
          { queue: true },
        );
        if (!accepted) {
          clearTimeout(timer);
          pendingBrowseRef.current.delete(requestId);
          resolve({ path, entries: [], error: "目录请求未发送：连接未就绪。" });
        }
      });
    },
    [ensureCodexInitialized, manager, requestCodexRpc],
  );

  const readFile = useCallback(
    (conversationId: string, path: string, maxBytes = 256_000) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      const session = conversation ? findSessionForConversation(conversation, manager.sessions) : undefined;
      if (!conversation || !session) {
        return Promise.resolve({
          path,
          content: "",
          encoding: "utf8" as const,
          truncated: false,
          error: "设备连接已失效，请重新打开会话。",
        });
      }
      if (conversation.provider === "codex") {
        return withTimeout(
          ensureCodexInitialized(session.sessionId),
          5_000,
          "Codex 初始化超时：无法读取文件，请确认主机端 codex app-server 仍在响应。",
        )
          .then(() => requestCodexRpc(session.sessionId, "fs/readFile", { path }, {
            conversationId,
            timeoutMs: 12_000,
          }))
          .then((response): AgentFileReadResult => {
            const raw = asRecord(response.result);
            const dataBase64 = firstString(raw, ["dataBase64", "base64", "data"]) ?? "";
            const fullContent = base64ToUtf8(dataBase64);
            const truncated = fullContent.length > maxBytes;
            return {
              path,
              content: truncated ? fullContent.slice(0, maxBytes) : fullContent,
              encoding: "utf8",
              size: fullContent.length,
              truncated,
            };
          })
          .catch((error): AgentFileReadResult => ({
            path,
            content: "",
            encoding: "utf8",
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      const requestId = `read-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<AgentFileReadResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingReadRef.current.delete(requestId);
          resolve({
            path,
            content: "",
            encoding: "utf8",
            truncated: false,
            error: "读取文件超时，请确认主机端仍在线。",
          });
        }, 12_000);
        pendingReadRef.current.set(requestId, { resolve, timer });
        const accepted = manager.sendAgentWorkspaceEnvelope(
          session.sessionId,
          "terminal.file.read",
          { path, maxBytes, requestId },
          { queue: true },
        );
        if (!accepted) {
          clearTimeout(timer);
          pendingReadRef.current.delete(requestId);
          resolve({
            path,
            content: "",
            encoding: "utf8",
            truncated: false,
            error: "文件请求未发送：连接未就绪。",
          });
        }
      });
    },
    [ensureCodexInitialized, manager, requestCodexRpc],
  );

  const loadOlderHistory = useCallback(
    (conversationId: string) => {
      if (historyHasMoreRef.current.get(conversationId) === false) return;
      requestHistoryPage(conversationId, historyCursorRef.current.get(conversationId));
    },
    [requestHistoryPage],
  );

  const refreshConversation = useCallback(
    (conversationId: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return;
      const revision = conversation.timelineRevision ?? 0;
      if (conversation.provider === "codex") {
        requestHistoryPage(conversationId);
        return;
      }
      const session = findSessionForConversation(conversation, managerRef.current.sessions);
      if (session) requestCapabilities(session.sessionId);
      if (revision > 0) requestDelta(conversationId, revision);
      else requestHistoryPage(conversationId);
    },
    [requestCapabilities, requestDelta, requestHistoryPage],
  );

  const archive = useCallback(async (conversationId: string, archived: boolean) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (conversation?.provider === "codex") {
      const session = findSessionForConversation(conversation, managerRef.current.sessions);
      const threadId = codexThreadsRef.current.get(conversationId)?.threadId ?? conversation.agentSessionId;
      if (!session || !threadId) {
        throw new Error("Codex thread 不在线，无法通过 app-server 归档。");
      }
      await ensureCodexInitialized(session.sessionId);
      await requestCodexRpc(session.sessionId, archived ? "thread/archive" : "thread/unarchive", { threadId }, {
        conversationId,
        timeoutMs: 15_000,
      });
    }
    await archiveAgentConversation(conversationId, archived);
    setConversations((prev) =>
      prev.map((item) => item.id === conversationId ? { ...item, archived, syncStatus: "complete" } : item),
    );
  }, [ensureCodexInitialized, requestCodexRpc]);

  const rename = useCallback(async (conversationId: string, title: string) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (conversation?.provider === "codex") {
      const session = findSessionForConversation(conversation, managerRef.current.sessions);
      const threadId = codexThreadsRef.current.get(conversationId)?.threadId ?? conversation.agentSessionId;
      if (!session || !threadId) {
        throw new Error("Codex thread 不在线，无法通过 app-server 重命名。");
      }
      await ensureCodexInitialized(session.sessionId);
      await requestCodexRpc(session.sessionId, "thread/name/set", { threadId, name: title }, {
        conversationId,
        timeoutMs: 15_000,
      });
    }
    await renameAgentConversation(conversationId, title);
    setConversations((prev) =>
      prev.map((item) => item.id === conversationId ? { ...item, title, syncStatus: "complete" } : item),
    );
  }, [ensureCodexInitialized, requestCodexRpc]);

  return {
    conversations: conversations.filter((item) => !item.archived),
    archivedConversations: conversations.filter((item) => item.archived),
    activeConversationId,
    capabilitiesBySessionId,
    connectedSessions,
    refresh,
    requestCapabilities,
    requestConversationList,
    refreshConversation,
    openConversation,
    openProject,
    resumeConversation,
    ensureConversationSession,
    getConversation: (conversationId) =>
      conversationsRef.current.find((item) => item.id === conversationId),
    getTimeline: (conversationId) => timelineRef.current.get(conversationId) ?? [],
    sendPrompt,
    executeCommand,
    updateConversationSettings,
    cancel,
    respondPermission,
    suppressPermissionRequest,
    respondStructuredInput,
    browseFiles,
    readFile,
    loadOlderHistory,
    archive,
    rename,
  };
}
