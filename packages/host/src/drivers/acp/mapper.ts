import { sessionGoalSchema } from "@linkshell/wire";
import type {
  ContentBlock,
  PermissionOption,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolDetail,
  ToolKind,
} from "@linkshell/wire";
import { describeClaudeTool } from "../claude/transcript.js";
import { inlineImage } from "../images.js";
import type { HistoryItem } from "../types.js";

// Normalizes Agent Client Protocol updates into LinkShell's (ACP-shaped) wire
// updates. Wire updates deliberately mirror ACP, so this is mostly validation
// and trimming of fields LinkShell doesn't carry.

type Json = Record<string, unknown>;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const obj = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const TOOL_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"]);
const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);

export function toContentBlock(raw: unknown): ContentBlock | undefined {
  const block = obj(raw);
  if (!block) return undefined;
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? { type: "text", text: block.text } : undefined;
    case "image":
      if (str(block.data)) return inlineImage(str(block.data), str(block.mimeType));
      return str(block.uri) ? { type: "image", mimeType: str(block.mimeType) ?? "image/*", uri: str(block.uri)! } : undefined;
    case "resource_link":
      return str(block.uri) ? { type: "resource_link", uri: str(block.uri)!, name: str(block.name) ?? str(block.uri)! } : undefined;
    case "resource": {
      const resource = obj(block.resource);
      if (typeof resource?.text === "string") return { type: "text", text: resource.text };
      if (str(resource?.mimeType)?.startsWith("image/") && str(resource?.blob)) return inlineImage(str(resource?.blob), str(resource?.mimeType));
      return str(resource?.uri) ? { type: "resource_link", uri: str(resource?.uri)!, name: str(resource?.uri)! } : undefined;
    }
    default:
      return undefined;
  }
}

function toolContent(raw: unknown): ToolCallContent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const content: ToolCallContent[] = [];
  for (const entry of raw) {
    const item = obj(entry);
    if (!item) continue;
    if (item.type === "content") {
      const block = toContentBlock(item.content);
      if (block) content.push({ type: "content", content: block });
    } else if (item.type === "diff" && str(item.path) && typeof item.newText === "string") {
      content.push({ type: "diff", path: str(item.path)!, oldText: str(item.oldText) ?? null, newText: item.newText });
    } else if (item.type === "terminal" && str(item.terminalId)) {
      content.push({ type: "terminal", terminalId: str(item.terminalId)! });
    }
  }
  return content;
}

function toolKind(value: unknown): ToolKind {
  return typeof value === "string" && TOOL_KINDS.has(value) ? (value as ToolKind) : "other";
}

function toolStatus(value: unknown): ToolCallStatus | undefined {
  return typeof value === "string" && TOOL_STATUSES.has(value) ? (value as ToolCallStatus) : undefined;
}

function locations(raw: unknown) {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry) => {
    const location = obj(entry);
    return str(location?.path) ? [{ path: str(location?.path)!, line: typeof location?.line === "number" ? location.line : undefined }] : [];
  });
}

/** Where an option came from decides which ACP method changes it. */
export type ConfigSource = "configOptions" | "modes" | "models";
export type SourcedConfigOption = SessionConfigOption & { source: ConfigSource };

