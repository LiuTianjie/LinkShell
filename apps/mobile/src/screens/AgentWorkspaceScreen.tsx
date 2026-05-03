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
import { loadProjects, removeProject, touchProject, type ProjectRecord } from "../storage/projects";
import { loadServers, type SavedServer } from "../storage/servers";
import { useTheme, type Theme } from "../theme";
import { fetchWithTimeout } from "../utils/fetch-with-timeout";

interface AgentWorkspaceScreenProps {
  workspace: AgentWorkspaceHandle;
  sessions?: SessionInfo[];
  gatewayBaseUrl?: string;
  deviceToken?: string | null;
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
  provider?: AgentProvider;
  status: "online";
}

interface GatewayHostSession {
  id: string;
  serverUrl: string;
  state?: string | null;
  hasHost?: boolean;
  hostname?: string | null;
  projectName?: string | null;
  cwd?: string | null;
  provider?: string | null;
  lastActivity?: number;
}

const PROVIDER_META: Record<AgentProvider, { label: string; subtitle: string }> = {
  codex: { label: "Codex", subtitle: "默认可视化 Agent" },
  claude: { label: "Claude", subtitle: "需要 CLI ACP adapter" },
  custom: { label: "Custom", subtitle: "自定义 ACP adapter" },
};

interface AgentProjectItem {
  id: string;
  serverUrl: string;
  sessionId: string;
  cwd: string;
  title: string;
  hostname?: string;
  target?: AgentTarget;
  project?: ProjectRecord;
  latestConversation?: AgentConversationRecord;
}

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

