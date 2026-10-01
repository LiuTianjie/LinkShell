import { unwrapShellCommand } from "@linkshell/wire";
import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
  SessionState,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
} from "@linkshell/wire";
import { imageFromPath, inlineImage } from "../images.js";
import type { DiscoveredSession, HistoryItem } from "../types.js";

// Minimal views of the Codex app-server v2 protocol (`codex app-server
// generate-ts`). Only the fields LinkShell reads are typed; everything else is
// ignored so newer Codex versions keep working.

type Json = Record<string, unknown>;

export interface CodexThread {
  id: string;
  preview?: string;
  name?: string | null;
  cwd: string;
  model?: string | null;
  createdAt: number;
  updatedAt: number;
  status?: { type: string; activeFlags?: string[] };
  turns?: CodexTurn[];
}

export interface CodexTurn {
  id: string;
  items: Json[];
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: { message: string; additionalDetails?: string | null } | null;
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface MappedUpdate {
  threadId: string;
  update: SessionUpdate;
  /** Set when this update completes a native item. */
  itemId?: string;
}

/** Per-thread state the mapper needs across notifications. */
export interface CodexThreadState {
  activeTurnId?: string;
  /** Messages whose text arrived as it was written; one that only arrives whole is sent when it completes. */
  streamed?: Set<string>;
  /** Between a review starting and finishing: the instruction Codex gives itself isn't something the user said. */
  reviewing?: boolean;
}

/** Codex's own review instruction, recorded as a user message inside the review. */
function isReviewPrompt(item: Json, reviewing: boolean | undefined): boolean {
  return reviewing === true && item.type === "userMessage" && !str(item.clientId);
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const obj = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function threadStateOf(status: CodexThread["status"]): SessionState {
  switch (status?.type) {
    case "active":
      return status.activeFlags?.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput")
        ? "waiting"
        : "running";
    case "systemError":
      return "error";
    default:
      return "idle";
  }
}

export function threadToDiscovered(thread: CodexThread): DiscoveredSession {
  return {
    nativeId: thread.id,
    cwd: thread.cwd,
    title: thread.name ?? undefined,
    preview: thread.preview || undefined,
    model: thread.model ?? undefined,
    createdAt: thread.createdAt * 1000,
    updatedAt: thread.updatedAt * 1000,
    state: threadStateOf(thread.status),
  };
}

function stopReasonOf(status: CodexTurn["status"]): StopReason {
  switch (status) {
    case "interrupted":
      return "cancelled";
    case "failed":
      return "error";
    default:
      return "end_turn";
  }
}

function userContent(item: Json): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const raw of arr(item.content)) {
    const input = obj(raw);
    if (!input) continue;
    switch (input.type) {
      case "text":
        if (str(input.text)) blocks.push({ type: "text", text: str(input.text)! });
        break;
      case "image":
        if (str(input.url)) blocks.push({ type: "image", mimeType: "image/*", uri: str(input.url) });
        break;
      case "localImage":
        if (str(input.path)) {
          blocks.push(imageFromPath(str(input.path)) ?? { type: "resource_link", uri: `file://${str(input.path)}`, name: str(input.path)! });
        }
        break;
      case "skill":
        if (str(input.name)) blocks.push({ type: "resource_link", kind: "skill", uri: str(input.path) ?? `skill:${str(input.name)}`, name: str(input.name)! });
        break;
      case "mention":
        if (str(input.name)) blocks.push({ type: "resource_link", uri: str(input.path) ?? str(input.name)!, name: str(input.name)! });
        break;
      default:
        break;
    }
  }
  return blocks;
}

function commandStatus(status: unknown): ToolCallStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "declined":
      return "failed";
    default:
      return "in_progress";
  }
}

function patchContent(changes: unknown): ToolCallContent[] {
  const content: ToolCallContent[] = [];
  for (const raw of arr(changes)) {
    const change = obj(raw);
    const path = str(change?.path);
    if (!change || !path) continue;
    const kind = obj(change.kind);
    const type = str(kind?.type);
    content.push({
      type: "patch",
      path,
      change: type === "add" || type === "delete" ? type : "update",
      movePath: str(kind?.move_path) ?? undefined,
      diff: str(change.diff) ?? "",
    });
  }
  return content;
}