/** Reads ACP `configOptions` / `modes` / legacy `models` into LinkShell config options. */
export function toConfigOptions(response: unknown): SourcedConfigOption[] {
  const source = obj(response);
  if (!source) return [];
  const options: SourcedConfigOption[] = [];
  for (const raw of arr(source.configOptions)) {
    const option = obj(raw);
    if (!option || option.type !== "select" || !str(option.id)) continue;
    const values = arr(option.options).flatMap((entry) => {
      const value = obj(entry);
      if (!value) return [];
      if (Array.isArray(value.options)) {
        return value.options.flatMap((inner) => {
          const v = obj(inner);
          return str(v?.value) ? [{ value: str(v?.value)!, name: str(v?.name) ?? str(v?.value)!, description: str(v?.description) }] : [];
        });
      }
      return str(value.value) ? [{ value: str(value.value)!, name: str(value.name) ?? str(value.value)!, description: str(value.description) }] : [];
    });
    const category = str(option.category) ?? str(option.id);
    options.push({
      id: str(option.id)!,
      name: str(option.name) ?? str(option.id)!,
      category: category === "model" || category === "mode" ? category : category?.includes("thought") || category?.includes("effort") ? "effort" : "other",
      current: str(option.currentValue) ?? values[0]?.value ?? "",
      values,
      source: "configOptions",
    });
  }
  const modes = obj(source.modes);
  if (modes && !options.some((option) => option.category === "mode")) {
    const values = arr(modes.availableModes).flatMap((entry) => {
      const mode = obj(entry);
      return str(mode?.id) ? [{ value: str(mode?.id)!, name: str(mode?.name) ?? str(mode?.id)!, description: str(mode?.description) }] : [];
    });
    if (values.length > 0) {
      options.push({ id: "mode", name: "Mode", category: "mode", current: str(modes.currentModeId) ?? values[0]!.value, values, source: "modes" });
    }
  }
  const models = obj(source.models);
  if (models && !options.some((option) => option.category === "model")) {
    const values = arr(models.availableModels).flatMap((entry) => {
      const model = obj(entry);
      const id = str(model?.modelId) ?? str(model?.id);
      return id ? [{ value: id, name: str(model?.name) ?? id, description: str(model?.description) }] : [];
    });
    if (values.length > 0) {
      options.push({ id: "model", name: "Model", category: "model", current: str(models.currentModelId) ?? values[0]!.value, values, source: "models" });
    }
  }
  // Copilot lists "auto" three times; a menu shows each choice once.
  return options.map((option) => ({
    ...option,
    values: option.values.filter((value, index, all) => all.findIndex((other) => other.value === value.value) === index),
  }));
}

/**
 * Agent-specific tool metadata some ACP adapters attach in `_meta`. Only
 * Claude's adapter does today (`_meta.claudeCode.toolName`); anything else
 * renders from ACP's generic `title` and `kind`.
 */
/** The spawning tool call of a sub-agent's update (Claude: `_meta.claudeCode.parentToolUseId`). */
function parentOf(update: Record<string, unknown>): string | undefined {
  return str(obj(obj(update._meta)?.claudeCode)?.parentToolUseId);
}

function toolDetail(update: Record<string, unknown>): ToolDetail | undefined {
  const claudeTool = str(obj(obj(update._meta)?.claudeCode)?.toolName);
  if (claudeTool) return describeClaudeTool(claudeTool, obj(update.rawInput) ?? {}).detail;
  // Claude's adapter reports `/compact` (and compacting by itself) as a call of no tool.
  if (update.kind === "think" && str(update.title) === "Compact conversation") return { type: "compaction" };
  return undefined;
}

