import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { createEnvelope, parseTypedPayload } from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";
import type { ProjectRecord } from "../storage/projects";
import type { SessionInfo, SessionManagerHandle } from "./useSessionManager";
import {
  archiveAgentConversation,
  loadAgentConversations,
  loadAgentTimeline,
  makeAgentConversationId,
  replaceAgentConversationsForDevice,
  renameAgentConversation,
  saveAgentTimeline,
  upsertAgentConversation,
  upsertAgentTimelineItem,
  type AgentCapabilities,
  type AgentCollaborationMode,
  type AgentCommandDescriptor,
  type AgentContentBlock,
  type AgentConversationRecord,
  type AgentProvider,
  type AgentPermissionMode,
  type AgentReasoningEffort,
  type AgentStructuredInput,
  type AgentStructuredInputOption,
  type AgentStructuredInputQuestion,
  type AgentTimelineItem,
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
  type: "message" | "command" | "file_change" | "tool" | "approval" | "structured_input" | "status" | "error";
  text?: string;
  command?: string;
  output?: string;
  diff?: string;
  requestId?: string;
  rpcId?: CodexRpcId;
  requestMethod?: string;
  structuredInput?: AgentTimelineItem["structuredInput"];
  answers?: Record<string, string[]>;
  raw?: unknown;
  isStreaming?: boolean;
  deliveryState: CodexDeliveryState;
  createdAt: number;
  updatedAt?: number;
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
      permissionMode?: AgentPermissionMode;
      collaborationMode?: AgentCollaborationMode;
      attachments?: AgentContentBlock[];
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
    .map((block) => block.type === "text" ? block.text ?? "" : `[${block.mimeType ?? "image"} attachment]`)
    .filter(Boolean)
    .join("\n");
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

function codexThreadId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return firstString(record, ["threadId", "conversationId", "sessionId"]) ??
    firstString(record.thread, ["id", "threadId"]);
}

function codexTurnId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return firstString(record, ["turnId"]) ?? firstString(record.turn, ["id", "turnId"]);
}

function codexItemId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return firstString(record, ["itemId", "messageId", "toolCallId", "callId", "id"]) ??
    firstString(record.item, ["id", "itemId"]);
}

