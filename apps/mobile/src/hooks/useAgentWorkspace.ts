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
  renameAgentConversation,
  saveAgentTimeline,
  upsertAgentConversation,
  upsertAgentTimelineItem,
  type AgentCapabilities,
  type AgentCollaborationMode,
  type AgentCommandDescriptor,
  type AgentContentBlock,
  type AgentConversationRecord,
  type AgentProvider,
  type AgentPermissionMode,
  type AgentReasoningEffort,
  type AgentTimelineItem,
} from "../storage/agent-workspace";

interface OpenConversationInput {
  conversationId?: string;
  agentSessionId?: string;
  hostDeviceId?: string;
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
  conversations: AgentConversationRecord[];
  archivedConversations: AgentConversationRecord[];
  activeConversationId: string | null;
  capabilitiesBySessionId: Map<string, AgentCapabilities>;
  connectedSessions: SessionInfo[];
  refresh: () => Promise<void>;
  requestCapabilities: (sessionId?: string) => void;
  openConversation: (input: OpenConversationInput) => Promise<OpenConversationResult>;
  openProject: (record: ProjectRecord) => Promise<string | null>;
  resumeConversation: (conversationId: string) => Promise<string | null>;
  ensureConversationSession: (conversationId: string, preferredSessionId?: string) => boolean;
  getConversation: (conversationId: string) => AgentConversationRecord | undefined;
  getTimeline: (conversationId: string) => AgentTimelineItem[];
  sendPrompt: (
    conversationId: string,
    text: string,
    options?: {
      model?: string;
      reasoningEffort?: AgentReasoningEffort;
      permissionMode?: AgentPermissionMode;
      collaborationMode?: AgentCollaborationMode;
      attachments?: AgentContentBlock[];
    },
  ) => void;
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
}

function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
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
    map.set(item.id, item);
  }
  return [...map.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-200);
}

