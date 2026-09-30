import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
  SessionConfigOption,
  SessionDriver,
  SessionEvent,
  SessionState,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolDetail,
  ToolKind,
} from "@linkshell/wire";

// Turns a session's event log into what the UI renders. Pure and immutable:
// each event returns a new view, and only the items it touched are new objects,
// so a streamed token re-renders one row.

export type TimelineItem =
  | {
      kind: "user";
      id: string;
      blocks: ContentBlock[];
      ts: number;
      /** Sent from this device and not yet confirmed by the host. */
      pending?: boolean;
      failed?: boolean;
    }
  | {
      kind: "agent";
      id: string;
      text: string;
      /** Images and links the agent sent alongside its text. */
      attachments?: ContentBlock[];
      streaming: boolean;
      ts: number;
    }
  | { kind: "thought"; id: string; text: string; streaming: boolean; ts: number; endedTs?: number }
  | {
      kind: "tool";
      id: string;
      title: string;
      toolKind: ToolKind;
      status: ToolCallStatus;
      rawInput?: unknown;
      rawOutput?: unknown;
      locations?: ToolCallLocation[];
      detail?: ToolDetail;
      /** A sub-agent's own timeline, for calls that spawned one. */
      sub?: SessionView;
      content: ToolCallContent[];
      output: string;
      ts: number;
      endedTs?: number;
    }
  | { kind: "plan"; id: string; entries: PlanEntry[]; ts: number }
  | { kind: "notice"; id: string; level: "info" | "warning"; title: string; detail?: string; ts: number }
  | { kind: "error"; id: string; code: string; message: string; hint?: string; ts: number }
  | { kind: "turn-end"; id: string; stopReason: StopReason; ts: number }
  | { kind: "driver"; id: string; driver: SessionDriver; ts: number }
  | { kind: "permission-result"; id: string; title: string; detail?: string; optionName?: string; allowed?: boolean; ts: number };

export interface PendingPermission {
  requestId: string;
  toolCallId?: string;
  title: string;
  detail?: string;
  options: PermissionOption[];
  ts: number;
}

export interface SessionView {
  sessionId: string;
  lastSeq: number;
  items: TimelineItem[];
  /** id → index into items. */
  index: Record<string, number>;
  permissions: PendingPermission[];
  config: SessionConfigOption[];
  commands: { name: string; description: string; hint?: string }[];
  modeId?: string;
  usage?: { usedTokens?: number; contextWindow?: number };
  state: SessionState;
  turnActive: boolean;
  driver?: SessionDriver;
  title?: string;
  /** Latest plan item id in the current turn (plans update in place). */
  planId?: string;
}

export function emptyView(sessionId: string): SessionView {
  return {
    sessionId,
    lastSeq: 0,
    items: [],
    index: {},
    permissions: [],
    config: [],
    commands: [],
    state: "idle",
    turnActive: false,
  };
}

// ── helpers ──────────────────────────────────────────────────────────

function upsert(view: SessionView, item: TimelineItem): SessionView {
  const at = view.index[item.id];
  if (at === undefined) {
    return { ...view, items: [...view.items, item], index: { ...view.index, [item.id]: view.items.length } };
  }
  const items = view.items.slice();
  items[at] = item;
  return { ...view, items };
}

function get<K extends TimelineItem["kind"]>(view: SessionView, id: string, kind: K): Extract<TimelineItem, { kind: K }> | undefined {
  const at = view.index[id];
  const item = at === undefined ? undefined : view.items[at];
  return item && item.kind === kind ? (item as Extract<TimelineItem, { kind: K }>) : undefined;
}

function appendText(existing: string, block: ContentBlock): string {
  return block.type === "text" ? existing + block.text : existing;
}

/** Stops every streaming message (turn ended, or a message boundary). */
function settleStreaming(view: SessionView, ts: number): SessionView {
  let items: TimelineItem[] | undefined;
  view.items.forEach((item, i) => {
    if ((item.kind === "agent" || item.kind === "thought") && item.streaming) {
      items ??= view.items.slice();
      items[i] = item.kind === "thought" ? { ...item, streaming: false, endedTs: item.endedTs ?? ts } : { ...item, streaming: false };
    }
  });
  return items ? { ...view, items } : view;
}

/** Stops streaming inside every sub-agent timeline too (the whole turn ended). */
function settleAll(view: SessionView, ts: number): SessionView {
  const settled = settleStreaming(view, ts);
  let items: TimelineItem[] | undefined;
  settled.items.forEach((item, i) => {
    if (item.kind !== "tool" || !item.sub) return;
    const sub = settleAll(item.sub, ts);
    if (sub !== item.sub) {
      items ??= settled.items.slice();
      items[i] = { ...item, sub };
    }
  });
  return items ? { ...settled, items } : settled;
}

function parentOf(update: SessionUpdate): string | undefined {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
    case "ls_message_done":
    case "ls_turn":
      return update.parentToolCallId;
    default:
      return undefined;
  }
}