/** Maps one ACP `session/update` payload. Returns undefined for kinds LinkShell doesn't carry. */
export function normalizeAcpUpdate(raw: unknown): SessionUpdate | undefined {
  const update = obj(raw);
  if (!update) return undefined;
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const content = toContentBlock(update.content);
      if (!content) return undefined;
      const messageId = str(update.messageId);
      if (update.sessionUpdate === "user_message_chunk") {
        // A sub-agent's prompt is its spawning call's input; don't show it as the user's.
        if (parentOf(update)) return undefined;
        const said = withoutContext(content);
        return said ? { sessionUpdate: "user_message_chunk", messageId, content: said } : undefined;
      }
      // Agent chunks without an id get one from the ItemTracker.
      return { sessionUpdate: update.sessionUpdate, messageId: messageId ?? "", content, parentToolCallId: parentOf(update) };
    }
    case "tool_call": {
      const toolCallId = str(update.toolCallId);
      if (!toolCallId) return undefined;
      return {
        sessionUpdate: "tool_call",
        toolCallId,
        parentToolCallId: parentOf(update),
        title: str(update.title) ?? str(update.name) ?? "Tool",
        kind: toolKind(update.kind),
        status: toolStatus(update.status) ?? "pending",
        rawInput: update.rawInput,
        content: toolContent(update.content),
        locations: locations(update.locations),
        detail: toolDetail(update),
      };
    }
    case "tool_call_update": {
      const toolCallId = str(update.toolCallId);
      if (!toolCallId) return undefined;
      // Workflow's tool result only acknowledges launch. Its durable artifacts
      // and task notification settle the run, including when ACP owns the turn.
      const workflow = str(obj(obj(update._meta)?.claudeCode)?.toolName) === "Workflow";
      return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        parentToolCallId: parentOf(update),
        status: workflow && update.status === "completed" ? "in_progress" : toolStatus(update.status),
        title: str(update.title) ?? undefined,
        detail: workflow ? undefined : toolDetail(update),
        content: toolContent(update.content),
        rawOutput: update.rawOutput,
      };
    }
    case "plan":
      return {
        sessionUpdate: "plan",
        entries: arr(update.entries).flatMap((entry) => {
          const plan = obj(entry);
          if (!str(plan?.content)) return [];
          const status = plan?.status === "completed" || plan?.status === "in_progress" ? plan.status : "pending";
          const priority = plan?.priority === "high" || plan?.priority === "low" ? plan.priority : "medium";
          return [{ content: str(plan?.content)!, status, priority }];
        }),
      };
    case "available_commands_update": {
      // Skills come with a paragraph each, and some agents list one twice: a
      // device needs the name and a line about it.
      const seen = new Set<string>();
      return {
        sessionUpdate: "available_commands_update",
        availableCommands: arr(update.availableCommands).flatMap((entry) => {
          const command = obj(entry);
          const name = str(command?.name);
          if (!name || seen.has(name)) return [];
          seen.add(name);
          return [{ name, description: brief(str(command?.description) ?? ""), hint: str(obj(command?.input)?.hint) }];
        }),
      };
    }
    case "current_mode_update":
      return str(update.currentModeId) ? { sessionUpdate: "current_mode_update", currentModeId: str(update.currentModeId)! } : undefined;
    case "config_option_update": {
      const options = toConfigOptions({ configOptions: update.configOptions }).map(({ source: _source, ...option }) => option);
      return options.length > 0 ? { sessionUpdate: "ls_config", options } : undefined;
    }
    case "session_info_update": {
      const air = obj(obj(obj(update._meta)?.jetbrains)?.air);
      if (air && Object.hasOwn(air, "goal")) {
        if (air.goal === null) return { sessionUpdate: "ls_goal", goal: null };
        const goal = sessionGoalSchema.safeParse(air.goal);
        if (goal.success) return { sessionUpdate: "ls_goal", goal: goal.data };
      }
      return str(update.title) ? { sessionUpdate: "session_info_update", title: str(update.title) } : undefined;
    }
    case "usage_update":
      return {
        sessionUpdate: "usage_update",
        usedTokens: typeof update.used === "number" ? update.used : undefined,
        contextWindow: typeof update.size === "number" ? update.size : undefined,
      };
    case "notice": {
      const title = str(update.title);
      if (!title) return undefined;
      if (update.severity === "error") return { sessionUpdate: "ls_error", code: "agent_notice", message: title, hint: str(update.description) };
      return { sessionUpdate: "ls_notice", level: update.severity === "warning" ? "warning" : "info", title, detail: str(update.description) };
    }
    default:
      return undefined;
  }
}

export interface TrackedUpdate {
  update: SessionUpdate;
  /** Present on the update that completes a native item, for de-duplication. */
  itemId?: string;
}

type OpenKind = "agent" | "thought" | "user";

/** FNV-1a, for content-derived ids of messages that arrive without one. */
function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Gives streamed ACP updates stable item ids and closes messages. Agents that
 * stamp `messageId` (Claude does, identically live and on replay) get ids that
 * match across session/load and transcripts. Messages without one get an id
 * derived from their content, so a later replay maps to the same item.
 */