function codexInputBlocks(blocks: AgentContentBlock[]): unknown[] {
  return blocks.map((block) => {
    if (block.type === "image" && block.data) {
      return { type: "input_image", image_url: block.data };
    }
    return { type: "input_text", text: block.text ?? "" };
  });
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
      },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
  if (item.type === "command") {
    return {
      id: item.itemId,
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
      id: item.itemId,
      conversationId,
      type: "tool_call",
      kind: "file_change",
      turnId: item.turnId,
      itemId: item.itemId,
      fileChange: {
        entries: [],
        diff: item.diff ?? item.text,
        summary: item.output,
        status: item.isStreaming ? "running" : item.deliveryState === "failed" ? "failed" : "completed",
      },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      isStreaming: item.isStreaming,
    };
  }
  if (item.type === "error") {
    return {
      id: item.itemId,
      conversationId,
      type: "error",
      error: item.text ?? "Codex request failed",
      metadata: { deliveryState: item.deliveryState },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
  return {
    id: item.itemId,
    conversationId,
    type: "message",
    kind: "chat",
    turnId: item.turnId,
    itemId: item.itemId,
    role: item.role,
    content: item.text ? [{ type: "text", text: item.text }] : [],
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
  const codexThreadConversationRef = useRef(new Map<string, string>());
  const pendingCodexRef = useRef(new Map<CodexRpcId, PendingCodexRequest>());
  const initializedCodexSessionsRef = useRef(new Set<string>());
  const initializingCodexSessionsRef = useRef(new Map<string, Promise<void>>());
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
    const stored = await loadAgentConversations();
    setConversations(stored);
    const pairs = await Promise.all(
      stored.slice(0, 20).map(async (conversation) => [
        conversation.id,
        await loadAgentTimeline(conversation.id),
      ] as const),
    );
    const timelineMap = new Map(pairs);
    setTimelineById(timelineMap);
    timelineRef.current = timelineMap;
    const restoredCodexThreads = new Map<string, CodexThreadState>();
    for (const conversation of stored) {
      if (conversation.provider !== "codex") continue;
      const timeline = timelineMap.get(conversation.id) ?? [];
      const threadId = conversation.agentSessionId ?? conversation.id;
      const items = timeline
        .map((item, index) => codexTimelineToMessage(item, threadId, index))
        .filter((item): item is CodexMessageItem => Boolean(item));
      if (items.length === 0) continue;
      restoredCodexThreads.set(conversation.id, {
        conversationId: conversation.id,
        threadId,
        nextCursor: historyCursorRef.current.get(conversation.id),
        activeTurnId: conversation.runningTurnId,
        isRunning: conversation.status === "running" || conversation.status === "waiting_permission",
        items,
      });
      codexThreadConversationRef.current.set(threadId, conversation.id);
      historyHasMoreRef.current.delete(conversation.id);
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
    const items = threadState.items.map((item) => codexMessageToTimeline(item, conversationId));
    const nextTimeline = new Map(timelineRef.current);
    nextTimeline.set(conversationId, items);
    timelineRef.current = nextTimeline;
    setTimelineById(nextTimeline);
    saveAgentTimeline(conversationId, items).catch(() => {});
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
    const index = items.findIndex((entry) => entry.itemId === item.itemId);
    if (index >= 0) {
      items[index] = {
        ...items[index],
        ...item,
        text: item.text ?? items[index].text,
        output: item.output ?? items[index].output,
        diff: item.diff ?? items[index].diff,
        structuredInput: item.structuredInput ?? items[index].structuredInput,
        answers: item.answers ?? items[index].answers,
        updatedAt: item.updatedAt ?? Date.now(),
      };
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

  const replaceCodexHistory = useCallback((
    conversationId: string,
    threadId: string,
    items: CodexMessageItem[],
    nextCursor?: string,
    mode: "replace" | "prepend" = "replace",
  ) => {
    const next = new Map(codexThreadsRef.current);
    const existing = next.get(conversationId);
    const incomingIds = new Set(items.map((item) => item.itemId));
    const preservedExisting = (existing?.items ?? []).filter((item) =>
      !incomingIds.has(item.itemId) &&
      (
        item.type !== "message" ||
        item.deliveryState !== "confirmed" ||
        item.isStreaming === true
      )
    );
    const merged = mode === "prepend"
      ? [...items, ...(existing?.items ?? [])]
      : [...items, ...preservedExisting];
    const nextThread = {
      conversationId,
      threadId,
      nextCursor,
      activeTurnId: existing?.activeTurnId,
      isRunning: existing?.isRunning ?? false,
      items: merged
        .map((entry, index) => ({ ...entry, orderIndex: index + 1 }))
        .sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt - b.createdAt),
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

  const ensureCodexInitialized = useCallback(async (sessionId: string) => {
    if (initializedCodexSessionsRef.current.has(sessionId)) return;
    const existing = initializingCodexSessionsRef.current.get(sessionId);
    if (existing) return existing;
    const initializing = (async () => {
      await requestCodexRpc(sessionId, "initialize", {
        clientInfo: { name: "linkshell_mobile", title: null, version: "0.1" },
        capabilities: { experimentalApi: true },
      }, { timeoutMs: 30_000 });
      sendCodexRpc(sessionId, { method: "initialized", params: {} });
      initializedCodexSessionsRef.current.add(sessionId);
    })();
    initializingCodexSessionsRef.current.set(sessionId, initializing);
    try {
      await initializing;
    } finally {
      initializingCodexSessionsRef.current.delete(sessionId);
    }
  }, [requestCodexRpc, sendCodexRpc]);

  const requestCodexTurns = useCallback(async (
    sessionId: string,
    conversationId: string,
    threadId: string,
    cursor?: string,
  ) => {
    const response = await requestCodexRpc(sessionId, "thread/turns/list", {
      threadId,
      sortDirection: "desc",
      itemsView: "summary",
      limit: 5,
      cursor,
    }, { conversationId, timeoutMs: 30_000 });
    const raw = asRecord(response.result);
    const turns = Array.isArray(raw?.turns)
      ? raw.turns
      : Array.isArray(raw?.items)
      ? raw.items
      : [];
    const nextCursor = typeof raw?.nextCursor === "string" ? raw.nextCursor : undefined;
    historyCursorRef.current.set(conversationId, nextCursor);
    historyHasMoreRef.current.set(conversationId, Boolean(nextCursor));
    const items: CodexMessageItem[] = [];
    turns.slice().reverse().forEach((turn, turnIndex) => {
      const turnId = codexTurnId(turn) ?? `turn-${turnIndex + 1}`;
      const record = asRecord(turn);
      const createdAt = Date.parse(String(record?.createdAt ?? record?.created_at ?? "")) || Date.now();
      const input = Array.isArray(record?.input) ? record?.input : Array.isArray(record?.inputs) ? record?.inputs : [];
      const output = Array.isArray(record?.output) ? record?.output : Array.isArray(record?.items) ? record?.items : [];
      const userText = codexText(input);
      if (userText) {
        items.push({
          threadId,
          turnId,
          itemId: `${turnId}:user`,
          orderIndex: items.length + 1,
          role: "user",
          type: "message",
          text: userText,
          deliveryState: "confirmed",
          createdAt,
        });
      }
      const assistantText = codexText(output);
      if (assistantText) {
        items.push({
          threadId,
          turnId,
          itemId: `${turnId}:assistant`,
          orderIndex: items.length + 1,
          role: "assistant",
          type: "message",
          text: assistantText,
          deliveryState: "confirmed",
          createdAt: createdAt + 1,
        });
      }
    });
    replaceCodexHistory(conversationId, threadId, items, nextCursor, cursor ? "prepend" : "replace");
  }, [replaceCodexHistory, requestCodexRpc]);

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
    [manager],
  );

  function findSessionForConversation(
    conversation: AgentConversationRecord,
    sessions: Map<string, SessionInfo>,
  ): SessionInfo | undefined {
    const exact = sessions.get(conversation.hostDeviceId ?? conversation.sessionId);
    if (exact && (!conversation.machineId || exact.machineId === conversation.machineId)) {
      return exact;
    }
    const serverUrl = normalizeServerUrl(conversation.serverUrl);
    const sameGateway = [...sessions.values()].filter((session) =>
      normalizeServerUrl(session.gatewayUrl) === serverUrl
    );
    if (conversation.machineId) {
      return sameGateway.find((session) => session.machineId === conversation.machineId);
    }
    return sameGateway.find((session) =>
      session.cwd === conversation.cwd ||
      [...session.terminals.values()].some((terminal) => terminal.cwd === conversation.cwd)
    );
  }

  const requestCapabilities = useCallback(
    (sessionId?: string) => {
      const currentManager = managerRef.current;
      const targets = sessionId
        ? [currentManager.sessions.get(sessionId)].filter((item): item is SessionInfo => Boolean(item))
        : [...currentManager.sessions.values()];
      for (const session of targets) {
        currentManager.sendAgentWorkspaceEnvelope(
          session.sessionId,
          "agent.v2.capabilities.request",
          {},
          { queue: true, dedupeKey: "agent-v2-capabilities" },
        );
      }
    },
    [],
  );

  const requestConversationList = useCallback(
    (sessionId?: string) => {
      const currentManager = managerRef.current;
      const targets = sessionId
        ? [currentManager.sessions.get(sessionId)].filter((item): item is SessionInfo => Boolean(item))
        : [...currentManager.sessions.values()];
      for (const session of targets) {
        ensureCodexInitialized(session.sessionId)
          .then(() => requestCodexRpc(session.sessionId, "thread/list", {
            limit: 50,
            includeArchived: true,
          }, { timeoutMs: 30_000 }))
          .then((response) => {
            const raw = asRecord(response.result);
            const threads = Array.isArray(raw?.threads)
              ? raw.threads
              : Array.isArray(raw?.items)
              ? raw.items
              : Array.isArray(raw?.sessions)
              ? raw.sessions
              : [];
            const records = threads
              .map((thread): AgentConversationRecord | undefined => {
                const threadId = codexThreadId(thread) ?? firstString(thread, ["id", "threadId"]);
                const record = asRecord(thread);
                if (!threadId) return undefined;
                const conversationId = makeAgentConversationId({
                  serverUrl: normalizeServerUrl(session.gatewayUrl),
                  hostDeviceId: session.hostDeviceId,
                  sessionId: session.sessionId,
                  agentSessionId: threadId,
                  cwd: firstString(record, ["cwd", "workingDirectory", "workspacePath"]) ?? session.cwd ?? "",
                  provider: "codex",
                });
                codexThreadConversationRef.current.set(threadId, conversationId);
                return {
                  id: conversationId,
                  serverUrl: normalizeServerUrl(session.gatewayUrl),
                  hostDeviceId: session.hostDeviceId,
                  sessionId: session.sessionId,
                  machineId: session.machineId ?? undefined,
                  agentSessionId: threadId,
                  provider: "codex",
                  cwd: firstString(record, ["cwd", "workingDirectory", "workspacePath"]) ?? session.cwd ?? "",
                  title: firstString(record, ["title", "name", "summary"]) ?? "Codex",
                  status: firstString(record, ["status", "state"]) === "running" ? "running" : "idle",
                  archived: Boolean(record?.archived),
                  runningTurnId: firstString(record, ["runningTurnId", "activeTurnId"]),
                  syncStatus: "complete",
                  source: "app-server",
                  lastMessagePreview: firstString(record, ["preview", "lastMessagePreview", "summary"]),
                  lastActivityAt: Date.parse(String(record?.lastActivityAt ?? record?.updatedAt ?? record?.modifiedAt ?? "")) || Date.now(),
                  createdAt: Date.parse(String(record?.createdAt ?? "")) || Date.now(),
                  schemaVersion: 2,
                };
              })
              .filter((record): record is AgentConversationRecord => Boolean(record));
            if (records.length > 0) {
              setConversations((prev) => {
                const byId = new Map(prev.map((item) => [item.id, item]));
                for (const record of records) byId.set(record.id, { ...byId.get(record.id), ...record });
                return [...byId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
              });
              replaceAgentConversationsForDevice({
                serverUrl: normalizeServerUrl(session.gatewayUrl),
                hostDeviceId: session.hostDeviceId,
                conversations: records,
              }).catch(() => {});
            }
          })
          .catch(() => {});
        currentManager.sendAgentWorkspaceEnvelope(
          session.sessionId,
          "agent.v2.conversation.list",
          { includeArchived: true },
          { queue: true, dedupeKey: "agent-v2-conversation-list" },
        );
      }
    },
    [ensureCodexInitialized, requestCodexRpc],
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
        pendingHistoryRef.current.add(`${conversationId}:${cursor ?? "latest"}`);
        markConversationSync(conversationId, "syncing");
        ensureCodexInitialized(session.sessionId)
          .then(() => requestCodexTurns(session.sessionId, conversationId, conversation.agentSessionId!, cursor))
          .then(() => markConversationSync(conversationId, "complete"))
          .catch(() => markConversationSync(conversationId, "stale"))
          .finally(() => pendingHistoryRef.current.delete(`${conversationId}:${cursor ?? "latest"}`));
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
    [markConversationSync],
  );

  useEffect(() => {
    if (connectedSessions.length === 0) return;
    requestCapabilities();
    requestConversationList();
  }, [connectedSessions.length, requestCapabilities, requestConversationList]);

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
        const interval = running
          ? foreground && isActive
            ? 2_500
            : foreground
            ? 12_000
            : 15_000
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
          next.set(envelope.hostDeviceId, payload);
          return next;
        });
        return;
      }

      if (envelope.type === "agent.codex.rpc") {
        const payload = parseTypedPayload("agent.codex.rpc" as any, envelope.payload) as CodexRpcMessage;
        if (payload.id !== undefined && !payload.method) {
          const pending = pendingCodexRef.current.get(payload.id);
          if (pending) {
            pendingCodexRef.current.delete(payload.id);
            clearTimeout(pending.timer);
            if (payload.error) {
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
                setConversations((prev) => prev.map((conversation) =>
                  conversation.id === pending.conversationId
                    ? { ...conversation, status: "error", lastActivityAt: Date.now() }
                    : conversation
                ));
              }
              pending.reject?.(payload.error.message ?? "Codex request failed");
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
          const status = firstString(params, ["status"]);
          setCodexThreadsByConversationId((prev) => {
            const next = new Map(prev);
            const existing = next.get(conversationId);
            if (existing) next.set(conversationId, { ...existing, isRunning: false, activeTurnId: undefined });
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
          upsertCodexItem(conversationId, {
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
          upsertCodexItem(conversationId, {
            threadId,
            turnId,
            itemId: itemId ?? `item:${Date.now().toString(36)}`,
            orderIndex: (codexThreadsRef.current.get(conversationId)?.items.length ?? 0) + 1,
            type: type.toLowerCase().includes("file") ? "file_change" : type.toLowerCase().includes("command") ? "command" : "tool",
            text: codexText(rawItem),
            command: firstString(rawItem, ["command", "name", "toolName"]),
            raw: rawItem,
            isStreaming: true,
            deliveryState: "confirmed",
            createdAt: Date.now(),
          });
          return;
        }

        if ((method === "item/completed" || method.endsWith("/completed")) && conversationId && itemId) {
          const existing = codexThreadsRef.current.get(conversationId)?.items.find((item) => item.itemId === itemId);
          if (existing) {
            upsertCodexItem(conversationId, {
              ...existing,
              text: existing.text ?? codexText(params),
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
          upsertCodexItem(conversationId, {
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
          upsertCodexItem(conversationId, {
            threadId,
            turnId: turnId ?? existing?.turnId,
            itemId: id,
            orderIndex: existing?.orderIndex ?? (codexThreadsRef.current.get(conversationId)?.items.length ?? 0) + 1,
            type: "file_change",
            diff: firstString(params, ["patch", "diff", "unified_diff"]) ?? codexText(params),
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
              item.requestId === requestId
            );
            if (!matching) continue;
            upsertCodexItem(candidateId, {
              ...matching,
              deliveryState: "confirmed",
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

        if (payload.id !== undefined && method.includes("requestApproval") && conversationId && threadId) {
          upsertCodexItem(conversationId, {
            threadId,
            turnId,
            itemId: `approval:${String(payload.id)}`,
            orderIndex: (codexThreadsRef.current.get(conversationId)?.items.length ?? 0) + 1,
            type: "approval",
            requestId: String(payload.id),
            rpcId: payload.id,
            requestMethod: method,
            command: firstString(params, ["toolName", "command", "name"]) ?? method,
            text: codexText(params?.command ?? params?.fileChanges ?? params),
            output: firstString(params, ["reason", "context", "message"]),
            raw: params,
            deliveryState: "pending",
            createdAt: Date.now(),
          });
          setConversations((prev) => prev.map((conversation) =>
            conversation.id === conversationId
              ? { ...conversation, status: "waiting_permission", lastActivityAt: Date.now() }
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
        const records = (payload.conversations ?? [])
          .map((conversation: any) => ({
            ...toRecord(conversation),
            syncStatus: "complete" as const,
          }))
          .filter((conversation: AgentConversationRecord) => conversation.id && conversation.cwd);
        replaceAgentConversationsForDevice({
          serverUrl,
          hostDeviceId: serverSession?.hostDeviceId ?? envelope.hostDeviceId,
          conversations: records,
          preserveLocalArchived: true,
        })
          .then((nextConversations) => setConversations(nextConversations))
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
    [activeConversationId, persistConversation, persistTimelineItem, requestDelta, requestHistoryPage, upsertCodexItem],
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
          permissionMode: input.permissionMode ?? existing?.permissionMode,
          collaborationMode: input.collaborationMode ?? existing?.collaborationMode ?? "default",
          status: existing?.status ?? "idle",
          archived: false,
          runningTurnId: existing?.runningTurnId,
          syncStatus: session ? "syncing" : "deferred",
          source: existing?.source ?? "cache",
          lastMessagePreview: existing?.lastMessagePreview,
          lastActivityAt: existing?.lastActivityAt ?? now,
          createdAt: existing?.createdAt ?? now,
          schemaVersion: 2,
        };
        await persistConversation(baseRecord, { preserveLocalArchived: false });
        const cachedTimeline = await loadAgentTimeline(conversationId);
        const cachedThreadId = baseRecord.agentSessionId ?? conversationId;
        const cachedItems = cachedTimeline
          .map((item, index) => codexTimelineToMessage(item, cachedThreadId, index))
          .filter((item): item is CodexMessageItem => Boolean(item));
        if (cachedItems.length > 0) {
          const cachedThread: CodexThreadState = {
            conversationId,
            threadId: cachedThreadId,
            activeTurnId: baseRecord.runningTurnId,
            isRunning: baseRecord.status === "running" || baseRecord.status === "waiting_permission",
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
        if (!session) return { conversationId, status: baseRecord.status };
        try {
          await ensureCodexInitialized(session.sessionId);
          const response = input.agentSessionId
            ? await requestCodexRpc(session.sessionId, "thread/resume", {
                threadId: input.agentSessionId,
                cwd: input.cwd,
              }, { conversationId, timeoutMs: 30_000 })
            : await requestCodexRpc(session.sessionId, "thread/start", {
                cwd: input.cwd,
                sessionStartSource: "startup",
              }, { conversationId, timeoutMs: 30_000 });
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
        permissionMode?: AgentPermissionMode;
        collaborationMode?: AgentCollaborationMode;
        attachments?: AgentContentBlock[];
      },
    ) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      const trimmed = text.trim();
      const attachments = (options?.attachments ?? []).filter((block) => block.type === "image" && block.data);
      if (!conversation || (!trimmed && attachments.length === 0)) return;
      const clientMessageId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const contentBlocks: AgentContentBlock[] = [
        ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
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
      setTimelineById((prev) => {
        const next = new Map(prev);
        next.set(conversationId, mergeTimeline(next.get(conversationId) ?? [], [optimisticItem]));
        return next;
      });
      upsertAgentTimelineItem(optimisticItem).catch(() => {});

      const hasModel = Object.prototype.hasOwnProperty.call(options ?? {}, "model");
      const hasEffort = Object.prototype.hasOwnProperty.call(options ?? {}, "reasoningEffort");
      const hasPermission = Object.prototype.hasOwnProperty.call(options ?? {}, "permissionMode");
      const hasCollaboration = Object.prototype.hasOwnProperty.call(options ?? {}, "collaborationMode");
      const nextConversation: AgentConversationRecord = {
        ...conversation,
        model: hasModel ? options?.model : conversation.model,
        reasoningEffort: hasEffort ? options?.reasoningEffort : conversation.reasoningEffort,
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

      const session = findSessionForConversation(conversation, manager.sessions);
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
        const threadId = conversation.agentSessionId ?? conversation.id;
        codexThreadConversationRef.current.set(threadId, conversationId);
        upsertCodexItem(conversationId, {
          threadId,
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
            const params = {
              threadId,
              model: hasModel ? options?.model ?? undefined : conversation.model,
              effort: hasEffort ? options?.reasoningEffort ?? undefined : conversation.reasoningEffort,
              input: codexInputBlocks(contentBlocks),
            };
            return requestCodexRpc(session.sessionId, "turn/start", params, {
              conversationId,
              clientMessageId,
              timeoutMs: 60_000,
            });
          })
          .then((response) => {
            const startedThreadId = codexThreadId(response.result) ?? threadId;
            const turnId = codexTurnId(response.result);
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
                ? { ...item, agentSessionId: startedThreadId, runningTurnId: turnId, status: "running" }
                : item
            ));
          })
          .catch((error) => {
            upsertCodexItem(conversationId, {
              threadId,
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
              item.id === conversationId ? { ...item, status: "error" } : item
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
    [manager],
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
        const now = Date.now();
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
    [manager],
  );

  const updateConversationSettings = useCallback(
    async (
      conversationId: string,
      settings: {
        model?: string;
        reasoningEffort?: AgentReasoningEffort;
        permissionMode?: AgentPermissionMode;
        collaborationMode?: AgentCollaborationMode;
      },
    ) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return;
      const hasModel = Object.prototype.hasOwnProperty.call(settings, "model");
      const hasEffort = Object.prototype.hasOwnProperty.call(settings, "reasoningEffort");
      const hasPermission = Object.prototype.hasOwnProperty.call(settings, "permissionMode");
      const hasCollaboration = Object.prototype.hasOwnProperty.call(settings, "collaborationMode");
      await persistConversation({
        ...conversation,
        model: hasModel ? settings.model : conversation.model,
        reasoningEffort: hasEffort ? settings.reasoningEffort : conversation.reasoningEffort,
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
        const threadId = conversation.agentSessionId;
        const turnId = conversation.runningTurnId ?? codexThreadsRef.current.get(conversationId)?.activeTurnId;
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
        const result = method.includes("permissions")
          ? {
              permissions: outcome === "allow" ? {} : { network: {}, fileSystem: {} },
              scope: "turn",
            }
          : { decision };
        const accepted = sendCodexRpc(session.sessionId, {
          id: codexItem?.rpcId ?? requestId,
          result,
        });
        if (accepted && codexItem) {
          upsertCodexItem(conversationId, {
            ...codexItem,
            deliveryState: "confirmed",
            updatedAt: Date.now(),
          });
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
    [manager],
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
    [manager],
  );

  const loadOlderHistory = useCallback(
    (conversationId: string) => {
      if (historyHasMoreRef.current.get(conversationId) === false) return;
      requestHistoryPage(conversationId, historyCursorRef.current.get(conversationId));
    },
    [requestHistoryPage],
  );

  const archive = useCallback(async (conversationId: string, archived: boolean) => {
    await archiveAgentConversation(conversationId, archived);
    setConversations((prev) =>
      prev.map((item) => item.id === conversationId ? { ...item, archived } : item),
    );
  }, []);

  const rename = useCallback(async (conversationId: string, title: string) => {
    await renameAgentConversation(conversationId, title);
    setConversations((prev) =>
      prev.map((item) => item.id === conversationId ? { ...item, title } : item),
    );
  }, []);

  return {
    conversations: conversations.filter((item) => !item.archived),
    archivedConversations: conversations.filter((item) => item.archived),
    activeConversationId,
    capabilitiesBySessionId,
    connectedSessions,
    refresh,
    requestCapabilities,
    requestConversationList,
    openConversation,
    openProject,
    resumeConversation,
    ensureConversationSession,
    getConversation: (conversationId) =>
      conversationsRef.current.find((item) => item.id === conversationId),
    getTimeline: (conversationId) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      const codexThread = codexThreadsRef.current.get(conversationId);
      if (conversation?.provider === "codex" && codexThread) {
        return codexThread.items.map((item) => codexMessageToTimeline(item, conversationId));
      }
      return timelineRef.current.get(conversationId) ?? [];
    },
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