function fileChangeTitle(content: ToolCallContent[]): string {
  const paths = content.flatMap((entry) => (entry.type === "patch" ? [entry.path] : []));
  if (paths.length === 0) return "Edit files";
  const names = paths.map((path) => path.split("/").pop() ?? path);
  return names.length <= 2 ? `Edit ${names.join(", ")}` : `Edit ${names[0]} and ${names.length - 1} more files`;
}

function imageContent(data: string | undefined, mimeType: string): ToolCallContent | undefined {
  const image = inlineImage(data, mimeType);
  return image ? { type: "content", content: image } : undefined;
}

function imageFileContent(path: string | undefined): ToolCallContent | undefined {
  const image = imageFromPath(path);
  return image ? { type: "content", content: image } : undefined;
}

/** An MCP tool's result: its text and image blocks, or its error. */
function mcpOutput(item: Json): ToolCallContent[] {
  const error = obj(item.error);
  if (error) return str(error.message) ? [{ type: "content", content: { type: "text", text: str(error.message)! } }] : [];
  const out: ToolCallContent[] = [];
  const texts: string[] = [];
  for (const raw of arr(obj(item.result)?.content)) {
    const entry = obj(raw);
    if (!entry) continue;
    if (entry.type === "image") {
      const image = imageContent(str(entry.data), str(entry.mimeType) ?? "image/png");
      if (image) out.push(image);
    } else if (entry.type === "resource_link" && str(entry.uri)) {
      out.push({ type: "content", content: { type: "resource_link", uri: str(entry.uri)!, name: str(entry.name) ?? str(entry.uri)! } });
    } else if (str(entry.text)) {
      texts.push(str(entry.text)!);
    }
  }
  return texts.length > 0 ? [{ type: "content", content: { type: "text", text: texts.join("\n") } }, ...out] : out;
}

/** Drops the `/bin/zsh -lc '…'` wrapper Codex puts around every command. */
export function unwrapShell(command: string): string {
  return unwrapShellCommand(command);
}

/** A readable title and kind for a command, from Codex's own parse of it. */
function describeCommand(item: Json): { title: string; kind: "read" | "search" | "execute" } {
  const actions = arr(item.commandActions).map(obj).filter((action): action is Json => Boolean(action));
  const command = unwrapShell(str(item.command) ?? "");
  if (actions.length === 1) {
    const action = actions[0]!;
    switch (action.type) {
      case "read":
        return { title: `Read ${str(action.name) ?? str(action.path) ?? command}`, kind: "read" };
      case "listFiles":
        return { title: `List ${str(action.path) ?? "files"}`, kind: "read" };
      case "search":
        return { title: `Search ${str(action.query) ? `“${str(action.query)}”` : ""}${str(action.path) ? ` in ${str(action.path)}` : ""}`.trim(), kind: "search" };
      default:
        break;
    }
  }
  return { title: command || "Run command", kind: "execute" };
}

const COLLAB_ACTIONS: Record<string, "spawn" | "message" | "wait" | "stop" | "resume" | "list"> = {
  spawnAgent: "spawn",
  sendInput: "message",
  sendMessage: "message",
  followupTask: "message",
  wait: "wait",
  closeAgent: "stop",
  interruptAgent: "stop",
  resumeAgent: "resume",
  listAgents: "list",
};

/** Threads a spawnAgent call created: their work nests under the call. */
export function spawnedThreads(item: unknown): string[] {
  const record = obj(item);
  if (record?.type !== "collabAgentToolCall" || record.tool !== "spawnAgent") return [];
  return arr(record.receiverThreadIds).filter((id): id is string => typeof id === "string");
}

