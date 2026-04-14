import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  LayoutAnimation,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import { useTheme, type Theme } from "../theme";
import { loadServers, type SavedServer } from "../storage/servers";
import { fetchWithTimeout } from "../utils/fetch-with-timeout";
import {
  loadSession,
  fetchOfficialGateways,
  fetchMySessions,
} from "../lib/supabase";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface SessionInfo {
  id: string;
  state: string;
  hasHost: boolean;
  clientCount: number;
  controllerId: string | null;
  lastActivity: number;
  createdAt: number;
  provider: string | null;
  hostname: string | null;
  platform: string | null;
  projectName: string | null;
  cwd: string | null;
}

interface GatewayGroup {
  server: SavedServer;
  sessions: SessionInfo[];
  loading: boolean;
  error: string | null;
}

interface SessionListScreenProps {
  gatewayBaseUrl: string;
  onSelectSession: (sessionId: string, serverUrl?: string) => void;
  refreshKey?: number;
  deviceToken?: string | null;
}

/* ── Skeleton pulse ─────────────────────────────── */
function SkeletonRow({ theme }: { theme: Theme }) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.7,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={{
        opacity,
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 12,
        paddingHorizontal: 16,
        gap: 12,
      }}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 7,
          backgroundColor: theme.borderLight,
        }}
      />
      <View style={{ flex: 1, gap: 6 }}>
        <View
          style={{
            width: "60%",
            height: 14,
            borderRadius: 4,
            backgroundColor: theme.borderLight,
          }}
        />
        <View
          style={{
            width: "40%",
            height: 10,
            borderRadius: 4,
            backgroundColor: theme.borderLight,
          }}
        />
      </View>
    </Animated.View>
  );
}

/* ── Fade-in wrapper ────────────────────────────── */
function FadeIn({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(8)).current;
  useEffect(() => {
    const timeout = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }, delay);
    return () => clearTimeout(timeout);
  }, [opacity, translateY, delay]);

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }] }}>
      {children}
    </Animated.View>
  );
}

