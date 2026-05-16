import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { Swipeable } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import { FolderPickerModal } from "../components/FolderPickerModal";
import type { AgentWorkspaceHandle } from "../hooks/useAgentWorkspace";
import type { SessionInfo } from "../hooks/useSessionManager";
import type {
  AgentCapabilities,
  AgentTimelineItem,
  AgentConversationRecord,
  AgentProvider,
  AgentProviderCapability,
} from "../storage/agent-workspace";
import { loadProjects, removeProject, touchProject, type ProjectRecord } from "../storage/projects";
import { loadServers, type SavedServer } from "../storage/servers";
import { getDeviceToken } from "../storage/device-token";
import { fetchMySessions, fetchOfficialGateways, getValidSession } from "../lib/supabase";
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
  onBrowseDirectory?: (sessionId: string, path: string) => void;
  onMkdirRemote?: (sessionId: string, path: string) => void;
  onConnectSession?: (sessionId: string, gatewayUrl: string) => void;
}

interface AgentTarget {
  hostDeviceId: string;
  sessionId: string;
  serverUrl: string;
  machineId?: string;
  hostname?: string;
  cwd?: string;
  projectName?: string;
  provider?: AgentProvider;
  status: "online";
}

interface GatewayHostSession {
  id: string;
  hostDeviceId?: string;
  serverUrl: string;
  state?: string | null;
  hasHost?: boolean;
  machineId?: string | null;
  hostname?: string | null;
  cwd?: string | null;
  lastActivity?: number;
}

const PROVIDER_META: Record<AgentProvider, { label: string; subtitle: string; icon: string }> = {
  codex: { label: "Codex", subtitle: "OpenAI Agent", icon: "sparkles" },
  claude: { label: "Claude", subtitle: "Anthropic Agent", icon: "brain.head.profile" },
  custom: { label: "Custom", subtitle: "自定义 Agent 命令", icon: "gearshape.fill" },
};

const HIDDEN_AGENT_PROJECT_KEYS = "@linkshell/agent-hidden-projects:v2";

interface AgentProjectGroup {
  id: string;
  serverUrl: string;
  hostDeviceId: string;
  sessionId: string;
  cwd: string;
  title: string;
  hostname?: string;
  target?: AgentTarget;
  project?: ProjectRecord;
  conversations: AgentConversationRecord[];
  lastActivityAt: number;
}

interface AgentDeviceProjectGroup {
  id: string;
  serverUrl: string;
  hostDeviceId: string;
  hostname?: string;
  online: boolean;
  projects: AgentProjectGroup[];
  lastActivityAt: number;
}

function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function agentHostKey(serverUrl: string, sessionId: string): string {
  return `${normalizeServerUrl(serverUrl)}\u0000${sessionId}`;
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

function isGatewayHostOnline(session: GatewayHostSession): boolean {
  return session.hasHost === true && (!session.state || session.state === "active");
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
      : "需要先连接主机并确认 Agent 能力。";
  }
  if (provider === "custom") return "Custom Agent 需要在 CLI 侧配置 --agent-command 后才能使用。";
  return capabilities?.error;
}

function projectKey(serverUrl: string, hostDeviceId: string, cwd: string): string {
  return [normalizeServerUrl(serverUrl), hostDeviceId, cwd.trim()].join("\u0000");
}

function projectPathKey(serverUrl: string, cwd: string, provider?: string): string {
  const parts = [normalizeServerUrl(serverUrl), cwd.trim()];
  if (provider) parts.push(provider);
  return parts.join("\u0000");
}

function projectFolderKey(cwd: string): string {
  return cwd.trim();
}

function normalizeDeviceName(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function deviceProjectKey(cwd: string, hostDeviceId?: string | null, serverUrl?: string | null): string {
  const normalizedDevice = normalizeDeviceName(hostDeviceId);
  if (normalizedDevice) return `device:${normalizedDevice}\u0000${cwd.trim()}`;
  return `server:${normalizeServerUrl(serverUrl ?? "")}\u0000${cwd.trim()}`;
}

function setUniqueTarget(
  map: Map<string, AgentTarget | null>,
  key: string,
  target: AgentTarget,
) {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, target);
  else if (existing?.sessionId !== target.sessionId || normalizeServerUrl(existing.serverUrl) !== normalizeServerUrl(target.serverUrl)) {
    map.set(key, null);
  }
}

function conversationHiddenKey(conversationId: string): string {
  return `conversation:${conversationId}`;
}

function projectHiddenKey(project: AgentProjectGroup): string {
  return `project:${project.id}`;
}

function providerFoldKey(projectId: string, provider: AgentProvider, scope = "active"): string {
  return `${scope}:provider:${projectId}:${provider}`;
}

function shortConversationId(conversation: AgentConversationRecord): string {
  return (conversation.agentSessionId || conversation.id).replace(/^agent-remote-/, "").slice(0, 8);
}

function deviceTitle(group: AgentDeviceProjectGroup): string {
  return group.hostname || group.hostDeviceId.slice(0, 8);
}

function relativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 月`;
  return `${Math.floor(months / 12)} 年`;
}

function conversationSummary(
  conversation: AgentConversationRecord,
  timeline?: AgentTimelineItem[],
): string {
  const storedPreview = conversation.lastMessagePreview?.trim();
  const titleFallback = conversation.title || titleFromCwd(conversation.cwd);
  const previewIsControlNoise = conversation.provider === "codex" && (
    /already\s+initialized/i.test(storedPreview ?? "") ||
    (storedPreview ?? "").includes("Codex request timed out: initialize")
  );
  if (storedPreview && !previewIsControlNoise && storedPreview !== conversation.title && storedPreview !== titleFallback) {
    return storedPreview;
  }
  const latestPreview = [...(timeline ?? [])]
    .reverse()
    .map(previewFromWorkspaceItem)
    .find((preview) => preview && preview !== conversation.title);
  return latestPreview || conversation.title || "暂无对话摘要";
}

function conversationDisplayTitle(conversation: AgentConversationRecord): string {
  return conversation.title?.trim() || titleFromCwd(conversation.cwd);
}

function providerGroups(conversations: AgentConversationRecord[]) {
  const order: AgentProvider[] = ["codex", "claude", "custom"];
  return order
    .map((provider) => ({
      provider,
      conversations: conversations
        .filter((conversation) => conversation.provider === provider)
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    }))
    .filter((group) => group.conversations.length > 0);
}

function latestConversation(conversations: AgentConversationRecord[]): AgentConversationRecord | undefined {
  return conversations.reduce<AgentConversationRecord | undefined>((latest, conversation) =>
    !latest || conversation.lastActivityAt > latest.lastActivityAt ? conversation : latest,
  undefined);
}

function areStringSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function textFromContentBlocks(blocks: AgentTimelineItem["content"]): string | undefined {
  const text = (blocks ?? [])
    .map((block) => block.type === "text" ? block.text ?? "" : block.text ?? "图片附件")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 160) : undefined;
}

function previewFromWorkspaceItem(item: AgentTimelineItem): string | undefined {
  if (item.role === "user") return undefined;
  if (item.error?.trim()) return item.error.trim().slice(0, 160);
  if (item.kind === "thinking") return undefined;
  if (item.kind === "user_input_prompt") return "Agent 需要补充信息";
  if (item.kind === "subagent_action" && item.subagent) {
    const count = Math.max(1, item.subagent.receiverThreadIds.length, item.subagent.receiverAgents.length);
    return count === 1 ? "子 Agent 活动" : `${count} 个子 Agent 活动`;
  }
  if (item.kind === "review") return "正在审查";
  if (item.kind === "context_compaction") return "正在压缩上下文";
  if (item.text?.trim()) return item.text.replace(/\s+/g, " ").trim().slice(0, 160);
  if (item.type === "message") return textFromContentBlocks(item.content);
  if (item.fileChange?.summary) return item.fileChange.summary;
  if (item.commandExecution?.command) return item.commandExecution.command;
  if (item.toolCall?.name) return `${item.toolCall.name} · ${item.toolCall.status}`;
  if (item.permission) return `需要授权 ${item.permission.toolName ?? ""}`.trim();
  return undefined;
}

function providerColor(provider: AgentProvider, theme: Theme): { color: string; bg: string } {
  if (provider === "claude") {
    return {
      color: theme.warning,
      bg: theme.mode === "dark" ? "rgba(255, 214, 10, 0.14)" : "rgba(255, 149, 0, 0.12)",
    };
  }
  if (provider === "codex") {
    return { color: theme.accent, bg: theme.accentLight };
  }
  return { color: theme.textSecondary, bg: theme.bgInput };
}

function providerLogo(provider: AgentProvider): number | undefined {
  if (provider === "codex") return require("../../assets/codex-logo.png");
  if (provider === "claude") return require("../../assets/claudecode-logo.png");
  return undefined;
}

function ProviderBadge({ provider, theme }: { provider: AgentProvider; theme: Theme }) {
  const meta = PROVIDER_META[provider];
  const colors = providerColor(provider, theme);
  const logo = providerLogo(provider);
  return (
    <View
      style={{
        borderRadius: 999,
        width: 26,
        height: 26,
        backgroundColor: colors.bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {logo ? (
        <Image source={logo} contentFit="contain" style={{ width: 17, height: 17 }} />
      ) : (
        <AppSymbol name={meta.icon} size={13} color={colors.color} />
      )}
    </View>
  );
}

function StatusPill({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <View
      style={{
        borderRadius: 999,
        paddingHorizontal: 7,
        paddingVertical: 3,
        backgroundColor: bg,
      }}
    >
      <Text style={{ color, fontSize: 11, fontWeight: "800" }}>
        {label}
      </Text>
    </View>
  );
}

function SpinningRing({ color }: { color: string }) {
  const rotation = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 900,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [rotation]);

  const rotate = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  return (
    <Animated.View
      style={{
        width: 12,
        height: 12,
        borderRadius: 6,
        borderWidth: 1.5,
        borderColor: color,
        borderTopColor: "transparent",
        transform: [{ rotate }],
      }}
    />
  );
}

function ConversationStateIndicator({
  conversation,
  theme,
}: {
  conversation: AgentConversationRecord;
  theme: Theme;
}) {
  if (conversation.status === "running") {
    return <SpinningRing color={theme.accent} />;
  }
  if (conversation.status === "waiting_permission") {
    return (
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.warning,
        }}
      />
    );
  }
  if (conversation.status === "error") {
    return (
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.error,
        }}
      />
    );
  }
  if (conversation.syncStatus === "stale") {
    return (
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.warning,
        }}
      />
    );
  }
  return null;
}

function ConversationGroupStateIndicator({
  conversations,
  theme,
}: {
  conversations: AgentConversationRecord[];
  theme: Theme;
}) {
  if (conversations.some((conversation) => conversation.status === "running")) {
    return <SpinningRing color={theme.accent} />;
  }
  if (conversations.some((conversation) => conversation.status === "waiting_permission")) {
    return (
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.warning,
        }}
      />
    );
  }
  if (conversations.some((conversation) => conversation.status === "error")) {
    return (
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.error,
        }}
      />
    );
  }
  if (conversations.some((conversation) => conversation.syncStatus === "stale")) {
    return (
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.warning,
        }}
      />
    );
  }
  return null;
}

async function loadHiddenAgentProjectKeys(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(HIDDEN_AGENT_PROJECT_KEYS);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0));
  } catch {
    return new Set();
  }
}

async function saveHiddenAgentProjectKeys(keys: Set<string>): Promise<void> {
  await AsyncStorage.setItem(HIDDEN_AGENT_PROJECT_KEYS, JSON.stringify([...keys]));
}

function uniqueServers(
  saved: SavedServer[],
  urls: (string | undefined | null)[],
): SavedServer[] {
  const byUrl = new Map<string, SavedServer>();
  for (const server of saved) {
    byUrl.set(normalizeServerUrl(server.url), {
      ...server,
      url: normalizeServerUrl(server.url),
    });
  }
  for (const current of urls) {
    if (!current?.trim()) continue;
    const url = normalizeServerUrl(current.trim());
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
  onBrowseDirectory,
  onMkdirRemote,
  onConnectSession,
}: AgentWorkspaceScreenProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const allSessions = sessions ?? workspace.connectedSessions;
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [createVisible, setCreateVisible] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>("codex");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [customCwd, setCustomCwd] = useState("");
  const [folderPickerVisible, setFolderPickerVisible] = useState(false);
  const [creating, setCreating] = useState(false);
  const [gatewayHosts, setGatewayHosts] = useState<GatewayHostSession[]>([]);
  const [loadingGatewayHosts, setLoadingGatewayHosts] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [manualRefreshToken, setManualRefreshToken] = useState(0);
  const [knownGatewayCount, setKnownGatewayCount] = useState(0);
  const [hiddenProjectKeys, setHiddenProjectKeys] = useState<Set<string>>(() => new Set());
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [collapsedDeviceKeys, setCollapsedDeviceKeys] = useState<Set<string>>(() => new Set());
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(() => new Set());
  const [collapsedProviderKeys, setCollapsedProviderKeys] = useState<Set<string>>(() => new Set());
  const swipeableRefs = useRef<Map<string, Swipeable>>(new Map());
  const autoConnectedHostKeysRef = useRef<Set<string>>(new Set());
  const didInitializeCollapsedProjectsRef = useRef(false);
  const knownProjectKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    loadHiddenAgentProjectKeys()
      .then((keys) => {
        if (!cancelled) setHiddenProjectKeys(keys);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const onlineSessions = useMemo(
    () =>
      allSessions.filter((session) =>
        session.status === "connected",
      ),
    [allSessions],
  );

  const selectedSession = useMemo(
    () => allSessions.find((s) => s.sessionId === selectedSessionId) ?? null,
    [allSessions, selectedSessionId],
  );

  const sessionSignature = useMemo(
    () => onlineSessions.map((session) => `${session.sessionId}:${session.status}`).join("|"),
    [onlineSessions],
  );
  const gatewaySignature = useMemo(
    () => allSessions.map((session) => session.gatewayUrl).sort().join("|"),
    [allSessions],
  );

  useEffect(() => {
    loadProjects()
      .then((projectItems) => setProjects(projectItems))
      .catch(() => {});
  }, [manualRefreshToken, workspace.conversations.length, refreshKey, sessionSignature]);

  useEffect(() => {
    for (const session of onlineSessions) {
      workspace.requestCapabilities(session.sessionId);
      workspace.requestConversationList(session.sessionId);
    }
  }, [onlineSessions, sessionSignature, workspace.requestCapabilities, workspace.requestConversationList]);

  useEffect(() => {
    let cancelled = false;
    setLoadingGatewayHosts(true);
    loadServers()
      .then(async (savedServers) => {
        const servers = uniqueServers(savedServers, [
          gatewayBaseUrl,
          ...allSessions.map((session) => session.gatewayUrl),
        ]);
        const authSession = await getValidSession();
        const officialGateways = authSession?.user.plan === "pro"
          ? await fetchOfficialGateways()
          : [];
        if (!cancelled) setKnownGatewayCount(servers.length + officialGateways.length);
        const token = deviceToken ?? (await getDeviceToken());
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const deviceResults = await Promise.allSettled(
          servers.map(async (server) => {
            const response = await fetchWithTimeout(`${server.url}/devices`, { headers });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = (await response.json()) as { devices?: GatewayHostSession[] };
            return (body.devices ?? []).map((session) => ({
              ...session,
              id: session.hostDeviceId ?? session.id,
              serverUrl: server.url,
            }));
          }),
        );
        const officialResults = await Promise.allSettled(
          officialGateways.map(async (gateway) => {
            const sessions = await fetchMySessions(gateway.url);
            return sessions.map((session) => ({
              ...session,
              id: session.hostDeviceId ?? session.id,
              serverUrl: gateway.url,
            }));
          }),
        );
        if (cancelled) return;
        const nextHosts = [...deviceResults, ...officialResults].flatMap((result) =>
            result.status === "fulfilled"
              ? result.value.filter((session) => session.id && isGatewayHostOnline(session))
              : [],
        );
        const byKey = new Map<string, GatewayHostSession>();
        for (const session of nextHosts) {
          byKey.set(`${normalizeServerUrl(session.serverUrl)}:${session.id}`, session);
        }
        setGatewayHosts([...byKey.values()]);
      })
      .catch(() => {
        if (!cancelled) setGatewayHosts([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingGatewayHosts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceToken, gatewayBaseUrl, gatewaySignature, manualRefreshToken, refreshKey, sessionSignature]);

  const targets = useMemo(() => {
    const bySession = new Map<string, AgentTarget>();
    for (const session of gatewayHosts) {
      const hostDeviceId = session.hostDeviceId ?? session.id;
      bySession.set(session.id, {
        hostDeviceId,
        sessionId: hostDeviceId,
        serverUrl: session.serverUrl,
        machineId: session.machineId ?? undefined,
        hostname: session.hostname ?? hostDeviceId.slice(0, 8),
        cwd: session.cwd ?? undefined,
        status: "online",
      });
    }
    for (const session of onlineSessions) {
      bySession.set(session.sessionId, {
        hostDeviceId: session.hostDeviceId,
        sessionId: session.sessionId,
        serverUrl: session.gatewayUrl,
        machineId: session.machineId ?? undefined,
        hostname: session.hostname ?? session.hostDeviceId.slice(0, 8),
        cwd: session.cwd || [...session.terminals.values()][0]?.cwd || undefined,
        projectName: session.projectName ?? undefined,
        status: "online",
      });
    }
    for (const project of projects) {
      const hostDeviceId = project.hostDeviceId ?? project.sessionId;
      if (bySession.has(hostDeviceId)) {
        const existing = bySession.get(hostDeviceId)!;
        bySession.set(hostDeviceId, {
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

  useEffect(() => {
    if (!onConnectSession) return;
    const existingKeys = new Set(
      allSessions.map((session) => agentHostKey(session.gatewayUrl, session.sessionId)),
    );
    const onlineHostKeys = new Set<string>();
    for (const host of gatewayHosts) {
      if (!host.id || !host.serverUrl) continue;
      const key = agentHostKey(host.serverUrl, host.id);
      onlineHostKeys.add(key);
      if (existingKeys.has(key) || autoConnectedHostKeysRef.current.has(key)) continue;
      autoConnectedHostKeysRef.current.add(key);
      onConnectSession(host.id, host.serverUrl);
    }
    for (const key of autoConnectedHostKeysRef.current) {
      if (!onlineHostKeys.has(key) && !existingKeys.has(key)) {
        autoConnectedHostKeysRef.current.delete(key);
      }
    }
  }, [allSessions, gatewayHosts, onConnectSession]);

  useEffect(() => {
    for (const target of targets) {
      workspace.requestCapabilities(target.sessionId);
      workspace.requestConversationList(target.sessionId);
    }
  }, [targets, workspace.requestCapabilities, workspace.requestConversationList]);

  const projectGroups = useMemo(() => {
    const targetBySession = new Map(targets.map((target) => [target.sessionId, target]));
    const targetByPath = new Map<string, AgentTarget>();
    const targetByDeviceProject = new Map<string, AgentTarget | null>();
    const targetByFolder = new Map<string, AgentTarget | null>();
    for (const target of targets) {
      if (target.cwd) targetByPath.set(projectPathKey(target.serverUrl, target.cwd), target);
      if (target.cwd) {
        setUniqueTarget(targetByDeviceProject, deviceProjectKey(target.cwd, target.hostDeviceId, target.serverUrl), target);
        setUniqueTarget(targetByFolder, projectFolderKey(target.cwd), target);
      }
    }
    const projectByExact = new Map<string, ProjectRecord>();
    const projectByDeviceProject = new Map<string, ProjectRecord>();
    for (const project of projects) {
      projectByExact.set(projectKey(project.serverUrl, project.hostDeviceId ?? project.sessionId, project.cwd), project);
      projectByDeviceProject.set(deviceProjectKey(project.cwd, project.hostDeviceId ?? project.sessionId, project.serverUrl), project);
    }

    const groups = new Map<string, AgentProjectGroup>();
    for (const conversation of workspace.conversations) {
      if (conversation.archived || !conversation.cwd) continue;
      if (hiddenProjectKeys.has(conversationHiddenKey(conversation.id))) continue;
      const exactProject = projectByExact.get(projectKey(conversation.serverUrl, conversation.hostDeviceId ?? conversation.sessionId, conversation.cwd));
      const deviceKey = deviceProjectKey(
        conversation.cwd,
        conversation.hostDeviceId ?? exactProject?.hostDeviceId ?? conversation.sessionId,
        conversation.serverUrl,
      );
      const target =
        targetBySession.get(conversation.hostDeviceId ?? conversation.sessionId) ??
        targetByPath.get(projectPathKey(conversation.serverUrl, conversation.cwd)) ??
        targetByDeviceProject.get(deviceKey) ??
        targetByFolder.get(projectFolderKey(conversation.cwd)) ??
        undefined;
      const project = exactProject ?? projectByDeviceProject.get(deviceKey);
      const id = target
        ? deviceProjectKey(conversation.cwd, target.hostDeviceId, target.serverUrl)
        : deviceKey;
      if (hiddenProjectKeys.has(`project:${id}`)) continue;
      const existing = groups.get(id);
      if (existing) {
        existing.conversations.push(conversation);
        existing.lastActivityAt = Math.max(existing.lastActivityAt, conversation.lastActivityAt);
        if (target) existing.target = target;
        if (project) existing.project = project;
        existing.hostname = existing.hostname ?? target?.hostname ?? project?.hostname;
        continue;
      }
      groups.set(id, {
        id,
        serverUrl: target?.serverUrl ?? conversation.serverUrl,
        hostDeviceId: target?.hostDeviceId ?? conversation.hostDeviceId ?? conversation.sessionId,
        sessionId: target?.sessionId ?? conversation.sessionId,
        cwd: conversation.cwd,
        title: project?.projectName || titleFromCwd(conversation.cwd),
        hostname: target?.hostname ?? project?.hostname,
        target,
        project,
        conversations: [conversation],
        lastActivityAt: conversation.lastActivityAt,
      });
    }

    for (const target of targets) {
      if (!target.cwd) continue;
      const id = deviceProjectKey(target.cwd, target.hostDeviceId, target.serverUrl);
      if (hiddenProjectKeys.has(`project:${id}`)) continue;
      const existing = groups.get(id);
      const project =
        projects.find((item) =>
          item.cwd === target.cwd &&
          ((item.hostDeviceId ?? item.sessionId) === target.hostDeviceId)
        ) ??
        projectByDeviceProject.get(id);
      if (existing) {
        existing.target = target;
        existing.sessionId = target.sessionId;
        existing.serverUrl = target.serverUrl;
        existing.hostname = existing.hostname ?? target.hostname ?? project?.hostname;
        existing.project = existing.project ?? project;
        existing.title = existing.project?.projectName || target.projectName || existing.title;
        continue;
      }
      groups.set(id, {
        id,
        serverUrl: target.serverUrl,
        hostDeviceId: target.hostDeviceId,
        sessionId: target.sessionId,
        cwd: target.cwd,
        title: project?.projectName || target.projectName || titleFromCwd(target.cwd),
        hostname: target.hostname ?? project?.hostname,
        target,
        project,
        conversations: [],
        lastActivityAt: project?.lastOpenedAt ?? 0,
      });
    }

    return [...groups.values()].sort((a, b) => {
      if (Boolean(a.target) !== Boolean(b.target)) return a.target ? -1 : 1;
      if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
      return a.title.localeCompare(b.title);
    });
  }, [hiddenProjectKeys, projects, targets, workspace.conversations]);

  const deviceProjectGroups = useMemo(() => {
    const groups = new Map<string, AgentDeviceProjectGroup>();
    for (const project of projectGroups) {
      const key = `${normalizeServerUrl(project.serverUrl)}\u0000${project.hostDeviceId}`;
      const existing = groups.get(key);
      if (existing) {
        existing.projects.push(project);
        existing.online = existing.online || Boolean(project.target);
        existing.hostname = existing.hostname ?? project.hostname;
        existing.lastActivityAt = Math.max(existing.lastActivityAt, project.lastActivityAt);
        continue;
      }
      groups.set(key, {
        id: key,
        serverUrl: project.serverUrl,
        hostDeviceId: project.hostDeviceId,
        hostname: project.hostname,
        online: Boolean(project.target),
        projects: [project],
        lastActivityAt: project.lastActivityAt,
      });
    }
    return [...groups.values()].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
      return deviceTitle(a).localeCompare(deviceTitle(b));
    });
  }, [projectGroups]);

  const archivedItems = useMemo(
    () => (archivedExpanded ? workspace.archivedConversations : []),
    [archivedExpanded, workspace.archivedConversations],
  );
  const projectGroupIdsSignature = useMemo(
    () => JSON.stringify(projectGroups.map((project) => project.id)),
    [projectGroups],
  );
  const deviceGroupIdsSignature = useMemo(
    () => JSON.stringify(deviceProjectGroups.map((device) => device.id)),
    [deviceProjectGroups],
  );
  const providerGroupIdsSignature = useMemo(
    () => JSON.stringify(projectGroups.flatMap((project) =>
      providerGroups(project.conversations).map((group) => providerFoldKey(project.id, group.provider)),
    )),
    [projectGroups],
  );

  useEffect(() => {
    const projectIds = JSON.parse(projectGroupIdsSignature) as string[];
    if (projectIds.length === 0) {
      knownProjectKeysRef.current = new Set();
      setCollapsedProjectKeys((prev) => prev.size === 0 ? prev : new Set());
      return;
    }
    setCollapsedProjectKeys((prev) => {
      const valid = new Set(projectIds);
      const next = new Set<string>();
      const previousKnown = knownProjectKeysRef.current;
      for (const projectId of projectIds) {
        if (prev.has(projectId) && previousKnown.has(projectId)) {
          next.add(projectId);
        }
      }
      for (const key of next) {
        if (!valid.has(key)) next.delete(key);
      }
      knownProjectKeysRef.current = valid;
      didInitializeCollapsedProjectsRef.current = true;
      return areStringSetsEqual(prev, next) ? prev : next;
    });
  }, [projectGroupIdsSignature]);

  useEffect(() => {
    const deviceIds = new Set(JSON.parse(deviceGroupIdsSignature) as string[]);
    setCollapsedDeviceKeys((prev) => {
      const next = new Set([...prev].filter((key) => deviceIds.has(key)));
      return areStringSetsEqual(prev, next) ? prev : next;
    });
  }, [deviceGroupIdsSignature]);

  useEffect(() => {
    const providerIds = new Set(JSON.parse(providerGroupIdsSignature) as string[]);
    setCollapsedProviderKeys((prev) => {
      const next = new Set([...prev].filter((key) => providerIds.has(key)));
      return areStringSetsEqual(prev, next) ? prev : next;
    });
  }, [providerGroupIdsSignature]);

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

  const didAutoSelectRef = useRef(false);

  useEffect(() => {
    if (!createVisible) {
      didAutoSelectRef.current = false;
      return;
    }
    if (didAutoSelectRef.current) return;
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
    didAutoSelectRef.current = true;
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

  const openCreate = useCallback((targetOverride?: AgentTarget, projectOverride?: AgentProjectGroup) => {
    if (targets.length === 0) {
      if (knownGatewayCount > 0) {
        Alert.alert(
          loadingGatewayHosts ? "正在加载网关会话" : "没有可用主机",
          loadingGatewayHosts
            ? "正在从已连接的网关读取可用主机，请稍候再试。"
            : "当前网关没有可用主机。请确认主机端 linkshell 仍在运行。",
        );
        return;
      }
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
  }, [knownGatewayCount, loadingGatewayHosts, onOpenConnectionSheet, projects, selectedTarget, targets]);

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
        hostDeviceId: selectedTarget.hostDeviceId,
        serverUrl: selectedTarget.serverUrl,
        cwd: effectiveCwd,
        provider: selectedProvider,
        title: selectedProject?.projectName || titleFromCwd(effectiveCwd),
      });
      if (!result.conversationId) {
        Alert.alert("无法创建 Agent 对话", result.error ?? "CLI 没有确认对话，请确认主机端 linkshell 仍在线。");
        return;
      }
      touchProject({
        serverUrl: selectedTarget.serverUrl,
        hostDeviceId: selectedTarget.hostDeviceId,
        sessionId: selectedTarget.sessionId,
        machineId: selectedTarget.machineId,
        cwd: effectiveCwd,
      }).catch(() => {});
      const exactKey = projectKey(selectedTarget.serverUrl, selectedTarget.hostDeviceId, effectiveCwd);
      const pathKey = projectPathKey(selectedTarget.serverUrl, effectiveCwd);
      const groupId = deviceProjectKey(
        effectiveCwd,
        selectedTarget.hostDeviceId,
        selectedTarget.serverUrl,
      );
      setHiddenProjectKeys((prev) => {
        const hiddenProjectKey = `project:${groupId}`;
        if (!prev.has(exactKey) && !prev.has(pathKey) && !prev.has(hiddenProjectKey)) return prev;
        const next = new Set(prev);
        next.delete(exactKey);
        next.delete(pathKey);
        next.delete(hiddenProjectKey);
        saveHiddenAgentProjectKeys(next).catch(() => {});
        return next;
      });
      setCollapsedProjectKeys((prev) => {
        if (!prev.has(groupId)) return prev;
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
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
    async (project: AgentProjectGroup, conversation?: AgentConversationRecord) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      const latest = conversation ?? project.conversations[0];
      if (!latest) {
        if (!project.target) {
          Alert.alert("主机不在线", "请先在这个项目所在的主机上启动 linkshell，再继续使用 Agent。");
          return;
        }
        openCreate(project.target, project);
        return;
      }

      onOpenConversation(latest.id);

      if (!project.target) return;

      workspace.openConversation({
        conversationId: latest.id,
        agentSessionId: latest.agentSessionId,
        sessionId: project.target.sessionId,
        hostDeviceId: project.target.hostDeviceId,
        machineId: project.target.machineId,
        serverUrl: project.target.serverUrl,
        cwd: project.cwd,
        provider: latest.provider ?? project.target.provider ?? "codex",
        model: latest.model,
        reasoningEffort: latest.reasoningEffort,
        permissionMode: latest.permissionMode,
        title: latest.title || project.title,
      }).then((result) => {
        if (!result.conversationId) {
          console.warn("[AgentWorkspace] background conversation open failed", result.error);
        }
      }).catch((error) => {
        console.warn("[AgentWorkspace] background conversation open failed", error);
      });
    },
    [onOpenConversation, openCreate, workspace],
  );

  const archiveConversation = useCallback((conversation: AgentConversationRecord) => {
    Alert.alert(
      "归档会话",
      `确定从 Agent 首页移除这条 ${PROVIDER_META[conversation.provider].label} 会话吗？历史不会被删除，可之后从归档入口恢复。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "归档",
          onPress: () => {
            setHiddenProjectKeys((prev) => {
              const next = new Set(prev);
              next.add(conversationHiddenKey(conversation.id));
              saveHiddenAgentProjectKeys(next).catch(() => {});
              return next;
            });
            workspace.archive(conversation.id, true).catch(() => {});
          },
        },
      ],
    );
  }, [workspace]);

  const removeProjectFromHome = useCallback((project: AgentProjectGroup) => {
    const conversationCount = project.conversations.length;
    Alert.alert(
      "移除项目",
      conversationCount > 0
        ? `确定从 Agent 首页移除“${project.title}”吗？该项目下 ${conversationCount} 条会话会移到归档，本地项目记录会被删除。`
        : `确定删除“${project.title}”的本地项目记录吗？`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "移除",
          style: "destructive",
          onPress: () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
            setHiddenProjectKeys((prev) => {
              const next = new Set(prev);
              next.add(projectHiddenKey(project));
              for (const conversation of project.conversations) {
                next.add(conversationHiddenKey(conversation.id));
              }
              saveHiddenAgentProjectKeys(next).catch(() => {});
              return next;
            });
            setProjects((prev) => prev.filter((item) => item.id !== project.project?.id));
            if (project.project?.id) removeProject(project.project.id).catch(() => {});
            Promise.all(project.conversations.map((conversation) =>
              workspace.archive(conversation.id, true),
            ))
              .then(() => setManualRefreshToken((value) => value + 1))
              .catch(() => {});
          },
        },
      ],
    );
  }, [workspace]);

  const unarchiveConversation = useCallback(async (conversation: AgentConversationRecord) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setHiddenProjectKeys((prev) => {
      const next = new Set(prev);
      next.delete(conversationHiddenKey(conversation.id));
      saveHiddenAgentProjectKeys(next).catch(() => {});
      return next;
    });
    await workspace.archive(conversation.id, false);
    setManualRefreshToken((value) => value + 1);
  }, [workspace]);

  const restoreArchivedConversation = useCallback(async (conversation: AgentConversationRecord) => {
    await unarchiveConversation(conversation);
    const result = await workspace.resumeConversation(conversation.id);
    if (result) {
      onOpenConversation(result);
      return;
    }
    Alert.alert("已取消归档", "会话已经回到首页；这台设备当前离线，启动 linkshell 后可以继续打开。");
  }, [onOpenConversation, unarchiveConversation, workspace]);

  const toggleDeviceCollapsed = useCallback((deviceId: string) => {
    setCollapsedDeviceKeys((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
    Haptics.selectionAsync().catch(() => {});
  }, []);

  const toggleProjectCollapsed = useCallback((projectId: string) => {
    setCollapsedProjectKeys((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    Haptics.selectionAsync().catch(() => {});
  }, []);

  const toggleProviderCollapsed = useCallback((key: string) => {
    setCollapsedProviderKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    Haptics.selectionAsync().catch(() => {});
  }, []);

  const refreshWorkspace = useCallback(async () => {
    Haptics.selectionAsync().catch(() => {});
    setRefreshing(true);
    try {
      await workspace.refresh();
      setManualRefreshToken((value) => value + 1);
      for (const session of allSessions) {
        workspace.requestCapabilities(session.sessionId);
        workspace.requestConversationList(session.sessionId);
      }
    } finally {
      setTimeout(() => setRefreshing(false), 350);
    }
  }, [allSessions, workspace]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 20) + 60,
          gap: 16,
        }}
        contentInsetAdjustmentBehavior="never"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshWorkspace}
            tintColor={theme.accent}
            colors={[theme.accent]}
          />
        }
      >
        <View
          style={{
            paddingHorizontal: 20,
            paddingTop: insets.top + 2,
            paddingBottom: 8,
            gap: 2,
          }}
        >
          <Text style={{ color: theme.text, fontSize: 34, fontWeight: "700", letterSpacing: 0.37 }}>
            Agent
          </Text>
          <Text style={{ color: theme.textTertiary, fontSize: 13 }}>
            按项目进入 Agent。在线项目会继续最近的对话，没有对话则新建。
          </Text>
        </View>

        <View
          style={{
            marginHorizontal: 20,
            backgroundColor: theme.bgCard,
            borderRadius: 12,
            borderCurve: "continuous",
            overflow: "hidden",
            ...(theme.mode === "light"
              ? {
                  shadowColor: "#000",
                  shadowOffset: { width: 0, height: 1 },
                  shadowOpacity: 0.06,
                  shadowRadius: 4,
                  elevation: 2,
                }
              : {}),
          }}
        >
          <Pressable
            onPress={() => openCreate()}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              paddingVertical: 11,
              paddingHorizontal: 16,
              gap: 12,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <View
              style={{
                width: 30,
                height: 30,
                borderRadius: 7,
                borderCurve: "continuous",
                backgroundColor: theme.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AppSymbol name="plus.circle.fill" size={16} color="#fff" />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.text, fontSize: 17 }}>
                {targets.length > 0 || knownGatewayCount > 0 ? "新建 Agent 对话" : "连接网关"}
              </Text>
              <Text style={{ color: theme.textTertiary, fontSize: 13, marginTop: 1 }} numberOfLines={1}>
                {targets.length > 0
                  ? "选择网关里的主机、Agent 和工作目录"
                  : knownGatewayCount > 0
                    ? "正在从网关确认可用主机"
                    : "没有可用网关时再扫码或输入连接"}
              </Text>
            </View>
            <AppSymbol name="chevron.right" size={13} color={theme.textTertiary} />
          </Pressable>
        </View>

        <View style={{ gap: 8 }}>
          <SectionTitle theme={theme}>设备 / 项目</SectionTitle>
          <View style={{ paddingHorizontal: 20, gap: 12 }}>
            {deviceProjectGroups.length === 0 ? (
              <View
                style={{
                  paddingVertical: 20,
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <AppSymbol name="bubble.left.and.text.bubble.right" size={24} color={theme.accent} />
                <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }}>
                  还没有项目
                </Text>
                <Text style={{ color: theme.textTertiary, fontSize: 13, lineHeight: 18, textAlign: "center" }}>
                  新建 Agent 对话后，这里会按设备和项目显示最近的会话。
                </Text>
              </View>
            ) : deviceProjectGroups.map((device) => {
              const deviceCollapsed = collapsedDeviceKeys.has(device.id);
              const deviceConversations = device.projects.flatMap((project) => project.conversations);
              return (
              <View key={device.id} style={{ gap: 10 }}>
                <Pressable
                  onPress={() => toggleDeviceCollapsed(device.id)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 9,
                    paddingHorizontal: 2,
                    paddingTop: 2,
                    borderRadius: 10,
                    borderCurve: "continuous",
                    backgroundColor: pressed ? "rgba(120,120,128,0.08)" : "transparent",
                  })}
                >
                  <View
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      borderCurve: "continuous",
                      backgroundColor: device.online ? theme.accentLight : theme.bgInput,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <AppSymbol
                      name="desktopcomputer"
                      size={14}
                      color={device.online ? theme.accent : theme.textTertiary}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                      <Text style={{ color: theme.text, fontSize: 15, fontWeight: "800" }} numberOfLines={1}>
                        {deviceTitle(device)}
                      </Text>
                      <StatusPill
                        label={device.online ? "在线" : "离线"}
                        color={device.online ? theme.success : theme.textTertiary}
                        bg={device.online ? theme.accentLight : theme.bgInput}
                      />
                    </View>
                    <Text style={{ color: theme.textTertiary, fontSize: 11, marginTop: 2 }} numberOfLines={1}>
                      {device.projects.length} 个项目 · {device.serverUrl}
                    </Text>
                  </View>
                  <ConversationGroupStateIndicator conversations={deviceConversations} theme={theme} />
                  <AppSymbol name={deviceCollapsed ? "chevron.right" : "chevron.down"} size={12} color={theme.textTertiary} />
                </Pressable>
                {!deviceCollapsed ? (
                <View style={{ gap: 12, paddingLeft: 10, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.separator }}>
                  {device.projects.map((project) => {
              const online = Boolean(project.target);
              const groups = providerGroups(project.conversations);
              const collapsed = collapsedProjectKeys.has(project.id);
              return (
                <View
                  key={project.id}
                  style={{
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: theme.separator,
                    paddingBottom: 13,
                    gap: 8,
                  }}
                >
                  <Pressable
                    onPress={() => {
                      if (project.conversations.length === 0) {
                        openCreate(project.target, project);
                        return;
                      }
                      toggleProjectCollapsed(project.id);
                    }}
                    style={({ pressed }) => ({
                      borderRadius: 10,
                      borderCurve: "continuous",
                      backgroundColor: pressed ? "rgba(120,120,128,0.08)" : "transparent",
                      paddingVertical: 5,
                      paddingHorizontal: 0,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                    })}
                  >
                    <AppSymbol name={collapsed ? "folder" : "folder.fill"} size={17} color={online ? theme.textSecondary : theme.textTertiary} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                        <Text style={{ color: theme.text, fontSize: 15, fontWeight: "700" }} numberOfLines={1}>
                          {project.title}
                        </Text>
                        {!online ? (
                          <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>
                            离线
                          </Text>
                        ) : null}
                      </View>
                    </View>
                    {project.conversations.length > 0 ? (
                      <ConversationGroupStateIndicator conversations={project.conversations} theme={theme} />
                    ) : null}
                    {project.conversations.length > 0 ? (
                      <AppSymbol name={collapsed ? "chevron.right" : "chevron.down"} size={12} color={theme.textTertiary} />
                    ) : null}
                    <Pressable
                      onPress={() => removeProjectFromHome(project)}
                      hitSlop={8}
                      style={({ pressed }) => ({
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: pressed ? "rgba(120,120,128,0.12)" : "transparent",
                      })}
                    >
                      <AppSymbol name="trash" size={13} color={online ? theme.textTertiary : theme.error} />
                    </Pressable>
                    <Pressable
                      onPress={() => openCreate(project.target, project)}
                      hitSlop={8}
                      style={({ pressed }) => ({
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: pressed ? "rgba(120,120,128,0.12)" : "transparent",
                      })}
                    >
                      <AppSymbol name="square.and.pencil" size={13} color={theme.textTertiary} />
                    </Pressable>
                  </Pressable>
                  {!collapsed && groups.length > 0 ? (
                    <View style={{ paddingLeft: 8, gap: 9 }}>
                      {groups.map(({ provider, conversations }) => {
                        const providerKey = providerFoldKey(project.id, provider);
                        const providerCollapsed = collapsedProviderKeys.has(providerKey);
                        return (
                        <View key={`${project.id}:${provider}`} style={{ gap: 4 }}>
                          <Pressable
                            onPress={() => toggleProviderCollapsed(providerKey)}
                            style={({ pressed }) => ({
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 7,
                              paddingTop: 2,
                              paddingBottom: 1,
                              borderRadius: 8,
                              borderCurve: "continuous",
                              backgroundColor: pressed ? "rgba(120,120,128,0.08)" : "transparent",
                            })}
                          >
                            <ProviderBadge provider={provider} theme={theme} />
                            <Text style={{ flex: 1, color: theme.textSecondary, fontSize: 13, fontWeight: "800" }}>
                              {PROVIDER_META[provider].label}
                            </Text>
                            <Text style={{ color: theme.textTertiary, fontSize: 11, fontWeight: "800" }}>
                              {conversations.length}
                            </Text>
                            <ConversationGroupStateIndicator conversations={conversations} theme={theme} />
                            <AppSymbol name={providerCollapsed ? "chevron.right" : "chevron.down"} size={11} color={theme.textTertiary} />
                          </Pressable>
                          {!providerCollapsed ? conversations.map((conversation) => {
                            const rowKey = conversationHiddenKey(conversation.id);
                            const rowTitle = conversationDisplayTitle(conversation);
                            const rowSummary = conversationSummary(conversation, workspace.getTimeline(conversation.id));
                            const showRowSummary = Boolean(rowSummary && rowSummary !== rowTitle);
                            return (
                              <Swipeable
                                key={conversation.id}
                                ref={(ref) => {
                                  if (ref) swipeableRefs.current.set(rowKey, ref);
                                  else swipeableRefs.current.delete(rowKey);
                                }}
                                overshootRight={false}
                                onSwipeableWillOpen={() => {
                                  swipeableRefs.current.forEach((swipeable, id) => {
                                    if (id !== rowKey) swipeable.close();
                                  });
                                }}
                                renderRightActions={(
                                  _progress: Animated.AnimatedInterpolation<number>,
                                  dragX: Animated.AnimatedInterpolation<number>,
                                ) => {
                                  const scale = dragX.interpolate({
                                    inputRange: [-72, 0],
                                    outputRange: [1, 0.5],
                                    extrapolate: "clamp",
                                  });
                                  return (
                                    <Pressable
                                      onPress={() => archiveConversation(conversation)}
                                      style={{
                                        width: 72,
                                        borderRadius: 8,
                                        borderCurve: "continuous",
                                        backgroundColor: theme.error,
                                        alignItems: "center",
                                        justifyContent: "center",
                                      }}
                                    >
                                      <Animated.View style={{ alignItems: "center", transform: [{ scale }] }}>
                                        <AppSymbol name="archivebox.fill" size={16} color="#fff" />
                                        <Text style={{ color: "#fff", fontSize: 11, fontWeight: "800", marginTop: 2 }}>
                                          归档
                                        </Text>
                                      </Animated.View>
                                    </Pressable>
                                  );
                                }}
                              >
                                <Pressable
                                  onPress={() => openProject(project, conversation)}
                                  style={({ pressed }) => ({
                                    marginLeft: 34,
                                    minHeight: 32,
                                    borderRadius: 8,
                                    borderCurve: "continuous",
                                    opacity: pressed ? 0.55 : 1,
                                    paddingVertical: 5,
                                    paddingHorizontal: 2,
                                    flexDirection: "row",
                                    alignItems: "center",
                                    gap: 8,
                                  })}
                                >
                                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                                    <Text style={{ color: theme.text, fontSize: 14, fontWeight: "700" }} numberOfLines={1}>
                                      {rowTitle}
                                    </Text>
                                    {showRowSummary ? (
                                      <Text style={{ color: theme.textTertiary, fontSize: 11, lineHeight: 15 }} numberOfLines={1}>
                                        {rowSummary}
                                      </Text>
                                    ) : null}
                                  </View>
                                  <ConversationStateIndicator conversation={conversation} theme={theme} />
                                  <Text style={{ color: theme.textTertiary, fontSize: 12, minWidth: 42, textAlign: "right" }}>
                                    {relativeTime(conversation.lastActivityAt)}
                                  </Text>
                                </Pressable>
                              </Swipeable>
                            );
                          }) : null}
                        </View>
                      );
                      })}
                    </View>
                  ) : !collapsed ? (
                    <Pressable
                      onPress={() => openCreate(project.target, project)}
                      style={({ pressed }) => ({
                        marginLeft: 34,
                        borderRadius: 8,
                        borderCurve: "continuous",
                        paddingVertical: 5,
                        paddingHorizontal: 2,
                        backgroundColor: pressed ? theme.bgInput : "transparent",
                      })}
                    >
                      <Text style={{ color: theme.textTertiary, fontSize: 14 }}>暂无对话</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
                  })}
                </View>
                ) : null}
              </View>
              );
            })}
          </View>
        </View>
        {workspace.archivedConversations.length > 0 ? (
          <View style={{ gap: 6, paddingHorizontal: 20, paddingTop: 2 }}>
            <Pressable
              onPress={() => setArchivedExpanded((value) => !value)}
              style={({ pressed }) => ({
                minHeight: 34,
                borderRadius: 10,
                borderCurve: "continuous",
                backgroundColor: pressed ? "rgba(120,120,128,0.08)" : "transparent",
                paddingVertical: 7,
                paddingHorizontal: 8,
                marginHorizontal: -8,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
              })}
            >
              <AppSymbol name="archivebox" size={14} color={theme.textTertiary} />
              <Text style={{ flex: 1, color: theme.textTertiary, fontSize: 12, fontWeight: "800" }}>
                已归档 · {workspace.archivedConversations.length}
              </Text>
              <AppSymbol name={archivedExpanded ? "chevron.down" : "chevron.right"} size={12} color={theme.textTertiary} />
            </Pressable>
            {archivedExpanded ? (
            <View style={{ paddingLeft: 28, gap: 6 }}>
              {archivedItems.map((conversation) => {
                const target = targets.find((item) => item.hostDeviceId === (conversation.hostDeviceId ?? conversation.sessionId));
                const rowTitle = conversationDisplayTitle(conversation);
                const rowSummary = conversationSummary(conversation, workspace.getTimeline(conversation.id));
                const showRowSummary = Boolean(rowSummary && rowSummary !== rowTitle);
                return (
                  <Pressable
                    key={conversation.id}
                    onPress={() => restoreArchivedConversation(conversation).catch(() => {
                      Alert.alert("无法恢复会话", "请确认主机端 linkshell 仍在线。");
                    })}
                    style={({ pressed }) => ({
                      minHeight: 40,
                      borderRadius: 8,
                      borderCurve: "continuous",
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: theme.borderLight,
                      backgroundColor: pressed ? theme.bgInput : "rgba(120,120,128,0.06)",
                      paddingVertical: 6,
                      paddingHorizontal: 8,
                      opacity: target ? 1 : 0.7,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                    })}
                  >
                    <ProviderBadge provider={conversation.provider} theme={theme} />
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text style={{ color: theme.textSecondary, fontSize: 14, fontWeight: "700" }} numberOfLines={1}>
                        {rowTitle}
                      </Text>
                      {showRowSummary ? (
                        <Text style={{ color: theme.textTertiary, fontSize: 11, lineHeight: 15 }} numberOfLines={1}>
                          {rowSummary}
                        </Text>
                      ) : null}
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={{ color: theme.textTertiary, fontSize: 11 }} numberOfLines={1}>
                          {target ? shortPath(conversation.cwd) : "设备离线"}
                        </Text>
                        <View
                          style={{
                            borderRadius: 999,
                            borderCurve: "continuous",
                            backgroundColor: theme.bgInput,
                            paddingHorizontal: 6,
                            paddingVertical: 1,
                          }}
                        >
                          <Text style={{ color: theme.textTertiary, fontSize: 10, fontWeight: "800" }}>
                            已归档
                          </Text>
                        </View>
                      </View>
                    </View>
                    <Text style={{ color: theme.textTertiary, fontSize: 12, minWidth: 42, textAlign: "right" }}>
                      {relativeTime(conversation.lastActivityAt)}
                    </Text>
                    <Pressable
                      onPress={(event) => {
                        event.stopPropagation();
                        unarchiveConversation(conversation).catch(() => {});
                      }}
                      style={({ pressed }) => ({
                        borderRadius: 999,
                        borderCurve: "continuous",
                        backgroundColor: pressed ? theme.bgInput : theme.accentLight,
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                      })}
                    >
                      <Text style={{ color: theme.accent, fontSize: 12, fontWeight: "800" }}>
                        取消归档
                      </Text>
                    </Pressable>
                  </Pressable>
                );
              })}
            </View>
            ) : null}
            </View>
        ) : null}
      </ScrollView>

      <Modal
        visible={createVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => !creating && setCreateVisible(false)}
      >
        <View style={{ flex: 1, backgroundColor: theme.bg }}>
          <ScrollView
            contentInsetAdjustmentBehavior="never"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingTop: 20,
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
                主机
              </Text>
              {targets.map((target) => {
                const selected = target.sessionId === selectedTarget?.sessionId;
                return (
                  <Pressable
                    key={`${target.serverUrl}:${target.sessionId}`}
                    onPress={() => {
                      setSelectedSessionId(target.sessionId);
                      const project = projects.find((item) => (item.hostDeviceId ?? item.sessionId) === target.hostDeviceId);
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
                      onPress={() => {
                        if (!provider.enabled) {
                          Alert.alert("Agent 不可用", provider.reason ?? "当前主机没有声明支持这个 Agent。");
                          return;
                        }
                        setSelectedProvider(provider.id);
                      }}
                      style={({ pressed }) => ({
                        flex: 1,
                        minHeight: 86,
                        borderRadius: 12,
                        borderCurve: "continuous",
                        borderWidth: selected ? 1.5 : StyleSheet.hairlineWidth,
                        borderColor: selected ? theme.accent : theme.separator,
                        backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                        padding: 12,
                        opacity: provider.enabled || selected ? 1 : 0.55,
                      })}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={{ flex: 1, color: theme.text, fontSize: 15, fontWeight: "800" }} numberOfLines={1}>
                          {provider.label || meta.label}
                        </Text>
                        {!provider.enabled ? (
                          <StatusPill label="不可用" color={theme.warning} bg={theme.accentLight} />
                        ) : null}
                      </View>
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
              <Pressable
                onPress={() => {
                  if (!selectedSession && selectedSessionId && onConnectSession) {
                    const target = targets.find(t => t.sessionId === selectedSessionId);
                    if (target) onConnectSession(selectedSessionId, target.serverUrl);
                  }
                  setFolderPickerVisible(true);
                }}
                style={({ pressed }) => ({
                  borderRadius: 12,
                  borderCurve: "continuous",
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: theme.separator,
                  backgroundColor: pressed ? theme.bgInput : theme.bgCard,
                  paddingHorizontal: 12,
                  paddingVertical: 12,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                })}
              >
                <AppSymbol name="folder" size={14} color={theme.textSecondary} />
                <Text
                  style={{
                    color: customCwd ? theme.text : theme.textTertiary,
                    fontSize: 14,
                    flex: 1,
                  }}
                  numberOfLines={1}
                >
                  {customCwd || "选择工作目录…"}
                </Text>
                <AppSymbol name="chevron.right" size={12} color={theme.textTertiary} />
              </Pressable>
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
          <FolderPickerModal
            visible={folderPickerVisible}
            browseResult={selectedSession?.browseResult ?? null}
            terminals={selectedSession?.terminals ?? new Map()}
            connectionStatus={selectedSession?.status ?? "connecting"}
            initialPath={customCwd || undefined}
            selectLabel="选择此目录"
            switchLabel="选择此目录"
            onBrowse={(path) => {
              if (selectedSessionId && onBrowseDirectory) {
                onBrowseDirectory(selectedSessionId, path);
              }
            }}
            onSelect={(path) => {
              setCustomCwd(path);
              setSelectedProjectId(null);
              setFolderPickerVisible(false);
            }}
            onMkdir={onMkdirRemote && selectedSessionId ? (path: string) => onMkdirRemote(selectedSessionId!, path) : undefined}
            onClose={() => setFolderPickerVisible(false)}
            theme={theme}
          />
        </View>
      </Modal>
    </View>
  );
}
