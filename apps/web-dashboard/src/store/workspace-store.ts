// WorkspaceStore — the single source of truth for one connected session's agent
// state. Wraps a BridgeClient (transport), folds incoming agent.v2 events through
// the pure agent-reducer, and exposes an immutable snapshot for useSyncExternalStore.
// React components never touch the BridgeClient directly.

import { parseTypedPayload } from "@linkshell/protocol";
import type { Envelope, ProtocolMessageType } from "@linkshell/protocol";
import { BridgeClient } from "../lib/bridge-client";
import type { BridgeEvent } from "../lib/bridge-client";
import {
  applyEvent,
  mergeTimeline,
  mergeConversations,
  groupByConversation,
  normalizeItems,
  previewFromItem,
} from "../lib/agent-reducer";
import type {
  AgentConversation,
  AgentTimelineItem,
  AgentContentBlock,
  AgentStatus,
  AgentCapabilitiesPayload,
  AgentProvider,
  AgentReasoningEffort,
  AgentPermissionMode,
  AgentCollaborationMode,
  ConnectionStatus,
  GatewayConfig,
  BrowseResult,
  FileReadResult,
  AgentUsageReport,
} from "../lib/types";
import {
  loadConversations,
  saveConversations,
  loadTimelines,
  saveTimelines,
} from "../lib/storage";

export interface HistoryState {
  loading: boolean;
  hasMore: boolean;
  cursor?: string;
  // True while re-syncing an already-rendered (cached) timeline with the host —
  // the UI shows a slim inline indicator instead of the full loading spinner.
  syncing?: boolean;
}

export interface Notice {
  id: string;
  kind: string;
  title: string;
  detail?: string;
}

export interface WorkspaceSnapshot {
  status: ConnectionStatus;
  isController: boolean;
  externalAgentStatus: AgentStatus | null;
  externalAgentTitle: string | null;
  externalAgentProvider: string | null;
  externalAgentConversationId: string | null;
  conversations: AgentConversation[];
  timelines: Map<string, AgentTimelineItem[]>;
  capabilities: AgentCapabilitiesPayload | null;
  activeConversationId: string | null;
  // sticky errors (auth/subscription/protocol) never auto-clear; UI should
  // render them as a persistent banner until dismissError() is called.
  lastError: { code: string; message: string; sticky?: boolean } | null;
  // Per-conversation older-history pagination state (for scroll-up loading).
  history: Map<string, HistoryState>;
  // Transient toast notices (model/effort/permission changes, info, warnings).
  notices: Notice[];
  // Latest on-demand usage report (null until requested + received).
  usage: AgentUsageReport | null;
}

function genId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

// Errors the user must act on (re-login, renew subscription, upgrade client)
// are pinned until manually dismissed; everything else auto-clears after 6s.
// Codes come from the gateway (auth_required / invalid_token / unauthorized /
// subscription_expired) and any future AUTH_* / SUBSCRIPTION_* / protocol or
// version mismatch variants.
function isStickyErrorCode(code: string): boolean {
  return /auth|unauthorized|token|subscription|version|protocol/i.test(code);
}

function agentStatusFromTerminalPhase(phase: string): AgentStatus | null {
  switch (phase) {
    case "thinking":
    case "tool_use":
    case "outputting":
      return "running";
    case "waiting":
      return "waiting_permission";
    case "idle":
      return "idle";
    case "error":
      return "error";
    default:
      return null;
  }
}

export interface SendPromptInput {
  conversationId: string;
  text: string;
  images?: { data: string; mimeType: string }[];
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  permissionMode?: AgentPermissionMode;
  collaborationMode?: AgentCollaborationMode;
}