/** Updates that open a tool-like item. Returns undefined for non-tool items. */
function toolStart(item: Json): Extract<SessionUpdate, { sessionUpdate: "tool_call" }> | undefined {
  const id = str(item.id);
  if (!id) return undefined;
  const base = { sessionUpdate: "tool_call" as const, toolCallId: id };
  switch (item.type) {
    case "commandExecution": {
      const { title, kind } = describeCommand(item);
      return {
        ...base,
        title,
        kind,
        status: commandStatus(item.status),
        rawInput: { command: unwrapShell(str(item.command) ?? ""), cwd: item.cwd },
      };
    }
    case "fileChange": {
      const content = patchContent(item.changes);
      return { ...base, title: fileChangeTitle(content), kind: "edit", status: commandStatus(item.status), content };
    }
    case "mcpToolCall":
      return {
        ...base,
        title: `${str(item.server) ?? "mcp"} · ${str(item.tool) ?? "tool"}`,
        kind: "other",
        status: commandStatus(item.status),
        rawInput: item.arguments,
        detail: { type: "mcp", server: str(item.server) ?? "mcp", tool: str(item.tool) ?? "tool" },
      };
    case "dynamicToolCall":
      return {
        ...base,
        title: str(item.tool) ?? "Tool",
        kind: "other",
        status: commandStatus(item.status),
        rawInput: item.arguments,
      };
    case "webSearch":
      return {
        ...base,
        title: str(item.query) ? `Search: ${str(item.query)}` : "Web search",
        kind: "fetch",
        status: "completed",
        rawInput: { query: item.query },
        detail: { type: "web_search", query: str(item.query) },
      };
    case "imageView": {
      const image = imageFileContent(str(item.path));
      return {
        ...base,
        title: `View ${str(item.path)?.split("/").pop() ?? "image"}`,
        kind: "read",
        status: "completed",
        rawInput: { path: item.path },
        locations: str(item.path) ? [{ path: str(item.path)! }] : undefined,
        content: image ? [image] : undefined,
      };
    }
    case "contextCompaction":
      return { ...base, title: "Context compacted", kind: "think", status: "completed", detail: { type: "compaction" } };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return {
        ...base,
        title: item.type === "enteredReviewMode" ? "Review started" : "Review finished",
        kind: "think",
        status: "completed",
        rawInput: { review: item.review },
        detail: { type: "review", phase: item.type === "enteredReviewMode" ? "started" : "finished" },
      };
    case "collabAgentToolCall": {
      const action = COLLAB_ACTIONS[str(item.tool) ?? ""] ?? "message";
      return {
        ...base,
        title: str(item.prompt) ? `Sub-agent: ${str(item.prompt)}` : "Sub-agent",
        kind: "other",
        status: item.status === "interrupted" ? "failed" : commandStatus(item.status),
        rawInput: action === "spawn" ? undefined : { agents: item.receiverThreadIds },
        detail: { type: "subagent", action, task: str(item.prompt), model: str(item.model) },
      };
    }
    case "subAgentActivity":
      // Lifecycle echoes of the collab calls above; the sub-agent's own turn state says the same.
      return undefined;
    case "imageGeneration":
      return {
        ...base,
        title: "Generate image",
        kind: "other",
        status: commandStatus(item.status),
        rawInput: str(item.revisedPrompt) ? { prompt: item.revisedPrompt } : undefined,
        detail: { type: "image_generation", prompt: str(item.revisedPrompt) },
      };
    default:
      return undefined;
  }
}

/** Updates that close a tool-like item with its final status and output. */
function toolFinish(
  item: Json,
  options: { includeOutput: boolean },
): Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> | undefined {
  const id = str(item.id);
  if (!id) return undefined;
  const update: Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> = {
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    status: item.status === undefined ? "completed" : commandStatus(item.status) === "in_progress" ? "completed" : commandStatus(item.status),
  };
  switch (item.type) {
    case "commandExecution":
      update.rawOutput = { exitCode: num(item.exitCode) ?? null, durationMs: num(item.durationMs) ?? null, declined: item.status === "declined" };
      if (options.includeOutput && str(item.aggregatedOutput)) update.appendOutput = str(item.aggregatedOutput);
      break;
    case "fileChange":
      update.content = patchContent(item.changes);
      break;
    case "mcpToolCall":
    case "dynamicToolCall": {
      const content = mcpOutput(item);
      if (content.length > 0) update.content = content;
      break;
    }
    case "imageGeneration": {
      const image = imageContent(str(item.result), "image/png") ?? imageFileContent(str(item.savedPath));
      if (image) update.content = [image];
      else if (str(obj(item.failure)?.message)) update.content = [{ type: "content", content: { type: "text", text: str(obj(item.failure)?.message)! } }];
      break;
    }
    default:
      break;
  }
  return update;
}