/* ── Gateway Section ────────────────────────────── */
function GatewaySection({
  group,
  theme,
  onSelect,
  index,
}: {
  group: GatewayGroup;
  theme: Theme;
  onSelect: (sessionId: string, serverUrl: string) => void;
  index: number;
}) {
  return (
    <FadeIn delay={index * 80}>
      <View style={{ marginTop: index > 0 ? 24 : 16 }}>
        {/* Section header */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 20,
            paddingBottom: 8,
            gap: 8,
          }}
        >
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: group.error
                ? theme.error
                : group.loading
                  ? theme.textTertiary
                  : group.sessions.length > 0
                    ? theme.success
                    : theme.textTertiary,
            }}
          />
          <Text
            style={{
              color: theme.text,
              fontSize: 15,
              fontWeight: "600",
              flex: 1,
            }}
            numberOfLines={1}
          >
            {group.server.name}
          </Text>
          {group.server.isDefault ? (
            <Text
              style={{
                color: theme.accent,
                fontSize: 11,
                fontWeight: "600",
                backgroundColor: theme.accentLight,
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 999,
                overflow: "hidden",
              }}
            >
              默认
            </Text>
          ) : null}
          {!group.loading ? (
            <Text
              style={{
                color: theme.textTertiary,
                fontSize: 12,
                fontVariant: ["tabular-nums"],
              }}
            >
              {group.sessions.length} 个会话
            </Text>
          ) : null}
        </View>

        <Text
          style={{
            color: theme.textTertiary,
            fontSize: 12,
            paddingHorizontal: 34,
            marginTop: -4,
            marginBottom: 8,
          }}
          numberOfLines={1}
        >
          {group.server.url}
        </Text>

        {/* Content card */}
        <View
          style={{
            marginHorizontal: 20,
            backgroundColor: theme.bgCard,
            borderRadius: 12,
            borderCurve: "continuous" as const,
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
          {group.loading ? (
            <>
              <SkeletonRow theme={theme} />
              <View
                style={{
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: theme.separator,
                  marginLeft: 58,
                }}
              />
              <SkeletonRow theme={theme} />
            </>
          ) : group.error ? (
            <View
              style={{
                paddingVertical: 20,
                paddingHorizontal: 16,
                alignItems: "center",
                gap: 6,
              }}
            >
              <AppSymbol
                name="exclamationmark.triangle.fill"
                size={20}
                color={theme.error}
              />
              <Text
                style={{
                  color: theme.error,
                  fontSize: 13,
                  textAlign: "center",
                }}
              >
                {group.error}
              </Text>
            </View>
          ) : group.sessions.length === 0 ? (
            <View
              style={{
                paddingVertical: 20,
                paddingHorizontal: 16,
                alignItems: "center",
                gap: 6,
              }}
            >
              <Text
                style={{
                  color: theme.textTertiary,
                  fontSize: 14,
                }}
              >
                暂无活动会话
              </Text>
              {group.server.isOfficial ? (
                <Text
                  style={{
                    color: theme.textTertiary,
                    fontSize: 12,
                    textAlign: "center",
                    lineHeight: 18,
                    marginTop: 4,
                  }}
                >
                  在电脑终端运行{" "}
                  <Text style={{ color: theme.accent, fontWeight: "600" }}>
                    linkshell login
                  </Text>{" "}
                  登录并连接官方网关
                </Text>
              ) : null}
            </View>
          ) : (
            group.sessions.map((session, i) => (
              <React.Fragment key={session.id}>
                {i > 0 ? (
                  <View
                    style={{
                      height: StyleSheet.hairlineWidth,
                      backgroundColor: theme.separator,
                      marginLeft: 58,
                    }}
                  />
                ) : null}
                <Pressable
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    paddingVertical: 12,
                    paddingHorizontal: 16,
                    gap: 12,
                    backgroundColor: pressed ? theme.bgInput : "transparent",
                  })}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onSelect(session.id, group.server.url);
                  }}
                >
                  <View
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 7,
                      borderCurve: "continuous" as const,
                      backgroundColor: session.hasHost
                        ? theme.success
                        : theme.error,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <AppSymbol name="terminal.fill" size={16} color="#ffffff" />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 5,
                      }}
                    >
                      <Text
                        numberOfLines={1}
                        style={{
                          color: theme.text,
                          fontSize: 15,
                          flexShrink: 1,
                        }}
                      >
                        {session.projectName ??
                          session.hostname ??
                          session.id.slice(0, 8)}
                      </Text>
                      {session.platform ? (
                        <AppSymbol
                          name={platformIcon(session.platform)}
                          size={13}
                          color={theme.textTertiary}
                        />
                      ) : null}
                    </View>
                    <Text
                      numberOfLines={1}
                      style={{ color: theme.textTertiary, fontSize: 13 }}
                    >
                      {session.hostname && session.projectName
                        ? `${session.hostname} · `
                        : ""}
                      {session.hasHost ? "主机在线" : "主机离线"}
                      {session.clientCount > 0
                        ? ` · ${session.clientCount} 个客户端`
                        : ""}
                      {" · "}
                      {timeAgo(session.lastActivity)}
                    </Text>
                  </View>
                  <AppSymbol
                    name="chevron.right"
                    size={10}
                    color={theme.textTertiary}
                  />
                </Pressable>
              </React.Fragment>
            ))
          )}
        </View>
      </View>
    </FadeIn>
  );
}