/** Routes a sub-agent's update into its spawning tool call's own timeline. */
function applyToChild(view: SessionView, parentId: string, update: SessionUpdate, ts: number, key: string): SessionView {
  const parent: Extract<TimelineItem, { kind: "tool" }> = get(view, parentId, "tool") ?? {
    kind: "tool",
    id: parentId,
    title: "Sub-agent",
    toolKind: "other",
    status: "in_progress",
    detail: { type: "subagent", action: "spawn" },
    content: [],
    output: "",
    ts,
  };
  const inner = { ...update, parentToolCallId: undefined } as SessionUpdate;
  const sub = applyUpdate(parent.sub ?? emptyView(view.sessionId), inner, ts, key);
  return sub === parent.sub ? view : upsert(view, { ...parent, sub });
}

// ── reducer ──────────────────────────────────────────────────────────

export function applyUpdate(view: SessionView, update: SessionUpdate, ts: number, key: string): SessionView {
  const parentId = parentOf(update);
  if (parentId) return applyToChild(view, parentId, update, ts, key);
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      const id = update.messageId ?? `user-${key}`;
      const existing = get(view, id, "user");
      // The host's copy confirms (and replaces) an optimistic one with the same id.
      const blocks = existing && !existing.pending ? [...existing.blocks, update.content] : [update.content];
      return upsert(view, { kind: "user", id, blocks: mergeText(blocks), ts: existing?.ts ?? ts });
    }
    case "agent_message_chunk": {
      const existing = get(view, update.messageId, "agent");
      const attachments =
        update.content.type === "text" ? existing?.attachments : [...(existing?.attachments ?? []), update.content];
      return upsert(view, {
        kind: "agent",
        id: update.messageId,
        text: appendText(existing?.text ?? "", update.content),
        attachments,
        streaming: true,
        ts: existing?.ts ?? ts,
      });
    }
    case "agent_thought_chunk": {
      const id = `thought:${update.messageId}`;
      const existing = get(view, id, "thought");
      return upsert(view, {
        kind: "thought",
        id,
        text: appendText(existing?.text ?? "", update.content),
        streaming: true,
        ts: existing?.ts ?? ts,
      });
    }
    case "ls_message_done": {
      const id = update.role === "thought" ? `thought:${update.messageId}` : update.messageId;
      const agent = get(view, id, "agent");
      if (agent) return upsert(view, { ...agent, streaming: false });
      const thought = get(view, id, "thought");
      if (thought) return upsert(view, { ...thought, streaming: false, endedTs: thought.endedTs ?? ts });
      return view;
    }
    case "tool_call": {
      const existing = get(view, update.toolCallId, "tool");
      const done = update.status === "completed" || update.status === "failed";
      return upsert(settleStreaming(view, ts), {
        kind: "tool",
        id: update.toolCallId,
        title: update.title,
        toolKind: update.kind,
        status: update.status,
        rawInput: update.rawInput ?? existing?.rawInput,
        rawOutput: existing?.rawOutput,
        locations: update.locations ?? existing?.locations,
        detail: update.detail ?? existing?.detail,
        sub: existing?.sub,
        content: update.content ?? existing?.content ?? [],
        output: existing?.output ?? "",
        ts: existing?.ts ?? ts,
        endedTs: done ? ts : existing?.endedTs,
      });
    }
    case "tool_call_update": {
      const existing = get(view, update.toolCallId, "tool");
      const base = existing ?? {
        kind: "tool" as const,
        id: update.toolCallId,
        title: update.title ?? "Tool",
        toolKind: "other" as ToolKind,
        status: "in_progress" as ToolCallStatus,
        content: [],
        output: "",
        ts,
      };
      const status = update.status ?? base.status;
      const done = status === "completed" || status === "failed";
      return upsert(view, {
        ...base,
        title: update.title ?? base.title,
        detail: update.detail ?? base.detail,
        status,
        content: update.content ? keepDiffs(base.content, update.content) : base.content,
        output: update.appendOutput ? base.output + update.appendOutput : base.output,
        rawOutput: update.rawOutput ?? base.rawOutput,
        endedTs: done ? (base.endedTs ?? ts) : base.endedTs,
        sub: done && base.sub ? settleAll(base.sub, ts) : base.sub,
      });
    }
    case "plan": {
      // One plan card per turn, updated in place.
      const id = view.planId ?? `plan-${key}`;
      const next = upsert(view, { kind: "plan", id, entries: update.entries, ts: get(view, id, "plan")?.ts ?? ts });
      return { ...next, planId: id };
    }
    case "available_commands_update":
      return { ...view, commands: update.availableCommands };
    case "current_mode_update":
      return {
        ...view,
        modeId: update.currentModeId,
        config: view.config.map((option) => (option.category === "mode" ? { ...option, current: update.currentModeId } : option)),
      };
    case "ls_config":
      return { ...view, config: update.options, modeId: update.options.find((o) => o.category === "mode")?.current ?? view.modeId };
    case "session_info_update":
      return { ...view, title: update.title ?? view.title };
    case "usage_update":
      return { ...view, usage: { usedTokens: update.usedTokens, contextWindow: update.contextWindow } };
    case "ls_turn":
      if (update.state === "started") return { ...view, turnActive: true, state: "running", planId: undefined };
      {
        const settled = settleAll(view, ts);
        const ended: SessionView = {
          ...settled,
          turnActive: false,
          state: update.stopReason === "error" ? "error" : "idle",
          permissions: [],
        };
        // Only interruptions are worth a marker; a normal end is implied by the reply.
        return update.stopReason === "cancelled"
          ? upsert(ended, { kind: "turn-end", id: `turn-end-${key}`, stopReason: "cancelled", ts })
          : ended;
      }
    case "ls_status":
      return { ...view, state: update.state };
    case "ls_permission": {
      if (view.permissions.some((p) => p.requestId === update.requestId)) return view;
      return {
        ...settleStreaming(view, ts),
        state: "waiting",
        permissions: [
          ...view.permissions,
          { requestId: update.requestId, toolCallId: update.toolCallId, title: update.title, detail: update.detail, options: update.options, ts },
        ],
      };
    }
    case "ls_permission_resolved": {
      const request = view.permissions.find((p) => p.requestId === update.requestId);
      if (!request) return view;
      const option = request.options.find((o) => o.optionId === update.optionId);
      const permissions = view.permissions.filter((p) => p.requestId !== update.requestId);
      const next: SessionView = {
        ...view,
        permissions,
        state: permissions.length > 0 ? "waiting" : view.turnActive ? "running" : view.state === "waiting" ? "idle" : view.state,
      };
      return upsert(next, {
        kind: "permission-result",
        id: `perm-${update.requestId}`,
        title: request.title,
        detail: request.detail,
        optionName: option?.name,
        allowed: option ? option.kind.startsWith("allow") : undefined,
        ts,
      });
    }
    case "ls_driver": {
      if (view.driver === update.driver) return view;
      const next = { ...view, driver: update.driver };
      // The first report is just the starting state; later ones are handoffs worth showing.
      return view.driver === undefined ? next : upsert(next, { kind: "driver", id: `driver-${key}`, driver: update.driver, ts });
    }
    case "ls_error":
      return upsert(settleStreaming(view, ts), { kind: "error", id: `error-${key}`, code: update.code, message: update.message, hint: update.hint, ts });
    case "ls_notice":
      return upsert(view, { kind: "notice", id: `notice-${key}`, level: update.level, title: update.title, detail: update.detail, ts });
    default:
      return view;
  }
}

