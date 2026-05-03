import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import type { AgentWorkspaceHandle } from "../hooks/useAgentWorkspace";
import type { SessionInfo } from "../hooks/useSessionManager";
import type {
  AgentCapabilities,
  AgentConversationRecord,
  AgentProvider,
  AgentProviderCapability,
} from "../storage/agent-workspace";
import { loadHistory, type ConnectionRecord } from "../storage/history";
import { loadProjects, touchProject, type ProjectRecord } from "../storage/projects";
import { useTheme, type Theme } from "../theme";

interface AgentWorkspaceScreenProps {
  workspace: AgentWorkspaceHandle;
  sessions?: SessionInfo[];
  refreshKey?: number;
  onOpenConnectionSheet: () => void;
  onOpenConversation: (conversationId: string) => void;
}

interface AgentTarget {
  sessionId: string;
  serverUrl: string;
  hostname?: string;
  cwd?: string;
  projectName?: string;
  status: "online" | "recoverable";
}

const PROVIDER_META: Record<AgentProvider, { label: string; subtitle: string }> = {
  codex: { label: "Codex", subtitle: "默认可视化 Agent" },
  claude: { label: "Claude", subtitle: "需要 CLI ACP adapter" },
  custom: { label: "Custom", subtitle: "自定义 ACP adapter" },
};

function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