/* ── Main Screen ────────────────────────────────── */
export function SessionListScreen({
  gatewayBaseUrl,
  onSelectSession,
  refreshKey,
  deviceToken,
}: SessionListScreenProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [groups, setGroups] = useState<GatewayGroup[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);

  const fetchAllGateways = useCallback(async () => {
    const servers = await loadServers();

    // Set loading skeleton for all gateways
    setGroups(
      servers.map((s) => ({
        server: s,
        sessions: [],
        loading: true,
        error: null,
      })),
    );

    // Fetch all in parallel
    const authHeaders: Record<string, string> = {};
    if (deviceToken) authHeaders["Authorization"] = `Bearer ${deviceToken}`;
    const results = await Promise.allSettled(
      servers.map(async (server) => {
        const res = await fetchWithTimeout(`${server.url}/sessions`, {
          headers: authHeaders,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { sessions: SessionInfo[] };
        return body.sessions.sort((a, b) => b.lastActivity - a.lastActivity);
      }),
    );

    const finalGroups: GatewayGroup[] = servers.map((server, i) => {
      const result = results[i]!;
      return {
        server,
        sessions: result.status === "fulfilled" ? result.value : [],
        loading: false,
        error: null,
      };
    });

    // Fetch official gateway sessions for Pro users
    const session = await loadSession();
    const officialUrls = new Set<string>();
    if (session && session.user.plan === "pro") {
      try {
        const officialGws = await fetchOfficialGateways();
        const officialResults = await Promise.allSettled(
          officialGws.map((gw) => fetchMySessions(gw.url)),
        );
        for (let i = 0; i < officialGws.length; i++) {
          const gw = officialGws[i]!;
          officialUrls.add(gw.url.replace(/\/+$/, ""));
          const result = officialResults[i]!;
          const sessions =
            result.status === "fulfilled"
              ? (result.value as SessionInfo[]).sort(
                  (a, b) => b.lastActivity - a.lastActivity,
                )
              : [];
          finalGroups.unshift({
            server: {
              url: gw.url,
              name: `⚡ ${gw.name}${gw.region ? ` (${gw.region})` : ""}`,
              isDefault: false,
              addedAt: 0,
              isOfficial: true,
            },
            sessions,
            loading: false,
            error: null,
          });
        }
      } catch {}
    }

    // Remove saved servers that duplicate official gateways
    if (officialUrls.size > 0) {
      for (let i = finalGroups.length - 1; i >= 0; i--) {
        const g = finalGroups[i]!;
        if (!g.server.isOfficial && officialUrls.has(g.server.url.replace(/\/+$/, ""))) {
          finalGroups.splice(i, 1);
        }
      }
    }

    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setGroups(finalGroups);
    setInitialLoad(false);
  }, [gatewayBaseUrl, deviceToken]);

  useEffect(() => {
    fetchAllGateways();
  }, [fetchAllGateways, refreshKey]);

  // Refresh when tab gains focus
  useFocusEffect(
    useCallback(() => {
      fetchAllGateways();
    }, [fetchAllGateways]),
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAllGateways();
    setRefreshing(false);
  }, [fetchAllGateways]);

  const totalSessions = groups.reduce((sum, g) => sum + g.sessions.length, 0);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 20),
          ...(initialLoad && groups.length === 0 ? { flexGrow: 1 } : undefined),
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.accent}
          />
        }
      >
        {/* Header */}
        <View
          style={{
            paddingHorizontal: 20,
            paddingTop: insets.top + 2,
            paddingBottom: 4,
          }}
        >
          <Text
            style={{
              fontSize: 34,
              fontWeight: "700",
              color: theme.text,
              letterSpacing: 0.37,
            }}
          >
            会话
          </Text>
          <Text
            style={{
              fontSize: 13,
              color: theme.textTertiary,
              marginTop: 2,
              fontVariant: ["tabular-nums"],
            }}
          >
            {groups.length} 个网关
            {!initialLoad ? ` · ${totalSessions} 个活动会话` : ""}
          </Text>
        </View>

        {/* Gateway sections */}
        {groups.map((group, index) => (
          <GatewaySection
            key={`${group.server.isOfficial ? "official-" : ""}${group.server.url}`}
            group={group}
            theme={theme}
            onSelect={onSelectSession}
            index={index}
          />
        ))}

        {/* Global empty state (no servers at all — unlikely but safe) */}
        {!initialLoad && groups.length === 0 ? (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 40,
              paddingTop: 80,
              gap: 8,
            }}
          >
            <AppSymbol
              name="server.rack"
              size={36}
              color={theme.textTertiary}
              style={{ marginBottom: 4 }}
            />
            <Text
              style={{
                color: theme.text,
                fontSize: 17,
                fontWeight: "600",
              }}
            >
              没有网关服务器
            </Text>
            <Text
              style={{
                color: theme.textTertiary,
                fontSize: 15,
                textAlign: "center",
                lineHeight: 20,
              }}
            >
              在首页的连接面板中添加网关服务器。
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function platformIcon(platform: string | null | undefined): string {
  switch (platform) {
    case "darwin":
      return "apple.logo";
    case "linux":
      return "server.rack";
    case "win32":
      return "pc";
    default:
      return "desktopcomputer";
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}