function normalizeSnapshotItems(items: AgentTimelineItem[]): AgentTimelineItem[] {
  return items.map((item) => {
    if (item.type === "permission" && !item.metadata?.permissionOutcome) {
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
  const managerRef = useRef(manager);
  const conversationsRef = useRef(conversations);
  const timelineRef = useRef(timelineById);
  const pendingOpenRef = useRef(new Map<string, {
    resolve: (result: OpenConversationResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  const pendingBrowseRef = useRef(new Map<string, {
    resolve: (result: AgentFileBrowseResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  const pendingReadRef = useRef(new Map<string, {
    resolve: (result: AgentFileReadResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());

  useEffect(() => {
    managerRef.current = manager;
  }, [manager]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    timelineRef.current = timelineById;
  }, [timelineById]);

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

  const refresh = useCallback(async () => {
    const stored = await loadAgentConversations();
    setConversations(stored);
    const pairs = await Promise.all(
      stored.slice(0, 20).map(async (conversation) => [
        conversation.id,
        await loadAgentTimeline(conversation.id),
      ] as const),
    );
    setTimelineById(new Map(pairs));
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const persistConversation = useCallback(async (
    record: AgentConversationRecord,
    options?: { preserveLocalArchived?: boolean },
  ) => {
    const saved = await upsertAgentConversation(record, options);
    setConversations((prev) => {
      const next = prev.filter((item) => item.id !== saved.id);
      next.unshift(saved);
      return next.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    });
  }, []);

  const persistTimelineItem = useCallback(async (item: AgentTimelineItem) => {
    setTimelineById((prev) => {
      const next = new Map(prev);
      next.set(item.conversationId, mergeTimeline(next.get(item.conversationId) ?? [], [item]));
      return next;
    });
    await upsertAgentTimelineItem(item);
  }, []);

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
        console.warn("[LiveActivityAction] workspace ensureSession missing conversation", { conversationId, preferredSessionId });
        return false;
      }
      const isUsable = (session: SessionInfo | undefined) =>
        Boolean(session) &&
        (
          session!.status === "connected" ||
          session!.status === "reconnecting" ||
          session!.status === "connecting" ||
          session!.status === "host_disconnected"
        );

      const preferred = preferredSessionId ? manager.sessions.get(preferredSessionId) : undefined;
      if (isUsable(preferred)) {
        console.log("[LiveActivityAction] workspace ensureSession preferred usable", {
          conversationId,
          preferredSessionId,
          status: preferred?.status,
          controllerId: preferred?.controllerId,
        });
        return true;
      }

      const resolved = findSessionForConversation(conversation, manager.sessions);
      if (isUsable(resolved)) {
        console.log("[LiveActivityAction] workspace ensureSession resolved usable", {
          conversationId,
          preferredSessionId,
          resolvedSessionId: resolved?.sessionId,
          status: resolved?.status,
          controllerId: resolved?.controllerId,
        });
        return true;
      }

      const sessionId = preferredSessionId || conversation.sessionId;
      if (sessionId && conversation.serverUrl) {
        console.warn("[LiveActivityAction] workspace ensureSession reconnect", {
          conversationId,
          preferredSessionId,
          sessionId,
          serverUrl: conversation.serverUrl,
          knownSessions: [...manager.sessions.values()].map((session) => ({
            sessionId: session.sessionId,
            status: session.status,
            gatewayUrl: session.gatewayUrl,
            controllerId: session.controllerId,
          })),
        });
        manager.connectToSession(sessionId, conversation.serverUrl);
      } else {
        console.warn("[LiveActivityAction] workspace ensureSession cannot reconnect", {
          conversationId,
          preferredSessionId,
          sessionId,
          serverUrl: conversation.serverUrl,
        });
      }
      return false;
    },
    [manager],
  );

  function findSessionForConversation(
    conversation: AgentConversationRecord,
    sessions: Map<string, SessionInfo>,
  ): SessionInfo | undefined {
    const exact = sessions.get(conversation.hostDeviceId ?? conversation.sessionId);
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
  }, [connectedSessions.length, requestCapabilities]);

  const handleEnvelope = useCallback(
    (envelope: Envelope) => {
      const serverSession = managerRef.current.sessions.get(envelope.hostDeviceId);
      const serverUrl = normalizeServerUrl(serverSession?.gatewayUrl ?? "");
      const toRecord = (conversation: any): AgentConversationRecord => ({
        id: conversation.id,
        serverUrl,
        hostDeviceId: serverSession?.hostDeviceId ?? envelope.hostDeviceId ?? envelope.hostDeviceId,
        sessionId: serverSession?.hostDeviceId ?? envelope.hostDeviceId ?? envelope.hostDeviceId,
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
        createdAt: conversation.createdAt ?? Date.now(),
        schemaVersion: 2,
      });

      if (envelope.type === "agent.v2.capabilities") {
        const payload = parseTypedPayload("agent.v2.capabilities", envelope.payload) as AgentCapabilities;
        if (serverSession && typeof payload.machineId === "string") {
          serverSession.machineId = payload.machineId;
        }
        setCapabilitiesBySessionId((prev) => {
          const next = new Map(prev);
          next.set(envelope.hostDeviceId, payload);
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
        const payload = parseTypedPayload("terminal.file.read.result", envelope.payload) as AgentFileReadResult & {
          requestId?: string;
        };
        if (!payload.requestId) return;
        const pending = pendingReadRef.current.get(payload.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingReadRef.current.delete(payload.requestId);
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
        const pending = pendingOpenRef.current.get(record.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingOpenRef.current.delete(record.id);
          pending.resolve({
            conversationId: record.status === "error" ? null : record.id,
            status: record.status,
            error: record.status === "error"
              ? record.lastMessagePreview || "Agent 对话创建失败。"
              : undefined,
          });
        }
        const items = normalizeSnapshotItems((payload.snapshot ?? []) as AgentTimelineItem[]);
        if (items.length > 0) {
          saveAgentTimeline(record.id, items).catch(() => {});
          setTimelineById((prev) => {
            const next = new Map(prev);
            next.set(record.id, mergeTimeline(next.get(record.id) ?? [], items));
            return next;
          });
        }
        return;
      }

      if (envelope.type === "agent.v2.conversation.list.result") {
        const payload = parseTypedPayload("agent.v2.conversation.list.result", envelope.payload) as any;
        for (const conversation of payload.conversations ?? []) {
          persistConversation(toRecord(conversation)).catch(() => {});
        }
        return;
      }

      if (envelope.type === "agent.v2.snapshot") {
        const payload = parseTypedPayload("agent.v2.snapshot", envelope.payload) as any;
        if (payload.activeConversationId) setActiveConversationId(payload.activeConversationId);
        for (const conversation of payload.conversations ?? []) {
          persistConversation(toRecord(conversation)).catch(() => {});
        }
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
          persistTimelineItem(payload.item as AgentTimelineItem).catch(() => {});
          const preview = previewFromItem(payload.item as AgentTimelineItem);
          if (preview) {
            const existing = conversationsRef.current.find((item) => item.id === payload.conversationId);
            if (existing) {
              persistConversation({
                ...existing,
                lastMessagePreview: preview,
                lastActivityAt: Date.now(),
                status: payload.item.status ?? existing.status,
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
              persistConversation({
                ...existing,
                lastMessagePreview: preview,
                lastActivityAt: Date.now(),
                status: patchedItem.status ?? existing.status,
              }).catch(() => {});
            }
            const next = new Map(prev);
            next.set(payload.conversationId, nextItems);
            return next;
          });
        }
        return;
      }

      if (envelope.type === "device.error") {
        const payload = parseTypedPayload("device.error", envelope.payload) as any;
        if (payload.code !== "control_conflict") return;
        setTimelineById((prev) => {
          const next = new Map(prev);
          for (const [conversationId, items] of prev) {
            const conversation = conversationsRef.current.find((item) => item.id === conversationId);
            if (conversation?.sessionId !== envelope.hostDeviceId) continue;
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
            sessionId: envelope.hostDeviceId,
            permissionLive: true,
            permissionExpired: false,
            permissionPending: false,
          },
        };
        persistTimelineItem(permissionItem).catch(() => {});
        const existing = conversationsRef.current.find((item) => item.id === payload.conversationId);
        if (existing) {
          persistConversation({
            ...existing,
            status: "waiting_permission",
            lastMessagePreview: previewFromItem(permissionItem) ?? "需要授权",
            lastActivityAt: Date.now(),
          }).catch(() => {});
        }
      }

      if (envelope.type === "terminal.status") {
        const payload = envelope.payload as {
          phase?: string;
          summary?: string;
          pendingPermissionCount?: number;
          permissionResolution?: {
            requestId?: string;
            outcome?: "allow" | "deny" | "cancelled";
            source?: string;
            delivered?: boolean;
          };
          topPermission?: {
            requestId?: string;
            toolName?: string;
            toolInput?: string;
            permissionRequest?: string;
            timestamp?: number;
          };
        };
        const topPermission = payload.topPermission;
        const permissionResolution = payload.permissionResolution;
        const terminalId = typeof (envelope as any).terminalId === "string"
          ? (envelope as any).terminalId
          : "default";
        const resolvedConversation = permissionResolution?.requestId
          ? conversationsRef.current.find((item) =>
              timelineRef.current.get(item.id)?.some((timelineItem) =>
                timelineItem.type === "permission" &&
                timelineItem.permission?.requestId === permissionResolution.requestId &&
                timelineItem.metadata?.sessionId === envelope.hostDeviceId,
              ),
            )
          : undefined;
        const conversation =
          resolvedConversation ??
          conversationsRef.current.find((item) => item.id === activeConversationId && item.sessionId === envelope.hostDeviceId) ??
          conversationsRef.current.find((item) =>
            item.sessionId === envelope.hostDeviceId &&
            !item.archived &&
            (item.status === "running" || item.status === "waiting_permission"),
          ) ??
          conversationsRef.current.find((item) => item.sessionId === envelope.hostDeviceId && !item.archived);
        if (!conversation) return;
        if (permissionResolution?.requestId) {
          const delivered = permissionResolution.delivered === true;
          const outcome = permissionResolution.outcome;
          setTimelineById((prev) => {
            const items = prev.get(conversation.id);
            if (!items) return prev;
            let changed = false;
            const nextItems = items.map((item) => {
              if (item.type === "permission" && item.permission?.requestId === permissionResolution.requestId) {
                changed = true;
                return {
                  ...item,
                  metadata: {
                    ...(item.metadata ?? {}),
                    permissionLive: false,
                    permissionPending: false,
                    permissionExpired: false,
                    permissionDelivered: delivered,
                    permissionResolutionSource: permissionResolution.source,
                    ...(outcome ? { permissionOutcome: outcome } : {}),
                    permissionError: delivered
                      ? undefined
                      : "授权没有送达 Agent：这条请求可能已经过期或被其它入口处理。",
                  },
                  updatedAt: Date.now(),
                };
              }
              return item;
            });
            if (!changed) return prev;
            saveAgentTimeline(conversation.id, nextItems).catch(() => {});
            const next = new Map(prev);
            next.set(conversation.id, nextItems);
            return next;
          });
          if (!topPermission?.requestId) return;
        }
        if (!topPermission?.requestId) {
          const pendingCount = payload.pendingPermissionCount ?? 0;
          const shouldClearPermissions =
            pendingCount === 0 &&
            (payload.phase !== "waiting" || payload.summary === "permission allowed" || payload.summary === "permission denied");
          if (!shouldClearPermissions) return;
          const outcome = payload.summary === "permission denied"
            ? "deny"
            : payload.summary === "permission allowed"
              ? "allow"
              : undefined;
          setTimelineById((prev) => {
            const items = prev.get(conversation.id);
            if (!items) return prev;
            let changed = false;
            const nextItems = items.map((item) => {
              if (
                item.type === "permission" &&
                item.metadata?.protocol === "terminal" &&
                item.metadata?.sessionId === envelope.hostDeviceId &&
                (item.metadata?.terminalId ?? "default") === terminalId &&
                item.metadata?.permissionLive === true &&
                !item.metadata?.permissionOutcome
              ) {
                changed = true;
                return {
                  ...item,
                  metadata: {
                    ...(item.metadata ?? {}),
                    permissionLive: false,
                    permissionPending: false,
                    permissionExpired: false,
                    ...(outcome ? { permissionOutcome: outcome } : {}),
                    permissionError: undefined,
                  },
                  updatedAt: Date.now(),
                };
              }
              return item;
            });
            if (!changed) return prev;
            saveAgentTimeline(conversation.id, nextItems).catch(() => {});
            const next = new Map(prev);
            next.set(conversation.id, nextItems);
            return next;
          });
          return;
        }
        const permissionItem: AgentTimelineItem = {
          id: `permission:${topPermission.requestId}`,
          conversationId: conversation.id,
          type: "permission",
          permission: {
            requestId: topPermission.requestId,
            toolName: topPermission.toolName,
            toolInput: topPermission.toolInput || topPermission.permissionRequest,
            context: topPermission.permissionRequest,
            options: [
              { id: "deny", label: "拒绝", kind: "deny" },
              { id: "allow_once", label: "允许一次", kind: "allow" },
            ],
          },
          metadata: {
            protocol: "terminal",
            sessionId: envelope.hostDeviceId,
            terminalId,
            permissionLive: true,
            permissionExpired: false,
            permissionPending: false,
          },
          createdAt: topPermission.timestamp ?? Date.now(),
          updatedAt: Date.now(),
        };
        persistTimelineItem(permissionItem).catch(() => {});
        persistConversation({
          ...conversation,
          status: "waiting_permission",
          lastMessagePreview: previewFromItem(permissionItem) ?? "需要授权",
          lastActivityAt: Date.now(),
        }).catch(() => {});
      }
    },
    [activeConversationId, persistConversation, persistTimelineItem],
  );

  useEffect(() => {
    manager.onAgentWorkspaceEnvelope(handleEnvelope);
    return () => manager.onAgentWorkspaceEnvelope(null);
  }, [handleEnvelope, manager]);

  const openConversation = useCallback(
    async (input: OpenConversationInput) => {
      let session = manager.sessions.get(input.sessionId);
      if (!session && input.serverUrl) {
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
          hostDeviceId: session?.hostDeviceId ?? input.hostDeviceId ?? input.sessionId,
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
          resolve({
            conversationId: null,
            error: "CLI 没有在 12 秒内确认对话，请确认主机端 linkshell 仍在线。",
          });
        }, 12_000);
        pendingOpenRef.current.set(conversationId, { resolve, timer });
        manager.sendAgentWorkspaceEnvelope(
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
          { queue: true, dedupeKey: `agent-v2-open:${conversationId}` },
        );
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
        hostDeviceId: session?.hostDeviceId ?? record.hostDeviceId,
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
      const session = findSessionForConversation(conversation, manager.sessions);
      if (!session) {
        return null;
      }
      manager.setActiveSessionId(session.sessionId);
      await persistConversation({
        ...conversation,
        hostDeviceId: session.hostDeviceId,
        sessionId: session.sessionId,
        machineId: session.machineId ?? conversation.machineId,
        archived: false,
        lastActivityAt: Date.now(),
      }, { preserveLocalArchived: false });
      const result = await openConversation({
        conversationId: conversation.id,
        agentSessionId: conversation.agentSessionId,
        sessionId: session.sessionId,
        hostDeviceId: session.hostDeviceId,
        machineId: session.machineId ?? conversation.machineId,
        serverUrl: session.gatewayUrl,
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
      if (!session) return;

      const now = Date.now();
      const optimisticItem: AgentTimelineItem = {
        id: clientMessageId,
        conversationId,
        type: "message",
        kind: "chat",
        role: "user",
        content: contentBlocks,
        text: textFromBlocks(contentBlocks),
        metadata: { optimistic: true },
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
      };
      setConversations((prev) => {
        const next = prev.filter((item) => item.id !== conversationId);
        next.unshift(nextConversation);
        return next.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      });
      upsertAgentConversation(nextConversation).catch(() => {});

      const accepted = manager.sendAgentWorkspaceEnvelope(
        session.sessionId,
        "agent.v2.prompt",
        {
          conversationId,
          clientMessageId,
          contentBlocks,
          model: options?.model,
          reasoningEffort: options?.reasoningEffort,
          permissionMode: options?.permissionMode,
          collaborationMode: options?.collaborationMode,
        },
        { queue: true },
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
    [manager],
  );

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
      if (!session) return;
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
        { queue: true },
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
    [manager],
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
        { queue: true, dedupeKey: `agent-v2-cancel:${conversationId}` },
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

  const updatePermissionMetadata = useCallback(
    (
      conversationId: string,
      requestId: string,
      metadata: Record<string, unknown>,
    ) => {
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
        console.warn("[LiveActivityAction] workspace respond missing conversation", { conversationId, requestId, outcome, optionId });
        return false;
      }
      const permissionItem = timelineRef.current
        .get(conversationId)
        ?.find((item) => item.type === "permission" && item.permission?.requestId === requestId);
      const sourceSessionId = resolvePermissionSessionId(conversation, permissionItem);
      if (!sourceSessionId) {
        console.warn("[LiveActivityAction] workspace respond no source session", {
          conversationId,
          requestId,
          outcome,
          optionId,
          protocol: permissionItem?.metadata?.protocol,
          conversationSessionId: conversation.sessionId,
        });
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
      console.log("[LiveActivityAction] workspace respond route", {
        conversationId,
        requestId,
        outcome,
        optionId,
        sourceSessionId,
        protocol,
      });
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
      } else {
        accepted = manager.sendAgentWorkspaceEnvelope(
          sourceSessionId,
          "agent.v2.permission.respond",
          { conversationId, requestId, outcome, optionId },
          { queue: true, dedupeKey: `agent-v2-permission:${requestId}`, claimControl: true },
        );
      }
      if (!accepted) {
        console.warn("[LiveActivityAction] workspace respond not accepted", {
          conversationId,
          requestId,
          outcome,
          optionId,
          sourceSessionId,
          protocol,
        });
        updatePermissionMetadata(conversationId, requestId, {
          permissionPending: false,
          permissionError: "授权未发送：连接未就绪，请稍后重试。",
        });
        return false;
      }
      console.log("[LiveActivityAction] workspace respond accepted", {
        conversationId,
        requestId,
        outcome,
        optionId,
        sourceSessionId,
        protocol,
      });
      updatePermissionMetadata(conversationId, requestId, {
        permissionPending: true,
        permissionLive: true,
        permissionExpired: false,
        pendingOutcome: outcome,
        optionId,
        permissionError: undefined,
      });
      persistConversation({
        ...conversation,
        status: "running",
        lastActivityAt: Date.now(),
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
      const accepted = manager.sendAgentWorkspaceEnvelope(
        conversation.sessionId,
        "agent.v2.structured_input.respond" as any,
        { conversationId, requestId, answers },
        { queue: true, dedupeKey: `agent-v2-input:${requestId}` },
      );
      updateTimelineItemMetadata(conversationId, `input:${requestId}`, accepted
        ? { inputSubmitting: true, inputError: undefined, answers }
        : { inputSubmitting: false, inputError: "回答未发送：连接未就绪，请稍后重试。" });
    },
    [manager, updateTimelineItemMetadata],
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
        pendingReadRef.current.set(requestId, { resolve, timer });
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

  return {
    conversations: conversations.filter((item) => !item.archived),
    archivedConversations: conversations.filter((item) => item.archived),
    activeConversationId,
    capabilitiesBySessionId,
    connectedSessions,
    refresh,
    requestCapabilities,
    openConversation,
    openProject,
    resumeConversation,
    ensureConversationSession,
    getConversation: (conversationId) =>
      conversationsRef.current.find((item) => item.id === conversationId),
    getTimeline: (conversationId) => timelineRef.current.get(conversationId) ?? [],
    sendPrompt,
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
  };
}