function normalizeProvider(provider: string | null | undefined): AgentProvider | undefined {
  return provider === "codex" || provider === "claude" || provider === "custom"
    ? provider
    : undefined;
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

function projectKey(serverUrl: string, sessionId: string, cwd: string): string {
  return [normalizeServerUrl(serverUrl), sessionId, cwd.trim()].join("\u0000");
}

function uniqueServers(saved: SavedServer[], gatewayBaseUrl?: string): SavedServer[] {
  const byUrl = new Map<string, SavedServer>();
  for (const server of saved) {
    byUrl.set(normalizeServerUrl(server.url), {
      ...server,
      url: normalizeServerUrl(server.url),
    });
  }
  const current = gatewayBaseUrl?.trim();
  if (current) {
    const url = normalizeServerUrl(current);
    if (!byUrl.has(url)) {
      byUrl.set(url, {
        url,
        name: (() => {
          try {
            return new URL(url).host;
          } catch {
            return url;
          }
        })(),
        isDefault: saved.length === 0,
        addedAt: Date.now(),
      });
    }
  }
  return [...byUrl.values()];
}

export function AgentWorkspaceScreen({
  workspace,
  sessions,
  gatewayBaseUrl,
  deviceToken,
  refreshKey,
  onOpenConnectionSheet,
  onOpenConversation,
}: AgentWorkspaceScreenProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [createVisible, setCreateVisible] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>("codex");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [customCwd, setCustomCwd] = useState("");
  const [creating, setCreating] = useState(false);
  const [gatewayHosts, setGatewayHosts] = useState<GatewayHostSession[]>([]);
  const [hiddenProjectKeys, setHiddenProjectKeys] = useState<Set<string>>(() => new Set());

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
    loadProjects()
      .then((projectItems) => setProjects(projectItems))
      .catch(() => {});
  }, [workspace.conversations.length, refreshKey, sessionSignature]);

  useEffect(() => {
    for (const session of onlineSessions) {
      workspace.requestCapabilities(session.sessionId);
    }
  }, [onlineSessions, sessionSignature, workspace.requestCapabilities]);

  useEffect(() => {
    let cancelled = false;
    loadServers()
      .then(async (savedServers) => {
        const servers = uniqueServers(savedServers, gatewayBaseUrl);
        const headers: Record<string, string> = {};
        if (deviceToken) headers.Authorization = `Bearer ${deviceToken}`;
        const results = await Promise.allSettled(
          servers.map(async (server) => {
            const response = await fetchWithTimeout(`${server.url}/sessions`, { headers });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = (await response.json()) as { sessions?: GatewayHostSession[] };
            return (body.sessions ?? []).map((session) => ({
              ...session,
              serverUrl: server.url,
            }));
          }),
        );
        if (cancelled) return;
        setGatewayHosts(
          results.flatMap((result) =>
            result.status === "fulfilled"
              ? result.value.filter((session) => session.id && session.hasHost !== false)
              : [],
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setGatewayHosts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceToken, gatewayBaseUrl, refreshKey, sessionSignature]);

  const targets = useMemo(() => {
    const bySession = new Map<string, AgentTarget>();
    for (const session of gatewayHosts) {
      bySession.set(session.id, {
        sessionId: session.id,
        serverUrl: session.serverUrl,
        hostname: session.hostname ?? session.projectName ?? session.id.slice(0, 8),
        cwd: session.cwd ?? undefined,
        projectName: session.projectName ?? undefined,
        provider: normalizeProvider(session.provider),
        status: "online",
      });
    }
    for (const session of onlineSessions) {
      bySession.set(session.sessionId, {
        sessionId: session.sessionId,
        serverUrl: session.gatewayUrl,
        hostname: session.hostname ?? session.projectName ?? session.sessionId.slice(0, 8),
        cwd: session.cwd || [...session.terminals.values()][0]?.cwd || undefined,
        projectName: session.projectName ?? undefined,
        provider: normalizeProvider(session.provider),
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
      }
    }
    return [...bySession.values()].sort((a, b) => {
      return (a.hostname ?? "").localeCompare(b.hostname ?? "");
    });
  }, [gatewayHosts, onlineSessions, projects]);

  const projectItems = useMemo(() => {
    const targetBySession = new Map(targets.map((target) => [target.sessionId, target]));
    const latestByProject = new Map<string, AgentConversationRecord>();
    for (const conversation of workspace.conversations) {
      if (conversation.archived || !conversation.cwd) continue;
      const key = projectKey(conversation.serverUrl, conversation.sessionId, conversation.cwd);
      const current = latestByProject.get(key);
      if (!current || conversation.lastActivityAt > current.lastActivityAt) {
        latestByProject.set(key, conversation);
      }
    }

    const byProject = new Map<string, AgentProjectItem>();
    for (const project of projects) {
      const key = projectKey(project.serverUrl, project.sessionId, project.cwd);
      if (hiddenProjectKeys.has(key)) continue;
      const target = targetBySession.get(project.sessionId);
      byProject.set(key, {
        id: key,
        serverUrl: project.serverUrl,
        sessionId: project.sessionId,
        cwd: project.cwd,
        title: project.projectName || titleFromCwd(project.cwd),
        hostname: target?.hostname ?? project.hostname,
        target,
        project,
        latestConversation: latestByProject.get(key),
      });
    }

    for (const target of targets) {
      if (!target.cwd) continue;
      const key = projectKey(target.serverUrl, target.sessionId, target.cwd);
      if (hiddenProjectKeys.has(key)) continue;
      const existing = byProject.get(key);
      byProject.set(key, {
        id: key,
        serverUrl: existing?.serverUrl ?? target.serverUrl,
        sessionId: existing?.sessionId ?? target.sessionId,
        cwd: existing?.cwd ?? target.cwd,
        title: existing?.title ?? target.projectName ?? titleFromCwd(target.cwd),
        hostname: target.hostname ?? existing?.hostname,
        target,
        project: existing?.project,
        latestConversation: existing?.latestConversation ?? latestByProject.get(key),
      });
    }

    for (const [key, conversation] of latestByProject) {
      if (hiddenProjectKeys.has(key)) continue;
      if (byProject.has(key)) continue;
      const target = targetBySession.get(conversation.sessionId);
      byProject.set(key, {
        id: key,
        serverUrl: conversation.serverUrl,
        sessionId: conversation.sessionId,
        cwd: conversation.cwd,
        title: conversation.title || titleFromCwd(conversation.cwd),
        hostname: target?.hostname,
        target,
        latestConversation: conversation,
      });
    }

    return [...byProject.values()].sort((a, b) => {
      if (Boolean(a.target) !== Boolean(b.target)) return a.target ? -1 : 1;
      const aTime = a.latestConversation?.lastActivityAt ?? a.project?.lastOpenedAt ?? 0;
      const bTime = b.latestConversation?.lastActivityAt ?? b.project?.lastOpenedAt ?? 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.title.localeCompare(b.title);
    });
  }, [hiddenProjectKeys, projects, targets, workspace.conversations]);

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
      const provider = selectedTarget?.provider ?? selectedProvider;
      return [{
        id: provider,
        label: PROVIDER_META[provider].label,
        enabled: Boolean(selectedTarget),
        reason: selectedTarget
          ? undefined
          : providerReason(selectedCapabilities, provider),
      }];
    },
    [selectedCapabilities, selectedProvider, selectedTarget],
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

  const openCreate = useCallback((targetOverride?: AgentTarget, projectOverride?: AgentProjectItem) => {
    if (targets.length === 0) {
      onOpenConnectionSheet();
      return;
    }
    const target = targetOverride ?? selectedTarget ?? targets[0];
    setSelectedSessionId(target?.sessionId ?? null);
    const projectForTarget =
      projectOverride?.project ?? projects.find((item) => item.sessionId === target?.sessionId);
    setSelectedProjectId(projectForTarget?.id ?? null);
    setCustomCwd(projectOverride?.cwd ?? projectForTarget?.cwd ?? target?.cwd ?? "");
    setSelectedProvider(target?.provider ?? "codex");
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
      Alert.alert("请选择工作目录", "可以使用当前目录，也可以手动输入一个目录。");
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

  const openProject = useCallback(
    async (project: AgentProjectItem) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      if (!project.target) {
        Alert.alert("Mac 不在线", "请先在这个项目所在的 Mac 上启动 linkshell，再继续使用 Agent。");
        return;
      }
      if (!project.latestConversation) {
        openCreate(project.target, project);
        return;
      }
      const id = await workspace.resumeConversation(project.latestConversation.id);
      if (id) {
        onOpenConversation(id);
        return;
      }
      Alert.alert("无法恢复 Agent 对话", "请确认 Mac 端会话在线，并且 Agent GUI 已启用。");
    },
    [onOpenConversation, openCreate, workspace],
  );

  const deleteProject = useCallback((project: AgentProjectItem) => {
    Alert.alert(
      "删除项目",
      `确定从 Agent 首页移除「${project.title}」吗？相关 Agent 对话会移到归档。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () => {
            const key = projectKey(project.serverUrl, project.sessionId, project.cwd);
            setHiddenProjectKeys((prev) => new Set(prev).add(key));
            setProjects((prev) => prev.filter((item) => item.id !== project.project?.id));
            const tasks: Promise<unknown>[] = [];
            if (project.project) tasks.push(removeProject(project.project.id));
            for (const conversation of workspace.conversations) {
              if (
                projectKey(conversation.serverUrl, conversation.sessionId, conversation.cwd) === key
              ) {
                tasks.push(workspace.archive(conversation.id, true));
              }
            }
            Promise.all(tasks).catch(() => {});
          },
        },
      ],
    );
  }, [workspace]);

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
            按项目进入 Agent。在线项目会继续最近的对话，没有对话则新建。
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
                {targets.length > 0 ? "新建 Agent 对话" : "连接网关"}
              </Text>
              <Text style={{ color: "rgba(255,255,255,0.78)", fontSize: 13, marginTop: 2 }} numberOfLines={1}>
                {targets.length > 0 ? "选择网关里的 Mac、Agent 和工作目录" : "没有可用 Mac 时再扫码或输入连接"}
              </Text>
            </View>
            <AppSymbol name="chevron.right" size={16} color="rgba(255,255,255,0.9)" />
          </Pressable>
        </View>

        <View style={{ gap: 8 }}>
          <SectionTitle theme={theme}>项目</SectionTitle>
          <View style={{ paddingHorizontal: 20, gap: 8 }}>
            {projectItems.length === 0 ? (
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
                  还没有项目
                </Text>
                <Text style={{ color: theme.textTertiary, fontSize: 13, lineHeight: 18, textAlign: "center" }}>
                  连接 Mac 后会自动显示当前工作目录，也可以从上方手动新建。
                </Text>
              </View>
            ) : projectItems.map((project) => {
              const online = Boolean(project.target);
              const caps = project.target ? workspace.capabilitiesBySessionId.get(project.target.sessionId) : undefined;
              const canUseAgent = online && caps?.enabled;
              return (
                <Pressable
                  key={project.id}
                  onPress={() => openProject(project)}
                  style={({ pressed }) => ({
                    borderRadius: 12,
                    borderCurve: "continuous",
                    backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                    padding: 12,
                    gap: 8,
                  })}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <AppSymbol name="folder.fill" size={18} color={online ? theme.accent : theme.textTertiary} />
                    <Text style={{ flex: 1, color: theme.text, fontSize: 16, fontWeight: "700" }} numberOfLines={1}>
                      {project.title}
                    </Text>
                    <Pressable
                      hitSlop={10}
                      onPress={(event) => {
                        event.stopPropagation();
                        deleteProject(project);
                      }}
                      style={({ pressed }) => ({
                        width: 30,
                        height: 30,
                        borderRadius: 15,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: pressed ? theme.errorLight : theme.bgInput,
                      })}
                    >
                      <AppSymbol name="trash.fill" size={13} color={theme.textTertiary} />
                    </Pressable>
                    <View
                      style={{
                        borderRadius: 999,
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        backgroundColor: canUseAgent ? theme.accentLight : theme.bgInput,
                      }}
                    >
                      <Text
                        style={{
                          color: canUseAgent ? theme.success : theme.textTertiary,
                          fontSize: 11,
                          fontWeight: "700",
                        }}
                      >
                        {online ? (caps ? (caps.enabled ? "在线" : "不可用") : "可用") : "离线"}
                      </Text>
                    </View>
                  </View>
                  <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }} numberOfLines={2}>
                    {project.latestConversation?.lastMessagePreview ||
                      (project.latestConversation ? "继续这个项目的 Agent 对话" : "还没有 Agent 对话")}
                  </Text>
                  <Text style={{ color: theme.textTertiary, fontSize: 12 }} numberOfLines={1}>
                    {[project.hostname, shortPath(project.cwd)].filter(Boolean).join(" · ")}
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
                        backgroundColor: theme.success,
                      }}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }} numberOfLines={1}>
                        {target.hostname || target.sessionId.slice(0, 8)}
                      </Text>
                      <Text style={{ color: theme.textTertiary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                        在线 · {shortPath(target.cwd ?? "~")}
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
