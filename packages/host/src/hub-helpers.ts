import {
  readUserText,
  type AsyncQuestion,
  type BackgroundTask,
  type ContentBlock,
  type QueuedMessage,
  type SessionActivity,
  type SessionEvent,
  type SessionNotice,
  type SessionSummary,
  type SessionUpdate,
  type SubagentInfo,
} from "@linkshell/wire";
import { type HostStore, type SessionPatch } from "./store.js";
import { outputRange } from "./task-output.js";

export interface Subscriber {
  event(event: SessionEvent): void;
  /** Optional batched delivery used for backlog replay and opt-in `session.events` subscribers. */
  events?(events: SessionEvent[]): void;
  /** Called when the subscriber is removed so pending coalescing timers can be cleared. */
  close?(): void;
  notice?(notice: SessionNotice): void;
  /** The backlog that follows starts after `startSeq`, not where the subscriber left off. */
  window?(startSeq: number): void;
  /** Underlying transport write buffer bytes, used to pace large backlog replays. */
  bufferedAmount?: () => number;
}

const MAX_COALESCED_CHARS = 64 * 1024;

function isAppendOnlyToolOutput(update: SessionUpdate): update is Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> & { appendOutput: string } {
  if (update.sessionUpdate !== "tool_call_update" || typeof update.appendOutput !== "string") return false;
  return (
    update.title === undefined &&
    update.kind === undefined &&
    update.status === undefined &&
    update.content === undefined &&
    update.locations === undefined &&
    update.rawInput === undefined &&
    update.rawOutput === undefined &&
    update.detail === undefined
  );
}

/**
 * Coalesces contiguous pure-text chunks and append-only tool output deltas within a wire batch.
 * Preserves the first chunk's `ts` and advances `seq` to the latest merged event so client
 * `lastSeq` cursors and reconnect catch-up stay exact.
 */
export function coalesceWireEvents(events: readonly SessionEvent[]): SessionEvent[] {
  if (events.length <= 1) return events.slice();
  const out: SessionEvent[] = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    if (prev && prev.sessionId === event.sessionId) {
      const a = prev.update;
      const b = event.update;
      if (
        a.sessionUpdate === "agent_message_chunk" &&
        b.sessionUpdate === "agent_message_chunk" &&
        a.content.type === "text" &&
        b.content.type === "text" &&
        !b.replace &&
        a.messageId === b.messageId &&
        a.parentToolCallId === b.parentToolCallId &&
        a.content.text.length + b.content.text.length <= MAX_COALESCED_CHARS
      ) {
        out[out.length - 1] = {
          sessionId: prev.sessionId,
          seq: event.seq,
          ts: prev.ts,
          update: {
            ...a,
            content: { type: "text", text: a.content.text + b.content.text },
          },
        };
        continue;
      }
      if (
        a.sessionUpdate === "agent_thought_chunk" &&
        b.sessionUpdate === "agent_thought_chunk" &&
        a.content.type === "text" &&
        b.content.type === "text" &&
        !b.replace &&
        a.messageId === b.messageId &&
        a.parentToolCallId === b.parentToolCallId &&
        a.content.text.length + b.content.text.length <= MAX_COALESCED_CHARS
      ) {
        out[out.length - 1] = {
          sessionId: prev.sessionId,
          seq: event.seq,
          ts: prev.ts,
          update: {
            ...a,
            content: { type: "text", text: a.content.text + b.content.text },
          },
        };
        continue;
      }
      if (
        isAppendOnlyToolOutput(a) &&
        isAppendOnlyToolOutput(b) &&
        a.toolCallId === b.toolCallId &&
        a.parentToolCallId === b.parentToolCallId &&
        a.appendOutput.length + b.appendOutput.length <= MAX_COALESCED_CHARS
      ) {
        out[out.length - 1] = {
          sessionId: prev.sessionId,
          seq: event.seq,
          ts: prev.ts,
          update: {
            ...a,
            appendOutput: a.appendOutput + b.appendOutput,
          },
        };
        continue;
      }
    }
    out.push(event);
  }
  return out;
}