export class AcpItemTracker {
  private open?: { kind: OpenKind; messageId: string; synthetic: boolean; text: string; parent?: string };
  private syntheticCounter = 0;
  private readonly finishedTools = new Set<string>();
  /** How often each user text has been seen, so repeats ("yes", "continue") get distinct ids. */
  private readonly userOccurrences = new Map<string, number>();

  feed(update: SessionUpdate): TrackedUpdate[] {
    const out: TrackedUpdate[] = [];
    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk" ||
      update.sessionUpdate === "user_message_chunk"
    ) {
      const kind: OpenKind =
        update.sessionUpdate === "agent_message_chunk" ? "agent" : update.sessionUpdate === "agent_thought_chunk" ? "thought" : "user";
      let messageId = update.messageId || "";
      const synthetic = !messageId;
      if (synthetic) {
        // Consecutive id-less chunks of one kind belong to the same message.
        messageId =
          this.open && this.open.kind === kind && this.open.synthetic ? this.open.messageId : `pending-${++this.syntheticCounter}`;
      }
      const parent = update.sessionUpdate === "user_message_chunk" ? undefined : update.parentToolCallId;
      if (this.open && (this.open.kind !== kind || this.open.messageId !== messageId || this.open.parent !== parent)) out.push(...this.close());
      if (!this.open) this.open = { kind, messageId, synthetic, text: "", parent };
      if (update.content.type === "text") this.open.text += update.content.text;
      out.push({ update: { ...update, messageId } as SessionUpdate });
      return out;
    }
    // Any other update ends the message in progress.
    out.push(...this.close());
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const terminal = update.status === "completed" || update.status === "failed";
      const itemId = terminal && !this.finishedTools.has(update.toolCallId) ? `tool:${update.toolCallId}` : undefined;
      if (itemId) this.finishedTools.add(update.toolCallId);
      out.push({ update, itemId });
      return out;
    }
    out.push({ update });
    return out;
  }

  /** Closes the open message (turn end, end of a history replay). */
  close(): TrackedUpdate[] {
    const open = this.open;
    this.open = undefined;
    if (!open) return [];
    let itemKey = open.synthetic ? `h${contentHash(open.text)}` : open.messageId;
    if (open.kind === "user") {
      // Agents (Claude among them) mint their own id for a prompt and don't echo
      // it live, so the id we see live never matches the one on replay. Key user
      // messages by content and occurrence instead, which both sides agree on.
      const hash = contentHash(open.text.replace(/\s+/g, " ").trim());
      const occurrence = this.userOccurrences.get(hash) ?? 0;
      this.userOccurrences.set(hash, occurrence + 1);
      itemKey = `h${hash}#${occurrence}`;
    }
    return [
      {
        update: { sessionUpdate: "ls_message_done", messageId: open.messageId, role: open.kind, parentToolCallId: open.parent },
        itemId: `${open.kind}:${itemKey}`,
      },
    ];
  }
}

/**
 * Groups a replay (session/load) into history items, keeping only complete
 * items. Pass the session's tracker so live messages that follow continue the
 * same numbering.
 */
