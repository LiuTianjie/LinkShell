import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEnvelope, parseTypedPayload } from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";
import type { ProjectRecord } from "../storage/projects";
import type { SessionInfo, SessionManagerHandle } from "./useSessionManager";
import {
  archiveAgentConversation,
  loadAgentConversations,
  loadAgentTimeline,
  makeAgentConversationId,
  mergeAgentConversationId,
  removeAgentConversationsByServerUrl,
  renameAgentConversation,
  saveAgentTimeline,
  upsertAgentConversation,
  upsertAgentTimelineItem,
  type AgentCapabilities,
  type AgentCollaborationMode,
  type AgentCommandDescriptor,
  type AgentContentBlock,
  type AgentConversationRecord,
  type AgentNotice,
  type AgentNoticeKind,
  type AgentProvider,
  type AgentPermissionMode,
  type AgentReasoningEffort,
  type AgentTimelineItem,
} from "../storage/agent-workspace";

interface OpenConversationInput {
  conversationId?: string;
  agentSessionId?: string;
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

export interface AgentWorkspaceRefreshOptions {
  mergeCurrent?: boolean;
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
  isHydrated: boolean;
  conversations: AgentConversationRecord[];
  archivedConversations: AgentConversationRecord[];
  activeConversationId: string | null;
  capabilitiesBySessionId: Map<string, AgentCapabilities>;
  connectedSessions: SessionInfo[];
  notices: AgentNotice[];
  dismissNotice: (id: string) => void;
  refresh: (options?: AgentWorkspaceRefreshOptions) => Promise<void>;
  requestCapabilities: (sessionId?: string) => void;
  openConversation: (input: OpenConversationInput) => Promise<OpenConversationResult>;
  openProject: (record: ProjectRecord) => Promise<string | null>;
  resumeConversation: (conversationId: string) => Promise<string | null>;
  ensureConversationSession: (conversationId: string, preferredSessionId?: string) => boolean;
  getConversation: (conversationId: string) => AgentConversationRecord | undefined;
  /**
   * Committed timeline state, keyed by conversation id. Consumers that render
   * the timeline MUST derive their list from this reactive Map (e.g. via
   * `useMemo(() => timelineById.get(id) ?? [], [timelineById, id])`) so a
   * streamed-token commit renders the freshly committed array on the same
   * pass. `getTimeline` reads a post-commit ref and therefore trails the
   * current state by one render — use it only for imperative reads.
   */
  timelineById: Map<string, AgentTimelineItem[]>;
  getTimeline: (conversationId: string) => AgentTimelineItem[];
  getHistoryState: (conversationId: string) => AgentHistoryState | undefined;
  loadOlderHistory: (conversationId: string) => void;
  sendPrompt: (
    conversationId: string,
    text: string,
    options?: {
      model?: string;
      reasoningEffort?: AgentReasoningEffort;
      permissionMode?: AgentPermissionMode;
      collaborationMode?: AgentCollaborationMode;
      attachments?: AgentContentBlock[];
      delivery?: "auto" | "new_turn" | "steer" | "queued";
    },
  ) => void;
  sendQueuedFollowUp: (
    conversationId: string,
    itemId: string,
    delivery: "steer" | "new_turn",
  ) => void;
  discardQueuedFollowUp: (conversationId: string, itemId: string) => void;
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
  archive: (conversationId: string, archived: boolean) => Promise<void>;
  rename: (conversationId: string, title: string) => Promise<void>;
  markRead: (conversationId: string) => void;
  removeByServerUrl: (serverUrl: string) => Promise<void>;
}

function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

// In-memory timeline cap. Higher than the on-disk cap (200) so older pages
// fetched via agent.v2.history.request stay visible for the session even
// though storage only persists the most recent slice.
const MAX_TIMELINE_ITEMS = 1000;

export interface AgentHistoryState {
  loading: boolean;
  hasMore: boolean;
  cursor?: string;
}

function isAgentSessionUsable(session: SessionInfo | undefined): boolean {
  return Boolean(session) &&
    (
      session!.status === "connected" ||
      session!.status === "reconnecting" ||
      session!.status === "connecting" ||
      session!.status === "host_disconnected"
    );
}

function mergeConversationRecords(
  current: AgentConversationRecord[],
  records: AgentConversationRecord[],
  options?: { preserveLocalArchived?: boolean },
): AgentConversationRecord[] {
  const preserveLocalArchived = options?.preserveLocalArchived ?? true;
  const next = [...current];
  for (const record of records) {
    const index = next.findIndex((item) => item.id === record.id);
    const merged = index >= 0
      ? {
          ...next[index],
          ...record,
          archived: preserveLocalArchived && next[index]!.archived && !record.archived
            ? true
            : record.archived,
          lastMessagePreview: record.lastMessagePreview ?? next[index]!.lastMessagePreview,
          lastUserActivityAt: record.lastUserActivityAt ?? next[index]!.lastUserActivityAt,
          lastResponseAt: record.lastResponseAt ?? next[index]!.lastResponseAt,
          lastReadAt: record.lastReadAt ?? next[index]!.lastReadAt,
        }
      : record;
    if (index >= 0) next[index] = merged;
    else next.unshift(merged);
  }
  return next.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

function isUserVisibleResponseItem(item: AgentTimelineItem): boolean {
  if (item.role === "user") return false;
  if (item.type === "error" || item.error) return true;
  if (item.type === "permission" || item.permission) return true;
  if (item.kind === "user_input_prompt") return true;
  if (item.role === "assistant") return true;
  return Boolean(previewFromItem(item));
}

function statusForIncomingItem(
  item: AgentTimelineItem,
  fallback: AgentConversationRecord["status"],
): AgentConversationRecord["status"] {
  if (item.type === "error" || item.error) return "error";
  if (item.type === "permission" || item.permission || item.kind === "user_input_prompt") {
    return "waiting_permission";
  }
  return item.status ?? fallback;
}

function reconcileConversationId(
  current: AgentConversationRecord[],
  requestedConversationId: string,
  record: AgentConversationRecord,
): AgentConversationRecord[] {
  if (!requestedConversationId || requestedConversationId === record.id) {
    return mergeConversationRecords(current, [record]);
  }

  const oldRecord = current.find((item) => item.id === requestedConversationId);
  const existingRecord = current.find((item) => item.id === record.id);
  const createdAt = Math.min(
    record.createdAt,
    oldRecord?.createdAt ?? record.createdAt,
    existingRecord?.createdAt ?? record.createdAt,
  );
  const lastActivityAt = Math.max(
    record.lastActivityAt,
    oldRecord?.lastActivityAt ?? record.lastActivityAt,
    existingRecord?.lastActivityAt ?? record.lastActivityAt,
  );
  const merged: AgentConversationRecord = {
    ...oldRecord,
    ...existingRecord,
    ...record,
    id: record.id,
    archived: Boolean(record.archived || oldRecord?.archived || existingRecord?.archived),
    createdAt,
    lastActivityAt,
    lastMessagePreview: record.lastMessagePreview ?? oldRecord?.lastMessagePreview ?? existingRecord?.lastMessagePreview,
    lastUserActivityAt: record.lastUserActivityAt ?? oldRecord?.lastUserActivityAt ?? existingRecord?.lastUserActivityAt,
    lastResponseAt: record.lastResponseAt ?? oldRecord?.lastResponseAt ?? existingRecord?.lastResponseAt,
    lastReadAt: record.lastReadAt ?? oldRecord?.lastReadAt ?? existingRecord?.lastReadAt,
  };
  return mergeConversationRecords(
    current.filter((item) => item.id !== requestedConversationId && item.id !== record.id),
    [merged],
    { preserveLocalArchived: false },
  );
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
    const existing = map.get(item.id);
    // A locally-discarded queued item must never be resurrected by a late echo.
    if (
      existing?.metadata?.queuedDiscarded === true &&
      existing.metadata?.delivery === "queued" &&
      item.metadata?.queuedDiscarded !== true
    ) {
      continue;
    }
    // Preserve client-only queue flags when the host echo lacks them, so a
    // late echo can't clear queuedSent/discarded and cause a double-send.
    if (
      existing?.metadata &&
      (existing.metadata.queuedSent || existing.metadata.queuedDiscarded || existing.metadata.delivery)
    ) {
      const inMeta = item.metadata ?? {};
      map.set(item.id, {
        ...item,
        metadata: {
          ...inMeta,
          queuedSent: inMeta.queuedSent ?? existing.metadata.queuedSent,
          queuedDiscarded: inMeta.queuedDiscarded ?? existing.metadata.queuedDiscarded,
          delivery: inMeta.delivery ?? existing.metadata.delivery,
        },
      });
      continue;
    }
    map.set(item.id, item);
  }
  return [...map.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_TIMELINE_ITEMS);
}

function normalizeSnapshotItems(items: AgentTimelineItem[]): AgentTimelineItem[] {
  return items.map((item) => {
    if (
      item.type === "permission" &&
      !item.metadata?.permissionOutcome &&
      item.metadata?.permissionLive !== true
    ) {
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
  const [capabilitiesBySessionId, setCapabilitiesBySessionId] = useState<Map<string, AgentCapabilities>>(new Map());
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [notices, setNotices] = useState<AgentNotice[]>([]);
  const [historyById, setHistoryById] = useState<Map<string, AgentHistoryState>>(new Map());
  const [isHydrated, setIsHydrated] = useState(false);
  const managerRef = useRef(manager);
  const conversationsRef = useRef(conversations);
  const timelineRef = useRef(timelineById);
  const historyRef = useRef(historyById);
  const autoSendingQueuedRef = useRef(new Set<string>());
  const pendingOpenRef = useRef(new Map<string, {
    resolve: (result: OpenConversationResult) => void;
    timer: ReturnType<typeof setTimeout>;
    allowErrorOpen: boolean;
  }>());
  const pendingBrowseRef = useRef(new Map<string, {
    resolve: (result: AgentFileBrowseResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  const pendingReadRef = useRef(new Map<string, {
    resolve: (result: AgentFileReadResult) => void;
    timer: ReturnType<typeof setTimeout>;
    path: string;
  }>());
  // History pagination in-flight timers, keyed by conversationId. Guards against
  // a host that never replies to agent.v2.history.request (offline / old CLI):
  // without this the loading flag sticks true forever and the user can never
  // retry, because loadOlderHistory bails while loading. Cleared on result.
  const pendingHistoryRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Timers that re-enable a permission / structured-input prompt if the host
  // never echoes the response (dropped message, host went offline after
  // accept). Keyed by `${conversationId}:${requestId}`. Cleared when the echo
  // arrives via updatePermissionMetadata / updateTimelineItemMetadata.
  const pendingResponseRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

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
    historyRef.current = historyById;
  }, [historyById]);

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
  const connectedSessionSignature = useMemo(
    () =>
      connectedSessions
        .map((session) => `${session.gatewayUrl}:${session.sessionId}:${session.status}:${session.machineId ?? ""}`)
        .sort()
        .join("|"),
    [connectedSessions],
  );

  const refresh = useCallback(async (options?: AgentWorkspaceRefreshOptions) => {
    try {
      const mergeCurrent = options?.mergeCurrent ?? true;
      const stored = await loadAgentConversations();
      setConversations((prev) => mergeCurrent ? mergeConversationRecords(stored, prev) : stored);
      const storedConversationIds = new Set(stored.map((conversation) => conversation.id));
      const pairs = await Promise.all(
        stored.slice(0, 20).map(async (conversation) => [
          conversation.id,
          await loadAgentTimeline(conversation.id),
        ] as const),
      );
      setTimelineById((prev) => {
        if (!mergeCurrent) return new Map(pairs);
        const next = new Map(prev);
        for (const [conversationId, storedItems] of pairs) {
          const currentItems = next.get(conversationId);
          next.set(
            conversationId,
            currentItems ? mergeTimeline(storedItems, currentItems) : storedItems,
          );
        }
        return next;
      });
      if (!mergeCurrent) {
        setActiveConversationId((current) =>
          current && storedConversationIds.has(current) ? current : null
        );
      }
    } finally {
      setIsHydrated(true);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const persistConversation = useCallback(async (
    record: AgentConversationRecord,
    options?: { preserveLocalArchived?: boolean },
  ) => {
    setConversations((prev) => mergeConversationRecords(prev, [record], options));
    const saved = await upsertAgentConversation(record, options);
    setConversations((prev) => mergeConversationRecords(prev, [saved], options));
  }, []);

  const persistConversations = useCallback((
    records: AgentConversationRecord[],
    options?: { preserveLocalArchived?: boolean },
  ) => {
    if (records.length === 0) return;
    setConversations((prev) => mergeConversationRecords(prev, records, options));
    (async () => {
      for (const record of records) {
        await upsertAgentConversation(record, options);
      }
    })().catch(() => {});
  }, []);

  const persistTimelineItem = useCallback(async (item: AgentTimelineItem) => {
    setTimelineById((prev) => {
      const next = new Map(prev);
      next.set(item.conversationId, mergeTimeline(next.get(item.conversationId) ?? [], [item]));
      return next;
    });
    await upsertAgentTimelineItem(item);
  }, []);

  const appendLocalError = useCallback((conversationId: string, error: string, idPrefix = "error") => {
    const item: AgentTimelineItem = {
      id: `${idPrefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      type: "error",
      error,
      createdAt: Date.now(),
    };
    setTimelineById((prev) => {
      const next = new Map(prev);
      next.set(conversationId, mergeTimeline(next.get(conversationId) ?? [], [item]));
      return next;
    });
    upsertAgentTimelineItem(item).catch(() => {});
    const conversation = conversationsRef.current.find((entry) => entry.id === conversationId);
    if (conversation) {
      const now = Date.now();
      persistConversation({
        ...conversation,
        status: "error",
        lastMessagePreview: error,
        lastActivityAt: now,
        lastResponseAt: now,
      }).catch(() => {});
    }
  }, [persistConversation]);

  const sessionForConversation = useCallback(
    (conversationId: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return undefined;
      return findSessionForConversation(conversation, manager.sessions);
    },
    [manager.sessions],
  );

  const ensureConversationSession = useCallback(
    (conversationId: string, preferredSessionId?: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) {
        return false;
      }

      const preferred = preferredSessionId ? manager.sessions.get(preferredSessionId) : undefined;
      if (isAgentSessionUsable(preferred)) {
        return true;
      }

      const resolved = findSessionForConversation(conversation, manager.sessions);
      if (isAgentSessionUsable(resolved)) {
        return true;
      }

      const sessionId = preferredSessionId || conversation.sessionId;
      if (sessionId && conversation.serverUrl) {
        manager.connectToSession(sessionId, conversation.serverUrl);
      }
      return false;
    },
    [manager],
  );

  function findSessionForConversation(
    conversation: AgentConversationRecord,
    sessions: Map<string, SessionInfo>,
  ): SessionInfo | undefined {
    const exact = sessions.get(conversation.sessionId);
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
        currentManager.sendAgentWorkspaceEnvelope(
          session.sessionId,
          "agent.v2.snapshot.request",
          {},
          { queue: true, dedupeKey: "agent-v2-snapshot" },
        );
      }
    },
    [],
  );

  useEffect(() => {
    if (connectedSessions.length === 0) return;
    requestCapabilities();
  }, [connectedSessionSignature, connectedSessions.length, requestCapabilities]);

  const handleEnvelope = useCallback(
    (envelope: Envelope) => {
      const serverSession = managerRef.current.sessions.get(envelope.sessionId);
      const serverUrl = normalizeServerUrl(serverSession?.gatewayUrl ?? "");
      const toRecord = (conversation: any): AgentConversationRecord => ({
        id: conversation.id,
        serverUrl,
        sessionId: envelope.sessionId,
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
        lastMessagePreview: conversation.lastMessagePreview,
        lastActivityAt: conversation.lastActivityAt ?? Date.now(),
        lastUserActivityAt: conversation.lastUserActivityAt,
        lastResponseAt: conversation.lastResponseAt,
        lastReadAt: conversation.lastReadAt,
        createdAt: conversation.createdAt ?? Date.now(),
        schemaVersion: 1,
      });

      if (envelope.type === "agent.v2.notice") {
        const payload = parseTypedPayload("agent.v2.notice", envelope.payload) as {
          conversationId?: string;
          kind: AgentNoticeKind;
          title: string;
          detail?: string;
          durationMs?: number;
        };
        const notice: AgentNotice = {
          id: `notice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          conversationId: payload.conversationId,
          kind: payload.kind,
          title: payload.title,
          detail: payload.detail,
          durationMs: payload.durationMs && payload.durationMs > 0 ? payload.durationMs : 4000,
          createdAt: Date.now(),
        };
        setNotices((prev) => [...prev.slice(-4), notice]);
        return;
      }

      if (envelope.type === "agent.v2.capabilities") {
        const payload = parseTypedPayload("agent.v2.capabilities", envelope.payload) as AgentCapabilities;
        if (serverSession && typeof payload.machineId === "string") {
          serverSession.machineId = payload.machineId;
        }
        setCapabilitiesBySessionId((prev) => {
          const next = new Map(prev);
          next.set(envelope.sessionId, payload);
          return next;
        });
        return;
      }

      if (envelope.type === "agent.v2.history.result") {
        const payload = parseTypedPayload("agent.v2.history.result", envelope.payload) as {
          conversationId: string;
          items?: AgentTimelineItem[];
          nextCursor?: string;
          hasMore?: boolean;
        };
        const pendingTimer = pendingHistoryRef.current.get(payload.conversationId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingHistoryRef.current.delete(payload.conversationId);
        }
        const older = normalizeSnapshotItems((payload.items ?? []) as AgentTimelineItem[]);
        if (older.length > 0) {
          setTimelineById((prev) => {
            const next = new Map(prev);
            const merged = mergeTimeline(next.get(payload.conversationId) ?? [], older);
            next.set(payload.conversationId, merged);
            saveAgentTimeline(payload.conversationId, merged).catch(() => {});
            return next;
          });
        }
        setHistoryById((prev) => {
          const next = new Map(prev);
          next.set(payload.conversationId, {
            loading: false,
            hasMore: Boolean(payload.hasMore),
            cursor: payload.nextCursor,
          });
          historyRef.current = next;
          return next;
        });
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
        let payload: AgentFileReadResult & { requestId?: string };
        try {
          payload = parseTypedPayload("terminal.file.read.result", envelope.payload) as AgentFileReadResult & {
            requestId?: string;
          };
        } catch {
          const raw = envelope.payload && typeof envelope.payload === "object"
            ? envelope.payload as Partial<AgentFileReadResult & { requestId?: string }>
            : {};
          payload = {
            path: typeof raw.path === "string" ? raw.path : "",
            content: typeof raw.content === "string" ? raw.content : "",
            encoding: "utf8",
            size: typeof raw.size === "number" ? raw.size : undefined,
            truncated: Boolean(raw.truncated),
            error: typeof raw.error === "string" ? raw.error : "文件读取响应格式无效。",
            requestId: typeof raw.requestId === "string" ? raw.requestId : undefined,
          };
        }
        let pendingKey = payload.requestId;
        let pending = pendingKey ? pendingReadRef.current.get(pendingKey) : undefined;
        if (!pending) {
          const matches = [...pendingReadRef.current.entries()].filter(([, item]) =>
            item.path === payload.path
          );
          if (matches.length === 1) {
            pendingKey = matches[0]![0];
            pending = matches[0]![1];
          }
        }
        if (!pending && pendingReadRef.current.size === 1) {
          const only = [...pendingReadRef.current.entries()][0];
          pendingKey = only?.[0];
          pending = only?.[1];
        }
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingReadRef.current.delete(pendingKey!);
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
        const record = toRecord(payload.conversation);
        persistConversation(record).catch(() => {});
        setActiveConversationId(record.id);
        const requestedConversationId = typeof payload.requestedConversationId === "string"
          ? payload.requestedConversationId
          : undefined;
        if (requestedConversationId && requestedConversationId !== record.id) {
          setConversations((prev) => reconcileConversationId(prev, requestedConversationId, record));
          mergeAgentConversationId(requestedConversationId, record.id).catch(() => {});
          setTimelineById((prev) => {
            const oldItems = prev.get(requestedConversationId);
            if (!oldItems?.length) return prev;
            const next = new Map(prev);
            next.delete(requestedConversationId);
            next.set(record.id, mergeTimeline(
              next.get(record.id) ?? [],
              oldItems.map((item) => ({ ...item, conversationId: record.id })),
            ));
            return next;
          });
        }
        const pending = pendingOpenRef.current.get(record.id) ??
          (requestedConversationId ? pendingOpenRef.current.get(requestedConversationId) : undefined);
        if (pending) {
          clearTimeout(pending.timer);
          pendingOpenRef.current.delete(record.id);
          if (requestedConversationId) pendingOpenRef.current.delete(requestedConversationId);
          const canOpenErrorConversation = pending.allowErrorOpen && record.status === "error";
          pending.resolve({
            conversationId: record.status === "error" && !canOpenErrorConversation ? null : record.id,
            status: record.status,
            error: record.status === "error"
              ? record.lastMessagePreview || "Agent 对话创建失败。"
              : undefined,
          });
        }
        const items = normalizeSnapshotItems((payload.snapshot ?? []) as AgentTimelineItem[]);
        if (items.length > 0) {
          setTimelineById((prev) => {
            const next = new Map(prev);
            const merged = mergeTimeline(next.get(record.id) ?? [], items);
            next.set(record.id, merged);
            saveAgentTimeline(record.id, merged).catch(() => {});
            return next;
          });
        }
        return;
      }

      if (envelope.type === "agent.v2.conversation.list.result") {
        const payload = parseTypedPayload("agent.v2.conversation.list.result", envelope.payload) as any;
        persistConversations((payload.conversations ?? []).map(toRecord));
        return;
      }

      if (envelope.type === "agent.v2.snapshot") {
        const payload = parseTypedPayload("agent.v2.snapshot", envelope.payload) as any;
        if (payload.activeConversationId) setActiveConversationId(payload.activeConversationId);
        persistConversations((payload.conversations ?? []).map(toRecord));
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

      if (envelope.type === "agent.v2.event") {
        const payload = parseTypedPayload("agent.v2.event", envelope.payload) as any;
        if (payload.conversation) {
          persistConversation(toRecord(payload.conversation)).catch(() => {});
        }
        if (payload.item) {
          const item = payload.item as AgentTimelineItem;
          const itemWithSourceSession: AgentTimelineItem = {
            ...item,
            metadata: {
              ...(item.metadata ?? {}),
              sessionId: item.metadata?.sessionId ?? envelope.sessionId,
            },
          };
          persistTimelineItem(itemWithSourceSession).catch(() => {});
          const preview = previewFromItem(itemWithSourceSession);
          if (preview) {
            const existing = conversationsRef.current.find((item) => item.id === payload.conversationId);
            if (existing) {
              const now = Date.now();
              const isResponse = isUserVisibleResponseItem(itemWithSourceSession);
              persistConversation({
                ...existing,
                lastMessagePreview: preview,
                lastActivityAt: now,
                lastResponseAt: isResponse ? now : existing.lastResponseAt,
                status: statusForIncomingItem(itemWithSourceSession, existing.status),
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
              const now = Date.now();
              const isResponse = isUserVisibleResponseItem(patchedItem);
              persistConversation({
                ...existing,
                lastMessagePreview: preview,
                lastActivityAt: now,
                lastResponseAt: isResponse ? now : existing.lastResponseAt,
                status: statusForIncomingItem(patchedItem, existing.status),
              }).catch(() => {});
            }
            const next = new Map(prev);
            next.set(payload.conversationId, nextItems);
            return next;
          });
        }
        return;
      }

      if (envelope.type === "session.error") {
        const payload = parseTypedPayload("session.error", envelope.payload) as any;
        if (payload.code !== "control_conflict") return;
        setTimelineById((prev) => {
          const next = new Map(prev);
          for (const [conversationId, items] of prev) {
            const conversation = conversationsRef.current.find((item) => item.id === conversationId);
            if (conversation?.sessionId !== envelope.sessionId) continue;
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
            sessionId: envelope.sessionId,
            permissionLive: true,
            permissionExpired: false,
            permissionPending: false,
          },
        };
        persistTimelineItem(permissionItem).catch(() => {});
        const existing = conversationsRef.current.find((item) => item.id === payload.conversationId);
        if (existing) {
          const now = Date.now();
          persistConversation({
            ...existing,
            status: "waiting_permission",
            lastMessagePreview: previewFromItem(permissionItem) ?? "需要授权",
            lastActivityAt: now,
            lastResponseAt: now,
          }).catch(() => {});
        }
      }

      if (envelope.type === "agent.permission.request") {
        const payload = parseTypedPayload("agent.permission.request" as any, envelope.payload) as any;
        const isTerminalPermission =
          typeof envelope.terminalId === "string" &&
          envelope.terminalId.length > 0 &&
          typeof payload.agentSessionId !== "string";
        if (isTerminalPermission) return;
        const conversation =
          conversationsRef.current.find((item) =>
            item.sessionId === envelope.sessionId &&
            item.agentSessionId &&
            item.agentSessionId === payload.agentSessionId,
          ) ??
          conversationsRef.current.find((item) => item.id === activeConversationId && item.sessionId === envelope.sessionId) ??
          conversationsRef.current.find((item) => item.sessionId === envelope.sessionId && !item.archived);
        if (!conversation) return;
        const permissionItem: AgentTimelineItem = {
          id: `permission:${payload.requestId}`,
          conversationId: conversation.id,
          type: "permission",
          permission: {
            requestId: payload.requestId,
            toolName: payload.toolName,
            toolInput: payload.toolInput,
            context: payload.context,
            options: payload.options ?? [],
          },
          metadata: {
            protocol: "legacy",
            sessionId: envelope.sessionId,
            agentSessionId: payload.agentSessionId,
            permissionLive: true,
            permissionExpired: false,
            permissionPending: false,
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        persistTimelineItem(permissionItem).catch(() => {});
        const now = Date.now();
        persistConversation({
          ...conversation,
          status: "waiting_permission",
          lastMessagePreview: previewFromItem(permissionItem) ?? "需要授权",
          lastActivityAt: now,
          lastResponseAt: now,
        }).catch(() => {});
      }

      if (envelope.type === "terminal.status") {
        return;
      }
    },
    [activeConversationId, persistConversation, persistConversations, persistTimelineItem],
  );

  useEffect(() => {
    manager.onAgentWorkspaceEnvelope(handleEnvelope);
    return () => manager.onAgentWorkspaceEnvelope(null);
  }, [handleEnvelope, manager]);

  const openConversation = useCallback(
    async (input: OpenConversationInput) => {
      let session = manager.sessions.get(input.sessionId);
      if ((!session || !isAgentSessionUsable(session)) && input.serverUrl) {
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
          sessionId: input.sessionId,
          agentSessionId: input.agentSessionId,
          cwd: input.cwd,
          provider: input.provider,
        });
      setActiveConversationId(conversationId);
      if (session) manager.setActiveSessionId(session.sessionId);
      return await new Promise<OpenConversationResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingOpenRef.current.delete(conversationId);
          if (input.conversationId) {
            resolve({
              conversationId,
              status: conversationsRef.current.find((item) => item.id === conversationId)?.status,
              error: "CLI 暂未确认对话，已打开本地历史。新消息需等待主机端 Agent 恢复。",
            });
            return;
          }
          resolve({
            conversationId: null,
            error: "CLI 没有在 12 秒内确认对话，请确认主机端 linkshell 仍在线。",
          });
        }, 12_000);
        pendingOpenRef.current.set(conversationId, {
          resolve,
          timer,
          allowErrorOpen: Boolean(input.conversationId),
        });
        const accepted = manager.sendAgentWorkspaceEnvelope(
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
          { queue: true, dedupeKey: `agent-v2-open:${conversationId}`, claimControl: true },
        );
        if (!accepted) {
          clearTimeout(timer);
          pendingOpenRef.current.delete(conversationId);
          resolve({
            conversationId: null,
            error: "Agent 对话请求未发送：连接未就绪，请稍后重试。",
          });
        }
      });
    },
    [manager],
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
      let session = findSessionForConversation(conversation, manager.sessions);
      if (!isAgentSessionUsable(session)) {
        if (!conversation.sessionId || !conversation.serverUrl) return null;
        manager.connectToSession(conversation.sessionId, conversation.serverUrl);
      }
      const sessionId = session?.sessionId ?? conversation.sessionId;
      const serverUrl = session?.gatewayUrl ?? conversation.serverUrl;
      const machineId = session?.machineId ?? conversation.machineId;
      manager.setActiveSessionId(sessionId);
      await persistConversation({
        ...conversation,
        sessionId,
        machineId,
        archived: false,
        lastActivityAt: Date.now(),
      }, { preserveLocalArchived: false });
      const result = await openConversation({
        conversationId: conversation.id,
        agentSessionId: conversation.agentSessionId,
        sessionId,
        machineId,
        serverUrl,
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
        delivery?: "auto" | "new_turn" | "steer" | "queued";
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
      const session = findSessionForConversation(conversation, manager.sessions);
      if (!session) {
        appendLocalError(conversationId, "消息未发送：设备连接已失效，请重新打开会话。", "send-error");
        return;
      }

      const now = Date.now();
      const delivery = options?.delivery ?? (conversation.status === "running" ? "queued" : "auto");
      const optimisticItem: AgentTimelineItem = {
        id: clientMessageId,
        conversationId,
        type: "message",
        kind: "chat",
        role: "user",
        content: contentBlocks,
        text: textFromBlocks(contentBlocks),
        metadata: { optimistic: true, delivery },
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
        model: options?.model ?? conversation.model,
        reasoningEffort: options?.reasoningEffort ?? conversation.reasoningEffort,
        permissionMode: options?.permissionMode ?? conversation.permissionMode,
        collaborationMode: options?.collaborationMode ?? conversation.collaborationMode,
        status: "running",
        lastMessagePreview: previewFromItem(optimisticItem) ?? conversation.lastMessagePreview,
        lastActivityAt: now,
        lastUserActivityAt: now,
        lastReadAt: now,
      };
      setConversations((prev) => {
        const next = prev.filter((item) => item.id !== conversationId);
        next.unshift(nextConversation);
        return next.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      });
      upsertAgentConversation(nextConversation).catch(() => {});

      if (delivery === "queued") {
        return;
      }

      const accepted = manager.sendAgentWorkspaceEnvelope(
        session.sessionId,
        "agent.v2.prompt",
        {
          conversationId,
          clientMessageId,
          contentBlocks,
          delivery,
          model: options?.model,
          reasoningEffort: options?.reasoningEffort,
          permissionMode: options?.permissionMode,
          collaborationMode: options?.collaborationMode,
        },
        { queue: true, dedupeKey: `agent-v2-prompt:${clientMessageId}`, claimControl: true },
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
    [appendLocalError, manager],
  );

  const markQueuedFollowUpSent = useCallback((conversationId: string, itemId: string) => {
    setTimelineById((prev) => {
      const items = prev.get(conversationId);
      if (!items) return prev;
      const nextItems = items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              metadata: { ...(item.metadata ?? {}), queuedSent: true },
              updatedAt: Date.now(),
            }
          : item,
      );
      saveAgentTimeline(conversationId, nextItems).catch(() => {});
      const next = new Map(prev);
      next.set(conversationId, nextItems);
      return next;
    });
  }, []);

  const discardQueuedFollowUp = useCallback((conversationId: string, itemId: string) => {
    const applyDiscard = (items: AgentTimelineItem[] | undefined) =>
      (items ?? []).map((item) =>
        item.id === itemId
          ? {
              ...item,
              metadata: {
                ...(item.metadata ?? {}),
                queuedDiscarded: true,
                queuedSent: true,
              },
              updatedAt: Date.now(),
            }
          : item,
      );

    const currentItems = timelineRef.current.get(conversationId);
    if (currentItems) {
      const nextCurrentItems = applyDiscard(currentItems);
      timelineRef.current = new Map(timelineRef.current);
      timelineRef.current.set(conversationId, nextCurrentItems);
    }

    setTimelineById((prev) => {
      const nextItems = applyDiscard(prev.get(conversationId));
      saveAgentTimeline(conversationId, nextItems).catch(() => {});
      const next = new Map(prev);
      next.set(conversationId, nextItems);
      return next;
    });
  }, []);

  const sendQueuedFollowUp = useCallback(
    (conversationId: string, itemId: string, delivery: "steer" | "new_turn") => {
      const item = timelineRef.current.get(conversationId)?.find((entry) => entry.id === itemId);
      const conversation = conversationsRef.current.find((entry) => entry.id === conversationId);
      if (!item || !conversation) return;
      if (item.metadata?.queuedDiscarded === true || item.metadata?.queuedSent === true) return;
      const blocks = item.content?.length
        ? item.content
        : item.text
          ? [{ type: "text" as const, text: item.text }]
          : [];
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n")
        .trim();
      const attachments = blocks.filter((block) => block.type === "image");
      if (!text && attachments.length === 0) return;
      markQueuedFollowUpSent(conversationId, itemId);
      sendPrompt(conversationId, text, {
        model: conversation.model,
        reasoningEffort: conversation.reasoningEffort,
        permissionMode: conversation.permissionMode,
        collaborationMode: conversation.collaborationMode,
        attachments,
        delivery,
      });
    },
    [markQueuedFollowUpSent, sendPrompt],
  );

  useEffect(() => {
    if (!isHydrated) return;
    for (const conversation of conversations) {
      if (conversation.status === "running" || conversation.status === "waiting_permission") continue;
      const queued = (timelineById.get(conversation.id) ?? []).find((item) =>
        item.type === "message" &&
        item.role === "user" &&
        item.metadata?.delivery === "queued" &&
        item.metadata?.queuedSent !== true &&
        item.metadata?.queuedDiscarded !== true
      );
      if (!queued || autoSendingQueuedRef.current.has(queued.id)) continue;
      autoSendingQueuedRef.current.add(queued.id);
      sendQueuedFollowUp(conversation.id, queued.id, "new_turn");
      setTimeout(() => autoSendingQueuedRef.current.delete(queued.id), 1500);
    }
  }, [conversations, isHydrated, sendQueuedFollowUp, timelineById]);

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
      if (!session) {
        appendLocalError(conversationId, "命令未发送：设备连接已失效，请重新打开会话。", "command-error");
        return;
      }
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
        { queue: true, dedupeKey: `agent-v2-command:${clientMessageId}`, claimControl: true },
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
          lastUserActivityAt: now,
          lastReadAt: now,
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
    [appendLocalError, manager],
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
      manager.sendAgentWorkspaceEnvelope(
        session.sessionId,
        "agent.v2.cancel",
        { conversationId },
        { queue: true, dedupeKey: `agent-v2-cancel:${conversationId}`, claimControl: true },
      );
    },
    [manager],
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

  const resolveStructuredInputSessionId = useCallback(
    (
      conversation: AgentConversationRecord,
      inputItem: AgentTimelineItem | undefined,
    ): string | null => {
      const metadataSessionId = typeof inputItem?.metadata?.sessionId === "string"
        ? inputItem.metadata.sessionId
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
      // A resolving update (host echo or local error) re-enables the card, so
      // clear any pending-response watchdog armed by respondPermission.
      if (metadata.permissionPending === false || "permissionOutcome" in metadata || metadata.permissionExpired === true) {
        const key = `${conversationId}:${requestId}`;
        const timer = pendingResponseRef.current.get(key);
        if (timer) {
          clearTimeout(timer);
          pendingResponseRef.current.delete(key);
        }
      }
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
      // A resolving update (host echo or local error) re-enables the card, so
      // clear any pending-response watchdog armed by respondStructuredInput.
      if (metadata.inputSubmitting === false || metadata.inputSubmitted === true) {
        const key = `${conversationId}:${itemId}`;
        const timer = pendingResponseRef.current.get(key);
        if (timer) {
          clearTimeout(timer);
          pendingResponseRef.current.delete(key);
        }
      }
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
        return false;
      }
      const permissionItem = timelineRef.current
        .get(conversationId)
        ?.find((item) => item.type === "permission" && item.permission?.requestId === requestId);
      const sourceSessionId = resolvePermissionSessionId(conversation, permissionItem);
      if (!sourceSessionId) {
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
      } else if (permissionItem?.metadata?.protocol === "legacy") {
        accepted = manager.sendAgentWorkspaceEnvelope(
          sourceSessionId,
          "agent.permission.response" as any,
          {
            agentSessionId: typeof permissionItem.metadata.agentSessionId === "string"
              ? permissionItem.metadata.agentSessionId
              : conversation.agentSessionId,
            requestId,
            outcome,
            optionId,
          },
          { queue: true, dedupeKey: `agent-permission:${requestId}`, claimControl: true },
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
        updatePermissionMetadata(conversationId, requestId, {
          permissionPending: false,
          permissionError: "授权未发送：连接未就绪，请稍后重试。",
        });
        return false;
      }
      updatePermissionMetadata(conversationId, requestId, {
        permissionPending: true,
        permissionLive: true,
        permissionExpired: false,
        pendingOutcome: outcome,
        optionId,
        permissionError: undefined,
      });
      // Watchdog: if the host never echoes the response (dropped message, host
      // went offline after accept), re-enable the card so the user can retry —
      // mirrors the history-request timeout. The host echo arrives via the
      // timeline-patch path, so verify against current state on expiry.
      const permissionKey = `${conversationId}:${requestId}`;
      const existingPermissionTimer = pendingResponseRef.current.get(permissionKey);
      if (existingPermissionTimer) clearTimeout(existingPermissionTimer);
      pendingResponseRef.current.set(
        permissionKey,
        setTimeout(() => {
          pendingResponseRef.current.delete(permissionKey);
          const current = timelineRef.current
            .get(conversationId)
            ?.find((item) => item.type === "permission" && item.permission?.requestId === requestId);
          if (current?.metadata?.permissionPending !== true || current?.metadata?.permissionOutcome) return;
          updatePermissionMetadata(conversationId, requestId, {
            permissionPending: false,
            permissionError: "未收到主机确认，请重试。",
          });
        }, 12_000),
      );
      const now = Date.now();
      persistConversation({
        ...conversation,
        status: "running",
        lastActivityAt: now,
        lastUserActivityAt: now,
        lastReadAt: now,
      }).catch(() => {});
      return true;
    },
    [manager, persistConversation, resolvePermissionSessionId, updatePermissionMetadata],
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
      const inputItem = timelineRef.current
        .get(conversationId)
        ?.find((item) =>
          item.kind === "user_input_prompt" &&
          item.structuredInput?.requestId === requestId,
        );
      const sourceSessionId = resolveStructuredInputSessionId(conversation, inputItem);
      if (!sourceSessionId) {
        updateTimelineItemMetadata(conversationId, `input:${requestId}`, {
          inputSubmitting: false,
          inputError: "回答未发送：设备连接已失效，请重新打开会话。",
        });
        return;
      }
      const accepted = manager.sendAgentWorkspaceEnvelope(
        sourceSessionId,
        "agent.v2.structured_input.respond" as any,
        { conversationId, requestId, answers },
        { queue: true, dedupeKey: `agent-v2-input:${requestId}`, claimControl: true },
      );
      updateTimelineItemMetadata(conversationId, `input:${requestId}`, accepted
        ? { inputSubmitting: true, inputError: undefined, answers, sessionId: sourceSessionId }
        : { inputSubmitting: false, inputError: "回答未发送：连接未就绪，请稍后重试。" });
      if (accepted) {
        // Watchdog: re-enable the form if the host never echoes inputSubmitted
        // (dropped message / host offline). Verify against current state on
        // expiry since the echo arrives via the timeline-patch path.
        const inputKey = `${conversationId}:input:${requestId}`;
        const existingInputTimer = pendingResponseRef.current.get(inputKey);
        if (existingInputTimer) clearTimeout(existingInputTimer);
        pendingResponseRef.current.set(
          inputKey,
          setTimeout(() => {
            pendingResponseRef.current.delete(inputKey);
            const current = timelineRef.current
              .get(conversationId)
              ?.find((item) => item.id === `input:${requestId}`);
            if (current?.metadata?.inputSubmitting !== true || current?.metadata?.inputSubmitted === true) return;
            updateTimelineItemMetadata(conversationId, `input:${requestId}`, {
              inputSubmitting: false,
              inputError: "未收到主机确认，请重试。",
            });
          }, 12_000),
        );
        const now = Date.now();
        persistConversation({
          ...conversation,
          status: "running",
          lastActivityAt: now,
          lastUserActivityAt: now,
          lastReadAt: now,
        }).catch(() => {});
      }
    },
    [manager, persistConversation, resolveStructuredInputSessionId, updateTimelineItemMetadata],
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
        pendingReadRef.current.set(requestId, { resolve, timer, path });
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

  const markRead = useCallback((conversationId: string) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation) return;
    const now = Math.max(Date.now(), conversation.lastResponseAt ?? 0, conversation.lastActivityAt ?? 0);
    const nextConversation: AgentConversationRecord = {
      ...conversation,
      lastReadAt: now,
    };
    setConversations((prev) =>
      mergeConversationRecords(prev, [nextConversation]),
    );
    upsertAgentConversation(nextConversation).catch(() => {});
  }, []);

  const removeByServerUrl = useCallback(async (serverUrl: string) => {
    const normalized = normalizeServerUrl(serverUrl);
    const removedIds = conversationsRef.current
      .filter((item) => normalizeServerUrl(item.serverUrl) === normalized)
      .map((item) => item.id);
    setConversations((prev) =>
      prev.filter((item) => normalizeServerUrl(item.serverUrl) !== normalized),
    );
    if (removedIds.length > 0) {
      setTimelineById((prev) => {
        const next = new Map(prev);
        for (const id of removedIds) next.delete(id);
        return next;
      });
    }
    await removeAgentConversationsByServerUrl(serverUrl);
  }, []);

  const loadOlderHistory = useCallback((conversationId: string) => {
    const state = historyRef.current.get(conversationId);
    if (state && (state.loading || !state.hasMore)) return;
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation) return;
    const session = findSessionForConversation(conversation, managerRef.current.sessions);
    if (!session) return;
    const accepted = managerRef.current.sendAgentWorkspaceEnvelope(
      session.sessionId,
      "agent.v2.history.request",
      { conversationId, cursor: state?.cursor, limit: 50 },
      { queue: true, dedupeKey: `agent-v2-history:${conversationId}` },
    );
    if (!accepted) return;
    // Arm a timeout so a silent host (offline / old CLI without history support)
    // can't leave the loading flag stuck true forever — reset it so the spinner
    // stops and the user can scroll up to retry. hasMore is preserved.
    const existingTimer = pendingHistoryRef.current.get(conversationId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      pendingHistoryRef.current.delete(conversationId);
      setHistoryById((prev) => {
        const current = prev.get(conversationId);
        if (!current?.loading) return prev;
        const next = new Map(prev);
        next.set(conversationId, { ...current, loading: false });
        historyRef.current = next;
        return next;
      });
    }, 12_000);
    pendingHistoryRef.current.set(conversationId, timer);
    setHistoryById((prev) => {
      const next = new Map(prev);
      next.set(conversationId, {
        loading: true,
        hasMore: state?.hasMore ?? true,
        cursor: state?.cursor,
      });
      historyRef.current = next;
      return next;
    });
  }, []);

  const dismissNotice = useCallback((id: string) => {
    setNotices((prev) => prev.filter((notice) => notice.id !== id));
  }, []);

  return {
    isHydrated,
    conversations: conversations.filter((item) => !item.archived),
    archivedConversations: conversations.filter((item) => item.archived),
    activeConversationId,
    capabilitiesBySessionId,
    connectedSessions,
    notices,
    dismissNotice,
    refresh,
    requestCapabilities,
    openConversation,
    openProject,
    resumeConversation,
    ensureConversationSession,
    getConversation: (conversationId) =>
      conversationsRef.current.find((item) => item.id === conversationId),
    timelineById,
    getTimeline: (conversationId) => timelineRef.current.get(conversationId) ?? [],
    getHistoryState: (conversationId) => historyRef.current.get(conversationId),
    loadOlderHistory,
    sendPrompt,
    sendQueuedFollowUp,
    discardQueuedFollowUp,
    executeCommand,
    updateConversationSettings,
    cancel,
    respondPermission,
    suppressPermissionRequest,
    respondStructuredInput,
    browseFiles,
    readFile,
    archive,
    rename,
    markRead,
    removeByServerUrl,
  };
}