/** One native item as complete history. */
export function itemToHistory(raw: Json): HistoryItem | undefined {
  const id = str(raw.id);
  if (!id) return undefined;
  switch (raw.type) {
    case "userMessage": {
      // A message sent through LinkShell carries the client's id; clients match
      // their optimistic copy by `local-<clientMessageId>` (same as ACP drivers).
      const messageId = str(raw.clientId) ? `local-${str(raw.clientId)}` : id;
      const updates = userContent(raw).map(
        (content): SessionUpdate => ({ sessionUpdate: "user_message_chunk", messageId, content }),
      );
      return updates.length > 0 ? { itemId: id, updates } : undefined;
    }
    case "agentMessage":
    case "plan": {
      const text = str(raw.text) ?? "";
      if (!text) return undefined;
      return {
        itemId: id,
        updates: [
          { sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text } },
          { sessionUpdate: "ls_message_done", messageId: id, role: "agent" },
        ],
      };
    }
    case "reasoning": {
      const text = [...arr(raw.summary), ...(arr(raw.summary).length === 0 ? arr(raw.content) : [])]
        .filter((part): part is string => typeof part === "string")
        .join("\n\n");
      if (!text) return undefined;
      return {
        itemId: id,
        updates: [
          { sessionUpdate: "agent_thought_chunk", messageId: id, content: { type: "text", text } },
          { sessionUpdate: "ls_message_done", messageId: id, role: "thought" },
        ],
      };
    }
    default: {
      const start = toolStart(raw);
      if (!start) return undefined;
      const finish = toolFinish(raw, { includeOutput: true });
      return { itemId: id, updates: finish ? [start, finish] : [start] };
    }
  }
}

export function threadToHistory(thread: CodexThread): HistoryItem[] {
  const history: HistoryItem[] = [];
  for (const turn of thread.turns ?? []) {
    // Codex reports turn times in seconds.
    const started = typeof turn.startedAt === "number" ? turn.startedAt : undefined;
    const ts = started === undefined ? undefined : started < 1e12 ? started * 1000 : started;
    let reviewing = false;
    for (const item of turn.items) {
      if (item.type === "enteredReviewMode") reviewing = true;
      else if (item.type === "exitedReviewMode") reviewing = false;
      if (isReviewPrompt(item, reviewing)) continue;
      const entry = itemToHistory(item);
      if (entry) history.push(ts === undefined ? entry : { ...entry, ts });
    }
    if (turn.status === "failed" && turn.error?.message) {
      history.push({
        itemId: `turn-error:${turn.id}`,
        updates: [
          {
            sessionUpdate: "ls_error",
            code: "turn_failed",
            message: turn.error.message,
            hint: turn.error.additionalDetails ?? undefined,
          },
        ],
      });
    }
  }
  return history;
}

function planEntries(plan: unknown): PlanEntry[] {
  return arr(plan).flatMap((raw) => {
    const step = obj(raw);
    const content = str(step?.step);
    if (!step || !content) return [];
    const status = step.status === "completed" ? "completed" : step.status === "inProgress" ? "in_progress" : "pending";
    return [{ content, priority: "medium" as const, status }];
  });
}

