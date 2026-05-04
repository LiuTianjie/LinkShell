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
  sessionId: string;
  serverUrl?: string;
  cwd: string;
  provider?: AgentProvider;
  title?: string;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  permissionMode?: AgentPermissionMode;
}

export interface OpenConversationResult {
  conversationId: string | null;
  status?: AgentConversationRecord["status"];
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
  getConversation: (conversationId: string) => AgentConversationRecord | undefined;
  getTimeline: (conversationId: string) => AgentTimelineItem[];
  sendPrompt: (
    conversationId: string,
    text: string,
    options?: {
      model?: string;
      reasoningEffort?: AgentReasoningEffort;
      permissionMode?: AgentPermissionMode;
      attachments?: AgentContentBlock[];
    },
  ) => void;
  cancel: (conversationId: string) => void;
  respondPermission: (
    conversationId: string,
    requestId: string,
    outcome: "allow" | "deny" | "cancelled",
    optionId?: string,
  ) => void;
  respondStructuredInput: (
    conversationId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ) => void;
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
    await upsertAgentTimelineItem(item);
    setTimelineById((prev) => {
      const next = new Map(prev);
      next.set(item.conversationId, mergeTimeline(next.get(item.conversationId) ?? [], [item]));
      return next;
    });
  }, []);

  const sessionForConversation = useCallback(
    (conversationId: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      return conversation ? manager.sessions.get(conversation.sessionId) : undefined;
    },
    [manager.sessions],
  );

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
      const serverSession = managerRef.current.sessions.get(envelope.sessionId);
      const serverUrl = normalizeServerUrl(serverSession?.gatewayUrl ?? "");
      const toRecord = (conversation: any): AgentConversationRecord => ({
        id: conversation.id,
        serverUrl,
        sessionId: envelope.sessionId,
        agentSessionId: conversation.agentSessionId,
        provider: conversation.provider ?? "codex",
        cwd: conversation.cwd ?? serverSession?.cwd ?? "",
        title: conversation.title,
        model: conversation.model,
        reasoningEffort: conversation.reasoningEffort,
        permissionMode: conversation.permissionMode,
        status: conversation.status ?? "idle",
        archived: Boolean(conversation.archived),
        lastMessagePreview: conversation.lastMessagePreview,
        lastActivityAt: conversation.lastActivityAt ?? Date.now(),
        createdAt: conversation.createdAt ?? Date.now(),
        schemaVersion: 1,
      });

      if (envelope.type === "agent.v2.capabilities") {
        const payload = parseTypedPayload("agent.v2.capabilities", envelope.payload) as AgentCapabilities;
        setCapabilitiesBySessionId((prev) => {
          const next = new Map(prev);
          next.set(envelope.sessionId, payload);
          return next;
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
        const items = (payload.snapshot ?? []) as AgentTimelineItem[];
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
        for (const item of (payload.items ?? []) as AgentTimelineItem[]) {
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

      if (envelope.type === "agent.permission.request") {
        const payload = parseTypedPayload("agent.permission.request" as any, envelope.payload) as any;
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
          },
          createdAt: Date.now(),
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

      if (envelope.type === "terminal.status") {
        const payload = envelope.payload as {
          phase?: string;
          topPermission?: {
            requestId?: string;
            toolName?: string;
            toolInput?: string;
            permissionRequest?: string;
            timestamp?: number;
          };
        };
        const topPermission = payload.topPermission;
        if (!topPermission?.requestId) return;
        const terminalId = typeof (envelope as any).terminalId === "string"
          ? (envelope as any).terminalId
          : "default";
        const conversation =
          conversationsRef.current.find((item) => item.id === activeConversationId && item.sessionId === envelope.sessionId) ??
          conversationsRef.current.find((item) =>
            item.sessionId === envelope.sessionId &&
            !item.archived &&
            (item.status === "running" || item.status === "waiting_permission"),
          ) ??
          conversationsRef.current.find((item) => item.sessionId === envelope.sessionId && !item.archived);
        if (!conversation) return;
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
            sessionId: envelope.sessionId,
            terminalId,
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
          sessionId: input.sessionId,
          agentSessionId: input.agentSessionId,
          cwd: input.cwd,
        });
      setActiveConversationId(conversationId);
      if (session) manager.setActiveSessionId(input.sessionId);
      return await new Promise<OpenConversationResult>((resolve) => {
        const timer = setTimeout(() => {
          pendingOpenRef.current.delete(conversationId);
          resolve({
            conversationId: null,
            error: "CLI 没有在 12 秒内确认对话，请确认 Mac 端 linkshell 仍在线。",
          });
        }, 12_000);
        pendingOpenRef.current.set(conversationId, { resolve, timer });
        manager.sendAgentWorkspaceEnvelope(
          input.sessionId,
          "agent.v2.conversation.open",
          {
            conversationId,
            agentSessionId: input.agentSessionId,
            cwd: input.cwd,
            provider: input.provider ?? "codex",
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            permissionMode: input.permissionMode,
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
      if (!manager.sessions.has(record.sessionId)) {
        manager.connectToSession(record.sessionId, record.serverUrl);
      } else {
        manager.setActiveSessionId(record.sessionId);
      }
      return openConversation({
        sessionId: record.sessionId,
        serverUrl: record.serverUrl,
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
      if (!manager.sessions.has(conversation.sessionId)) {
        manager.connectToSession(conversation.sessionId, conversation.serverUrl);
      } else {
        manager.setActiveSessionId(conversation.sessionId);
      }
      await persistConversation({
        ...conversation,
        archived: false,
        lastActivityAt: Date.now(),
      }, { preserveLocalArchived: false });
      const result = await openConversation({
        conversationId: conversation.id,
        agentSessionId: conversation.agentSessionId,
        sessionId: conversation.sessionId,
        serverUrl: conversation.serverUrl,
        cwd: conversation.cwd,
        provider: conversation.provider,
        model: conversation.model,
        reasoningEffort: conversation.reasoningEffort,
        permissionMode: conversation.permissionMode,
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
      manager.sendAgentWorkspaceEnvelope(
        conversation.sessionId,
        "agent.v2.prompt",
        {
          conversationId,
          clientMessageId,
          contentBlocks,
          model: options?.model,
          reasoningEffort: options?.reasoningEffort,
          permissionMode: options?.permissionMode,
        },
        { queue: true },
      );
    },
    [manager],
  );

  const cancel = useCallback(
    (conversationId: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return;
      manager.sendAgentWorkspaceEnvelope(
        conversation.sessionId,
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
      if (manager.sessions.has(conversation.sessionId)) return conversation.sessionId;

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
      if (!conversation) return;
      const permissionItem = timelineRef.current
        .get(conversationId)
        ?.find((item) => item.type === "permission" && item.permission?.requestId === requestId);
      const sourceSessionId = resolvePermissionSessionId(conversation, permissionItem);
      if (!sourceSessionId) {
        updatePermissionMetadata(conversationId, requestId, {
          permissionError: "授权未发送：设备连接已失效，请重新打开会话。",
        });
        return;
      }
      let accepted = false;
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
          permissionError: "授权未发送：连接未就绪，请稍后重试。",
        });
        return;
      }
      updatePermissionMetadata(conversationId, requestId, {
        permissionOutcome: outcome,
        optionId,
        permissionError: undefined,
      });
      persistConversation({
        ...conversation,
        status: "running",
        lastActivityAt: Date.now(),
      }).catch(() => {});
    },
    [manager, persistConversation, resolvePermissionSessionId, updatePermissionMetadata],
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
        { queue: true, dedupeKey: `agent-v2-input:${requestId}`, claimControl: true },
      );
      updateTimelineItemMetadata(conversationId, `input:${requestId}`, accepted
        ? { inputPending: false, inputSubmitted: true, inputError: undefined, answers }
        : { inputError: "回答未发送：连接未就绪，请稍后重试。" });
    },
    [manager, updateTimelineItemMetadata],
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
    getConversation: (conversationId) =>
      conversationsRef.current.find((item) => item.id === conversationId),
    getTimeline: (conversationId) => timelineRef.current.get(conversationId) ?? [],
    sendPrompt,
    cancel,
    respondPermission,
    respondStructuredInput,
    archive,
    rename,
  };
}
