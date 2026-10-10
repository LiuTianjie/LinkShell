import { createStore, type StoreApi } from "zustand/vanilla";
import {
  RpcError,
  asyncQuestionReply,
  type AsyncQuestion,
  type ContentBlock,
  type BackgroundTask,
  type MachineInfo,
  type MethodResult,
  type ProjectSummary,
  type QueuedMessage,
  type QuestionAnswer,
  type SessionEvent,
  type SessionSummary,
  type SessionNotice,
  type PendingPermissionSummary,
  type SubagentInfo,
  type GitInfo,
  type WorktreeEntry,
} from "@linkshell/wire";
import type { HostLink, LinkStatus } from "./host-link.js";
import { applyTaskEvent, mergeTaskList, type TaskRecords } from "./tasks.js";
import { applyWorkflowEvent, mergeWorkflowList, type WorkflowRecords } from "./workflows.js";
import {
  addOptimisticMessage,
  applyEvents,
  emptyView,
  findTool,
  markMessageFailed,
  prependEvents,
  removeItem,
  startWindow,
  type SessionView,
} from "./timeline.js";

export interface ClientState {
  status: LinkStatus;
  /** Why the link is down, in words for people. */
  statusDetail?: string;
  machine?: MachineInfo;
  sessions: Record<string, SessionSummary>;
  /** True once the first session list has arrived (distinguishes "loading" from "empty"). */
  sessionsLoaded: boolean;
  sessionsError?: string;
  notices: Record<string, (SessionNotice & { id: string })[]>;
  interactions: Record<string, PendingPermissionSummary[]>;
  projects: ProjectSummary[];
  views: Record<string, SessionView>;
  /** Sessions currently subscribed (on screen). */
  open: Record<string, true>;
  /** Sessions whose history backlog has fully arrived since they were opened. */
  ready: Record<string, true>;
  /** Sessions fetching a page of earlier history right now. */
  loadingEarlier: Record<string, true>;
  /** The sub-agents each session started, newest first, as last fetched (`loadSubagents`). */
  subagents: Record<string, SubagentInfo[]>;
  /** Complete workflow snapshots, including runs outside the loaded history window. */
  workflows: Record<string, WorkflowRecords>;
  tasks: Record<string, TaskRecords>;
  /**
   * Sub-agent conversations opened on their own (`openSubagent`), by
   * `subagentKey`: a view holding the call that started it, whose `sub` is the
   * conversation. They don't depend on what part of the session is loaded.
   */
  subagentViews: Record<string, SessionView>;
  /** Unsent or failed messages, by client message id. */
  outbox: Record<string, { sessionId: string; content: ContentBlock[] }>;
  /**
   * Messages sent while a turn runs, on their way to the session's queue:
   * shown at the end of it until the host has them.
   */
  queueing: Record<string, QueueEntry[]>;
}

/** A message in a session's queue, or (`pending`) one this device has sent there and the host hasn't confirmed. */
export interface QueueEntry extends QueuedMessage {
  pending?: boolean;
}

/** The session's queue as it is shown: what the host holds, then what is still on its way there. */
export function shownQueue(queue: QueuedMessage[] | undefined, queueing: QueueEntry[] | undefined): QueueEntry[] {
  const held = queue ?? [];
  if (!queueing?.length) return held;
  const known = new Set(held.map((entry) => entry.clientMessageId));
  return [...held, ...queueing.filter((entry) => !known.has(entry.clientMessageId))];
}