/** Maps one app-server notification to session updates. */
export function mapNotification(
  method: string,
  rawParams: unknown,
  stateOf: (threadId: string) => CodexThreadState,
): MappedUpdate[] {
  const params = obj(rawParams);
  const threadId = str(params?.threadId);
  if (!params || !threadId) return [];
  const state = stateOf(threadId);
  const out = (update: SessionUpdate, itemId?: string): MappedUpdate => ({ threadId, update, itemId });

  switch (method) {
    case "turn/started": {
      const turn = obj(params.turn);
      state.activeTurnId = str(turn?.id);
      return [out({ sessionUpdate: "ls_turn", state: "started", turnId: state.activeTurnId })];
    }
    case "turn/completed": {
      const turn = obj(params.turn) as unknown as CodexTurn | undefined;
      state.activeTurnId = undefined;
      state.reviewing = false;
      state.streamed = undefined;
      const updates = [
        out({
          sessionUpdate: "ls_turn",
          state: "ended",
          turnId: turn?.id,
          stopReason: stopReasonOf(turn?.status ?? "completed"),
        }),
      ];
      if (turn?.status === "failed" && turn.error?.message) {
        updates.push(
          out({
            sessionUpdate: "ls_error",
            code: "turn_failed",
            message: turn.error.message,
            hint: turn.error.additionalDetails ?? undefined,
          }),
        );
      }
      return updates;
    }
    case "thread/status/changed":
      return [out({ sessionUpdate: "ls_status", state: threadStateOf(obj(params.status) as CodexThread["status"]) })];
    case "thread/name/updated": {
      const title = str(params.threadName);
      return title ? [out({ sessionUpdate: "session_info_update", title })] : [];
    }
    case "thread/tokenUsage/updated": {
      const usage = obj(params.tokenUsage);
      return [
        out({
          sessionUpdate: "usage_update",
          usedTokens: num(obj(usage?.last)?.totalTokens) ?? num(obj(usage?.total)?.totalTokens),
          contextWindow: num(usage?.modelContextWindow),
        }),
      ];
    }
    case "turn/plan/updated":
      return [out({ sessionUpdate: "plan", entries: planEntries(params.plan) })];
    case "error": {
      if (params.willRetry === true) return [];
      const error = obj(params.error);
      return [
        out({
          sessionUpdate: "ls_error",
          code: "agent_error",
          message: str(error?.message) ?? "Codex reported an error",
          hint: str(error?.additionalDetails) ?? undefined,
        }),
      ];
    }
    case "serverRequest/resolved":
      return params.requestId === undefined
        ? []
        : [out({ sessionUpdate: "ls_permission_resolved", requestId: String(params.requestId) })];
    case "item/agentMessage/delta":
    case "item/plan/delta": {
      const itemId = str(params.itemId);
      const delta = str(params.delta);
      if (!itemId || !delta) return [];
      (state.streamed ??= new Set()).add(itemId);
      return [out({ sessionUpdate: "agent_message_chunk", messageId: itemId, content: { type: "text", text: delta } })];
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const itemId = str(params.itemId);
      const delta = str(params.delta);
      return itemId && delta
        ? [out({ sessionUpdate: "agent_thought_chunk", messageId: itemId, content: { type: "text", text: delta } })]
        : [];
    }
    case "item/commandExecution/outputDelta": {
      const itemId = str(params.itemId);
      const delta = str(params.delta);
      return itemId && delta ? [out({ sessionUpdate: "tool_call_update", toolCallId: itemId, appendOutput: delta })] : [];
    }
    case "item/fileChange/patchUpdated": {
      const itemId = str(params.itemId);
      return itemId
        ? [out({ sessionUpdate: "tool_call_update", toolCallId: itemId, content: patchContent(params.changes) })]
        : [];
    }
    case "item/started": {
      const item = obj(params.item);
      if (!item) return [];
      if (item.type === "enteredReviewMode") state.reviewing = true;
      if (isReviewPrompt(item, state.reviewing)) return [];
      if (item.type === "userMessage") {
        const history = itemToHistory(item);
        if (!history) return [];
        return history.updates.map((update, index) =>
          out(update, index === history.updates.length - 1 ? history.itemId : undefined),
        );
      }
      const start = toolStart(item);
      return start ? [out(start)] : [];
    }
    case "item/completed": {
      const item = obj(params.item);
      const itemId = str(item?.id);
      if (!item || !itemId) return [];
      switch (item.type) {
        case "userMessage":
          return [];
        case "agentMessage":
        case "plan": {
          const done = out({ sessionUpdate: "ls_message_done", messageId: itemId, role: "agent" }, itemId);
          // A review's findings arrive whole, not written out bit by bit.
          const text = state.streamed?.delete(itemId) ? undefined : str(item.text);
          return text ? [out({ sessionUpdate: "agent_message_chunk", messageId: itemId, content: { type: "text", text } }), done] : [done];
        }
        case "reasoning":
          return [out({ sessionUpdate: "ls_message_done", messageId: itemId, role: "thought" }, itemId)];
        default: {
          if (item.type === "exitedReviewMode") state.reviewing = false;
          const finish = toolFinish(item, { includeOutput: false });
          return finish ? [out(finish, itemId)] : [];
        }
      }
    }
    default:
      return [];
  }
}

