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
  type AgentPermissionMode,
  type AgentReasoningEffort,
  type AgentTimelineItem,
} from "../storage/agent-workspace";

interface OpenConversationInput {
  sessionId: string;
  serverUrl?: string;
  cwd: string;
  title?: string;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  permissionMode?: AgentPermissionMode;
}

export interface AgentWorkspaceHandle {
  conversations: AgentConversationRecord[];
  archivedConversations: AgentConversationRecord[];
  activeConversationId: string | null;
  capabilitiesBySessionId: Map<string, AgentCapabilities>;
  connectedSessions: SessionInfo[];
  refresh: () => Promise<void>;
  requestCapabilities: (sessionId?: string) => void;
  openConversation: (input: OpenConversationInput) => Promise<string | null>;
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

  const persistConversation = useCallback(async (record: AgentConversationRecord) => {
    await upsertAgentConversation(record);
    setConversations((prev) => {
      const next = prev.filter((item) => item.id !== record.id);
      next.unshift(record);
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
        if (payload.item) {
          persistTimelineItem(payload.item as AgentTimelineItem).catch(() => {});
        }
      }
    },
    [persistConversation, persistTimelineItem],
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
      if (!serverUrl) return null;
      const conversationId = makeAgentConversationId({
        serverUrl,
        sessionId: input.sessionId,
        cwd: input.cwd,
      });
      const now = Date.now();
      const record: AgentConversationRecord = {
        id: conversationId,
        serverUrl,
        sessionId: input.sessionId,
        provider: "codex",
        cwd: input.cwd,
        title: input.title || input.cwd.split("/").filter(Boolean).pop() || "Agent",
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        permissionMode: input.permissionMode,
        status: "running",
        archived: false,
        lastActivityAt: now,
        createdAt: conversationsRef.current.find((item) => item.id === conversationId)?.createdAt ?? now,
        schemaVersion: 1,
      };
      await persistConversation(record);
      setActiveConversationId(conversationId);
      if (session) manager.setActiveSessionId(input.sessionId);
      manager.sendAgentWorkspaceEnvelope(
        input.sessionId,
        "agent.v2.conversation.open",
        {
          conversationId,
          cwd: input.cwd,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          permissionMode: input.permissionMode,
          title: record.title,
        },
        { queue: true, dedupeKey: `agent-v2-open:${conversationId}` },
      );
      return conversationId;
    },
    [manager, persistConversation],
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
        title: record.projectName,
      });
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
      });
      manager.sendAgentWorkspaceEnvelope(
        conversation.sessionId,
        "agent.v2.conversation.open",
        {
          conversationId: conversation.id,
          agentSessionId: conversation.agentSessionId,
          cwd: conversation.cwd,
          model: conversation.model,
          reasoningEffort: conversation.reasoningEffort,
          permissionMode: conversation.permissionMode,
          title: conversation.title,
        },
        { queue: true, dedupeKey: `agent-v2-open:${conversation.id}` },
      );
      setActiveConversationId(conversation.id);
      return conversation.id;
    },
    [manager, persistConversation],
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

  const respondPermission = useCallback(
    (
      conversationId: string,
      requestId: string,
      outcome: "allow" | "deny" | "cancelled",
      optionId?: string,
    ) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return;
      manager.sendAgentWorkspaceEnvelope(
        conversation.sessionId,
        "agent.v2.permission.respond",
        { conversationId, requestId, outcome, optionId },
        { queue: true, dedupeKey: `agent-v2-permission:${requestId}` },
      );
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
    getConversation: (conversationId) =>
      conversationsRef.current.find((item) => item.id === conversationId),
    getTimeline: (conversationId) => timelineRef.current.get(conversationId) ?? [],
    sendPrompt,
    cancel,
    respondPermission,
    archive,
    rename,
  };
}