export interface ClientActions {
  dismissNotice(sessionId: string, id: string): void;
  connect(): void;
  disconnect(): void;
  refresh(): Promise<void>;
  openSession(sessionId: string): void;
  closeSession(sessionId: string): void;
  /**
   * Sends a message. While a turn is running it waits in the session's queue
   * (`summary.queue`) and goes out when the turn ends; `now` sends it at once
   * instead, the agent's own way (into the running turn where it can be).
   */
  send(sessionId: string, content: ContentBlock[], options?: { now?: boolean }): Promise<MethodResult<"sessions.prompt">["delivery"] | "failed">;
  retry(clientMessageId: string): Promise<void>;
  discard(clientMessageId: string): void;
  respond(sessionId: string, requestId: string, optionId: string): Promise<void>;
  /** Answers the questions of a pending request (one whose `questions` are set). */
  answer(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<void>;
  /** Answers an async question immediately, without putting it behind the active turn. */
  answerAsync(sessionId: string, question: AsyncQuestion, answer: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  takeover(sessionId: string): Promise<void>;
  /** Hands a handoff session back so the desktop can pick it up again. */
  release(sessionId: string): Promise<void>;
  setConfig(sessionId: string, optionId: string, value: string): Promise<void>;
  /** `worktree`: start in a new git worktree of the project instead of its working directory. */
  createSession(input: { agent: string; cwd: string; prompt?: ContentBlock[]; worktree?: boolean }): Promise<SessionSummary>;
  /**
   * A new session that starts with this one's conversation (through the turn
   * of `itemId` when given), in the same directory or in a new worktree. The
   * new session is opened; the original is untouched.
   */
  forkSession(sessionId: string, options?: { itemId?: string; worktree?: boolean }): Promise<SessionSummary>;
  /** What git says about a directory on the computer (undefined: not a repository). */
  gitInfo(path: string): Promise<GitInfo | undefined>;
  /** The worktrees LinkShell made for sessions. */
  listWorktrees(): Promise<WorktreeEntry[]>;
  removeWorktree(path: string, force?: boolean): Promise<void>;
  /** Drops a message still waiting in the host's queue. */
  unqueue(sessionId: string, clientMessageId: string): Promise<boolean>;
  /** Takes a queued message back to edit it: removes it from the queue and returns what it said. */
  takeQueued(sessionId: string, clientMessageId: string): Promise<ContentBlock[] | undefined>;
  /** Sends a queued message (the first, or the one named) now, stopping the running turn if it has to. */
  sendQueuedNow(sessionId: string, clientMessageId?: string): Promise<void>;
  /** Puts the queue in this order. */
  reorderQueue(sessionId: string, clientMessageIds: string[]): Promise<void>;
  archive(sessionId: string, archived: boolean): Promise<void>;
  rename(sessionId: string, title: string): Promise<void>;
  /** `worktree`: what to do with a worktree only this session used ("remove" even if work in it is lost, "keep"; default: removed when nothing would be lost). */
  deleteSession(sessionId: string, worktree?: "keep" | "remove"): Promise<void>;
  /** Adds archived sessions to `sessions` (the regular list leaves them out). */
  loadArchived(): Promise<void>;
  /**
   * Adds the page of history before what the session shows (its view's
   * `startSeq` says whether there is any). Resolves false when it couldn't.
   */
  loadEarlier(sessionId: string): Promise<boolean>;
  /** Fetches the session's sub-agents (also kept in `subagents`). */
  loadTasks(sessionId: string): Promise<BackgroundTask[]>;
  loadTaskOutput(sessionId: string, taskId: string, before?: number): Promise<MethodResult<"sessions.taskOutput">>;
  stopTask(sessionId: string, taskId: string): Promise<void>;
  loadSubagents(sessionId: string): Promise<SubagentInfo[]>;
  /** Loads a sub-agent's conversation into `subagentViews` and keeps it live while the session is open. */
  openSubagent(sessionId: string, toolCallId: string): Promise<boolean>;
  closeSubagent(sessionId: string, toolCallId: string): void;
  /** The picture behind an image block that came as a `linkshell-event:` uri, as a data: URI. */
  loadImage(sessionId: string, uri: string): Promise<string>;
}

export type ClientStore = StoreApi<ClientState & ClientActions>;

/** Where a sub-agent's conversation is kept in `subagentViews`. */
export function subagentKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\n${toolCallId}`;
}

/** An independently opened agent is the root of its own view, even inside a workflow. */
function eventForSubagent(view: SessionView, call: string, event: SessionEvent): SessionEvent | undefined {
  const update = event.update as { parentToolCallId?: string; toolCallId?: string };
  if (update.toolCallId === call) return { ...event, update: { ...event.update, parentToolCallId: undefined } as SessionEvent["update"] };
  if (update.parentToolCallId && (update.parentToolCallId === call || findTool(view, update.parentToolCallId))) return event;
  return undefined;
}

export interface ClientStoreOptions {
  /** Generates client message ids; defaults to crypto.randomUUID when available. */
  newId?: () => string;
  /** The link was created with `lazyImages`: ask for history the same way. */
  lazyImages?: boolean;
  /** How many characters of pictures to keep in memory (default 24 MB). */
  imageCacheChars?: number;
}

function defaultId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Describes an error the way the UI should show it. */
export function describeError(error: unknown): string {
  if (error instanceof RpcError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createClientStore(link: HostLink, options: ClientStoreOptions = {}): ClientStore {
  const newId = options.newId ?? defaultId;
  let pending: SessionEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flushEvents = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    store.setState((state) => {
      let views = state.views;
      let subagentViews = state.subagentViews;
      let workflows = state.workflows;
      let tasks = state.tasks;
      const bySession = new Map<string, SessionEvent[]>();
      for (const event of batch) {
        const records = tasks[event.sessionId] ?? {};
        const nextTasks = applyTaskEvent(records, event);
        if (nextTasks !== records) tasks = { ...tasks, [event.sessionId]: nextTasks };
        const runs = workflows[event.sessionId] ?? {};
        const nextRuns = applyWorkflowEvent(runs, event);
        if (nextRuns !== runs) workflows = { ...workflows, [event.sessionId]: nextRuns };
        const list = bySession.get(event.sessionId) ?? [];
        list.push(event);
        bySession.set(event.sessionId, list);
        // A sub-agent opened on its own follows along too.
        const prefix = `${event.sessionId}\n`;
        // The parent's history may still be loading, so filter this buffer only
        // after we know which nested calls belong to that view.
        for (const [key, buffer] of loadingSubagents) if (key.startsWith(prefix)) buffer.push(event);
        for (const [key, current] of Object.entries(subagentViews)) {
          if (!key.startsWith(prefix)) continue;
          const own = eventForSubagent(current, key.slice(prefix.length), event);
          if (!own) continue;
          const next = applyEvents(current, [own]);
          if (next !== current) subagentViews = { ...subagentViews, [key]: next };
        }
      }
      for (const [sessionId, events] of bySession) {
        const current = views[sessionId];
        if (!current) continue;
        const next = applyEvents(current, events);
        if (next !== current) views = { ...views, [sessionId]: next };
      }
      return views === state.views && subagentViews === state.subagentViews && workflows === state.workflows && tasks === state.tasks ? state : { views, subagentViews, workflows, tasks };
    });
  };

  /**
   * A session's subscription was answered: the host sends the whole backlog
   * first, so apply it, then the session can show.
   */
  const subscribed = (summary: SessionSummary) => {
    const sessionId = summary.id;
    if (!store.getState().open[sessionId]) return;
    flushEvents();
    store.setState((state) => ({ sessions: { ...state.sessions, [sessionId]: summary }, ready: { ...state.ready, [sessionId]: true } }));
    void store.getState().loadTasks(sessionId).catch(() => {});
  };

  // Sub-agent conversations being fetched: live events that arrive meanwhile are applied after.
  const loadingSubagents = new Map<string, SessionEvent[]>();

  // What this device's queued messages said, to edit one (the host's queue only lists text).
  const queuedContent = new Map<string, ContentBlock[]>();
  const rememberQueued = (clientMessageId: string, content: ContentBlock[]) => {
    queuedContent.set(clientMessageId, content);
    if (queuedContent.size > 50) queuedContent.delete(queuedContent.keys().next().value as string);
  };

  // Pictures already fetched, most recently used last.
  const images = new Map<string, Promise<string>>();
  const imageSizes = new Map<string, number>();
  let imageChars = 0;
  const forgetImage = (key: string) => {
    images.delete(key);
    imageChars -= imageSizes.get(key) ?? 0;
    imageSizes.delete(key);
  };

  /** A deleted session: gone from every list and view. */
  function forget(sessionId: string): void {
    store.setState((state) => {
      const without = <T,>(record: Record<string, T>) => {
        if (!(sessionId in record)) return record;
        const next = { ...record };
        delete next[sessionId];
        return next;
      };
      return {
        sessions: without(state.sessions),
        notices: without(state.notices),
        views: without(state.views),
        open: without(state.open),
        ready: without(state.ready),
        loadingEarlier: without(state.loadingEarlier),
        queueing: without(state.queueing),
        subagents: without(state.subagents),
        workflows: without(state.workflows),
        tasks: without(state.tasks),
        subagentViews: Object.fromEntries(Object.entries(state.subagentViews).filter(([key]) => !key.startsWith(`${sessionId}\n`))),
      };
    });
  }

  const resolvedInteractions = new Set<string>();
  const store = createStore<ClientState & ClientActions>()((set, get) => {
    const updateView = (sessionId: string, fn: (view: SessionView) => SessionView) =>
      set((state) => {
        const current = state.views[sessionId] ?? emptyView(sessionId);
        const next = fn(current);
        return next === current ? state : { views: { ...state.views, [sessionId]: next } };
      });

    const deliver = async (clientMessageId: string, now = false) => {
      const pending = get().outbox[clientMessageId];
      if (!pending) return "failed" as const;
      try {
        const result = await link.call("sessions.prompt", {
          sessionId: pending.sessionId,
          clientMessageId,
          content: pending.content,
          whenBusy: now ? undefined : "queue",
        });
        if (result.delivery === "queued") rememberQueued(clientMessageId, pending.content);
        set((state) => {
          const outbox = { ...state.outbox };
          delete outbox[clientMessageId];
          return { outbox };
        });
        return result.delivery;
      } catch {
        updateView(pending.sessionId, (view) => markMessageFailed(view, clientMessageId));
        return "failed" as const;
      }
    };

    return {
      status: link.status,
      sessions: {},
      notices: {},
      interactions: {},
      sessionsLoaded: false,
      projects: [],
      views: {},
      open: {},
      ready: {},
      loadingEarlier: {},
      subagents: {},
      workflows: {},
      tasks: {},
      subagentViews: {},
      outbox: {},
      queueing: {},

      connect() {
        link.start();
      },

      disconnect() {
        link.stop();
      },
      dismissNotice(sessionId, id) { set((state) => ({ notices: { ...state.notices, [sessionId]: (state.notices[sessionId] ?? []).filter((notice) => notice.id !== id) } })); },

      async refresh() {
        void link.call("agents.pending", {}).then(({ interactions }) => {
          set((state) => {
            const next = { ...state.interactions };
            for (const { agent, request } of interactions) {
              if (resolvedInteractions.has(`${agent}\n${request.requestId}`) || next[agent]?.some((pending) => pending.requestId === request.requestId)) continue;
              next[agent] = [...(next[agent] ?? []), request];
            }
            return { interactions: next };
          });
        }).catch(() => {});
        try {
          const [machine, list, projects] = await Promise.all([
            link.call("machine.info", {}),
            link.call("sessions.list", { limit: 200 }),
            link.call("projects.list", { limit: 100 }),
          ]);
          set((state) => {
            const sessions = { ...state.sessions };
            // A complete list: anything live it doesn't mention was deleted meanwhile.
            if (list.sessions.length < 200) {
              const listed = new Set(list.sessions.map((session) => session.id));
              for (const [id, session] of Object.entries(sessions)) if (!session.archived && !listed.has(id)) delete sessions[id];
            }
            for (const session of list.sessions) sessions[session.id] = session;
            return { machine, sessions, projects: projects.projects, sessionsLoaded: true, sessionsError: undefined };
          });
        } catch (error) {
          set({ sessionsError: describeError(error) });
        }
      },

      openSession(sessionId) {
        if (get().open[sessionId]) return;
        set((state) => ({
          open: { ...state.open, [sessionId]: true },
          views: state.views[sessionId] ? state.views : { ...state.views, [sessionId]: emptyView(sessionId) },
        }));
        void link.subscribe(sessionId, () => get().views[sessionId]?.lastSeq ?? 0).then((summary) => {
          if (summary) subscribed(summary);
        });
      },

      closeSession(sessionId) {
        if (!get().open[sessionId]) return;
        link.unsubscribe(sessionId);
        set((state) => {
          const open = { ...state.open };
          delete open[sessionId];
          const ready = { ...state.ready };
          delete ready[sessionId];
          return { open, ready };
        });
      },

      async send(sessionId, content, sendOptions) {
        const clientMessageId = newId();
        const session = get().sessions[sessionId];
        // A turn is running (or messages already wait): this one is headed for the
        // queue, so that is where it shows from the start, not as a sent message first.
        const queues = !sendOptions?.now && (session?.state === "running" || session?.state === "waiting" || (session?.queue?.length ?? 0) > 0);
        set((state) => ({ outbox: { ...state.outbox, [clientMessageId]: { sessionId, content } } }));
        if (queues) {
          const entry: QueueEntry = {
            clientMessageId,
            text: content.map((block) => (block.type === "text" ? block.text : "")).join("").trim(),
            images: content.filter((block) => block.type === "image").length,
            pending: true,
          };
          set((state) => ({ queueing: { ...state.queueing, [sessionId]: [...(state.queueing[sessionId] ?? []), entry] } }));
        } else {
          updateView(sessionId, (view) => addOptimisticMessage(view, clientMessageId, content));
        }
        const delivery = await deliver(clientMessageId, sendOptions?.now);
        if (!queues) {
          // Waiting in the host's queue after all: it shows there (summary.queue)
          // until its turn starts, when the agent's echo puts it in the timeline.
          if (delivery === "queued") updateView(sessionId, (view) => removeItem(view, `local-${clientMessageId}`));
          return delivery;
        }
        // (The host announces its queue before it answers, so the message is in `summary.queue` by now.)
        set((state) => {
          const rest = (state.queueing[sessionId] ?? []).filter((entry) => entry.clientMessageId !== clientMessageId);
          const queueing = { ...state.queueing };
          if (rest.length > 0) queueing[sessionId] = rest;
          else delete queueing[sessionId];
          return { queueing };
        });
        // The turn ended meanwhile and it went straight out, or it didn't go at all: a message like any other.
        if (delivery === "started" || delivery === "steered" || delivery === "failed") {
          updateView(sessionId, (view) => (view.index[`local-${clientMessageId}`] === undefined ? addOptimisticMessage(view, clientMessageId, content) : view));
          if (delivery === "failed") updateView(sessionId, (view) => markMessageFailed(view, clientMessageId));
        }
        return delivery;
      },

      async retry(clientMessageId) {
        const pending = get().outbox[clientMessageId];
        if (!pending) return;
        updateView(pending.sessionId, (view) => addOptimisticMessage(view, clientMessageId, pending.content));
        await deliver(clientMessageId);
      },

      discard(clientMessageId) {
        const pending = get().outbox[clientMessageId];
        if (!pending) return;
        updateView(pending.sessionId, (view) => removeItem(view, `local-${clientMessageId}`));
        set((state) => {
          const outbox = { ...state.outbox };
          delete outbox[clientMessageId];
          return { outbox };
        });
      },

      async respond(sessionId, requestId, optionId) {
        await link.call("sessions.permission", { sessionId, requestId, optionId });
      },

      async answer(sessionId, requestId, answers) {
        await link.call("sessions.answer", { sessionId, requestId, answers });
      },

      async answerAsync(sessionId, question, answer) {
        const clientMessageId = newId();
        const result = await link.call("sessions.prompt", {
          sessionId, clientMessageId,
          content: [{ type: "text", text: asyncQuestionReply([{ question, answer }]) }],
        }, 30_000);
        // Older hosts enqueue desktop-owned turns. Use their existing immediate-send path.
        if (result.delivery === "queued") {
          try {
            await link.call("sessions.sendQueued", { sessionId, clientMessageId }, 30_000);
          } catch (error) {
            await link.call("sessions.unqueue", { sessionId, clientMessageId }).catch(() => {});
            throw error;
          }
        }
      },

      async cancel(sessionId) {
        await link.call("sessions.cancel", { sessionId });
      },

      async takeover(sessionId) {
        await link.call("sessions.takeover", { sessionId }, 60_000);
      },

      async release(sessionId) {
        await link.call("sessions.release", { sessionId });
      },

      async setConfig(sessionId, optionId, value) {
        await link.call("sessions.setConfig", { sessionId, optionId, value });
      },

      async unqueue(sessionId, clientMessageId) {
        const { removed } = await link.call("sessions.unqueue", { sessionId, clientMessageId });
        if (removed) queuedContent.delete(clientMessageId);
        return removed;
      },

      async takeQueued(sessionId, clientMessageId) {
        const entry = get().sessions[sessionId]?.queue?.find((queued) => queued.clientMessageId === clientMessageId);
        const { removed } = await link.call("sessions.unqueue", { sessionId, clientMessageId });
        if (!removed) return undefined;
        // Queued from this device: everything it carried. From another one: its text.
        const content = queuedContent.get(clientMessageId) ?? (entry?.text ? [{ type: "text" as const, text: entry.text }] : []);
        queuedContent.delete(clientMessageId);
        return content;
      },

      async sendQueuedNow(sessionId, clientMessageId) {
        const queue = get().sessions[sessionId]?.queue ?? [];
        const entry = clientMessageId ? queue.find((queued) => queued.clientMessageId === clientMessageId) : queue[0];
        const content = entry && (queuedContent.get(entry.clientMessageId) ?? (entry.text ? [{ type: "text" as const, text: entry.text }] : []));
        await link.call("sessions.sendQueued", { sessionId, clientMessageId }, 30_000);
        if (entry && content?.length) {
          // Out of the queue and with the agent: it shows as said at once. The agent's own
          // copy, which replaces it, can be a while (it is recorded when the agent takes it up).
          const id = entry.clientMessageId;
          const stillQueued = get().sessions[sessionId]?.queue?.some((queued) => queued.clientMessageId === id);
          if (!stillQueued) {
            updateView(sessionId, (view) => (view.index[`local-${id}`] === undefined ? addOptimisticMessage(view, id, content, Date.now(), true) : view));
          }
        }
      },

      async reorderQueue(sessionId, clientMessageIds) {
        await link.call("sessions.reorderQueue", { sessionId, clientMessageIds });
      },

      async archive(sessionId, archived) {
        const { session } = await link.call("sessions.archive", { sessionId, archived });
        set((state) => ({ sessions: { ...state.sessions, [session.id]: session } }));
      },

      async rename(sessionId, title) {
        const { session } = await link.call("sessions.rename", { sessionId, title });
        set((state) => ({ sessions: { ...state.sessions, [session.id]: session } }));
      },

      async deleteSession(sessionId, worktree) {
        await link.call("sessions.delete", { sessionId, worktree }, 60_000);
        forget(sessionId);
      },

      async forkSession(sessionId, forkOptions) {
        const { session } = await link.call("sessions.fork", { sessionId, itemId: forkOptions?.itemId, worktree: forkOptions?.worktree }, 90_000);
        set((state) => ({ sessions: { ...state.sessions, [session.id]: session } }));
        get().openSession(session.id);
        return session;
      },

      async gitInfo(path) {
        return (await link.call("git.info", { path })).git;
      },

      async listWorktrees() {
        return (await link.call("worktrees.list", {})).worktrees;
      },

      async removeWorktree(path, force) {
        await link.call("worktrees.remove", { path, force }, 60_000);
      },

      async loadArchived() {
        const list = await link.call("sessions.list", { limit: 200, includeArchived: true });
        set((state) => {
          const sessions = { ...state.sessions };
          for (const session of list.sessions) sessions[session.id] = session;
          return { sessions };
        });
      },

      async loadEarlier(sessionId) {
        const from = get().views[sessionId]?.startSeq ?? 0;
        if (from === 0 || get().loadingEarlier[sessionId]) return false;
        set((state) => ({ loadingEarlier: { ...state.loadingEarlier, [sessionId]: true } }));
        try {
          const page = await link.call("sessions.history", { sessionId, beforeSeq: from + 1, lazyImages: options.lazyImages });
          flushEvents();
          // The view may have started over meanwhile (a reconnect after a long absence).
          if (get().views[sessionId]?.startSeq !== from) return false;
          updateView(sessionId, (view) => prependEvents(view, page.events, page.startSeq));
          return true;
        } catch {
          return false;
        } finally {
          set((state) => {
            const loadingEarlier = { ...state.loadingEarlier };
            delete loadingEarlier[sessionId];
            return { loadingEarlier };
          });
        }
      },

      async loadTasks(sessionId) {
        const { tasks } = await link.call("sessions.tasks", { sessionId });
        flushEvents();
        set((state) => ({ tasks: { ...state.tasks, [sessionId]: mergeTaskList(state.tasks[sessionId] ?? {}, tasks) } }));
        return tasks;
      },
      loadTaskOutput: (sessionId, taskId, before) => link.call("sessions.taskOutput", { sessionId, taskId, before }),
      async stopTask(sessionId, taskId) {
        await link.call("sessions.stopTask", { sessionId, taskId });
        await get().loadTasks(sessionId);
      },
      async loadSubagents(sessionId) {
        const { subagents } = await link.call("sessions.subagents", { sessionId });
        flushEvents();
        set((state) => ({
          subagents: { ...state.subagents, [sessionId]: subagents },
          workflows: { ...state.workflows, [sessionId]: mergeWorkflowList(state.workflows[sessionId] ?? {}, subagents) },
        }));
        return subagents;
      },

      async openSubagent(sessionId, toolCallId) {
        const key = subagentKey(sessionId, toolCallId);
        if (loadingSubagents.has(key)) return false;
        const meanwhile: SessionEvent[] = [];
        loadingSubagents.set(key, meanwhile);
        try {
          const { events } = await link.call("sessions.subagent", { sessionId, toolCallId, lazyImages: options.lazyImages }, 30_000);
          flushEvents();
          let view = emptyView(sessionId);
          for (const event of [...events, ...meanwhile]) {
            const own = eventForSubagent(view, toolCallId, event);
            if (own) view = applyEvents(view, [own]);
          }
          set((state) => ({ subagentViews: { ...state.subagentViews, [key]: view } }));
          return true;
        } catch {
          return false;
        } finally {
          loadingSubagents.delete(key);
        }
      },

      closeSubagent(sessionId, toolCallId) {
        const key = subagentKey(sessionId, toolCallId);
        if (!(key in get().subagentViews)) return;
        set((state) => {
          const subagentViews = { ...state.subagentViews };
          delete subagentViews[key];
          return { subagentViews };
        });
      },

      loadImage(sessionId, uri) {
        const key = `${sessionId} ${uri}`;
        const cached = images.get(key);
        if (cached) {
          images.delete(key);
          images.set(key, cached);
          return cached;
        }
        const loading = link.call("sessions.image", { sessionId, uri }).then(
          (image) => {
            const dataUri = `data:${image.mimeType};base64,${image.data}`;
            imageSizes.set(key, dataUri.length);
            imageChars += dataUri.length;
            const limit = options.imageCacheChars ?? 24 * 1024 * 1024;
            for (const oldest of images.keys()) {
              if (imageChars <= limit || oldest === key) break;
              forgetImage(oldest);
            }
            return dataUri;
          },
          (error: unknown) => {
            forgetImage(key);
            throw error;
          },
        );
        images.set(key, loading);
        return loading;
      },

      async createSession(input) {
        const { session } = await link.call("sessions.create", { agent: input.agent, cwd: input.cwd, worktree: input.worktree }, 60_000);
        set((state) => ({ sessions: { ...state.sessions, [session.id]: session } }));
        get().openSession(session.id);
        if (input.prompt && input.prompt.length > 0) await get().send(session.id, input.prompt);
        return session;
      },
    };
  });

  link.onStatus((status, detail) => {
    if (status !== "online") resolvedInteractions.clear();
    store.setState({ status, statusDetail: detail || undefined, ...(status !== "online" ? { notices: {}, interactions: {} } : {}) });
  });
  link.on("agent.interaction", ({ agent, request }) => {
    const key = `${agent}\n${request.requestId}`;
    if ("resolved" in request) resolvedInteractions.add(key); else resolvedInteractions.delete(key);
    store.setState((state) => ({ interactions: { ...state.interactions, [agent]: "resolved" in request
      ? (state.interactions[agent] ?? []).filter((pending) => pending.requestId !== request.requestId)
      : [...(state.interactions[agent] ?? []).filter((pending) => pending.requestId !== request.requestId), request] } }));
  });
  link.on("agent.changed", ({ agent }) => store.setState((state) => state.machine ? { machine: { ...state.machine, agents: state.machine.agents.map((entry) => entry.id === agent.id ? agent : entry) } } : {}));
  link.on("session.notice", ({ sessionId, notice }) => {
    store.setState((state) => ({ notices: { ...state.notices, [sessionId]: [...(state.notices[sessionId] ?? []).slice(-4), { ...notice, id: newId() }] } }));
  });
  link.on("session.removed", ({ sessionId }) => forget(sessionId));
  // What the host sends next for this session starts after `startSeq`.
  link.on("session.window", ({ sessionId, startSeq }) => {
    flushEvents();
    store.setState((state) => {
      const view = state.views[sessionId];
      if (!view) return state;
      const next = startWindow(view, startSeq);
      return next === view ? state : { views: { ...state.views, [sessionId]: next } };
    });
  });
  link.onSummary((summary) => store.setState((state) => ({ sessions: { ...state.sessions, [summary.id]: summary } })));
  // Events arrive one per socket message; a history backlog is hundreds of
  // them. Apply them in batches, at most one store update per frame.
  link.onEvent((event) => {
    pending.push(event);
    flushTimer ??= setTimeout(flushEvents, 16);
  });
  // Opened while the link was down, or back after a break: the backlog is in, the session can show.
  link.onRestored((summary) => subscribed(summary));
  // Refresh the list after every (re)connect; retry unsent messages too.
  link.onOnline(() => {
    void store.getState().refresh();
  });

  return store;
}
