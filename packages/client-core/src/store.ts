import { createStore, type StoreApi } from "zustand/vanilla";
import {
  RpcError,
  type ContentBlock,
  type MachineInfo,
  type MethodResult,
  type ProjectSummary,
  type SessionEvent,
  type SessionSummary,
} from "@linkshell/wire";
import type { HostLink, LinkStatus } from "./host-link.js";
import { addOptimisticMessage, applyEvents, emptyView, markMessageFailed, removeItem, type SessionView } from "./timeline.js";

export interface ClientState {
  status: LinkStatus;
  /** Why the link is down, in words for people. */
  statusDetail?: string;
  machine?: MachineInfo;
  sessions: Record<string, SessionSummary>;
  /** True once the first session list has arrived (distinguishes "loading" from "empty"). */
  sessionsLoaded: boolean;
  sessionsError?: string;
  projects: ProjectSummary[];
  views: Record<string, SessionView>;
  /** Sessions currently subscribed (on screen). */
  open: Record<string, true>;
  /** Sessions whose history backlog has fully arrived since they were opened. */
  ready: Record<string, true>;
  /** Unsent or failed messages, by client message id. */
  outbox: Record<string, { sessionId: string; content: ContentBlock[] }>;
}

export interface ClientActions {
  connect(): void;
  disconnect(): void;
  refresh(): Promise<void>;
  openSession(sessionId: string): void;
  closeSession(sessionId: string): void;
  send(sessionId: string, content: ContentBlock[]): Promise<MethodResult<"sessions.prompt">["delivery"] | "failed">;
  retry(clientMessageId: string): Promise<void>;
  discard(clientMessageId: string): void;
  respond(sessionId: string, requestId: string, optionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  takeover(sessionId: string): Promise<void>;
  /** Hands a handoff session back so the desktop can pick it up again. */
  release(sessionId: string): Promise<void>;
  setConfig(sessionId: string, optionId: string, value: string): Promise<void>;
  createSession(input: { agent: string; cwd: string; prompt?: ContentBlock[] }): Promise<SessionSummary>;
  /** Drops a message still waiting in the host's queue. */
  unqueue(sessionId: string, clientMessageId: string): Promise<boolean>;
  archive(sessionId: string, archived: boolean): Promise<void>;
  rename(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** Adds archived sessions to `sessions` (the regular list leaves them out). */
  loadArchived(): Promise<void>;
}

export type ClientStore = StoreApi<ClientState & ClientActions>;

export interface ClientStoreOptions {
  /** Generates client message ids; defaults to crypto.randomUUID when available. */
  newId?: () => string;
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
      const bySession = new Map<string, SessionEvent[]>();
      for (const event of batch) {
        const list = bySession.get(event.sessionId) ?? [];
        list.push(event);
        bySession.set(event.sessionId, list);
      }
      for (const [sessionId, events] of bySession) {
        const current = views[sessionId];
        if (!current) continue;
        const next = applyEvents(current, events);
        if (next !== current) views = { ...views, [sessionId]: next };
      }
      return views === state.views ? state : { views };
    });
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
      return { sessions: without(state.sessions), views: without(state.views), open: without(state.open), ready: without(state.ready) };
    });
  }

  const store = createStore<ClientState & ClientActions>()((set, get) => {
    const updateView = (sessionId: string, fn: (view: SessionView) => SessionView) =>
      set((state) => {
        const current = state.views[sessionId] ?? emptyView(sessionId);
        const next = fn(current);
        return next === current ? state : { views: { ...state.views, [sessionId]: next } };
      });

    const deliver = async (clientMessageId: string) => {
      const pending = get().outbox[clientMessageId];
      if (!pending) return "failed" as const;
      try {
        const result = await link.call("sessions.prompt", {
          sessionId: pending.sessionId,
          clientMessageId,
          content: pending.content,
        });
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
      sessionsLoaded: false,
      projects: [],
      views: {},
      open: {},
      ready: {},
      outbox: {},

      connect() {
        link.start();
      },

      disconnect() {
        link.stop();
      },

      async refresh() {
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
          // The host sends the whole backlog before it answers: apply it, then mark ready.
          flushEvents();
          set((state) => ({
            sessions: summary ? { ...state.sessions, [summary.id]: summary } : state.sessions,
            ready: summary ? { ...state.ready, [sessionId]: true } : state.ready,
          }));
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

      async send(sessionId, content) {
        const clientMessageId = newId();
        set((state) => ({ outbox: { ...state.outbox, [clientMessageId]: { sessionId, content } } }));
        updateView(sessionId, (view) => addOptimisticMessage(view, clientMessageId, content));
        const delivery = await deliver(clientMessageId);
        // Waiting in the host's queue: it shows there (summary.queue) until its
        // turn starts, when the agent's echo puts it in the timeline.
        if (delivery === "queued") updateView(sessionId, (view) => removeItem(view, `local-${clientMessageId}`));
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
        return removed;
      },

      async archive(sessionId, archived) {
        const { session } = await link.call("sessions.archive", { sessionId, archived });
        set((state) => ({ sessions: { ...state.sessions, [session.id]: session } }));
      },

      async rename(sessionId, title) {
        const { session } = await link.call("sessions.rename", { sessionId, title });
        set((state) => ({ sessions: { ...state.sessions, [session.id]: session } }));
      },

      async deleteSession(sessionId) {
        await link.call("sessions.delete", { sessionId });
        forget(sessionId);
      },

      async loadArchived() {
        const list = await link.call("sessions.list", { limit: 200, includeArchived: true });
        set((state) => {
          const sessions = { ...state.sessions };
          for (const session of list.sessions) sessions[session.id] = session;
          return { sessions };
        });
      },

      async createSession(input) {
        const { session } = await link.call("sessions.create", { agent: input.agent, cwd: input.cwd }, 60_000);
        set((state) => ({ sessions: { ...state.sessions, [session.id]: session } }));
        get().openSession(session.id);
        if (input.prompt && input.prompt.length > 0) await get().send(session.id, input.prompt);
        return session;
      },
    };
  });

  link.onStatus((status, detail) => store.setState({ status, statusDetail: detail || undefined }));
  link.on("session.removed", ({ sessionId }) => forget(sessionId));
  link.onSummary((summary) => store.setState((state) => ({ sessions: { ...state.sessions, [summary.id]: summary } })));
  // Events arrive one per socket message; a history backlog is hundreds of
  // them. Apply them in batches, at most one store update per frame.
  link.onEvent((event) => {
    pending.push(event);
    flushTimer ??= setTimeout(flushEvents, 16);
  });
  // Refresh the list after every (re)connect; retry unsent messages too.
  link.onOnline(() => {
    void store.getState().refresh();
  });

  return store;
}