function titleFromCwd(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() || cwd || "Agent";
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

function conversationGroupKey(conversation: AgentConversationRecord): string {
  return [
    normalizeServerUrl(conversation.serverUrl),
    conversation.sessionId,
    conversation.agentSessionId || conversation.cwd || conversation.id,
  ].join("\u0000");
}

function collapseDuplicateConversations(
  conversations: AgentConversationRecord[],
  getTimelineLength: (conversationId: string) => number,
): AgentConversationRecord[] {
  const bestByKey = new Map<string, AgentConversationRecord>();
  for (const conversation of conversations) {
    const timelineLength = getTimelineLength(conversation.id);
    if (
      !conversation.agentSessionId &&
      !conversation.lastMessagePreview &&
      timelineLength === 0
    ) {
      continue;
    }

    const key = conversationGroupKey(conversation);
    const current = bestByKey.get(key);
    if (!current) {
      bestByKey.set(key, conversation);
      continue;
    }
    const currentScore =
      getTimelineLength(current.id) * 1000 +
      (current.agentSessionId ? 200 : 0) +
      (current.lastMessagePreview ? 100 : 0);
    const nextScore =
      timelineLength * 1000 +
      (conversation.agentSessionId ? 200 : 0) +
      (conversation.lastMessagePreview ? 100 : 0);
    if (nextScore > currentScore || conversation.lastActivityAt > current.lastActivityAt) {
      bestByKey.set(key, conversation);
    }
  }
  return [...bestByKey.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

function providerCapability(
  capabilities: AgentCapabilities | undefined,
  provider: AgentProvider,
): AgentProviderCapability | undefined {
  return capabilities?.providers?.find((item) => item.id === provider);
}

function providerOptions(
  capabilities: AgentCapabilities | undefined,
): AgentProviderCapability[] {
  if (capabilities?.providers?.length) {
    return capabilities.providers.map((item) => ({
      ...item,
      label: item.label || PROVIDER_META[item.id].label,
    }));
  }
  if (capabilities?.provider) {
    const provider = capabilities.provider;
    return [{
      id: provider,
      label: PROVIDER_META[provider].label,
      enabled: capabilities.enabled,
      reason: capabilities.enabled ? undefined : capabilities.error,
      supportsImages: capabilities.supportsImages,
      supportsPermission: capabilities.supportsPermission,
      supportsPlan: capabilities.supportsPlan,
      supportsCancel: capabilities.supportsCancel,
    }];
  }
  return [];
}

function providerReason(
  capabilities: AgentCapabilities | undefined,
  provider: AgentProvider,
  targetStatus?: AgentTarget["status"],
): string | undefined {
  const specific = providerCapability(capabilities, provider);
  if (specific?.reason) return specific.reason;
  if (!capabilities) {
    return targetStatus === "online"
      ? "正在确认 Agent 能力，请稍候。"
      : "需要先连接 Mac 并确认 Agent 能力。";
  }
  if (provider === "claude") return "Claude 需要在 CLI 侧配置 ACP command 后才能使用。";
  if (provider === "custom") return "Custom Agent 需要在 CLI 侧配置 ACP command 后才能使用。";
  return capabilities?.error;
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
  const [history, setHistory] = useState<ConnectionRecord[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>("codex");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [customCwd, setCustomCwd] = useState("");
  const [creating, setCreating] = useState(false);

  const onlineSessions = useMemo(
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
    () => onlineSessions.map((session) => `${session.sessionId}:${session.status}`).join("|"),
    [onlineSessions],
  );

  useEffect(() => {
    Promise.all([loadProjects(), loadHistory()])
      .then(([projectItems, historyItems]) => {
        setProjects(projectItems);
        setHistory(historyItems);
      })
      .catch(() => {});
  }, [workspace.conversations.length, refreshKey, sessionSignature]);

  useEffect(() => {
    for (const session of onlineSessions) {
      workspace.requestCapabilities(session.sessionId);
    }
  }, [onlineSessions, sessionSignature, workspace.requestCapabilities]);

  const targets = useMemo(() => {
    const bySession = new Map<string, AgentTarget>();
    for (const session of onlineSessions) {
      bySession.set(session.sessionId, {
        sessionId: session.sessionId,
        serverUrl: session.gatewayUrl,
        hostname: session.hostname ?? session.projectName ?? session.sessionId.slice(0, 8),
        cwd: session.cwd || [...session.terminals.values()][0]?.cwd || undefined,
        projectName: session.projectName ?? undefined,
        status: "online",
      });
    }
    for (const project of projects) {
      if (bySession.has(project.sessionId)) {
        const existing = bySession.get(project.sessionId)!;
        bySession.set(project.sessionId, {
          ...existing,
          hostname: existing.hostname ?? project.hostname,
          cwd: existing.cwd ?? project.cwd,
          projectName: existing.projectName ?? project.projectName,
        });
        continue;
      }
      bySession.set(project.sessionId, {
        sessionId: project.sessionId,
        serverUrl: project.serverUrl,
        hostname: project.hostname ?? project.sessionId.slice(0, 8),
        cwd: project.cwd,
        projectName: project.projectName,
        status: "recoverable",
      });
    }
    for (const record of history) {
      if (bySession.has(record.sessionId)) continue;
      bySession.set(record.sessionId, {
        sessionId: record.sessionId,
        serverUrl: record.serverUrl,
        hostname: record.hostname ?? record.sessionId.slice(0, 8),
        cwd: record.cwd || "~",
        projectName: record.projectName,
        status: "recoverable",
      });
    }
    return [...bySession.values()].sort((a, b) => {
      if (a.status !== b.status) return a.status === "online" ? -1 : 1;
      return (a.hostname ?? "").localeCompare(b.hostname ?? "");
    });
  }, [history, onlineSessions, projects]);

  const selectedTarget = useMemo(
    () => targets.find((target) => target.sessionId === selectedSessionId) ?? targets[0],
    [selectedSessionId, targets],
  );
  const selectedCapabilities = selectedTarget?.status === "online"
    ? workspace.capabilitiesBySessionId.get(selectedTarget.sessionId)
    : undefined;
  const targetProjects = useMemo(
    () =>
      projects
        .filter((project) => !selectedTarget || project.sessionId === selectedTarget.sessionId)
        .slice(0, 6),
    [projects, selectedTarget],
  );
  const selectedProject = targetProjects.find((project) => project.id === selectedProjectId);
  const effectiveCwd = (customCwd.trim() || selectedProject?.cwd || selectedTarget?.cwd || "").trim();
  const providerChoices = useMemo(
    () => {
      const choices = providerOptions(selectedCapabilities);
      if (choices.length > 0) return choices;
      return [{
        id: selectedProvider,
        label: PROVIDER_META[selectedProvider].label,
        enabled: false,
        reason: providerReason(selectedCapabilities, selectedProvider, selectedTarget?.status),
      }];
    },
    [selectedCapabilities, selectedProvider, selectedTarget?.status],
  );
  const selectedProviderChoice = providerChoices.find((provider) => provider.id === selectedProvider);
  const selectedProviderEnabled = Boolean(selectedProviderChoice?.enabled);
  const selectedProviderReason =
    selectedProviderChoice?.reason ??
    providerReason(selectedCapabilities, selectedProvider, selectedTarget?.status);

  useEffect(() => {
    if (!createVisible) return;
    const nextTarget = selectedTarget ?? targets[0];
    if (nextTarget && selectedSessionId !== nextTarget.sessionId) {
      setSelectedSessionId(nextTarget.sessionId);
    }
    const firstProject = projects.find((project) => project.sessionId === nextTarget?.sessionId);
    if (!selectedProjectId && firstProject) setSelectedProjectId(firstProject.id);
    if (!customCwd && !firstProject && nextTarget?.cwd) setCustomCwd(nextTarget.cwd);
    const enabledProvider = providerChoices.find((provider) => provider.enabled);
    const selectedStillExists = providerChoices.some((provider) => provider.id === selectedProvider);
    const nextProvider = enabledProvider?.id ?? (selectedStillExists ? selectedProvider : providerChoices[0]?.id);
    if (nextProvider && nextProvider !== selectedProvider) setSelectedProvider(nextProvider);
  }, [
    createVisible,
    customCwd,
    projects,
    providerChoices,
    selectedProjectId,
    selectedProvider,
    selectedSessionId,
    selectedTarget,
    targets,
  ]);

  const visibleConversations = useMemo(
    () =>
      collapseDuplicateConversations(
        showArchived ? workspace.archivedConversations : workspace.conversations,
        (conversationId) => workspace.getTimeline(conversationId).length,
      ),
    [showArchived, workspace],
  );

  const openCreate = useCallback((project?: ProjectRecord) => {
    if (targets.length === 0 && !project) {
      onOpenConnectionSheet();
      return;
    }
    if (project) {
      setSelectedSessionId(project.sessionId);
      setSelectedProjectId(project.id);
      setCustomCwd(project.cwd);
    } else {
      const target = selectedTarget ?? targets[0];
      setSelectedSessionId(target?.sessionId ?? null);
      const projectForTarget = projects.find((item) => item.sessionId === target?.sessionId);
      setSelectedProjectId(projectForTarget?.id ?? null);
      setCustomCwd(projectForTarget?.cwd ?? target?.cwd ?? "");
    }
    setSelectedProvider("codex");
    setCreateVisible(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, [onOpenConnectionSheet, projects, selectedTarget, targets]);

  const createConversation = useCallback(async () => {
    if (!selectedTarget) {
      onOpenConnectionSheet();
      return;
    }
    if (!selectedProviderEnabled) {
      Alert.alert("Agent 不可用", selectedProviderReason ?? "当前会话未启用这个 Agent。");
      return;
    }
    if (!effectiveCwd) {
      Alert.alert("请选择工作目录", "可以从最近项目选择，也可以手动输入一个目录。");
      return;
    }
    setCreating(true);
    try {
      const result = await workspace.openConversation({
        sessionId: selectedTarget.sessionId,
        serverUrl: selectedTarget.serverUrl,
        cwd: effectiveCwd,
        provider: selectedProvider,
        title: selectedProject?.projectName || titleFromCwd(effectiveCwd),
      });
      if (!result.conversationId) {
        Alert.alert("无法创建 Agent 对话", result.error ?? "CLI 没有确认对话，请确认 Mac 端 linkshell 仍在线。");
        return;
      }
      touchProject({
        serverUrl: selectedTarget.serverUrl,
        sessionId: selectedTarget.sessionId,
        cwd: effectiveCwd,
      }).catch(() => {});
      setCreateVisible(false);
      onOpenConversation(result.conversationId);
    } catch (error) {
      Alert.alert("无法创建 Agent 对话", error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }, [
    effectiveCwd,
    onOpenConnectionSheet,
    onOpenConversation,
    selectedCapabilities,
    selectedProject?.projectName,
    selectedProvider,
    selectedProviderEnabled,
    selectedProviderReason,
    selectedTarget,
    workspace,
  ]);

  const openConversation = useCallback(
    async (conversationId: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      const id = await workspace.resumeConversation(conversationId);
      if (id) onOpenConversation(id);
    },
    [onOpenConversation, workspace],
  );

  const recentProjects = projects.slice(0, 6);

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
            选择 Agent 和工作目录，在已连接的 Mac 上开始可视化对话。
          </Text>
        </View>

        <View style={{ paddingHorizontal: 20 }}>
          <Pressable
            onPress={() => openCreate()}
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
              <AppSymbol name={targets.length > 0 ? "sparkles" : "plus"} size={17} color="#fff" />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: "#fff", fontSize: 17, fontWeight: "700" }}>
                {targets.length > 0 ? "新建 Agent 对话" : "连接 Mac"}
              </Text>
              <Text style={{ color: "rgba(255,255,255,0.78)", fontSize: 13, marginTop: 2 }} numberOfLines={1}>
                {targets.length > 0 ? "选择 Codex / Claude 和工作目录" : "首次使用需要先配对 CLI"}
              </Text>
            </View>
            <AppSymbol name="chevron.right" size={16} color="rgba(255,255,255,0.9)" />
          </Pressable>
        </View>

        {targets.length > 0 ? (
          <View style={{ gap: 8 }}>
            <SectionTitle theme={theme}>可用 Mac</SectionTitle>
            <View style={{ paddingHorizontal: 20, gap: 8 }}>
              {targets.map((target) => {
                const caps = workspace.capabilitiesBySessionId.get(target.sessionId);
                const online = target.status === "online";
                return (
                  <Pressable
                    key={`${target.serverUrl}:${target.sessionId}`}
                    onPress={() => openCreate(projects.find((project) => project.sessionId === target.sessionId))}
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
                    <View
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 5,
                        backgroundColor: online ? theme.success : theme.textTertiary,
                      }}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }} numberOfLines={1}>
                        {target.hostname || target.sessionId.slice(0, 8)}
                      </Text>
                      <Text style={{ color: theme.textTertiary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                        {online
                          ? caps?.enabled
                            ? `${caps.provider ?? "codex"} · Agent 已就绪`
                            : caps?.error ?? "连接中，创建时会自动确认能力"
                          : `${shortPath(target.cwd ?? "~")} · 可恢复，无需重新扫码`}
                      </Text>
                    </View>
                    {online && !caps ? <ActivityIndicator size="small" color={theme.textTertiary} /> : null}
                    <AppSymbol name="chevron.right" size={14} color={theme.textTertiary} />
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}

        {recentProjects.length > 0 ? (
          <View style={{ gap: 8 }}>
            <SectionTitle theme={theme}>最近项目</SectionTitle>
            <View style={{ paddingHorizontal: 20, gap: 8 }}>
              {recentProjects.map((project) => {
                const online = onlineSessions.some((session) => session.sessionId === project.sessionId);
                return (
                  <Pressable
                    key={project.id}
                    onPress={() => openCreate(project)}
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
                        {project.projectName || titleFromCwd(project.cwd)}
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
                  新建对话时先选 Agent 和工作目录，确认创建后才会出现在这里。
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
                      {conversation.title || titleFromCwd(conversation.cwd)}
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

      <Modal
        visible={createVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => !creating && setCreateVisible(false)}
      >
        <View style={{ flex: 1, backgroundColor: theme.bg }}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingTop: insets.top + 18,
              paddingHorizontal: 20,
              paddingBottom: Math.max(insets.bottom, 18) + 20,
              gap: 18,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.text, fontSize: 26, fontWeight: "800" }}>
                  新建 Agent 对话
                </Text>
                <Text style={{ color: theme.textTertiary, fontSize: 13, marginTop: 4 }}>
                  已有会话会直接复用，不需要再次扫码。
                </Text>
              </View>
              <Pressable
                disabled={creating}
                onPress={() => setCreateVisible(false)}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.bgInput,
                }}
              >
                <AppSymbol name="xmark" size={14} color={theme.textSecondary} />
              </Pressable>
            </View>

            <View style={{ gap: 9 }}>
              <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
                Mac
              </Text>
              {targets.map((target) => {
                const selected = target.sessionId === selectedTarget?.sessionId;
                return (
                  <Pressable
                    key={`${target.serverUrl}:${target.sessionId}`}
                    onPress={() => {
                      setSelectedSessionId(target.sessionId);
                      const project = projects.find((item) => item.sessionId === target.sessionId);
                      setSelectedProjectId(project?.id ?? null);
                      setCustomCwd(project?.cwd ?? target.cwd ?? "");
                    }}
                    style={({ pressed }) => ({
                      borderRadius: 12,
                      borderCurve: "continuous",
                      borderWidth: selected ? 1.5 : StyleSheet.hairlineWidth,
                      borderColor: selected ? theme.accent : theme.separator,
                      backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                      padding: 12,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                    })}
                  >
                    <View
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: 5,
                        backgroundColor: target.status === "online" ? theme.success : theme.textTertiary,
                      }}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }} numberOfLines={1}>
                        {target.hostname || target.sessionId.slice(0, 8)}
                      </Text>
                      <Text style={{ color: theme.textTertiary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                        {target.status === "online" ? "在线" : "可恢复"} · {shortPath(target.cwd ?? "~")}
                      </Text>
                    </View>
                    {selected ? <AppSymbol name="checkmark.circle.fill" size={18} color={theme.accent} /> : null}
                  </Pressable>
                );
              })}
            </View>

            <View style={{ gap: 9 }}>
              <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
                Agent
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {providerChoices.map((provider) => {
                  const selected = provider.id === selectedProvider;
                  const meta = PROVIDER_META[provider.id];
                  return (
                    <Pressable
                      key={provider.id}
                      onPress={() => setSelectedProvider(provider.id)}
                      style={({ pressed }) => ({
                        flex: 1,
                        minHeight: 74,
                        borderRadius: 12,
                        borderCurve: "continuous",
                        borderWidth: selected ? 1.5 : StyleSheet.hairlineWidth,
                        borderColor: selected ? theme.accent : theme.separator,
                        backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                        padding: 12,
                        opacity: provider.enabled || selected ? 1 : 0.55,
                      })}
                    >
                      <Text style={{ color: theme.text, fontSize: 15, fontWeight: "800" }}>
                        {provider.label || meta.label}
                      </Text>
                      <Text style={{ color: theme.textTertiary, fontSize: 12, lineHeight: 16, marginTop: 4 }} numberOfLines={2}>
                        {provider.enabled ? meta.subtitle : provider.reason}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={{ gap: 9 }}>
              <Text style={{ color: theme.textTertiary, fontSize: 12, fontWeight: "700" }}>
                工作目录
              </Text>
              {targetProjects.length > 0 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    {targetProjects.map((project) => {
                      const selected = project.id === selectedProjectId;
                      return (
                        <Pressable
                          key={project.id}
                          onPress={() => {
                            setSelectedProjectId(project.id);
                            setCustomCwd(project.cwd);
                          }}
                          style={({ pressed }) => ({
                            width: 190,
                            borderRadius: 12,
                            borderCurve: "continuous",
                            borderWidth: selected ? 1.5 : StyleSheet.hairlineWidth,
                            borderColor: selected ? theme.accent : theme.separator,
                            backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                            padding: 12,
                            gap: 5,
                          })}
                        >
                          <Text style={{ color: theme.text, fontSize: 14, fontWeight: "700" }} numberOfLines={1}>
                            {project.projectName || titleFromCwd(project.cwd)}
                          </Text>
                          <Text style={{ color: theme.textTertiary, fontSize: 12 }} numberOfLines={1}>
                            {shortPath(project.cwd)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </ScrollView>
              ) : null}
              <TextInput
                value={customCwd}
                onChangeText={(value) => {
                  setCustomCwd(value);
                  setSelectedProjectId(null);
                }}
                placeholder="/Users/you/project"
                placeholderTextColor={theme.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  borderRadius: 12,
                  borderCurve: "continuous",
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: theme.separator,
                  backgroundColor: theme.bgCard,
                  color: theme.text,
                  fontSize: 14,
                  paddingHorizontal: 12,
                  paddingVertical: 12,
                }}
              />
            </View>

            {!selectedProviderEnabled ? (
              <Text selectable style={{ color: theme.warning, fontSize: 13, lineHeight: 18 }}>
                {selectedProviderReason}
              </Text>
            ) : null}

            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable
                disabled={creating}
                onPress={() => setCreateVisible(false)}
                style={({ pressed }) => ({
                  flex: 1,
                  borderRadius: 12,
                  alignItems: "center",
                  paddingVertical: 13,
                  backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                })}
              >
                <Text style={{ color: theme.textSecondary, fontWeight: "700" }}>取消</Text>
              </Pressable>
              <Pressable
                disabled={creating || !selectedProviderEnabled || !effectiveCwd}
                onPress={createConversation}
                style={({ pressed }) => ({
                  flex: 1.4,
                  borderRadius: 12,
                  alignItems: "center",
                  justifyContent: "center",
                  paddingVertical: 13,
                  backgroundColor: pressed ? theme.accentSecondary : theme.accent,
                  opacity: creating || !selectedProviderEnabled || !effectiveCwd ? 0.5 : 1,
                })}
              >
                {creating ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={{ color: "#fff", fontWeight: "800" }}>创建对话</Text>
                )}
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