/** Updates that should never wait in a 16 ms coalescing buffer (turns, approvals, errors, prompts). */
export function isImmediateWireEvent(update: SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case "ls_turn":
    case "ls_permission":
    case "ls_permission_resolved":
    case "ls_status":
    case "ls_error":
    case "ls_notice":
    case "user_message_chunk":
    case "ls_message":
    case "ls_message_done":
    case "ls_async_questions":
    case "ls_driver":
    case "ls_goal":
    case "tool_call":
      return true;
    default:
      return false;
  }
}

/**
 * Whether an update is something happening in the session. Names, settings
 * and usage figures arrive when a session is merely opened or renamed, and
 * must not move it to the top of the list.
 */
export function isActivity(update: SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case "session_info_update":
    case "ls_config":
    case "ls_goal":
    case "available_commands_update":
    case "usage_update":
    // What state a session is in and who drives it are said again whenever it
    // is opened; a turn starting or ending is what counts.
    case "ls_async_questions":
    case "ls_status":
    case "ls_driver":
    // A task's record is said again whenever the session is opened; its end is followed by the agent's turn about it.
    case "ls_task":
      return false;
    default:
      return true;
  }
}

export interface SubagentState {
  callDone: boolean;
  turnActive?: boolean;
  /** When the sub-agent last did anything. */
  lastChildTs?: number;
}

/**
 * Whether a sub-agent is working. Its call says so while it is open; an agent
 * that outlives its call (it reports turns of its own) counts while it keeps
 * doing things — a turn left open by an agent that was killed doesn't run forever.
 */
export function subagentRunning(state: SubagentState, now = Date.now()): boolean {
  if (!state.callDone) return state.turnActive ?? true;
  return state.turnActive === true && now - (state.lastChildTs ?? 0) < 15 * 60_000;
}

/** A short name for a worktree, from what the session is asked to do. */
export function promptLabel(prompt: ContentBlock[] | undefined): string {
  return prompt ? textOf(prompt).slice(0, 40) || "session" : "session";
}

export function worktreeLossMessage(state: { dirty: boolean; ahead: number }): string {
  const parts = [state.dirty ? "未提交的改动" : "", state.ahead > 0 ? `${state.ahead} 个新提交` : ""].filter(Boolean);
  return `这个 worktree 里有${parts.join("和")}，删除会丢失`;
}

/** Driver-state key: when a session was renamed, and when it was last active before that. */
export const RENAMED = "renamed";

/** Driver-state key: the conversation a forked session's agent is still to be told, with its first message. */
export const CARRY = "carry";

/** Driver-state key: the session a session was forked from (made here, or as its agent recorded it). */
export const FORKED_FROM = "forkedFrom";

/**
 * Driver-state keys, for agents with an app LinkShell only reads (`appArchive`):
 * LinkShell's own archive choice and when it was made, and the app's state as
 * last seen and since when.
 */
export const LOCAL_ARCHIVE = "archive-local";
export const APP_ARCHIVE = "archive-app";

/**
 * Archived here or in the app, unless it was unarchived here after the app
 * archived it (`local.at` 0: chosen before times were kept, so it never outranks the app).
 */
export function mergedArchive(local: { archived: boolean; at: number }, app: { archived: boolean; since: number } | undefined): boolean {
  if (local.archived) return true;
  return !!app?.archived && !(local.at > app.since);
}

/** A returning client catches up from where it was, unless it missed more than this. */
export const CATCH_UP = { events: 800, bytes: 4 * 1024 * 1024 };

/** State a client needs from before its window: the latest of each applies. */
export const STANDING: SessionUpdate["sessionUpdate"][] = [
  "ls_goal",
  "ls_config",
  "available_commands_update",
  "current_mode_update",
  "usage_update",
  "session_info_update",
  "ls_driver",
];