export function toHistory(
  updates: SessionUpdate[],
  tracker = new AcpItemTracker(),
  timeOf?: (update: SessionUpdate) => number | undefined,
  /** Receives what isn't a finished item yet (a turn under way: its start, tool calls still running), in order. */
  unfinished?: SessionUpdate[],
): HistoryItem[] {
  const tracked = [
    ...updates.flatMap((update) => {
      const ts = timeOf?.(update);
      return tracker.feed(update).map((entry) => ({ ...entry, ts }));
    }),
    ...tracker.close().map((entry) => ({ ...entry, ts: undefined as number | undefined })),
  ];
  const history: HistoryItem[] = [];
  let group: SessionUpdate[] = [];
  let groupTs: number | undefined;
  const toolGroups = new Map<string, { updates: SessionUpdate[]; ts?: number }>();
  // Calls whose item is already in the history, and how many later words on each there have been.
  const closed = new Map<string, number>();
  const position = new Map<SessionUpdate, number>(tracked.map((entry, index) => [entry.update, index]));
  for (const { update, itemId, ts } of tracked) {
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const late = closed.get(update.toolCallId);
      if (late !== undefined && update.sessionUpdate === "tool_call_update") {
        // More about a call that already ended (a background task reporting back): history too, not something under way.
        closed.set(update.toolCallId, late + 1);
        history.push({ itemId: `tool:${update.toolCallId}+${late + 1}`, updates: [update], ts });
        continue;
      }
      const entry = toolGroups.get(update.toolCallId) ?? { updates: [], ts };
      entry.updates.push(update);
      entry.ts ??= ts;
      toolGroups.set(update.toolCallId, entry);
      if (itemId) {
        history.push({ itemId, updates: entry.updates, ts: entry.ts });
        toolGroups.delete(update.toolCallId);
        closed.set(update.toolCallId, 0);
      }
      continue;
    }
    group.push(update);
    groupTs ??= ts;
    if (itemId) {
      history.push({ itemId, updates: group, ts: groupTs });
      group = [];
      groupTs = undefined;
    }
  }
  if (unfinished) {
    const rest = [...group, ...[...toolGroups.values()].flatMap((entry) => entry.updates)];
    unfinished.push(...rest.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)));
  }
  return history;
}

const CONTEXT_OPEN = "<previous-conversation>";
const CONTEXT_CLOSE = "</previous-conversation>";

/** A prompt with `context` ahead of it: sent to the agent, not shown as what the user said. */
export function withContext(prompt: Json[], context: string | undefined): Json[] {
  return context ? [{ type: "text", text: `${CONTEXT_OPEN}\n${context}\n${CONTEXT_CLOSE}` }, ...prompt] : prompt;
}

/** What the user said, when an agent replays a prompt that carried context. */
function withoutContext(content: ContentBlock): ContentBlock | undefined {
  if (content.type !== "text" || !content.text.startsWith(CONTEXT_OPEN)) return content;
  const end = content.text.indexOf(CONTEXT_CLOSE);
  const rest = end < 0 ? "" : content.text.slice(end + CONTEXT_CLOSE.length).trimStart();
  return rest ? { type: "text", text: rest } : undefined;
}

export function toAcpPrompt(content: ContentBlock[]): Json[] {
  return content.flatMap((block): Json[] => {
    switch (block.type) {
      case "text":
        return [{ type: "text", text: block.text }];
      case "image":
        return block.data ? [{ type: "image", mimeType: block.mimeType, data: block.data, uri: block.uri }] : [];
      case "resource_link":
        return [{ type: "resource_link", uri: block.uri, name: block.name }];
      default:
        return [];
    }
  });
}

export function toStopReason(value: unknown): StopReason {
  switch (value) {
    case "cancelled":
    case "refusal":
    case "max_tokens":
      return value;
    case "max_turn_requests":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

export interface AcpPermissionRequest {
  update: Extract<SessionUpdate, { sessionUpdate: "ls_permission" }>;
}

export function mapPermissionRequest(params: unknown, requestId: string): AcpPermissionRequest | undefined {
  const payload = obj(params);
  const toolCall = obj(payload?.toolCall);
  const options: PermissionOption[] = arr(payload?.options).flatMap((entry) => {
    const option = obj(entry);
    const kind = option?.kind;
    if (!str(option?.optionId) || (kind !== "allow_once" && kind !== "allow_always" && kind !== "reject_once" && kind !== "reject_always")) {
      return [];
    }
    return [{ optionId: str(option?.optionId)!, name: str(option?.name) ?? str(option?.optionId)!, kind }];
  });
  if (options.length === 0) return undefined;
  const rawInput = obj(toolCall?.rawInput);
  const detail = str(rawInput?.command) ?? str(rawInput?.file_path) ?? str(rawInput?.path) ?? str(rawInput?.url);
  return {
    update: {
      sessionUpdate: "ls_permission",
      requestId,
      toolCallId: str(toolCall?.toolCallId),
      title: str(toolCall?.title) ?? "Permission required",
      detail,
      options,
    },
  };
}

/** The first line or so of a description. */
function brief(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
