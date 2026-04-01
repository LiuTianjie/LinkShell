import React, { useCallback, useEffect, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTheme } from "../theme";
import type { ConnectionRecord } from "../storage/history";
import { loadHistory } from "../storage/history";
import { getDefaultServer, type SavedServer } from "../storage/servers";

interface HomeScreenProps {
  gatewayBaseUrl: string;
  status: string;
  onOpenConnectionSheet: () => void;
  onConnectSession: (sessionId: string, serverUrl?: string) => void;
}

export function HomeScreen({
  gatewayBaseUrl,
  status,
  onOpenConnectionSheet,
  onConnectSession,
}: HomeScreenProps) {
  const { theme } = useTheme();
  const [history, setHistory] = useState<ConnectionRecord[]>([]);
  const [defaultServer, setDefaultServer] = useState<SavedServer | undefined>();

  const refresh = useCallback(async () => {
    const [recent, server] = await Promise.all([loadHistory(), getDefaultServer()]);
    setHistory(recent.slice(0, 4));
    setDefaultServer(server);
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh, gatewayBaseUrl, status]);

  const latest = history[0];

  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: theme.bg }]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View style={[styles.heroCard, { backgroundColor: theme.bgCard, borderColor: theme.border }]}> 
        <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>LinkShell</Text>
        <View style={styles.heroHeadlineWrap}>
          <Text style={[styles.heroTitle, { color: theme.text }]}>终端接管</Text>
          <Text style={[styles.heroTitle, { color: theme.text }]}>随开随连，</Text>
          <Text style={styles.heroAccentLine}>
            <Text style={[styles.heroTitle, { color: theme.text }]}>随时</Text>
            <Text style={[styles.heroTitle, { color: theme.accent }]}>接管</Text>
          </Text>
        </View>
        <Text style={[styles.heroBody, { color: theme.textSecondary }]}>把耗时任务留在桌面端，用手机快速接入远程 PTY 会话；首页保持干净，连接动作统一收口到新建连接面板。</Text>

        <View style={styles.heroActions}>
          <Pressable style={[styles.primaryButton, { backgroundColor: theme.accent }]} onPress={onOpenConnectionSheet}>
            <Text style={styles.primaryButtonGlyph}>+</Text>
            <Text style={styles.primaryButtonText}>新建连接</Text>
          </Pressable>
          {latest ? (
            <Pressable
              style={[styles.secondaryButton, { backgroundColor: theme.bgInput, borderColor: theme.border }]}
              onPress={() => onConnectSession(latest.sessionId, latest.serverUrl)}
            >
              <Text style={[styles.secondaryButtonText, { color: theme.text }]}>继续上次会话</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={[styles.section, { backgroundColor: theme.bgCard, borderColor: theme.border }]}> 
        <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>当前网关</Text>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>{safeHost(defaultServer?.url ?? gatewayBaseUrl)}</Text>
        <Text style={[styles.sectionHint, { color: theme.textTertiary }]}>已保存服务器、扫码入口和配对码输入都统一放在新建连接面板里。</Text>
      </View>

      <View style={[styles.section, { backgroundColor: theme.bgCard, borderColor: theme.border }]}> 
        <View style={styles.sectionHeader}>
          <View>
            <Text style={[styles.sectionLabel, { color: theme.textSecondary }]}>最近会话</Text>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>快速继续</Text>
          </View>
          <Pressable onPress={onOpenConnectionSheet}>
            <Text style={[styles.linkText, { color: theme.accent }]}>管理连接</Text>
          </Pressable>
        </View>

        {history.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: theme.bgInput }]}> 
            <Text style={[styles.emptyGlyph, { color: theme.textSecondary }]}>SYNC</Text>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>还没有最近连接</Text>
            <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>点击新建连接即可扫码连接、输入配对码，或从已保存网关发起连接。</Text>
          </View>
        ) : (
          history.map((item) => (
            <Pressable
              key={`${item.sessionId}-${item.connectedAt}`}
              style={[styles.recentRow, { borderBottomColor: theme.borderLight }]}
              onPress={() => onConnectSession(item.sessionId, item.serverUrl)}
            >
              <View style={styles.recentMain}>
                <Text style={[styles.recentTitle, { color: theme.text }]}>{item.hostname ?? item.sessionId.slice(0, 8)}</Text>
                <Text style={[styles.recentMeta, { color: theme.textSecondary }]}>{safeHost(item.serverUrl)} · {timeAgo(item.connectedAt)}</Text>
              </View>
              <Text style={[styles.rowSuffix, { color: theme.textTertiary }]}>进入</Text>
            </Pressable>
          ))
        )}
      </View>
    </ScrollView>
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
  screen: {
    flex: 1,
  },
  content: {
    padding: 20,
    gap: 16,
  },
  heroCard: {
    borderRadius: 28,
    borderWidth: 1,
    padding: 22,
    gap: 14,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  heroTitle: {
    fontSize: 34,
    lineHeight: 40,
    fontWeight: "800",
  },
  heroHeadlineWrap: {
    gap: 2,
  },
  heroAccentLine: {
    flexDirection: "row",
  },
  heroBody: {
    fontSize: 15,
    lineHeight: 22,
  },
  heroActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 4,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: 16,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
  primaryButtonGlyph: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "800",
    lineHeight: 18,
  },
  secondaryButton: {
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: "600",
  },
  section: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 18,
    gap: 12,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700",
  },
  sectionHint: {
    fontSize: 14,
    lineHeight: 20,
  },
  linkText: {
    fontSize: 14,
    fontWeight: "700",
  },
  emptyCard: {
    borderRadius: 20,
    padding: 16,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  emptyGlyph: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 20,
  },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  recentMain: {
    flex: 1,
    gap: 4,
  },
  recentTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  recentMeta: {
    fontSize: 13,
  },
  rowSuffix: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
});