/** Joins adjacent text blocks (user messages arrive one block per chunk). */
function mergeText(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (block.type === "text" && last?.type === "text") out[out.length - 1] = { type: "text", text: last.text + block.text };
    else out.push(block);
  }
  return out;
}

/** Applies one logged event; events at or below the view's seq are ignored (replays). */
export function applyEvent(view: SessionView, event: SessionEvent): SessionView {
  if (event.seq <= view.lastSeq) return view;
  const next = applyUpdate(view, event.update, event.ts, String(event.seq));
  return next === view ? { ...view, lastSeq: event.seq } : { ...next, lastSeq: event.seq };
}

export function applyEvents(view: SessionView, events: SessionEvent[]): SessionView {
  return events.reduce(applyEvent, view);
}

/** Shows a message the user just sent, before the host confirms it. */
export function addOptimisticMessage(view: SessionView, clientMessageId: string, blocks: ContentBlock[], ts = Date.now()): SessionView {
  return upsert(view, { kind: "user", id: `local-${clientMessageId}`, blocks, ts, pending: true });
}

export function markMessageFailed(view: SessionView, clientMessageId: string): SessionView {
  const item = get(view, `local-${clientMessageId}`, "user");
  return item && item.pending ? upsert(view, { ...item, pending: false, failed: true }) : view;
}

export function removeItem(view: SessionView, id: string): SessionView {
  const at = view.index[id];
  if (at === undefined) return view;
  const items = view.items.filter((_, i) => i !== at);
  const index: Record<string, number> = {};
  items.forEach((item, i) => {
    index[item.id] = i;
  });
  return { ...view, items, index };
}

/**
 * An update's content replaces the call's, except that a result without diffs
 * (Claude's "The file has been updated.") keeps the diffs the call carried:
 * the change itself is what the reader wants to see.
 */
function keepDiffs<T extends { type: string }>(previous: T[], next: T[]): T[] {
  if (next.some((entry) => entry.type === "diff")) return next;
  const diffs = previous.filter((entry) => entry.type === "diff");
  return diffs.length ? [...diffs, ...next] : next;
}
