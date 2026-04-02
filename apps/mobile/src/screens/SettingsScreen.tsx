import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Switch, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import { useTheme } from "../theme";
import { clearHistory, loadHistory } from "../storage/history";
import { getDefaultServer, loadServers } from "../storage/servers";

interface SettingsScreenProps {
  gatewayBaseUrl: string;
  onGatewayChange: (url: string) => void;
  onOpenGatewayList: () => void;
}

export function SettingsScreen({ gatewayBaseUrl, onGatewayChange, onOpenGatewayList }: SettingsScreenProps) {
  const { theme, toggleTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const isDark = theme.mode === "dark";

  const [serverCount, setServerCount] = useState(0);
  const [defaultServerName, setDefaultServerName] = useState("");
  const [historyCount, setHistoryCount] = useState(0);

  const refreshCounts = useCallback(async () => {
    const [servers, history, defaultSrv] = await Promise.all([
      loadServers(),
      loadHistory(),
      getDefaultServer(),
    ]);
    setServerCount(servers.length);
    setHistoryCount(history.length);
    setDefaultServerName(defaultSrv?.name ?? "未设置");
  }, []);

  useEffect(() => {
    refreshCounts();
  }, [refreshCounts]);

  const handleClearHistory = useCallback(() => {
    if (historyCount === 0) return;
    Alert.alert("清除历史记录", `确定要清除全部 ${historyCount} 条连接记录吗？`, [
      { text: "取消", style: "cancel" },
      {
        text: "清除",
        style: "destructive",
        onPress: async () => {
          await clearHistory();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setHistoryCount(0);
        },
      },
    ]);
  }, [historyCount]);

  const cardStyle = {
    marginHorizontal: 20,
    backgroundColor: theme.bgCard,
    borderRadius: 12,
    borderCurve: "continuous" as const,
    overflow: "hidden" as const,
    boxShadow: theme.mode === "light" ? "0 0.5px 2px rgba(0,0,0,0.06)" : undefined,
  };

  const sectionLabel = {
    fontSize: 13,
    fontWeight: "400" as const,
    color: theme.textTertiary,
    textTransform: "uppercase" as const,
    paddingHorizontal: 36,
    paddingTop: 28,
    paddingBottom: 6,
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 20) }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={{ paddingHorizontal: 20, paddingTop: insets.top + 2, paddingBottom: 8 }}>
        <Text style={{ fontSize: 34, fontWeight: "700", color: theme.text, letterSpacing: 0.37 }}>设置</Text>
      </View>

      {/* Appearance Section */}
      <Text style={[sectionLabel, { paddingTop: 24 }]}>外观</Text>
      <View style={cardStyle}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 11, paddingHorizontal: 16, gap: 12 }}>
          <View style={{ width: 30, height: 30, borderRadius: 7, borderCurve: "continuous", backgroundColor: "#5856d6", alignItems: "center", justifyContent: "center" }}>
            <AppSymbol name="moon.fill" size={16} color="#ffffff" />
          </View>
          <Text style={{ flex: 1, fontSize: 17, color: theme.text }}>深色模式</Text>
          <Switch
            value={isDark}
            onValueChange={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              toggleTheme();
            }}
            trackColor={{ false: "#e5e5ea", true: "#34c759" }}
          />
        </View>
      </View>
      <Text style={{ fontSize: 13, color: theme.textTertiary, paddingHorizontal: 36, paddingTop: 6 }}>在深色和浅色主题间切换。</Text>

      {/* Gateway Section */}
      <Text style={sectionLabel}>网关</Text>
      <View style={cardStyle}>
        <Pressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onOpenGatewayList();
          }}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 11,
            paddingHorizontal: 16,
            gap: 12,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <View style={{ width: 30, height: 30, borderRadius: 7, borderCurve: "continuous", backgroundColor: "#34c759", alignItems: "center", justifyContent: "center" }}>
            <AppSymbol name="server.rack" size={16} color="#ffffff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 17, color: theme.text }}>管理网关</Text>
            <Text style={{ fontSize: 13, color: theme.textTertiary, marginTop: 1 }}>
              {serverCount > 0 ? `${serverCount} 个网关 · 默认: ${defaultServerName}` : "尚未添加网关"}
            </Text>
          </View>
          <AppSymbol name="chevron.right" size={13} color={theme.textTertiary} />
        </Pressable>
      </View>
      <Text style={{ fontSize: 13, color: theme.textTertiary, paddingHorizontal: 36, paddingTop: 6 }}>添加、测试和管理中继网关服务器。</Text>

      {/* Data Section */}
      <Text style={sectionLabel}>数据</Text>
      <View style={cardStyle}>
        <Pressable
          onPress={handleClearHistory}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            paddingVertical: 11,
            paddingHorizontal: 16,
            gap: 12,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <View style={{ width: 30, height: 30, borderRadius: 7, borderCurve: "continuous", backgroundColor: "#ff3b30", alignItems: "center", justifyContent: "center" }}>
            <AppSymbol name="trash.fill" size={16} color="#ffffff" />
          </View>
          <Text style={{ flex: 1, fontSize: 17, color: theme.text }}>清除历史记录</Text>
          <Text style={{ fontSize: 17, color: theme.textTertiary }}>{historyCount} 条</Text>
        </Pressable>
      </View>
      <Text style={{ fontSize: 13, color: theme.textTertiary, paddingHorizontal: 36, paddingTop: 6 }}>清除所有已保存的连接记录。</Text>

      {/* About Section */}
      <Text style={sectionLabel}>关于</Text>
      <View style={cardStyle}>
        <SettingsRow icon="app.badge.fill" iconBg="#007aff" label="版本" value="0.1.0" theme={theme} />
      </View>
      <Text style={{ fontSize: 13, color: theme.textTertiary, paddingHorizontal: 36, paddingTop: 6 }}>面向 AI 编码代理的远程终端应用。</Text>
    </ScrollView>
  );
}

function SettingsRow({ icon, iconBg, label, value, theme }: { icon: string; iconBg: string; label: string; value: string; theme: any }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 11, paddingHorizontal: 16, gap: 12 }}>
      <View style={{ width: 30, height: 30, borderRadius: 7, borderCurve: "continuous" as const, backgroundColor: iconBg, alignItems: "center", justifyContent: "center" }}>
        <AppSymbol name={icon} size={16} color="#ffffff" />
      </View>
      <Text style={{ flex: 1, fontSize: 17, color: theme.text }}>{label}</Text>
      <Text style={{ fontSize: 17, color: theme.textTertiary }}>{value}</Text>
    </View>
  );
}