export class WorkspaceStore {
  private bridge: BridgeClient;
  private sessionId: string;
  private unsub: () => void;
  private listeners = new Set<() => void>();
  private snapshot: WorkspaceSnapshot;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  // requestId → resolver, for file browse/read round-trips.
  private pendingBrowse = new Map<string, (r: BrowseResult) => void>();
  private pendingRead = new Map<string, (r: FileReadResult) => void>();
  // Conversations we've sent an open for but not yet received opened back, so we
  // don't re-trigger the host's disk load on every re-selection.
  private openInFlight = new Set<string>();
  // Conversations the host has confirmed opened THIS session. A conversation
  // hydrated from the localStorage cache renders instantly, but until it's in
  // this set we still send conversation.open on selection so the timeline
  // re-syncs with the on-disk transcript (mergeTimeline dedupes by id).
  private openedThisSession = new Set<string>();
  // Queued-item ids currently being auto-flushed, to fire once per item.
  private autoFlushing = new Set<string>();
  private reqCounter = 0;
  // Outbox for NON-idempotent sends (prompts, permission/input responses,
  // cancel) that failed because the socket wasn't OPEN. Flushed on reconnect;
  // entries older than 60s are dropped with a notice instead of firing a
  // stale action against a moved-on conversation. Idempotent requests
  // (snapshot/capabilities/list) are never buffered — reconnect re-issues them.
  private outbox: { type: ProtocolMessageType; payload: unknown; queuedAt: number }[] = [];
  // Per-conversation debounce timers for snapshot recovery after an
  // agent.v2.event patch targeted an item we've never seen.
  private snapshotRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Mutable working state; snapshot is rebuilt from it on change.
  private status: ConnectionStatus = "idle";
  private isController = false;
  private externalAgentStatus: AgentStatus | null = null;
  private externalAgentTitle: string | null = null;
  private externalAgentProvider: string | null = null;
  private externalAgentConversationId: string | null = null;
  private conversations: AgentConversation[] = [];
  private timelines = new Map<string, AgentTimelineItem[]>();
  private capabilities: AgentCapabilitiesPayload | null = null;
  private activeConversationId: string | null = null;
  private lastError: { code: string; message: string; sticky?: boolean } | null = null;
  // Timer that auto-clears a transient error banner after a few seconds.
  private errorClearTimer: ReturnType<typeof setTimeout> | undefined;
  private history = new Map<string, HistoryState>();
  private notices: Notice[] = [];
  private usage: AgentUsageReport | null = null;
  // Enabled-provider signature; re-request snapshot when it changes (providers
  // come online after connect, so the first snapshot was empty).
  private lastProviderSig = "";

  constructor(config: GatewayConfig, sessionId: string, getJwt?: () => Promise<string | null> | string | null) {
    this.sessionId = sessionId;
    this.bridge = new BridgeClient({ config, sessionId, getJwt });
    // Hydrate cached conversations + timelines so chat history survives refresh
    // and shows instantly before the server snapshot arrives.
    this.conversations = loadConversations(sessionId);
    const cachedTimelines = loadTimelines(sessionId);
    this.timelines = new Map(Object.entries(cachedTimelines));
    this.snapshot = this.buildSnapshot();
    this.unsub = this.bridge.onEvent((e) => this.handleBridgeEvent(e));
  }

