import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
  Question,
  QuestionAnswer,
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
import { agentInboxMessages, type AgentInboxMessage } from "./agent-messages.js";
import { userMessageView } from "./user-message.js";
import { reconnectOf } from "./errors.js";

// Turns a session's event log into what the UI renders. Pure and immutable:
// each event returns a new view, and only the items it touched are new objects,
// so a streamed token re-renders one row.

import type { AsyncQuestion } from "@linkshell/wire";
export { asyncQuestionReply, questionReplies, answeredQuestions, type AsyncQuestion, type QuestionReply } from "@linkshell/wire";

export type TimelineItem =
  | {
      kind: "user";
      id: string;
      blocks: ContentBlock[];
      /** Claude delivers teammate mail through user-role envelopes. */
      agentMessages?: AgentInboxMessage[];
      ts: number;
      /** Sent from this device and not yet confirmed by the host. */
      pending?: boolean;
      /** The host took it: it shows as said while the agent's own copy is on its way. */
      accepted?: boolean;
      failed?: boolean;
    }
  | {
      kind: "agent";
      id: string;
      text: string;
      /** Images and links the agent sent alongside its text. */
      attachments?: ContentBlock[];
      senderSessionId?: string;
      recipientSessionId?: string;
      /** Questions it asks without stopping (Codex Desktop): answered with `asyncQuestionReply`. */
      questions?: AsyncQuestion[];
      streaming: boolean;
      ts: number;
    }
  | { kind: "thought"; id: string; text: string; streaming: boolean; ts: number; endedTs?: number }
  | {
      kind: "tool";
      id: string;
      title: string;
      name?: string;
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
  | { kind: "plan"; id: string; entries: PlanEntry[]; title?: string; markdown?: string | null; path?: string | null; ts: number }
  | { kind: "notice"; id: string; level: "info" | "warning"; title: string; detail?: string; ts: number }
  | { kind: "error"; id: string; code: string; message: string; hint?: string; ts: number }
  | { kind: "turn-end"; id: string; stopReason: StopReason; ts: number }
  | { kind: "driver"; id: string; driver: SessionDriver; ts: number }
  | {
      kind: "permission-result";
      id: string;
      title: string;
      detail?: string;
      optionName?: string;
      allowed?: boolean;
      /** For a request that asked questions: each with what was answered (none: it was skipped). */
      answers?: { question: string; answer: string }[];
      /** The request was questions, not a permission. */
      asked?: boolean;
      ts: number;
    };

export interface PendingPermission {
  requestId: string;
  childSessionId?: string;
  toolCallId?: string;
  title: string;
  detail?: string;
  tool?: Extract<SessionUpdate, { sessionUpdate: "ls_permission" }>["tool"];
  url?: Extract<SessionUpdate, { sessionUpdate: "ls_permission" }>["url"];
  options: PermissionOption[];
  /** The agent is asking these rather than asking permission: answered with `answer`, or skipped with an option. */
  questions?: Question[];
  ts: number;
}

export interface SessionView {
  sessionId: string;
  lastSeq: number;
  /**
   * Events up to this seq aren't loaded: the session opens at its latest
   * turns, and earlier ones are added a page at a time. 0: from the beginning.
   */
  startSeq: number;
  items: TimelineItem[];
  /** id → index into items. */
  index: Record<string, number>;
  /**
   * The last item of each finished turn, by id: where a turn ended, which nothing on screen marks
   * when it simply finished. A message sent while the agent works doesn't end its turn.
   */
  turnBreaks?: string[];
  permissions: PendingPermission[];
  config: SessionConfigOption[];
  commands: { name: string; description: string; hint?: string }[];
  goal?: import("@linkshell/wire").SessionGoal | null;
  modeId?: string;
  usage?: Omit<Extract<SessionUpdate, { sessionUpdate: "usage_update" }>, "sessionUpdate">;
  state: SessionState;
  turnActive: boolean;
  /** When the running turn started, as its `ls_turn` said: the live row counts from it. */
  turnStartedAt?: number;
  driver?: SessionDriver;
  title?: string;
  /** The plan card the current turn updates (in place; see the `plan` update). */
  planId?: string;
}

export function emptyView(sessionId: string): SessionView {
  return {
    sessionId,
    lastSeq: 0,
    startSeq: 0,
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
    case "ls_message":
      return update.parentToolCallId;
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

/** Questions with what was answered, as text: the options' labels, then the user's own words. */
function answered(questions: Question[], answers: QuestionAnswer[]): { question: string; answer: string }[] {
  return questions.flatMap((question) => {
    const answer = answers.find((entry) => entry.id === question.id);
    if (!answer) return [];
    const picked = answer.values.filter(Boolean).map((value) => question.options?.find((option) => option.value === value)?.label ?? value);
    const said = [...(question.secret && picked.length > 0 ? ["••••••"] : picked), ...(answer.other ? [answer.other] : [])];
    return said.length > 0 ? [{ question: question.header ?? question.text, answer: said.join("，") }] : [];
  });
}

/** Routes a sub-agent's update into its spawning tool call's own timeline. */
function applyToChild(view: SessionView, parentId: string, update: SessionUpdate, ts: number, key: string): SessionView {
  if (!get(view, parentId, "tool")) {
    for (const item of view.items) {
      if (item.kind !== "tool" || !item.sub || !findTool(item.sub, parentId)) continue;
      return upsert(view, { ...item, sub: applyToChild(item.sub, parentId, update, ts, key) });
    }
  }
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

/** Workflow agents can themselves contain agents; ids are session-wide. */
/**
 * Where a plan is shown: at the end of its turn, as the Claude app and Codex keep it — its latest
 * state under everything the turn has done so far, moving down as the turn goes on and updated in
 * place — rather than where it was first written. A finished turn's plan stays at that turn's end,
 * above its "turn ended" line. The same array comes back when nothing moves.
 */
export function plansAtTurnEnd(items: TimelineItem[], turnBreaks?: readonly string[]): TimelineItem[] {
  if (!items.some((item) => item.kind === "plan")) return items;
  const ends = new Set(turnBreaks);
  // An agent that never says where its turns end: each message of the person's starts one.
  const byMessage = ends.size === 0;
  const out: TimelineItem[] = [];
  let held: TimelineItem[] = [];
  const flush = () => { out.push(...held); held = []; };
  for (const item of items) {
    if (item.kind === "plan") {
      held.push(item);
      if (ends.has(item.id)) flush();
      continue;
    }
    if (held.length && (item.kind === "turn-end" || (byMessage && item.kind === "user"))) flush();
    out.push(item);
    if (held.length && ends.has(item.id)) flush();
  }
  flush();
  return out.every((item, index) => item === items[index]) ? items : out;
}

export function findTool(view: SessionView, id: string): Extract<TimelineItem, { kind: "tool" }> | undefined {
  const own = get(view, id, "tool");
  if (own) return own;
  for (const item of view.items) {
    if (item.kind !== "tool" || !item.sub) continue;
    const found = findTool(item.sub, id);
    if (found) return found;
  }
  return undefined;
}

// ── reducer ──────────────────────────────────────────────────────────

export function applyUpdate(view: SessionView, update: SessionUpdate, ts: number, key: string): SessionView {
  const parentId = parentOf(update);
  if (parentId) return applyToChild(view, parentId, update, ts, key);
  switch (update.sessionUpdate) {
    case "ls_message": {
      const id = update.role === "thought" ? `thought:${update.messageId}` : update.messageId;
      const role = update.role === "session" ? "agent" : update.role;
      const existing = get(view, id, role);
      if (update.content === undefined && existing) {
        return role === "agent" ? upsert(view, { ...existing, senderSessionId: update.senderSessionId ?? (existing.kind === "agent" ? existing.senderSessionId : undefined), recipientSessionId: update.recipientSessionId ?? (existing.kind === "agent" ? existing.recipientSessionId : undefined) } as TimelineItem) : view;
      }
      const blocks = update.content ?? [];
      const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
      const at = existing?.ts ?? ts;
      if (role === "user") {
        const content = update.append && existing?.kind === "user" ? [...existing.blocks, ...blocks] : blocks;
        return upsertUser(view, existing, { kind: "user", id, blocks: mergeText(content), agentMessages: agentInboxMessages(content), ts: at });
      }
      if (role === "thought") return upsert(view, { kind: "thought", id, text: (update.append && existing?.kind === "thought" ? existing.text : "") + text, streaming: view.turnActive, ts: at });
      return upsert(view, { kind: "agent", id, text: (update.append && existing?.kind === "agent" ? existing.text : "") + text,
        attachments: [...(update.append && existing?.kind === "agent" ? existing.attachments ?? [] : []), ...blocks.filter((block) => block.type !== "text")],
        senderSessionId: update.senderSessionId ?? (existing?.kind === "agent" ? existing.senderSessionId : undefined),
        recipientSessionId: update.recipientSessionId ?? (existing?.kind === "agent" ? existing.recipientSessionId : undefined), streaming: view.turnActive, ts: at });
    }
    case "user_message_chunk": {
      const id = update.messageId ?? `user-${key}`;
      const existing = get(view, id, "user");
      // The host's copy confirms (and replaces) an optimistic one with the same id.
      const blocks = existing && !existing.pending ? [...existing.blocks, update.content] : [update.content];
      return upsertUser(view, existing, { kind: "user", id, blocks: mergeText(blocks), agentMessages: agentInboxMessages(blocks), ts: existing?.ts ?? ts });
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
      if (agent) return upsert(view, { ...agent, streaming: false, ...(update.questions?.length ? { questions: update.questions } : {}) });
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
        name: update.name ?? existing?.name,
        toolKind: update.kind,
        status: update.status,
        rawInput: update.rawInput ?? existing?.rawInput,
        rawOutput: update.rawOutput ?? existing?.rawOutput,
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
        name: update.name ?? base.name,
        toolKind: update.kind ?? base.toolKind,
        rawInput: update.rawInput === undefined ? base.rawInput : update.rawInput,
        locations: update.locations ?? base.locations,
        detail: update.detail ?? base.detail,
        status,
        content: update.content ? update.replaceContent ? update.content : keepDiffs(base.content, update.content) : base.content,
        output: update.replaceOutput ?? (update.appendOutput ? base.output + update.appendOutput : base.output),
        rawOutput: update.rawOutput === undefined ? base.rawOutput : update.rawOutput,
        endedTs: done ? (base.endedTs ?? ts) : update.status ? undefined : base.endedTs,
        sub: done && base.sub ? settleAll(base.sub, ts) : base.sub,
      });
    }
    case "plan": {
      // One card per plan, updated in place. Without an id that is one per turn; a plan the agent
      // names (one list it keeps working through, turn after turn) has one card, which an update
      // in a later turn takes down to that turn: its latest state is where the reader is.
      const id = update.planId ? `plan:${update.planId}` : view.planId ?? `plan-${key}`;
      if (update.removed) return removeItem(view, id);
      const earlier = get(view, id, "plan");
      const base = earlier && view.planId !== id ? moveOut(view, id) : view;
      const next = upsert(base, { kind: "plan", id, entries: update.entries, title: update.title, markdown: update.markdown, path: update.path, ts: earlier?.ts ?? ts });
      return { ...next, planId: id };
    }
    case "available_commands_update":
      return { ...view, commands: update.availableCommands };
    case "ls_goal":
      return { ...view, goal: update.goal };
    case "current_mode_update":
      return {
        ...view,
        modeId: update.currentModeId,
        config: view.config.map((option) => (option.category === "mode" ? { ...option, current: update.currentModeId } : option)),
      };
    case "ls_config":
      return { ...view, config: update.options, modeId: update.options.find((o) => o.category === "mode")?.current ?? view.modeId };
    case "session_info_update":
      return { ...view, title: update.title === null ? undefined : update.title ?? view.title };
    case "usage_update":
      return { ...view, usage: { ...view.usage, usedTokens: update.usedTokens ?? view.usage?.usedTokens, contextWindow: update.contextWindow ?? view.usage?.contextWindow,
        cost: update.cost === undefined ? view.usage?.cost : update.cost, tokens: update.tokens ?? view.usage?.tokens } };
    case "ls_turn":
      // A message sent while the agent works starts no new turn: the clock keeps the first start.
      // Nor does it start a plan card of its own: the running turn's card stays the one it updates.
      if (update.state === "started") return { ...view, turnActive: true, state: "running", planId: view.turnActive ? view.planId : undefined, turnStartedAt: view.turnActive ? view.turnStartedAt ?? ts : ts };
      {
        const settled = settleAll(view, ts);
        const ended: SessionView = {
          ...settled,
          turnActive: false,
          state: settled.permissions.some((permission) => permission.childSessionId) ? "waiting" : update.stopReason === "error" ? "error" : "idle",
          permissions: settled.permissions.filter((permission) => permission.childSessionId),
        };
        const last = ended.items.at(-1)?.id;
        const marked = last && ended.turnBreaks?.at(-1) !== last ? { ...ended, turnBreaks: [...(ended.turnBreaks ?? []), last] } : ended;
        // A normal end is implied; limits and refusals must remain visible.
        return update.stopReason && update.stopReason !== "end_turn"
          ? upsert(marked, { kind: "turn-end", id: `turn-end-${key}`, stopReason: update.stopReason, ts })
          : marked;
      }
    case "ls_status": {
      const turnActive = update.turnActive ?? (update.state === "running" || update.state === "waiting");
      const base = !turnActive && view.turnActive ? settleAll(view, ts) : view;
      return { ...base, state: update.state, turnActive };
    }
    case "ls_permission": {
      if (view.permissions.some((p) => p.requestId === update.requestId)) return view;
      return {
        ...settleStreaming(view, ts),
        state: "waiting",
        permissions: [
          ...view.permissions,
          {
            requestId: update.requestId,
            childSessionId: update.childSessionId,
            toolCallId: update.toolCallId,
            title: update.title,
            detail: update.detail,
            tool: update.tool,
            url: update.url,
            options: update.options,
            questions: update.questions,
            ts,
          },
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
        asked: request.questions ? true : undefined,
        answers: request.questions && update.answers ? answered(request.questions, update.answers) : undefined,
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
    case "ls_notice": {
      // An agent retrying its connection reports each attempt; the latest replaces the one before.
      const last = view.items.at(-1);
      const id = last?.kind === "notice" && reconnectOf(update.title) && reconnectOf(last.title) ? last.id : `notice-${key}`;
      return upsert(view, { kind: "notice", id, level: update.level, title: update.title, detail: update.detail, ts });
    }
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

/**
 * The host's backlog starts after `startSeq` instead of where the view left
 * off. A view that holds nothing yet just notes it. One that holds events
 * can't be continued and starts over, keeping unsent messages: either events
 * in between are missing (it was away too long), or the backlog starts before
 * what the view has — the host's log is behind the view (its state was reset),
 * and nothing it sends would get past what the view holds.
 */
export function startWindow(view: SessionView, startSeq: number): SessionView {
  if (view.lastSeq === 0) return { ...view, startSeq };
  if (view.lastSeq === startSeq) return view;
  const unsent = view.items.filter((item) => item.kind === "user" && (item.pending || item.failed));
  const index: Record<string, number> = {};
  unsent.forEach((item, i) => {
    index[item.id] = i;
  });
  return { ...emptyView(view.sessionId), startSeq, items: unsent, index };
}

/** Titles the reducer gives a tool call it only saw the end of. */
const STUB_TITLES = new Set(["Tool", "Sub-agent"]);

/**
 * A user message only the agent was meant to read (a reminder, a model switch) gets no item: it
 * would show as nothing, yet still split the run of steps around it.
 */
function upsertUser(view: SessionView, existing: TimelineItem | undefined, item: Extract<TimelineItem, { kind: "user" }>): SessionView {
  if (!existing && !item.agentMessages && userMessageView(item.blocks).hidden) return view;
  return upsert(view, item);
}

/** One item seen in two pages: `earlier` has how it began, `later` how it went on. */
function joinItem(earlier: TimelineItem, later: TimelineItem): TimelineItem {
  if (earlier.kind === "agent" && later.kind === "agent") {
    const attachments = [...(earlier.attachments ?? []), ...(later.attachments ?? [])];
    return { ...later, text: earlier.text + later.text, attachments: attachments.length ? attachments : undefined, ts: earlier.ts };
  }
  if (earlier.kind === "thought" && later.kind === "thought") return { ...later, text: earlier.text + later.text, ts: earlier.ts };
  if (earlier.kind === "user" && later.kind === "user") {
    const blocks = mergeText([...earlier.blocks, ...later.blocks]);
    return { ...later, blocks, agentMessages: agentInboxMessages(blocks), ts: earlier.ts };
  }
  if (earlier.kind === "tool" && later.kind === "tool") {
    return {
      ...later,
      title: STUB_TITLES.has(later.title) ? earlier.title : later.title,
      toolKind: earlier.toolKind,
      rawInput: later.rawInput ?? earlier.rawInput,
      rawOutput: later.rawOutput ?? earlier.rawOutput,
      locations: later.locations ?? earlier.locations,
      detail: later.detail ?? earlier.detail,
      content: later.content.length ? keepDiffs(earlier.content, later.content) : earlier.content,
      output: earlier.output + later.output,
      sub: earlier.sub && later.sub ? joinViews(earlier.sub, later.sub) : (later.sub ?? earlier.sub),
      ts: earlier.ts,
      endedTs: later.endedTs ?? earlier.endedTs,
    };
  }
  return later;
}

/** Puts an earlier stretch of a timeline in front of a later one. */
function joinViews(earlier: SessionView, later: SessionView): SessionView {
  const items: TimelineItem[] = [];
  const joined = new Set<string>();
  // A turn that ended with a plan the later page took down now ends with what came before it.
  const moved = new Map<string, string | undefined>();
  for (const item of earlier.items) {
    const at = later.index[item.id];
    if (at === undefined) items.push(item);
    // A plan updated in a later turn was taken down there: the later place is its place.
    else if (item.kind === "plan") moved.set(item.id, items.at(-1)?.id);
    else {
      items.push(joinItem(item, later.items[at]!));
      joined.add(item.id);
    }
  }
  for (const item of later.items) if (!joined.has(item.id)) items.push(item);
  const index: Record<string, number> = {};
  items.forEach((item, i) => {
    index[item.id] = i;
  });
  // Where the earlier page's turns ended, as well as the later page's.
  const before = (earlier.turnBreaks ?? []).flatMap((id) => (moved.has(id) ? (moved.get(id) ? [moved.get(id)!] : []) : [id]));
  const breaks = [...new Set([...before, ...(later.turnBreaks ?? [])])].filter((id) => index[id] !== undefined);
  return { ...later, items, index, ...(breaks.length ? { turnBreaks: breaks } : {}) };
}

/**
 * Adds a page of earlier history (`sessions.history`) in front of what the
 * view shows. An item that straddles the page boundary (a long turn was cut)
 * becomes one item again.
 */
export function prependEvents(view: SessionView, events: SessionEvent[], startSeq: number): SessionView {
  let earlier = emptyView(view.sessionId);
  for (const event of events) earlier = applyUpdate(earlier, event.update, event.ts, String(event.seq));
  // Whatever was still streaming where the page ends is continued by the later items, or was cut off.
  earlier = settleAll(earlier, events[events.length - 1]?.ts ?? 0);
  const joined = joinViews(earlier, view);
  // A turn still running that began in this page: its start is here.
  const turnStartedAt = view.turnStartedAt ?? (view.turnActive && earlier.turnActive ? earlier.turnStartedAt : undefined);
  return { ...joined, startSeq, ...(turnStartedAt !== undefined ? { turnStartedAt } : {}) };
}

/**
 * Shows a message the user just sent, before the host confirms it. `accepted`:
 * the host has it already, and only the agent's own copy is still to come.
 */
export function addOptimisticMessage(view: SessionView, clientMessageId: string, blocks: ContentBlock[], ts = Date.now(), accepted = false): SessionView {
  return upsert(view, { kind: "user", id: `local-${clientMessageId}`, blocks, ts, pending: true, ...(accepted ? { accepted: true } : {}) });
}

export function markMessageFailed(view: SessionView, clientMessageId: string): SessionView {
  const item = get(view, `local-${clientMessageId}`, "user");
  return item && item.pending ? upsert(view, { ...item, pending: false, failed: true }) : view;
}

export function markMessageAccepted(view: SessionView, clientMessageId: string): SessionView {
  const item = get(view, `local-${clientMessageId}`, "user");
  return item && item.pending && !item.accepted ? upsert(view, { ...item, accepted: true }) : view;
}

/**
 * Takes an item out of an earlier turn to put it in the running one. Where that turn ended stays
 * marked: if the item was the turn's last, the one before it is.
 */
function moveOut(view: SessionView, id: string): SessionView {
  const at = view.index[id];
  const removed = removeItem(view, id);
  if (at === undefined || !view.turnBreaks?.includes(id)) return removed;
  const before = view.items[at - 1]?.id;
  const turnBreaks = view.turnBreaks.flatMap((entry) => (entry !== id ? [entry] : before && !view.turnBreaks!.includes(before) ? [before] : []));
  return { ...removed, turnBreaks };
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
