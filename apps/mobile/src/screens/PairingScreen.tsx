import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAccessory } from "../components/KeyboardAccessory";
import { ServerPicker } from "../components/ServerPicker";
import { useTheme } from "../theme";
import { getDefaultServer, touchServer } from "../storage/servers";
import {
  clearHistory,
  loadHistory,
  removeFromHistory,
} from "../storage/history";
import type { ConnectionRecord } from "../storage/history";

interface PairingScreenProps {
  gatewayBaseUrl: string;
  onGatewayChange: (url: string) => void;
  onClaim: (code: string) => void;
  onConnectSession: (sessionId: string, serverUrl?: string) => void;
  onBrowseSessions: () => void;
  onOpenScanner: () => void;
  status: string;
}

const ACCESSORY_ID = "pairing-code-accessory";

export function PairingScreen({
  gatewayBaseUrl,
  onGatewayChange,
  onClaim,
  onConnectSession,
  onBrowseSessions,
  onOpenScanner,
  status,
}: PairingScreenProps) {
  const { theme } = useTheme();
  const [pairingCode, setPairingCode] = useState("");
  const [history, setHistory] = useState<ConnectionRecord[]>([]);

  const loadRecent = useCallback(async () => {
    const records = await loadHistory();
    setHistory(records);
  }, []);

  useEffect(() => {
    getDefaultServer().then((server) => {
      if (server) {
        onGatewayChange(server.url);
      }
    });
    loadRecent();
  }, [loadRecent, onGatewayChange]);

  const handleClaim = useCallback(async () => {
    if (!pairingCode.trim()) return;
    await touchServer(gatewayBaseUrl);
    onClaim(pairingCode.trim());
  }, [gatewayBaseUrl, onClaim, pairingCode]);

  const handleReconnect = useCallback(
    async (record: ConnectionRecord) => {
      onGatewayChange(record.serverUrl);
      await touchServer(record.serverUrl);
      onConnectSession(record.sessionId, record.serverUrl);
    },
    [onConnectSession, onGatewayChange],
  );

  const handleDeleteRecord = useCallback(
    (record: ConnectionRecord) => {
      Alert.alert(
        "删除最近会话",
        "删除后不会影响服务器中的真实会话，只会移除本机记录。",
        [
          { text: "取消", style: "cancel" },
          {
            text: "删除",
            style: "destructive",
            onPress: () => {
              removeFromHistory(record)
                .then(loadRecent)
                .catch(() => {});
            },
          },
        ],
      );
    },
    [loadRecent],
  );

  const handleClearHistory = useCallback(() => {
    Alert.alert("清空最近会话", "将清空首页展示的所有最近会话记录。", [
      { text: "取消", style: "cancel" },
      {
        text: "清空",
        style: "destructive",
        onPress: () => {
          clearHistory()
            .then(loadRecent)
            .catch(() => {});
        },
      },
    ]);
  }, [loadRecent]);

  const statusCopy = useMemo(() => getStatusCopy(status), [status]);
  const recentSession = history[0];

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: theme.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={[styles.heroCard, { backgroundColor: theme.bgCard }]}>
          <View style={styles.heroTopRow}>
            <View style={styles.titleWrap}>
              <Text style={[styles.heroTitle, { color: theme.text }]}>LinkShell</Text>
              <Text style={[styles.heroSubtitle, { color: theme.textSecondary }]}>Remote Terminal</Text>
            </View>
            <View
              style={[
                styles.statusBadge,
                statusCopy.isError && styles.statusBadgeError,
              ]}
            >
              <Text
                style={[
                  styles.statusBadgeText,
                  statusCopy.isError && styles.statusBadgeTextError,
                ]}
              >
                {statusCopy.badge}
              </Text>
            </View>
          </View>
          <Text style={styles.heroDescription}>{statusCopy.description}</Text>

          <View style={styles.primaryActions}>
            <Pressable
              style={[styles.primaryActionBtn, styles.scanBtn]}
              onPress={onOpenScanner}
            >
              <Text style={styles.primaryActionTitle}>扫码连接</Text>
              <Text style={styles.primaryActionHint}>
                推荐方式，自动填入配对码和网关
              </Text>
            </Pressable>
            <Pressable
              style={styles.primaryActionBtn}
              onPress={onBrowseSessions}
            >
              <Text style={styles.primaryActionTitle}>活跃会话</Text>
              <Text style={styles.primaryActionHint}>
                直接加入当前网关下已在线会话
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.primaryActionBtn,
                !recentSession && styles.primaryActionDisabled,
              ]}
              onPress={() => recentSession && handleReconnect(recentSession)}
              disabled={!recentSession}
            >
              <Text style={styles.primaryActionTitle}>继续上次会话</Text>
              <Text style={styles.primaryActionHint}>
                {recentSession
                  ? `${recentSession.hostname ?? recentSession.sessionId.slice(0, 8)} · ${timeAgo(recentSession.connectedAt)}`
                  : "连接过一次后会自动出现在这里"}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionLabel}>网关服务器</Text>
          <ServerPicker
            selectedUrl={gatewayBaseUrl}
            onSelect={onGatewayChange}
          />
          <Text style={styles.sectionHint}>
            当前：{safeHost(gatewayBaseUrl)}
          </Text>
        </View>

        <View style={styles.sectionCard}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleWrap}>
              <Text style={styles.sectionLabel}>手动配对</Text>
              <Text style={styles.sectionTitle}>输入 6 位配对码</Text>
            </View>
            <Pressable style={styles.secondaryPill} onPress={onOpenScanner}>
              <Text style={styles.secondaryPillText}>去扫码</Text>
            </Pressable>
          </View>
          <View style={styles.codeRow}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              inputAccessoryViewID={ACCESSORY_ID}
              keyboardType="number-pad"
              maxLength={6}
              onChangeText={setPairingCode}
              onSubmitEditing={handleClaim}
              placeholder="请输入 6 位数字"
              placeholderTextColor="#99a3b4"
              style={styles.codeInput}
              textContentType="oneTimeCode"
              value={pairingCode}
              textAlign="center"
            />
            <Pressable
              style={[
                styles.connectBtn,
                !pairingCode.trim() && styles.connectBtnDisabled,
              ]}
              onPress={handleClaim}
              disabled={!pairingCode.trim()}
            >
              <Text style={styles.connectBtnText}>连接</Text>
            </Pressable>
          </View>
        </View>

        {statusCopy.message ? (
          <View
            style={[
              styles.statusBar,
              statusCopy.isError && styles.statusBarError,
            ]}
          >
            <Text
              style={[
                styles.statusBarText,
                statusCopy.isError && styles.statusBarTextError,
              ]}
            >
              {statusCopy.message}
            </Text>
          </View>
        ) : null}

        <View style={styles.sectionCard}>
          <View style={styles.recentHeader}>
            <View>
              <Text style={styles.sectionLabel}>最近会话</Text>
              <Text style={styles.sectionTitle}>快速重连</Text>
            </View>
            {history.length > 0 ? (
              <Pressable onPress={handleClearHistory}>
                <Text style={styles.clearText}>清空</Text>
              </Pressable>
            ) : null}
          </View>

          {history.length === 0 ? (
            <Text style={styles.emptyText}>
              暂无最近会话，连接成功后会自动记录。
            </Text>
          ) : (
            <FlatList
              data={history.slice(0, 8)}
              keyExtractor={(item, index) =>
                `${item.sessionId}-${item.connectedAt}-${index}`
              }
              scrollEnabled={false}
              renderItem={({ item }) => (
                <View style={styles.recentRow}>
                  <Pressable
                    style={styles.recentMain}
                    onPress={() => handleReconnect(item)}
                  >
                    <Text style={styles.recentTitle}>
                      {item.hostname ?? item.sessionId.slice(0, 8)}
                    </Text>
                    <Text style={styles.recentMeta}>
                      {safeHost(item.serverUrl)} · {timeAgo(item.connectedAt)}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.deleteBtn}
                    onPress={() => handleDeleteRecord(item)}
                    hitSlop={8}
                  >
                    <Text style={styles.deleteText}>删除</Text>
                  </Pressable>
                </View>
              )}
            />
          )}
        </View>
      </ScrollView>
      <KeyboardAccessory
        nativeID={ACCESSORY_ID}
        title="配对码"
        actionLabel="连接"
        onActionPress={handleClaim}
      />
    </KeyboardAvoidingView>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function getStatusCopy(status: string): {
  badge: string;
  description: string;
  message: string | null;
  isError: boolean;
} {
  if (status.startsWith("error:")) {
    return {
      badge: "连接异常",
      description: "无法连接到目标会话，请检查网关和会话状态。",
      message: status.replace("error:", "").replace(/_/g, " "),
      isError: true,
    };
  }

  switch (status) {
    case "claiming":
      return {
        badge: "正在连接",
        description: "正在领取会话控制权，请稍候。",
        message: "正在校验配对码...",
        isError: false,
      };
    case "connecting":
      return {
        badge: "正在连接",
        description: "正在建立实时终端通道。",
        message: "正在建立会话连接...",
        isError: false,
      };
    case "reconnecting":
      return {
        badge: "重连中",
        description: "网络抖动时会自动恢复，不需要重新配对。",
        message: "连接中断，正在自动恢复...",
        isError: false,
      };
    default:
      return {
        badge: "就绪",
        description: "你可以扫码、输入配对码，或从最近会话中直接继续。",
        message: null,
        isError: false,
      };
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
    backgroundColor: "#f2f2f7",
  },
  container: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 30,
    gap: 14,
  },
  heroCard: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 16,
    gap: 12,
  },
  heroTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  titleWrap: {
    gap: 4,
  },
  heroTitle: {
    color: "#111827",
    fontSize: 28,
    fontWeight: "700",
  },
  heroSubtitle: {
    color: "#6b7280",
    fontSize: 14,
    fontWeight: "500",
  },
  heroDescription: {
    color: "#4b5563",
    fontSize: 14,
    lineHeight: 20,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#e8f5e9",
  },
  statusBadgeError: {
    backgroundColor: "#fee2e2",
  },
  statusBadgeText: {
    color: "#166534",
    fontSize: 12,
    fontWeight: "600",
  },
  statusBadgeTextError: {
    color: "#991b1b",
  },
  primaryActions: {
    gap: 10,
  },
  primaryActionBtn: {
    backgroundColor: "#f9fafb",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 4,
  },
  scanBtn: {
    backgroundColor: "#eff6ff",
    borderColor: "#bfdbfe",
  },
  primaryActionDisabled: {
    opacity: 0.45,
  },
  primaryActionTitle: {
    color: "#111827",
    fontSize: 15,
    fontWeight: "600",
  },
  primaryActionHint: {
    color: "#6b7280",
    fontSize: 13,
    lineHeight: 18,
  },
  sectionCard: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 14,
    gap: 10,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  sectionTitleWrap: {
    flex: 1,
    gap: 3,
  },
  sectionLabel: {
    color: "#6b7280",
    fontSize: 12,
    fontWeight: "600",
  },
  sectionTitle: {
    color: "#111827",
    fontSize: 18,
    fontWeight: "700",
  },
  sectionHint: {
    color: "#6b7280",
    fontSize: 12,
  },
  secondaryPill: {
    minHeight: 34,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#d1d5db",
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryPillText: {
    color: "#2563eb",
    fontSize: 13,
    fontWeight: "600",
  },
  codeRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  codeInput: {
    flex: 1,
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: "#f9fafb",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    color: "#111827",
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: 5,
  },
  connectBtn: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: "#2563eb",
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  connectBtnDisabled: {
    opacity: 0.4,
  },
  connectBtnText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "700",
  },
  statusBar: {
    backgroundColor: "#e0f2fe",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  statusBarError: {
    backgroundColor: "#fee2e2",
  },
  statusBarText: {
    color: "#075985",
    fontSize: 13,
    textAlign: "center",
  },
  statusBarTextError: {
    color: "#b91c1c",
  },
  recentHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  clearText: {
    color: "#ef4444",
    fontSize: 13,
    fontWeight: "600",
  },
  emptyText: {
    color: "#6b7280",
    fontSize: 13,
    lineHeight: 18,
  },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  recentMain: {
    flex: 1,
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 3,
  },
  recentTitle: {
    color: "#111827",
    fontSize: 14,
    fontWeight: "600",
  },
  recentMeta: {
    color: "#6b7280",
    fontSize: 12,
  },
  deleteBtn: {
    minHeight: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#fecaca",
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff1f2",
  },
  deleteText: {
    color: "#dc2626",
    fontSize: 12,
    fontWeight: "600",
  },
});