  // ── React store contract ──────────────────────────────────────────
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): WorkspaceSnapshot => this.snapshot;

  private buildSnapshot(): WorkspaceSnapshot {
    return {
      status: this.status,
      isController: this.isController,
      externalAgentStatus: this.externalAgentStatus,
      externalAgentTitle: this.externalAgentTitle,
      externalAgentProvider: this.externalAgentProvider,
      externalAgentConversationId: this.externalAgentConversationId,
      conversations: this.conversations,
      timelines: this.timelines,
      capabilities: this.capabilities,
      activeConversationId: this.activeConversationId,
      lastError: this.lastError,
      history: this.history,
      notices: this.notices,
      usage: this.usage,
    };
  }

  private notify(): void {
    this.snapshot = this.buildSnapshot();
    for (const l of this.listeners) l();
    this.schedulePersist();
  }

  // Throttle localStorage writes so a fast token stream doesn't thrash it.
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      saveConversations(this.sessionId, this.conversations);
      saveTimelines(this.sessionId, this.timelines);
    }, 800);
  }

  private flushPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    saveConversations(this.sessionId, this.conversations);
    saveTimelines(this.sessionId, this.timelines);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────
  connect(): void {
    this.bridge.connect();
  }

  destroy(): void {
    this.flushPersist();
    if (this.errorClearTimer) clearTimeout(this.errorClearTimer);
    for (const t of this.snapshotRecoveryTimers.values()) clearTimeout(t);
    this.snapshotRecoveryTimers.clear();
    this.unsub();
    this.bridge.disconnect();
    this.listeners.clear();
  }

  get client(): BridgeClient {
    return this.bridge;
  }

  // ── Bridge event handling ───────────────────────────────────────────
  private handleBridgeEvent(e: BridgeEvent): void {
    switch (e.type) {
      case "status":
        this.status = e.status;
        if (e.status === "connected") {
          // A successful (re)connect clears any stale TRANSIENT error banner —
          // otherwise a momentary close code (e.g. 1006) lingers red in the
          // header long after the connection recovered. Sticky errors (auth/
          // subscription/protocol) stay until the user dismisses them.
          if (!this.lastError?.sticky) this.lastError = null;
          this.requestCapabilities();
          this.requestSnapshot();
          this.flushOutbox();
        }
        this.notify();
        break;
      case "control":
        this.isController = this.bridge.isController;
        this.notify();
        break;
      case "session.error": {
        const sticky = isStickyErrorCode(e.code);
        this.lastError = { code: e.code, message: e.message, sticky };
        this.notify();
        // Auto-dismiss TRANSIENT errors: most session.error events are a
        // momentary close code or a recoverable hiccup, and leaving a red code
        // pinned to the header forever looks broken. Sticky errors (auth/
        // subscription/protocol mismatch) need user action, so they stay
        // until dismissError().
        if (this.errorClearTimer) {
          clearTimeout(this.errorClearTimer);
          this.errorClearTimer = undefined;
        }
        if (!sticky) {
          this.errorClearTimer = setTimeout(() => {
            this.lastError = null;
            this.errorClearTimer = undefined;
            this.notify();
          }, 6000);
        }
        break;
      }
      case "agent":
        this.handleAgentEnvelope(e.envelope);
        break;
      case "envelope":
        this.handleOtherEnvelope(e.envelope);
        break;
      default:
        // terminal.output events are consumed directly by the terminal view via
        // a separate subscription on the bridge; nothing to fold here.
        break;
    }
  }

  // Resolve pending file-browse / file-read requests by requestId.
  private handleOtherEnvelope(envelope: Envelope): void {
    const type = envelope.type as string;
    if (type === "terminal.status") {
      try {
        const p = parseTypedPayload("terminal.status", envelope.payload);
        this.externalAgentStatus = agentStatusFromTerminalPhase(p.phase);
        this.externalAgentProvider = p.provider ?? null;
        this.externalAgentTitle = p.toolName
          ? `外部终端 · ${p.toolName}`
          : p.summary
            ? `外部终端 · ${p.summary}`
            : "外部终端";
        this.externalAgentConversationId = (p as any).conversationId ?? null;
        this.notify();
      } catch {}
      return;
    }
    if (type === "terminal.browse.result") {
      try {
        const p = parseTypedPayload("terminal.browse.result", envelope.payload);
        if (p.requestId) {
          const resolve = this.pendingBrowse.get(p.requestId);
          if (resolve) {
            this.pendingBrowse.delete(p.requestId);
            resolve(p);
          }
        }
      } catch {}
      return;
    }
    if (type === "terminal.file.read.result") {
      try {
        const p = parseTypedPayload("terminal.file.read.result", envelope.payload);
        if (p.requestId) {
          const resolve = this.pendingRead.get(p.requestId);
          if (resolve) {
            this.pendingRead.delete(p.requestId);
            resolve(p);
          }
        }
      } catch {}
      return;
    }
  }

  private setTimeline(conversationId: string, items: AgentTimelineItem[]): void {
    const next = new Map(this.timelines);
    next.set(conversationId, items);
    this.timelines = next;
  }

  private handleAgentEnvelope(envelope: Envelope): void {
    const type = envelope.type as string;
    try {
      if (type === "agent.v2.capabilities") {
        this.capabilities = parseTypedPayload("agent.v2.capabilities", envelope.payload);
        // Providers (esp. codex) come online a beat AFTER the socket connects,
        // so the initial snapshot was empty — which is why the user had to hit
        // refresh. Re-request the snapshot whenever the enabled-provider set
        // changes, so conversations/history populate automatically once ready.
        const sig = (this.capabilities.providers ?? [])
          .filter((p) => p.enabled)
          .map((p) => p.id)
          .sort()
          .join(",");
        if (sig && sig !== this.lastProviderSig) {
          this.lastProviderSig = sig;
          this.requestSnapshot();
        }
        this.notify();
        return;
      }
      if (type === "agent.v2.snapshot") {
        const p = parseTypedPayload("agent.v2.snapshot", envelope.payload);
        this.conversations = mergeConversations(this.conversations, p.conversations);
        if (p.activeConversationId) this.activeConversationId = p.activeConversationId;
        const grouped = groupByConversation(p.items);
        const next = new Map(this.timelines);
        for (const [cid, items] of grouped) {
          next.set(cid, mergeTimeline(next.get(cid) ?? [], items));
        }
        this.timelines = next;
        this.notify();
        return;
      }
      if (type === "agent.v2.conversation.opened") {
        const p = parseTypedPayload("agent.v2.conversation.opened", envelope.payload);
        this.conversations = mergeConversations(this.conversations, [p.conversation]);
        this.activeConversationId = p.conversation.id;
        this.setTimeline(
          p.conversation.id,
          mergeTimeline(this.timelines.get(p.conversation.id) ?? [], normalizeItems(p.snapshot)),
        );
        // The open completed: unconditionally clear loading/syncing (ensure-
        // HistoryLoaded set them before sending open) while preserving any
        // pagination cursor/hasMore already learned. Seeding hasMore:true is
        // only meaningful when the host can page (Codex); other providers
        // report hasMore=false on the first load-older request.
        const seedHistory = (id: string) => {
          const prev = this.history.get(id);
          this.history.set(id, {
            loading: false,
            hasMore: prev?.hasMore ?? true,
            cursor: prev?.cursor,
            syncing: false,
          });
          this.openedThisSession.add(id);
        };
        seedHistory(p.conversation.id);
        if (p.requestedConversationId && p.requestedConversationId !== p.conversation.id) {
          seedHistory(p.requestedConversationId);
        }
        // Clear in-flight guard for both the requested id and the canonical id
        // the host returned (the host may reconcile local → server id).
        this.openInFlight.delete(p.conversation.id);
        if (p.requestedConversationId) this.openInFlight.delete(p.requestedConversationId);
        this.notify();
        return;
      }
      if (type === "agent.v2.history.result") {
        const p = parseTypedPayload("agent.v2.history.result", envelope.payload);
        // Prepend older items (they're ascending); mergeTimeline dedupes by id
        // and re-sorts by createdAt, so prepend vs append is safe either way.
        this.setTimeline(
          p.conversationId,
          mergeTimeline(this.timelines.get(p.conversationId) ?? [], normalizeItems(p.items)),
        );
        this.history.set(p.conversationId, {
          loading: false,
          hasMore: p.hasMore,
          cursor: p.nextCursor,
        });
        this.notify();
        return;
      }
      if (type === "agent.v2.conversation.list.result") {
        const p = parseTypedPayload("agent.v2.conversation.list.result", envelope.payload);
        this.conversations = mergeConversations(this.conversations, p.conversations);
        this.notify();
        return;
      }
      if (type === "agent.v2.conversation.deleted") {
        const p = parseTypedPayload("agent.v2.conversation.deleted", envelope.payload);
        this.removeConversationLocal(p.conversationId);
        this.notify();
        return;
      }
      if (type === "agent.v2.event") {
        const p = parseTypedPayload("agent.v2.event", envelope.payload);
        if (p.conversation) {
          // Host events are the real-time source of truth for conversation
          // STATE (esp. status). Force-replace by id rather than going through
          // the timestamp-gated merge — otherwise an optimistic "running" set
          // with the browser clock can out-timestamp the host's real "error"/
          // "idle" update, leaving the conversation stuck running forever and
          // silently queuing every later message (the "all subsequent fail" bug).
          const incoming = p.conversation;
          const exists = this.conversations.some((c) => c.id === incoming.id);
          this.conversations = (
            exists
              ? this.conversations.map((c) => (c.id === incoming.id ? incoming : c))
              : [incoming, ...this.conversations]
          ).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        } else if (p.patch?.status) {
          this.updateConversationStatus(
            p.conversationId,
            p.patch.status,
            p.patch.updatedAt ?? Date.now(),
          );
        }
        const current = this.timelines.get(p.conversationId) ?? [];
        const updated = applyEvent(current, p, () =>
          // Patch for an item we've never seen (missed upsert) — recover via a
          // debounced per-conversation snapshot request instead of losing it.
          this.scheduleSnapshotRecovery(p.conversationId),
        );
        if (updated !== current) {
          this.setTimeline(p.conversationId, updated);
          // Keep the conversation preview/status fresh from the latest item.
          const latest = updated[updated.length - 1];
          if (latest) this.touchConversation(p.conversationId, latest);
        }
        this.notify();
        // If this event left the conversation idle/errored, flush any queued
        // follow-up — this is also what lets a stuck queue recover.
        this.maybeFlushQueue(p.conversationId);
        return;
      }
      if (type === "agent.v2.permission.request") {
        const p = parseTypedPayload("agent.v2.permission.request", envelope.payload);
        this.updateConversationStatus(p.conversationId, "waiting_permission", Date.now());
        if (p.item) {
          const item: AgentTimelineItem = {
            ...p.item,
            metadata: { ...(p.item.metadata ?? {}), permissionLive: true },
          };
          this.setTimeline(
            p.conversationId,
            mergeTimeline(this.timelines.get(p.conversationId) ?? [], [item]),
          );
          this.notify();
        }
        return;
      }
      if (type === "agent.v2.notice") {
        const p = parseTypedPayload("agent.v2.notice", envelope.payload);
        const id = genId("notice");
        this.notices = [
          ...this.notices,
          { id, kind: p.kind, title: p.title, detail: p.detail },
        ].slice(-4); // keep at most 4 stacked
        this.notify();
        const ttl = p.durationMs && p.durationMs > 0 ? p.durationMs : 4000;
        setTimeout(() => this.dismissNotice(id), ttl);
        return;
      }
      if (type === "agent.v2.usage.report") {
        this.usage = parseTypedPayload("agent.v2.usage.report", envelope.payload);
        this.notify();
        return;
      }
    } catch {
      // Defensive: host may send shapes we don't validate; drop quietly.
    }
  }

  private touchConversation(conversationId: string, item: AgentTimelineItem): void {
    const preview = previewFromItem(item);
    this.conversations = this.conversations.map((c) =>
      c.id === conversationId
        ? {
            ...c,
            lastMessagePreview: preview ?? c.lastMessagePreview,
            lastActivityAt: item.updatedAt ?? item.createdAt ?? c.lastActivityAt,
          }
        : c,
    );
  }

  private updateConversationStatus(
    conversationId: string,
    status: AgentStatus,
    lastActivityAt: number,
  ): void {
    this.conversations = this.conversations
      .map((c) =>
        c.id === conversationId
          ? {
              ...c,
              status,
              lastActivityAt: Math.max(c.lastActivityAt, lastActivityAt),
            }
          : c,
      )
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  // ── Outbox (reliable non-idempotent sends) ──────────────────────────
  // Send now if the socket is OPEN; otherwise buffer for the reconnect flush.
  // Use ONLY for non-idempotent actions (prompt / permission / structured
  // input / cancel) — idempotent requests are simply re-issued on connect.
  private sendReliable(type: ProtocolMessageType, payload: unknown): boolean {
    const ok = this.bridge.sendAgent(type, payload);
    if (!ok) {
      this.outbox.push({ type, payload, queuedAt: Date.now() });
    }
    return ok;
  }

  // Flush buffered sends after (re)connect. Entries older than 60s are
  // dropped with a notice — replaying a stale prompt/cancel against a
  // conversation that has moved on does more harm than good.
  private flushOutbox(): void {
    if (this.outbox.length === 0) return;
    const pending = this.outbox;
    this.outbox = [];
    const now = Date.now();
    let dropped = 0;
    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i];
      if (now - entry.queuedAt > 60_000) {
        dropped += 1;
        continue;
      }
      // If the socket dropped again mid-flush, keep the remainder buffered
      // (sendReliable already re-buffered the failed entry itself).
      if (!this.sendReliable(entry.type, entry.payload)) {
        this.outbox.push(...pending.slice(i + 1));
        break;
      }
    }
    if (dropped > 0) {
      const id = genId("notice");
      this.notices = [
        ...this.notices,
        {
          id,
          kind: "warning",
          title: "发送失败",
          detail: `${dropped} 条消息因连接中断超过 60 秒未能送达，已丢弃`,
        },
      ].slice(-4);
      this.notify();
      setTimeout(() => this.dismissNotice(id), 6000);
    }
  }

  // Debounced (~1s per conversation) snapshot request, used to recover when an
  // agent.v2.event patch targets an item we've never seen (missed upsert).
  private scheduleSnapshotRecovery(conversationId: string): void {
    if (this.snapshotRecoveryTimers.has(conversationId)) return;
    this.snapshotRecoveryTimers.set(
      conversationId,
      setTimeout(() => {
        this.snapshotRecoveryTimers.delete(conversationId);
        this.requestSnapshot(conversationId);
      }, 1000),
    );
  }

  // ── Client actions ──────────────────────────────────────────────────
  dismissNotice(id: string): void {
    const next = this.notices.filter((n) => n.id !== id);
    if (next.length !== this.notices.length) {
      this.notices = next;
      this.notify();
    }
  }

  /** Manually clear the header error banner (user tapped it). */
  dismissError(): void {
    if (this.errorClearTimer) {
      clearTimeout(this.errorClearTimer);
      this.errorClearTimer = undefined;
    }
    if (this.lastError) {
      this.lastError = null;
      this.notify();
    }
  }

  setActiveConversation(conversationId: string | null): void {
    this.activeConversationId = conversationId;
    this.notify();
    // Lazy-load history: when switching to a known conversation whose timeline
    // has no real (non-optimistic) items yet, ask the host to OPEN it. The host
    // loads the on-disk transcript via loadSession and replies with
    // conversation.opened carrying the full snapshot. A plain snapshot.request
    // does NOT trigger that disk load, so open is the correct call.
    if (conversationId) this.ensureHistoryLoaded(conversationId);
  }

  private ensureHistoryLoaded(conversationId: string): void {
    if (this.openInFlight.has(conversationId)) return;
    const existing = this.timelines.get(conversationId) ?? [];
    const hasRealHistory = existing.some((i) => i.metadata?.optimistic !== true);
    // Already confirmed opened by the host this session → nothing to sync.
    if (hasRealHistory && this.openedThisSession.has(conversationId)) return;
    const conv = this.conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    this.openInFlight.add(conversationId);
    const prev = this.history.get(conversationId);
    if (hasRealHistory) {
      // Timeline was hydrated from the localStorage cache: keep rendering it
      // instantly, but still open on the host so it re-syncs with the on-disk
      // transcript. syncing (not loading) → the UI shows a slim inline
      // indicator instead of hiding the cached content behind a spinner.
      this.history.set(conversationId, {
        loading: prev?.loading ?? false,
        hasMore: prev?.hasMore ?? true,
        cursor: prev?.cursor,
        syncing: true,
      });
    } else {
      // Signal the UI that we're loading history for this conversation so it
      // shows a spinner instead of the bare "发送第一条指令…" placeholder.
      this.history.set(conversationId, { loading: true, hasMore: prev?.hasMore ?? true, cursor: prev?.cursor });
    }
    this.notify();
    // Sweep the guard if the host never replies, so re-selecting can retry
    // instead of being permanently blocked (blank history forever) — and clear
    // the loading/syncing flags + warn, so the spinner doesn't spin forever.
    setTimeout(() => {
      if (!this.openInFlight.delete(conversationId)) return;
      const state = this.history.get(conversationId);
      if (state && (state.loading || state.syncing)) {
        this.history.set(conversationId, {
          loading: false,
          hasMore: state.hasMore,
          cursor: state.cursor,
          syncing: false,
        });
        const id = genId("notice");
        this.notices = [
          ...this.notices,
          { id, kind: "warning", title: "加载对话记录超时" },
        ].slice(-4);
        setTimeout(() => this.dismissNotice(id), 6000);
        this.notify();
      }
    }, 12_000);
    this.bridge.sendAgent("agent.v2.conversation.open", {
      conversationId,
      agentSessionId: conv.agentSessionId,
      provider: conv.provider,
      cwd: conv.cwd,
      model: conv.model,
      reasoningEffort: conv.reasoningEffort,
      permissionMode: conv.permissionMode,
      collaborationMode: conv.collaborationMode,
      title: conv.title,
    });
  }

  requestCapabilities(): void {
    this.bridge.sendAgent("agent.v2.capabilities.request", {});
  }
  requestSnapshot(conversationId?: string): void {
    this.bridge.sendAgent("agent.v2.snapshot.request", conversationId ? { conversationId } : {});
  }
  requestConversationList(includeArchived = false): void {
    this.bridge.sendAgent("agent.v2.conversation.list", { includeArchived });
  }

  /** Ask the host to aggregate all on-disk transcripts into a usage report. */
  requestUsage(): void {
    this.bridge.sendAgent("agent.v2.usage.request", {});
  }

  /** Load an older page of history for a conversation (scroll-up). No-op while
   *  a page is already loading or when there's no more history. */
  loadOlderHistory(conversationId: string): void {
    const state = this.history.get(conversationId);
    if (state && (state.loading || !state.hasMore)) return;
    this.history.set(conversationId, {
      loading: true,
      hasMore: state?.hasMore ?? true,
      cursor: state?.cursor,
    });
    this.notify();
    this.bridge.sendAgent("agent.v2.history.request", {
      conversationId,
      cursor: state?.cursor,
      limit: 50,
    });
  }

  openConversation(input: {
    conversationId?: string;
    provider?: AgentProvider;
    cwd?: string;
    model?: string;
    reasoningEffort?: AgentReasoningEffort;
    permissionMode?: AgentPermissionMode;
    collaborationMode?: AgentCollaborationMode;
    title?: string;
  }): string {
    const conversationId = input.conversationId ?? genId("agent");
    this.bridge.sendAgent("agent.v2.conversation.open", {
      conversationId,
      provider: input.provider,
      cwd: input.cwd,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      permissionMode: input.permissionMode,
      collaborationMode: input.collaborationMode,
      title: input.title,
    });
    return conversationId;
  }

  /** Fork the current conversation into a NEW one, seeded from its transcript
   *  truncated at `turnId` (Claude only — the CLI notifies + falls back for
   *  other providers). Inherits provider/cwd from the source; the CLI fills in
   *  model/effort/permission from the source transcript. On success the CLI
   *  emits conversation.opened and we switch to it (same as a new conversation). */
  forkConversation(sourceConversationId: string, turnId: string): string | undefined {
    const source = this.conversations.find((c) => c.id === sourceConversationId);
    if (!source || source.provider !== "claude") return undefined;
    const conversationId = genId("agent");
    this.bridge.sendAgent("agent.v2.conversation.open", {
      conversationId,
      provider: source.provider,
      cwd: source.cwd,
      forkFromConversationId: sourceConversationId,
      forkFromTurnId: turnId,
    });
    return conversationId;
  }

  sendPrompt(input: SendPromptInput): void {
    const contentBlocks: AgentContentBlock[] = [];
    if (input.text.trim()) contentBlocks.push({ type: "text", text: input.text });
    for (const img of input.images ?? []) {
      contentBlocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    if (contentBlocks.length === 0) return;

    const conv = this.conversations.find((c) => c.id === input.conversationId);
    const running = conv?.status === "running" || conv?.status === "waiting_permission";
    // While a turn is running, new messages QUEUE (shown but not sent) and are
    // auto-flushed as a new_turn when the conversation goes idle. Otherwise send
    // immediately. This mirrors the mobile delivery model.
    const delivery: "auto" | "queued" = running ? "queued" : "auto";

    const clientMessageId = genId("msg");
    // IMPORTANT: id === clientMessageId so the host's echoed user item (which
    // reuses clientMessageId) MERGES with this optimistic one instead of
    // duplicating. metadata.delivery drives the queued-follow-up UI.
    const optimistic: AgentTimelineItem = {
      id: clientMessageId,
      conversationId: input.conversationId,
      type: "message",
      kind: "chat",
      role: "user",
      content: contentBlocks,
      text: input.text,
      createdAt: Date.now(),
      metadata: { optimistic: true, delivery, clientMessageId },
    };
    this.setTimeline(
      input.conversationId,
      mergeTimeline(this.timelines.get(input.conversationId) ?? [], [optimistic]),
    );
    // Persist the requested settings onto the conversation; mark running.
    this.conversations = this.conversations.map((c) =>
      c.id === input.conversationId
        ? {
            ...c,
            model: input.model ?? c.model,
            reasoningEffort: input.reasoningEffort ?? c.reasoningEffort,
            permissionMode: input.permissionMode ?? c.permissionMode,
            collaborationMode: input.collaborationMode ?? c.collaborationMode,
            status: delivery === "auto" ? "running" : c.status,
            lastActivityAt: Date.now(),
          }
        : c,
    );
    this.notify();

    if (delivery === "queued") return; // held locally; flushed when idle

    this.sendReliable("agent.v2.prompt", {
      conversationId: input.conversationId,
      clientMessageId,
      contentBlocks,
      delivery: "auto",
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      permissionMode: input.permissionMode,
      collaborationMode: input.collaborationMode,
    });
  }

  /** Send a held queued item now, either as a fresh turn or by steering the
   *  running turn (Codex only). Marks it sent so auto-flush won't re-send. */
  sendQueuedFollowUp(
    conversationId: string,
    itemId: string,
    delivery: "new_turn" | "steer",
  ): void {
    const items = this.timelines.get(conversationId) ?? [];
    const item = items.find((i) => i.id === itemId);
    if (!item || item.metadata?.queuedSent === true || item.metadata?.queuedDiscarded === true) return;
    const conv = this.conversations.find((c) => c.id === conversationId);
    const contentBlocks = (item.content as AgentContentBlock[] | undefined) ??
      (item.text ? [{ type: "text" as const, text: item.text }] : []);
    if (contentBlocks.length === 0) return;

    // Send FIRST, mark sent only on success — marking before a failed send
    // would strand the message as "sent" forever with no retry. On failure it
    // simply stays queued and the next flush pass (idle event / reconnect
    // snapshot) retries it. Not routed through the outbox: the queue itself
    // is the retry buffer, and double-buffering would risk a double-send.
    const ok = this.bridge.sendAgent("agent.v2.prompt", {
      conversationId,
      clientMessageId: (item.metadata?.clientMessageId as string) ?? genId("msg"),
      contentBlocks,
      delivery,
      model: conv?.model,
      reasoningEffort: conv?.reasoningEffort,
      permissionMode: conv?.permissionMode,
      collaborationMode: conv?.collaborationMode,
    });
    if (ok) {
      this.patchItem(conversationId, itemId, { queuedSent: true });
      this.notify();
    }
  }

  discardQueuedFollowUp(conversationId: string, itemId: string): void {
    this.patchItem(conversationId, itemId, { queuedDiscarded: true, queuedSent: true });
    this.notify();
  }

  // Shallow-merge a metadata patch onto one timeline item.
  private patchItem(conversationId: string, itemId: string, metaPatch: Record<string, unknown>): void {
    const items = this.timelines.get(conversationId);
    if (!items) return;
    this.setTimeline(
      conversationId,
      items.map((i) =>
        i.id === itemId
          ? { ...i, metadata: { ...(i.metadata ?? {}), ...metaPatch }, updatedAt: Date.now() }
          : i,
      ),
    );
  }

  // When a conversation goes idle, auto-send its oldest still-queued message as
  // a new turn (mirrors mobile auto-flush). Guarded so it fires once per item.
  private maybeFlushQueue(conversationId: string): void {
    const conv = this.conversations.find((c) => c.id === conversationId);
    if (!conv || conv.status === "running" || conv.status === "waiting_permission") return;
    const items = this.timelines.get(conversationId) ?? [];
    const queued = items.find(
      (i) =>
        i.metadata?.delivery === "queued" &&
        i.metadata?.queuedSent !== true &&
        i.metadata?.queuedDiscarded !== true,
    );
    if (!queued || this.autoFlushing.has(queued.id)) return;
    this.autoFlushing.add(queued.id);
    this.sendQueuedFollowUp(conversationId, queued.id, "new_turn");
    setTimeout(() => this.autoFlushing.delete(queued.id), 1500);
  }

  cancel(conversationId: string): void {
    this.sendReliable("agent.v2.cancel", { conversationId });
  }

  respondPermission(
    conversationId: string,
    requestId: string,
    outcome: "allow" | "deny" | "cancelled",
    optionId?: string,
  ): void {
    // Optimistically mark the matching permission item pending for instant UI
    // feedback; the host's follow-up event will set the final state.
    this.patchItemByPredicate(
      conversationId,
      (i) => i.permission?.requestId === requestId,
      { permissionPending: true, pendingOutcome: outcome, optionId },
    );
    this.notify();
    this.sendReliable("agent.v2.permission.respond", {
      conversationId,
      requestId,
      outcome,
      optionId,
    });
  }

  respondStructuredInput(
    conversationId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): void {
    this.patchItemByPredicate(
      conversationId,
      (i) => i.structuredInput?.requestId === requestId,
      { inputSubmitting: true, answers },
    );
    this.notify();
    this.sendReliable("agent.v2.structured_input.respond", {
      conversationId,
      requestId,
      answers,
    });
  }

  // Patch the metadata of the first timeline item matching a predicate.
  private patchItemByPredicate(
    conversationId: string,
    pred: (i: AgentTimelineItem) => boolean,
    metaPatch: Record<string, unknown>,
  ): void {
    const items = this.timelines.get(conversationId);
    if (!items) return;
    let done = false;
    this.setTimeline(
      conversationId,
      items.map((i) => {
        if (done || !pred(i)) return i;
        done = true;
        return { ...i, metadata: { ...(i.metadata ?? {}), ...metaPatch }, updatedAt: Date.now() };
      }),
    );
  }

  /** Run a slash command (from capabilities.commands) in a conversation. */
  executeCommand(conversationId: string, commandId: string, args?: string): void {
    this.bridge.sendAgent("agent.v2.command.execute", {
      conversationId,
      commandId,
      args,
      clientMessageId: genId("cmd"),
    });
  }

  /** Update a conversation's local settings (model/effort/permission/plan).
   *  The next prompt carries these, so the change takes effect on next turn. */
  updateConversationSettings(
    conversationId: string,
    patch: Partial<
      Pick<
        AgentConversation,
        "model" | "reasoningEffort" | "permissionMode" | "collaborationMode"
      >
    >,
  ): void {
    this.conversations = this.conversations.map((c) =>
      c.id === conversationId ? { ...c, ...patch } : c,
    );
    this.notify();
  }

  /** Rename a conversation. Optimistically updates the local title, then asks
   *  the host to persist it; the host echoes back the canonical record. An
   *  empty title clears the custom name (falls back to preview/id in the UI). */
  renameConversation(conversationId: string, title: string): void {
    const trimmed = title.trim();
    const next = trimmed === "" ? undefined : trimmed;
    this.conversations = this.conversations.map((c) =>
      c.id === conversationId ? { ...c, title: next } : c,
    );
    this.notify();
    this.bridge.sendAgent("agent.v2.conversation.update", {
      conversationId,
      title: trimmed,
    });
  }

  /** Archive or unarchive a conversation. Optimistic + host round-trip. */
  setConversationArchived(conversationId: string, archived: boolean): void {
    this.conversations = this.conversations.map((c) =>
      c.id === conversationId ? { ...c, archived } : c,
    );
    this.notify();
    this.bridge.sendAgent("agent.v2.conversation.update", {
      conversationId,
      archived,
    });
  }

  /** Forget a conversation from the workspace. This does NOT delete the agent's
   *  on-disk transcript — it removes the conversation from the tracked list on
   *  both web and host. Optimistically removes it locally, then tells the host. */
  deleteConversation(conversationId: string): void {
    this.removeConversationLocal(conversationId);
    this.notify();
    this.bridge.sendAgent("agent.v2.conversation.delete", { conversationId });
  }

  // Drop a conversation and its timeline/history from local state. Shared by the
  // optimistic delete and the host's `conversation.deleted` broadcast.
  private removeConversationLocal(conversationId: string): void {
    this.conversations = this.conversations.filter((c) => c.id !== conversationId);
    if (this.timelines.has(conversationId)) {
      const nextTimelines = new Map(this.timelines);
      nextTimelines.delete(conversationId);
      this.timelines = nextTimelines;
    }
    this.history.delete(conversationId);
    this.openInFlight.delete(conversationId);
    if (this.activeConversationId === conversationId) this.activeConversationId = null;
  }

  private nextRequestId(prefix: string): string {
    this.reqCounter += 1;
    return `${prefix}-${this.reqCounter}-${genId("r")}`;
  }

  /** Browse a directory on the host. Resolves with entries (10s timeout). */
  browse(path: string, includeFiles = true): Promise<BrowseResult> {
    const requestId = this.nextRequestId("browse");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBrowse.delete(requestId);
        reject(new Error("browse timeout"));
      }, 10_000);
      this.pendingBrowse.set(requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.bridge.send("terminal.browse", { path, includeFiles, requestId });
    });
  }

  /** Read a file on the host. Resolves with its content (10s timeout). */
  readFile(path: string, maxBytes = 256_000): Promise<FileReadResult> {
    const requestId = this.nextRequestId("read");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRead.delete(requestId);
        reject(new Error("read timeout"));
      }, 10_000);
      this.pendingRead.set(requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.bridge.send("terminal.file.read", { path, maxBytes, requestId });
    });
  }
}