export type PermissionUpdate = Extract<SessionUpdate, { sessionUpdate: "ls_permission" }>;

export interface LiveSession {
  attached: boolean;
  /** True whenever `driver.attach()` succeeded, even for archived sessions where `attached` stays false. */
  driverAttached?: boolean;
  attaching?: Promise<void>;
  /** Being detached because nobody had it open (see `detachWhenIdle`); attaching waits for it. */
  detaching?: Promise<void>;
  /** Live updates that arrive while native history is being imported. */
  buffer?: { update: SessionUpdate; itemId?: string; ts?: number }[];
  subscribers: Set<Subscriber>;
  /** Streaming agent text per message, for the list preview. */
  messageText: Map<string, string>;
  permissions: Map<string, PermissionUpdate>;
  turnActive: boolean;
  /** Incremented whenever an `ls_turn` event commits for the root session. */
  turnSeq?: number;
  /** Incremented whenever an `ls_notice` event commits for the root session. */
  noticeSeq?: number;
  /** What the running turn is doing, for list rows (never persisted). */
  activity?: SessionActivity;
  /** Messages the driver holds until the turn ends (never persisted). */
  queue?: QueuedMessage[];
  /** Messages a client asked to hold while a turn runs: sent one per turn end, in this order. */
  held: { clientMessageId: string; content: ContentBlock[] }[];
  sendingHeld?: boolean;
  /** Keeps a permission-change continuation ahead of queued and concurrently sent messages. */
  settingsChange?: Promise<void>;
  /** Stop invalidates setting changes queued before it, as well as the current continuation. */
  stopGeneration?: number;
  /** Sub-agents the session started, and whether each is working; read from the log when first needed. */
  subagents?: Map<string, SubagentState>;
  tasks?: Map<string, BackgroundTask>;
  /** True while native history is imported: no live activity, one summary at the end. */
  importing?: boolean;
  importChanged?: boolean;
  /** Streaming chunks can be coalesced once the last subscriber leaves after a completed turn. */
  pendingCompaction?: boolean;
  asyncQuestions?: AsyncQuestion[];
}

/** How long a session nobody has open stays attached to a driver that pays to follow it. */
export const IDLE_DETACH_MS = 10 * 60_000;
/** Grace window after the last subscriber leaves before post-turn chunk compaction runs. */
export const DEFERRED_COMPACT_MS = 10_000;
/** How long a completed `sessions.create(requestId)` result is kept for reconnect retries. */
export const CREATE_DEDUP_TTL_MS = 5 * 60_000;
export const CREATE_DEDUP_LIMIT = 500;

export const PREVIEW_LENGTH = 160;
export const TITLE_LENGTH = 60;

