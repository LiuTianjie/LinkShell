import React, { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { fetchWithTimeout } from "../utils/fetch-with-timeout";

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
}

interface SessionListScreenProps {
  gatewayBaseUrl: string;
  onSelectSession: (sessionId: string, serverUrl?: string) => void;
}

export function SessionListScreen({
  gatewayBaseUrl,
  onSelectSession,
}: SessionListScreenProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetchWithTimeout(`${gatewayBaseUrl}/sessions`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { sessions: SessionInfo[] };
      setSessions(
        body.sessions.sort((a, b) => b.lastActivity - a.lastActivity),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "获取会话失败");
    }

    setLoading(false);
  }, [gatewayBaseUrl]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={fetchSessions}
            tintColor={theme.accent}
          />
        }
        ListHeaderComponent={
          <View style={[styles.headerWrap, { paddingTop: Math.max(insets.top + 10, 24) }]}>
            <View style={[styles.heroCard, { backgroundColor: theme.bgCard, borderColor: theme.border }]}> 
              <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>会话</Text>
              <Text style={[styles.title, { color: theme.text }]}>当前网关上的活动终端</Text>
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}>不需要重新输入配对码，直接接管已有会话。</Text>
              <View style={styles.heroMetaRow}>
                <View style={[styles.heroMetaPill, { backgroundColor: theme.bgInput }]}> 
                  <Text style={[styles.heroMetaLabel, { color: theme.textTertiary }]}>网关</Text>
                  <Text style={[styles.heroMetaValue, { color: theme.text }]}>{safeHost(gatewayBaseUrl)}</Text>
                </View>
                <View style={[styles.heroMetaPill, { backgroundColor: theme.bgInput }]}> 
                  <Text style={[styles.heroMetaLabel, { color: theme.textTertiary }]}>在线数</Text>
                  <Text style={[styles.heroMetaValue, { color: theme.text }]}>{sessions.length}</Text>
                </View>
              </View>
            </View>

            {error ? (
              <View style={[styles.errorBar, { backgroundColor: theme.errorLight }]}> 
                <Text style={[styles.errorText, { color: theme.error }]}>{error}</Text>
              </View>
            ) : null}
          </View>
        }
        contentContainerStyle={sessions.length === 0 ? styles.emptyContainer : styles.listContent}
        renderItem={({ item, index }) => (
          <Pressable
            style={[styles.sessionCard, { backgroundColor: theme.bgCard, borderColor: theme.border }, index === sessions.length - 1 && styles.lastCard]}
            onPress={() => onSelectSession(item.id, gatewayBaseUrl)}
          >
            <View style={styles.rowTop}>
              <View style={styles.rowLeft}>
                <View style={[styles.dot, item.hasHost ? styles.dotOnline : styles.dotOffline]} />
                <View style={styles.titleGroup}>
                  <Text style={[styles.hostname, { color: theme.text }]}>
                    {item.hostname ?? item.id.slice(0, 8)}
                  </Text>
                  <Text style={[styles.sessionIdText, { color: theme.textTertiary }]}>{item.id.slice(0, 8)}</Text>
                </View>
              </View>
              <Text style={[styles.provider, { color: theme.textSecondary, backgroundColor: theme.bgInput }]}>{item.provider ?? "未知来源"}</Text>
            </View>

            <Text style={[styles.meta, { color: theme.textSecondary }]}>
              {item.hasHost ? "主机在线" : "主机离线"}
              {item.clientCount > 0 ? ` · ${item.clientCount} 个客户端` : ""}
            </Text>

            <View style={styles.rowBottom}>
              <Text style={[styles.activeTime, { color: theme.textTertiary }]}>最近活动 {timeAgo(item.lastActivity)}</Text>
              <Text style={[styles.joinText, { color: theme.accent }]}>进入</Text>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyWrap}>
              <Text style={[styles.emptyTitle, { color: theme.text }]}>当前没有活动会话</Text>
              <Text style={[styles.emptyText, { color: theme.textSecondary }]}>先在本地启动 CLI bridge，然后下拉刷新这里的列表。</Text>
            </View>
          ) : null
        }
      />
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

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F2F4F7",
  },
  headerWrap: {
    paddingHorizontal: 20,
    paddingBottom: 10,
    gap: 12,
  },
  heroCard: {
    borderRadius: 28,
    borderWidth: 1,
    padding: 20,
    gap: 10,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "800",
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
  heroMetaRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
  },
  heroMetaPill: {
    flex: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  heroMetaLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.7,
  },
  heroMetaValue: {
    fontSize: 16,
    fontWeight: "700",
  },
  errorBar: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorText: {
    fontSize: 13,
    textAlign: "center",
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 22,
  },
  sessionCard: {
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
    marginBottom: 14,
    gap: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03,
    shadowRadius: 5,
    elevation: 2,
  },
  lastCard: {
    marginBottom: 0,
  },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  titleGroup: {
    flex: 1,
    gap: 3,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotOnline: {
    backgroundColor: "#22c55e",
  },
  dotOffline: {
    backgroundColor: "#ef4444",
  },
  hostname: {
    fontSize: 15,
    fontWeight: "700",
  },
  sessionIdText: {
    fontSize: 11,
    fontWeight: "600",
  },
  provider: {
    fontSize: 12,
    fontWeight: "600",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  meta: {
    fontSize: 12,
  },
  rowBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#eef0f4",
  },
  activeTime: {
    fontSize: 12,
  },
  joinText: {
    fontSize: 12,
    fontWeight: "700",
  },
  emptyContainer: {
    flex: 1,
  },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    color: "#374151",
    fontSize: 16,
    fontWeight: "600",
  },
  emptyText: {
    color: "#6b7280",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
});