// ── Approvals ────────────────────────────────────────────────────────

export const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

const DECISION_OPTIONS: PermissionOption[] = [
  { optionId: "accept", name: "Allow", kind: "allow_once" },
  { optionId: "acceptForSession", name: "Allow for this session", kind: "allow_always" },
  { optionId: "decline", name: "Decline", kind: "reject_once" },
  { optionId: "cancel", name: "Decline and stop", kind: "reject_once" },
];

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "turn", name: "Allow this turn", kind: "allow_once" },
  { optionId: "session", name: "Allow for this session", kind: "allow_always" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

export interface ApprovalRequest {
  threadId: string;
  update: Extract<SessionUpdate, { sessionUpdate: "ls_permission" }>;
  /** Builds the JSON-RPC result for the chosen option. */
  respond(optionId: string): unknown;
}

export function mapApprovalRequest(method: string, rawParams: unknown, requestId: string): ApprovalRequest | undefined {
  const params = obj(rawParams);
  const threadId = str(params?.threadId);
  if (!params || !threadId || !APPROVAL_METHODS.has(method)) return undefined;
  const toolCallId = str(params.itemId);
  const reason = str(params.reason) ?? undefined;

  if (method === "item/permissions/requestApproval") {
    const requested = obj(params.permissions) ?? {};
    return {
      threadId,
      update: {
        sessionUpdate: "ls_permission",
        requestId,
        toolCallId,
        title: "Grant additional permissions",
        detail: reason ?? Object.keys(requested).filter((key) => requested[key]).join(", "),
        options: PERMISSION_OPTIONS,
      },
      respond: (optionId) =>
        optionId === "deny"
          ? { permissions: {}, scope: "turn" }
          : { permissions: requested, scope: optionId === "session" ? "session" : "turn" },
    };
  }

  const isCommand = method === "item/commandExecution/requestApproval";
  return {
    threadId,
    update: {
      sessionUpdate: "ls_permission",
      requestId,
      toolCallId,
      title: isCommand ? "Run command" : "Apply file changes",
      detail: isCommand
        ? (str(params.command) ? unwrapShell(str(params.command)!) : reason)
        : (reason ?? str(params.grantRoot) ?? undefined),
      options: DECISION_OPTIONS,
    },
    respond: (optionId) => ({ decision: optionId }),
  };
}

export function toCodexInput(content: ContentBlock[]): Json[] {
  return content.flatMap((block): Json[] => {
    switch (block.type) {
      case "text":
        return [{ type: "text", text: block.text, text_elements: [] }];
      case "image":
        if (block.uri) return [{ type: "image", url: block.uri }];
        if (block.data) return [{ type: "image", url: `data:${block.mimeType};base64,${block.data}` }];
        return [];
      case "resource_link": {
        if (block.kind === "skill") return [{ type: "skill", name: block.name, path: block.uri.replace(/^file:\/\//, "") }];
        const path = block.uri.startsWith("file://") ? block.uri.slice("file://".length) : block.uri;
        return /\.(png|jpe?g|gif|webp|heic)$/i.test(path)
          ? [{ type: "localImage", path }]
          : [{ type: "text", text: `@${path}`, text_elements: [] }];
      }
      default:
        return [];
    }
  });
}
