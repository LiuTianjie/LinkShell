// localStorage persistence for the web client: current view (survives refresh),
// and per-session conversations + timelines (chat history survives refresh).
// localStorage is synchronous so no write-queue is needed (unlike mobile's
// AsyncStorage). Everything is versioned and defensively parsed.

import type { AgentConversation, AgentTimelineItem, SessionSummary } from "./types";

const VERSION = 1;
const VIEW_KEY = "linkshell_view";
const CONV_PREFIX = "linkshell_conv_";
const TIMELINE_PREFIX = "linkshell_timeline_";
const KNOWN_SESSIONS_KEY = "linkshell_known_sessions";

// Keep storage bounded (localStorage is ~5MB/origin). Cap items per timeline.
const MAX_TIMELINE_ITEMS = 200;

export type AppView = { name: "list" } | { name: "console"; sessionId: string };

interface Versioned<T> {
  version: number;
  data: T;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Versioned<T>>;
    if (parsed && parsed.version === VERSION && parsed.data !== undefined) {
      return parsed.data as T;
    }
    return null;
  } catch {
    return null;
  }
}

function write<T>(key: string, data: T): void {
  try {
    const wrapped: Versioned<T> = { version: VERSION, data };
    localStorage.setItem(key, JSON.stringify(wrapped));
  } catch {
    // Quota exceeded or unavailable — non-fatal, history just isn't cached.
  }
}

// ── Current view ────────────────────────────────────────────────────

export function loadView(): AppView {
  return read<AppView>(VIEW_KEY) ?? { name: "list" };
}
export function saveView(view: AppView): void {
  write(VIEW_KEY, view);
}

// ── Known sessions (so "back" always shows a clickable list) ────────
// A safety net independent of the live /sessions API: every session the user
// has listed or claimed is remembered here, so returning to the list never
// forces a re-pairing even if /sessions is momentarily empty.

export function loadKnownSessions(): SessionSummary[] {
  return read<SessionSummary[]>(KNOWN_SESSIONS_KEY) ?? [];
}

export function rememberSessions(incoming: SessionSummary[]): SessionSummary[] {
  if (incoming.length === 0) return loadKnownSessions();
  const liveIds = new Set(incoming.map((s) => s.id));
  const byId = new Map<string, SessionSummary>();
  // Cached sessions NOT present in the live results are stale — the gateway no
  // longer reports them, so the host is gone. Keep them in the list (so it's
  // never empty) but force them offline; never show a dead host as "在线".
  for (const s of loadKnownSessions()) {
    byId.set(s.id, liveIds.has(s.id) ? s : { ...s, hasHost: false });
  }
  // Live results are the source of truth — overwrite with real hasHost etc.
  for (const s of incoming) byId.set(s.id, { ...byId.get(s.id), ...s });
  const merged = [...byId.values()]
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
    .slice(0, 50);
  write(KNOWN_SESSIONS_KEY, merged);
  return merged;
}

/** Reconcile against a definitive empty live result: if /sessions returns []
 *  (we own no live sessions), every remembered session is offline. */
export function markAllOffline(): SessionSummary[] {
  const next = loadKnownSessions().map((s) => ({ ...s, hasHost: false }));
  write(KNOWN_SESSIONS_KEY, next);
  return next;
}

export function forgetSession(sessionId: string): SessionSummary[] {
  const next = loadKnownSessions().filter((s) => s.id !== sessionId);
  write(KNOWN_SESSIONS_KEY, next);
  return next;
}

// ── Conversations (per session) ─────────────────────────────────────

export function loadConversations(sessionId: string): AgentConversation[] {
  return read<AgentConversation[]>(CONV_PREFIX + sessionId) ?? [];
}
export function saveConversations(sessionId: string, conversations: AgentConversation[]): void {
  write(CONV_PREFIX + sessionId, conversations);
}

// ── Timelines (per session, keyed by conversationId) ────────────────

export function loadTimelines(sessionId: string): Record<string, AgentTimelineItem[]> {
  return read<Record<string, AgentTimelineItem[]>>(TIMELINE_PREFIX + sessionId) ?? {};
}
export function saveTimelines(
  sessionId: string,
  timelines: Map<string, AgentTimelineItem[]>,
): void {
  const obj: Record<string, AgentTimelineItem[]> = {};
  for (const [cid, items] of timelines) {
    // Cap and drop optimistic/local-only items from the persisted copy.
    const persistable = items
      .filter((i) => i.metadata?.optimistic !== true)
      .slice(-MAX_TIMELINE_ITEMS);
    obj[cid] = persistable;
  }
  write(TIMELINE_PREFIX + sessionId, obj);
}