export function compact(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function sameActivity(a?: SessionActivity, b?: SessionActivity): boolean {
  return a?.kind === b?.kind && a?.title === b?.title && a?.toolKind === b?.toolKind;
}

export function textOf(content: ContentBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join(" ")
    .trim();
}

/** Updates tracked sub-agent map on an incoming update; returns true if running state changed. */
export function trackSubagentUpdate(known: Map<string, SubagentState> | undefined, update: SessionUpdate): boolean {
  if (!known) return false;
  if (update.sessionUpdate === "tool_call" && update.detail?.type === "subagent" && (update.detail.action ?? "spawn") === "spawn") {
    if (known.has(update.toolCallId)) return false;
    known.set(update.toolCallId, { callDone: update.status === "completed" || update.status === "failed" });
    return true;
  }
  if (update.sessionUpdate === "tool_call_update") {
    const state = known.get(update.toolCallId);
    if (!state || update.status === undefined) return false;
    const done = update.status === "completed" || update.status === "failed";
    if (state.callDone === done) return false;
    // A corrected launch or a teammate's next turn can reopen the same call.
    state.callDone = done;
    return true;
  }
  const parent = (update as { parentToolCallId?: string }).parentToolCallId;
  const state = parent ? known.get(parent) : undefined;
  if (!state) return false;
  const was = subagentRunning(state);
  state.lastChildTs = Date.now();
  if (update.sessionUpdate === "ls_turn") state.turnActive = update.state === "started";
  return subagentRunning(state) !== was;
}

/** Collects a stored background task's output slice when the driver itself doesn't serve live output. */
export function collectTaskOutput(
  store: HostStore,
  sessionId: string,
  task: BackgroundTask,
  before?: number,
  limit = 64 * 1024,
) {
  let text = "";
  for (const event of task.toolCallId ? store.toolEvents(sessionId, task.toolCallId) : []) {
    const update = event.update;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") continue;
    if (update.sessionUpdate === "tool_call_update" && update.replaceOutput !== undefined) text = update.replaceOutput;
    else if (update.sessionUpdate === "tool_call_update" && update.appendOutput) text += update.appendOutput;
    const whole = update.content?.flatMap((block) => block.type === "content" && block.content.type === "text" ? [block.content.text] : []).join("\n");
    if (whole) text = whole;
    const aggregate = update.sessionUpdate === "tool_call_update" ? (update.rawOutput as { aggregatedOutput?: unknown } | undefined)?.aggregatedOutput : undefined;
    if (typeof aggregate === "string") text = aggregate;
  }
  return outputRange(Buffer.from(text), before, limit);
}

/** Builds the newest-first subagent list from stored call and child events. */
export function buildSubagentsList(store: HostStore, sessionId: string): SubagentInfo[] {
  const agents = new Map<string, SubagentInfo>();
  for (const event of store.subagentCalls(sessionId)) {
    const call = event.update as Extract<SessionUpdate, { sessionUpdate: "tool_call" }>;
    // (A call still open when the session was opened again is logged again.)
    if (agents.has(call.toolCallId)) continue;
    const detailEvent = store.toolDetail(sessionId, call.toolCallId);
    const latest = detailEvent?.update as Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> | undefined;
    const detail = latest?.detail?.type === "subagent" ? latest.detail : call.detail?.type === "subagent" ? call.detail : undefined;
    const state = store.toolState(sessionId, call.toolCallId);
    const callDone = state.status === "completed" || state.status === "failed";
    const workflow = detail?.workflow && !detail.workflow.state && state.status === "failed"
      ? { ...detail.workflow, state: "failed" as const, endedAt: state.ts }
      : detail?.workflow;
    const running = workflow?.state ? workflow.state === "running" || workflow.state === "paused" || workflow.agents?.some((agent) => agent.state === "running" || agent.state === "paused") === true
      : detail?.state ? detail.state === "running" || detail.state === "paused" || detail.state === "pending"
      : subagentRunning({ callDone, turnActive: state.turnActive, lastChildTs: state.lastChildTs });
    agents.set(call.toolCallId, {
      toolCallId: call.toolCallId,
      parentToolCallId: call.parentToolCallId,
      task: detail?.task ?? call.title,
      agentType: detail?.agentType,
      name: detail?.name,
      nativeSessionId: detail?.nativeSessionId,
      canCancel: detail?.canCancel,
      running,
      failed: (workflow?.state ? workflow.state === "failed" : detail?.state ? detail.state === "failed" : state.status === "failed") || undefined,
      startedAt: workflow?.startedAt ?? event.ts,
      endedAt: running ? undefined : workflow?.endedAt ?? (callDone ? state.ts : state.lastChildTs),
      state: detail?.state,
      workflow,
      lastSeq: Math.max(detailEvent?.seq ?? event.seq, state.seq ?? 0),
    });
  }
  return [...agents.values()].reverse();
}

/** Collects standing session events before `seq` (settings, active turn, open permissions, running sub-agents). */
export function computeStandingBefore(
  store: HostStore,
  sessionId: string,
  seq: number,
  live: LiveSession,
  subagents: Map<string, SubagentState>,
): SessionEvent[] {
  if (seq < 1) return [];
  const events = STANDING.flatMap((kind) => store.latestOfKind(sessionId, kind, seq));
  const [turn] = store.latestOfKind(sessionId, "ls_turn", seq);
  const [status] = store.latestOfKind(sessionId, "ls_status", seq);
  const statusEndedTurn =
    status &&
    turn &&
    status.seq > turn.seq &&
    status.update.sessionUpdate === "ls_status" &&
    (status.update.turnActive === false || (status.update.state !== "running" && status.update.state !== "waiting"));
  if (turn?.update.sessionUpdate === "ls_turn" && turn.update.state === "started" && !statusEndedTurn) events.push(turn);
  if (live.permissions.size > 0) {
    for (const event of store.latestOfKind(sessionId, "ls_permission", seq, 50)) {
      if (event.update.sessionUpdate === "ls_permission" && live.permissions.has(event.update.requestId)) events.push(event);
    }
  }
  // Include running sub-agent calls and their ancestors so nested updates always find their parent card.
  const sent = new Set<string>();
  const withAncestors = (toolCallId: string) => {
    for (let id: string | undefined = toolCallId; id && !sent.has(id); ) {
      sent.add(id);
      const call: SessionEvent | undefined = store.toolEvents(sessionId, id)[0];
      if (!call || call.seq > seq) break;
      events.push(call);
      const latest = store.toolDetail(sessionId, id);
      if (latest && latest.seq !== call.seq && latest.seq <= seq) events.push(latest);
      id = (call.update as { parentToolCallId?: string }).parentToolCallId;
    }
  };
  for (const [toolCallId, state] of subagents) {
    if (subagentRunning(state)) withAncestors(toolCallId);
  }
  return events.sort((a, b) => a.seq - b.seq);
}

/** Merges live session indicators (tasks, subagents, queue, activity, permission) onto a summary. */
export function applyLiveSummaryDecorations(
  summary: SessionSummary,
  live: LiveSession,
  tasks: Map<string, BackgroundTask>,
  subagents: Map<string, SubagentState> | undefined,
): SessionSummary {
  const activity = live.turnActive ? live.activity : undefined;
  const first = live.permissions.values().next().value as PermissionUpdate | undefined;
  if (!activity && !first && !live.queue && live.held.length === 0 && !subagents?.size && !tasks.size) return summary;
  const decorated: SessionSummary = { ...summary };
  if (tasks.size) decorated.tasks = { total: tasks.size, running: [...tasks.values()].filter((task) => task.state === "running").length };
  if (subagents?.size) {
    let running = 0;
    for (const state of subagents.values()) if (subagentRunning(state)) running += 1;
    decorated.subagents = { total: subagents.size, running };
  }
  if (live.queue || live.held.length > 0) {
    decorated.queue = [
      ...(live.queue ?? []),
      ...live.held.map((entry) => ({
        clientMessageId: entry.clientMessageId,
        text: textOf(entry.content),
        images: entry.content.filter((block) => block.type === "image").length,
      })),
    ];
  }
  if (activity) decorated.activity = activity;
  if (first) {
    decorated.permission = {
      requestId: first.requestId,
      childSessionId: first.childSessionId,
      toolCallId: first.toolCallId,
      title: first.title,
      detail: first.detail,
      tool: first.tool,
      url: first.url,
      options: first.options,
      questions: first.questions,
    };
  }
  return decorated;
}

/** Computes a SessionPatch and activity-changed flag for a single summary update event. */
export function computeSummaryPatch(
  before: SessionSummary,
  live: LiveSession,
  update: SessionUpdate,
  hooks: {
    onPermissionTouch: (requestId: string) => void;
    onGoalUpdate: (active: boolean) => void;
  },
): { patch: SessionPatch; activityChanged: boolean } {
  const patch: SessionPatch = {};
  let activityChanged = false;
  const setActivity = (next: SessionActivity | undefined) => {
    if (live.importing || sameActivity(live.activity, next)) return;
    live.activity = next;
    activityChanged = true;
  };
  switch (update.sessionUpdate) {
    case "ls_message": {
      if (update.parentToolCallId || !update.content) break;
      const text = update.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      // A title is the person's words, not the context their client or Claude wrapped around them.
      if (update.role === "user" && !before.title && readUserText(text).text.trim()) patch.title = compact(readUserText(text).text, TITLE_LENGTH);
      if (update.role === "agent" && text.trim()) patch.preview = compact(text, PREVIEW_LENGTH);
      if (live.turnActive && update.role === "agent") setActivity({ kind: "responding" });
      break;
    }
    case "user_message_chunk": {
      const text = update.content.type === "text" ? readUserText(update.content.text).text : "";
      if (text && !before.title) patch.title = compact(text, TITLE_LENGTH);
      if (text && !before.preview) patch.preview = compact(text, PREVIEW_LENGTH);
      break;
    }
    case "agent_message_chunk":
      if (update.content.type === "text") {
        live.messageText.set(
          update.messageId,
          (update.replace ? "" : (live.messageText.get(update.messageId) ?? "")) + update.content.text,
        );
      }
      if (live.turnActive) setActivity({ kind: "responding" });
      break;
    case "agent_thought_chunk":
      if (live.turnActive) setActivity({ kind: "thinking" });
      break;
    case "tool_call":
      if (live.turnActive) setActivity({ kind: "tool", title: compact(update.title, TITLE_LENGTH), toolKind: update.kind });
      break;
    case "ls_message_done": {
      const text = live.messageText.get(update.messageId);
      live.messageText.delete(update.messageId);
      if (update.role === "agent" && text?.trim()) patch.preview = compact(text, PREVIEW_LENGTH);
      break;
    }
    case "ls_turn":
      // A sub-agent's turn is its own; the session's is the one without a parent.
      if (update.parentToolCallId) break;
      live.turnActive = update.state === "started";
      setActivity(live.turnActive ? { kind: "thinking" } : undefined);
      // Leftover permissions are cleared right after a turn ends (see commit).
      patch.state = live.turnActive ? "running" : [...live.permissions.values()].some((permission) => permission.childSessionId) ? "waiting" : update.stopReason === "error" ? "error" : "idle";
      break;
    case "ls_status":
      patch.state = update.state;
      if (!live.importing) {
        live.turnActive = update.turnActive ?? (update.state === "running" || update.state === "waiting");
        if (!live.turnActive) setActivity(undefined);
      }
      break;
    case "ls_permission":
      hooks.onPermissionTouch(update.requestId);
      live.permissions.set(update.requestId, update);
      patch.pendingPermissions = live.permissions.size;
      patch.state = "waiting";
      break;
    case "ls_permission_resolved":
      hooks.onPermissionTouch(update.requestId);
      live.permissions.delete(update.requestId);
      patch.pendingPermissions = live.permissions.size;
      if (live.permissions.size === 0 && before.state === "waiting") patch.state = live.turnActive ? "running" : "idle";
      break;
    case "session_info_update":
      if (update.title !== undefined) patch.title = update.title === null ? null : compact(update.title, TITLE_LENGTH);
      if (update.updatedAt !== undefined) {
        const updatedAt = update.updatedAt === null ? before.createdAt : Date.parse(update.updatedAt);
        if (Number.isFinite(updatedAt)) patch.updatedAt = updatedAt;
      }
      if (update.model) patch.model = update.model;
      break;
    case "ls_driver":
      patch.driver = update.driver;
      break;
    case "ls_goal":
      hooks.onGoalUpdate(update.goal?.status === "active");
      break;
    default:
      break;
  }
  return { patch, activityChanged };
}
