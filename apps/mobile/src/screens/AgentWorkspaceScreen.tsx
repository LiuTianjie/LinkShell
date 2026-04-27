import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import type { AgentWorkspaceHandle } from "../hooks/useAgentWorkspace";
import type { SessionInfo } from "../hooks/useSessionManager";
import type { AgentConversationRecord } from "../storage/agent-workspace";
import { loadProjects, type ProjectRecord } from "../storage/projects";
import { useTheme, type Theme } from "../theme";

interface AgentWorkspaceScreenProps {
  workspace: AgentWorkspaceHandle;
  sessions?: SessionInfo[];
  refreshKey?: number;
  onOpenConnectionSheet: () => void;
  onOpenConversation: (conversationId: string) => void;
}

function statusMeta(status: string, theme: Theme) {
  switch (status) {
    case "running":
      return { label: "运行中", color: theme.accent, bg: theme.accentLight };
    case "waiting_permission":
      return { label: "待授权", color: theme.warning, bg: theme.accentLight };
    case "error":
      return { label: "错误", color: theme.error, bg: theme.errorLight };
    case "idle":
      return { label: "空闲", color: theme.success, bg: theme.accentLight };
    default:
      return { label: "不可用", color: theme.textTertiary, bg: theme.bgInput };
  }
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

function conversationGroupKey(conversation: AgentConversationRecord): string {
  return [
    conversation.serverUrl.replace(/\/+$/, ""),
    conversation.sessionId,
    conversation.cwd || conversation.agentSessionId || conversation.id,
  ].join("\u0000");
}

function conversationRank(
  conversation: AgentConversationRecord,
  timelineLength: number,
): number {
  const statusRank =
    conversation.status === "waiting_permission" ? 60 :
    conversation.status === "running" ? 50 :
    conversation.status === "idle" ? 20 :
    conversation.status === "error" ? 10 :
    0;
  return (
    timelineLength * 1000 +
    (conversation.agentSessionId ? 200 : 0) +
    (conversation.lastMessagePreview ? 100 : 0) +
    statusRank
  );
}

function collapseDuplicateConversations(
  conversations: AgentConversationRecord[],
  getTimelineLength: (conversationId: string) => number,
): AgentConversationRecord[] {
  const bestByKey = new Map<string, AgentConversationRecord>();
  for (const conversation of conversations) {
    const key = conversationGroupKey(conversation);
    const current = bestByKey.get(key);
    if (!current) {
      bestByKey.set(key, conversation);
      continue;
    }
    const currentRank = conversationRank(current, getTimelineLength(current.id));
    const nextRank = conversationRank(conversation, getTimelineLength(conversation.id));
    if (
      nextRank > currentRank ||
      (nextRank === currentRank && conversation.lastActivityAt > current.lastActivityAt)
    ) {
      bestByKey.set(key, conversation);
    }
  }
  return [...bestByKey.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

function isEmptyFallbackConversation(
  conversation: AgentConversationRecord,
  timelineLength: number,
): boolean {
  return (
    conversation.cwd === "~" &&
    !conversation.agentSessionId &&
    !conversation.lastMessagePreview &&
    timelineLength === 0
  );
}

function SectionTitle({ children, theme }: { children: React.ReactNode; theme: Theme }) {
  return (
    <Text
      style={{
        color: theme.textTertiary,
        fontSize: 12,
        fontWeight: "700",
        textTransform: "uppercase",
        paddingHorizontal: 20,
      }}
    >
      {children}
    </Text>
  );
}

export function AgentWorkspaceScreen({
  workspace,
  sessions,
  refreshKey,
  onOpenConnectionSheet,
  onOpenConversation,
}: AgentWorkspaceScreenProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [showArchived, setShowArchived] = useState(false);

  const availableSessions = useMemo(
    () =>
      (sessions ?? workspace.connectedSessions).filter((session) =>
        session.status === "connected" ||
        session.status === "connecting" ||
        session.status === "reconnecting" ||
        session.status === "host_disconnected",
      ),
    [sessions, workspace.connectedSessions],
  );

  const sessionSignature = useMemo(
    () => availableSessions.map((session) => `${session.sessionId}:${session.status}`).join("|"),
    [availableSessions],
  );

  useEffect(() => {
    loadProjects().then((items) => setProjects(items.slice(0, 6))).catch(() => {});
  }, [workspace.conversations.length, refreshKey, sessionSignature]);

  useEffect(() => {
    for (const session of availableSessions) {
      workspace.requestCapabilities(session.sessionId);
    }
  }, [sessionSignature, workspace.requestCapabilities]);

  const connectedSessionIds = useMemo(
    () => new Set(availableSessions.map((session) => session.sessionId)),
    [availableSessions],
  );

  const visibleConversations = useMemo(
    () =>
      collapseDuplicateConversations(
        showArchived ? workspace.archivedConversations : workspace.conversations,
        (conversationId) => workspace.getTimeline(conversationId).length,
      ).filter((conversation) =>
        !isEmptyFallbackConversation(conversation, workspace.getTimeline(conversation.id).length),
      ),
    [showArchived, workspace],
  );
  const recentProjects = projects.slice(0, 6);
  const hasResumeTarget = recentProjects.length > 0 || visibleConversations.length > 0;

  const openProject = useCallback(
    async (project: ProjectRecord) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const id = await workspace.openProject(project);
      if (id) onOpenConversation(id);
    },
    [onOpenConversation, workspace],
  );

  const openConversation = useCallback(
    async (conversationId: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const id = await workspace.resumeConversation(conversationId);
      if (id) onOpenConversation(id);
    },
    [onOpenConversation, workspace],
  );

  const startFromSession = useCallback(async () => {
    const session = availableSessions[0];
    if (!session) {
      const project = recentProjects[0];
      if (project) {
        const id = await workspace.openProject(project);
        if (id) onOpenConversation(id);
        return;
      }
      const conversation = visibleConversations[0];
      if (conversation) {
        const id = await workspace.resumeConversation(conversation.id);
        if (id) onOpenConversation(id);
        return;
      }
      onOpenConnectionSheet();
      return;
    }
    const project = recentProjects.find((item) => item.sessionId === session.sessionId);
    const cwd = session.cwd || [...session.terminals.values()][0]?.cwd || project?.cwd || "~";
    const id = await workspace.openConversation({
      sessionId: session.sessionId,
      serverUrl: session.gatewayUrl,
      cwd,
      title: session.projectName || project?.projectName || session.hostname || "Agent",
    });
    if (id) onOpenConversation(id);
  }, [availableSessions, onOpenConnectionSheet, onOpenConversation, recentProjects, visibleConversations, workspace]);

  const primaryTitle =
    availableSessions.length > 0
      ? "新建 Agent 对话"
      : hasResumeTarget
        ? "继续 Agent 对话"
        : "连接 Mac";
  const primarySubtitle =
    availableSessions.length > 0
      ? `${availableSessions[0]?.hostname ?? "本机"} · ${availableSessions.length} 个可用会话`
      : hasResumeTarget
        ? "复用已有配对恢复会话，无需重新扫码"
        : "首次使用需要连接 CLI";

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: Math.max(insets.bottom, 18) + 12,
          gap: 18,
        }}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={{ paddingHorizontal: 20, gap: 6 }}>
          <Text style={{ color: theme.text, fontSize: 34, fontWeight: "800" }}>
            Agent
          </Text>
          <Text style={{ color: theme.textTertiary, fontSize: 14, lineHeight: 20 }}>
            像 Codex 客户端一样管理远程 Agent 对话。
          </Text>
        </View>

        <View style={{ paddingHorizontal: 20 }}>
          <Pressable
            onPress={startFromSession}
            style={({ pressed }) => ({
              borderRadius: 14,
              borderCurve: "continuous",
              backgroundColor: pressed ? theme.accentSecondary : theme.accent,
              padding: 16,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
            })}
          >
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(255,255,255,0.16)",
              }}
            >
              {availableSessions.length > 0 ? (
                <AppSymbol name="sparkles" size={17} color="#fff" />
              ) : hasResumeTarget ? (
                <AppSymbol name="arrow.clockwise" size={17} color="#fff" />
              ) : (
                <AppSymbol name="plus" size={17} color="#fff" />
              )}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: "#fff", fontSize: 17, fontWeight: "700" }}>
                {primaryTitle}
              </Text>
              <Text style={{ color: "rgba(255,255,255,0.78)", fontSize: 13, marginTop: 2 }} numberOfLines={1}>
                {primarySubtitle}
              </Text>
            </View>
            <AppSymbol name="chevron.right" size={16} color="rgba(255,255,255,0.9)" />
          </Pressable>
        </View>

        {availableSessions.length > 0 ? (
          <View style={{ gap: 8 }}>
            <SectionTitle theme={theme}>在线 Mac</SectionTitle>
            <View style={{ paddingHorizontal: 20, gap: 8 }}>
              {availableSessions.map((session) => {
                const caps = workspace.capabilitiesBySessionId.get(session.sessionId);
                const meta = statusMeta(
                  caps?.enabled
                    ? "idle"
                    : session.status === "host_disconnected"
                      ? "unavailable"
                      : "running",
                  theme,
                );
                return (
                  <View
                    key={session.sessionId}
                    style={{
                      borderRadius: 12,
                      borderCurve: "continuous",
                      backgroundColor: theme.bgCard,
                      padding: 12,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <View
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 5,
                        backgroundColor: caps?.enabled ? theme.success : theme.textTertiary,
                      }}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }} numberOfLines={1}>
                        {session.hostname || session.projectName || session.sessionId.slice(0, 8)}
                      </Text>
                      <Text style={{ color: theme.textTertiary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                        {caps?.enabled ? `${caps.provider ?? "agent"} · Workspace 已连接` : caps?.error ?? "等待 Agent 能力"}
                      </Text>
                    </View>
                    {!caps ? <ActivityIndicator size="small" color={theme.textTertiary} /> : (
                      <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: meta.bg }}>
                        <Text style={{ color: meta.color, fontSize: 11, fontWeight: "700" }}>{meta.label}</Text>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        ) : null}

        {recentProjects.length > 0 ? (
          <View style={{ gap: 8 }}>
            <SectionTitle theme={theme}>最近项目</SectionTitle>
            <View style={{ paddingHorizontal: 20, gap: 8 }}>
              {recentProjects.slice(0, 4).map((project) => {
                const online = connectedSessionIds.has(project.sessionId);
                return (
                <Pressable
                  key={project.id}
                  onPress={() => openProject(project)}
                  style={({ pressed }) => ({
                    borderRadius: 12,
                    borderCurve: "continuous",
                    backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                    padding: 12,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                  })}
                >
                  <AppSymbol name="folder.fill" size={18} color={theme.accent} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }} numberOfLines={1}>
                      {project.projectName || project.cwd.split("/").filter(Boolean).pop() || project.cwd}
                    </Text>
                    <Text style={{ color: theme.textTertiary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                      {[project.hostname, shortPath(project.cwd), online ? "在线" : "可恢复"].filter(Boolean).join(" · ")}
                    </Text>
                  </View>
                  <AppSymbol name="chevron.right" size={14} color={theme.textTertiary} />
                </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}

        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20 }}>
            <Text
              style={{
                color: theme.textTertiary,
                fontSize: 12,
                fontWeight: "700",
                textTransform: "uppercase",
              }}
            >
              {showArchived ? "已归档" : "最近对话"}
            </Text>
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => setShowArchived((value) => !value)} hitSlop={8}>
              <Text style={{ color: theme.accent, fontSize: 13, fontWeight: "700" }}>
                {showArchived ? "返回最近" : "查看归档"}
              </Text>
            </Pressable>
          </View>
          <View style={{ paddingHorizontal: 20, gap: 8 }}>
            {visibleConversations.length === 0 ? (
              <View
                style={{
                  borderRadius: 12,
                  borderCurve: "continuous",
                  backgroundColor: theme.bgCard,
                  padding: 18,
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <AppSymbol name="bubble.left.and.text.bubble.right" size={24} color={theme.accent} />
                <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>
                  还没有 Agent 对话
                </Text>
                <Text style={{ color: theme.textTertiary, fontSize: 13, lineHeight: 18, textAlign: "center" }}>
                  从在线 Mac 或最近项目新建一个对话，工具调用和代码输出会在这里保留入口。
                </Text>
              </View>
            ) : visibleConversations.map((conversation) => {
              const meta = statusMeta(conversation.status, theme);
              return (
                <Pressable
                  key={conversation.id}
                  onPress={() => openConversation(conversation.id)}
                  style={({ pressed }) => ({
                    borderRadius: 12,
                    borderCurve: "continuous",
                    backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                    padding: 12,
                    gap: 8,
                  })}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ flex: 1, color: theme.text, fontSize: 16, fontWeight: "700" }} numberOfLines={1}>
                      {conversation.title || conversation.cwd.split("/").filter(Boolean).pop() || "Agent"}
                    </Text>
                    <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: meta.bg }}>
                      <Text style={{ color: meta.color, fontSize: 11, fontWeight: "700" }}>{meta.label}</Text>
                    </View>
                  </View>
                  <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }} numberOfLines={2}>
                    {conversation.lastMessagePreview || "新的 Agent 对话"}
                  </Text>
                  <Text style={{ color: theme.textTertiary, fontSize: 12 }} numberOfLines={1}>
                    {[conversation.provider, shortPath(conversation.cwd)].filter(Boolean).join(" · ")}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
