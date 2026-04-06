import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View,
} from "react-native";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import * as Haptics from "expo-haptics";
import { Swipeable } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import { GlassBar } from "../components/GlassBar";
import { useTheme, type Theme } from "../theme";
import type { ConnectionRecord } from "../storage/history";
import { loadHistory, removeBySessionId } from "../storage/history";
import { getDefaultServer, type SavedServer } from "../storage/servers";

interface HomeScreenProps {
  gatewayBaseUrl: string;
  status: string;
  connectionDetail?: string | null;
  onOpenConnectionSheet: () => void;
  onConnectSession: (sessionId: string, serverUrl?: string) => void;
  refreshKey?: number;
}

export function HomeScreen({
  gatewayBaseUrl,
  status,
  connectionDetail,
  onOpenConnectionSheet,
  onConnectSession,
  refreshKey,
}: HomeScreenProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [history, setHistory] = useState<ConnectionRecord[]>([]);
  const [defaultServer, setDefaultServer] = useState<SavedServer | undefined>();
  const swipeableRefs = useRef<Map<string, Swipeable>>(new Map());

  const refresh = useCallback(async () => {
    const [recent, server] = await Promise.all([loadHistory(), getDefaultServer()]);
    const seen = new Set<string>();
    const deduped = recent.filter((r) => {
      if (seen.has(r.sessionId)) return false;
      seen.add(r.sessionId);
      return true;
    });
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setHistory(deduped.slice(0, 5));
    setDefaultServer(server);
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh, gatewayBaseUrl, status, refreshKey]);

  const latest = history[0];
  const isLoading = status === "claiming" || status === "connecting";

  const handleNewConnection = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onOpenConnectionSheet();
  }, [onOpenConnectionSheet]);

  const handleResumeSession = useCallback((sessionId: string, serverUrl?: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onConnectSession(sessionId, serverUrl);
  }, [onConnectSession]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await removeBySessionId(sessionId);
    setHistory((prev) => prev.filter((r) => r.sessionId !== sessionId));
    swipeableRefs.current.delete(sessionId);
  }, []);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 20) }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={{ paddingHorizontal: 20, paddingTop: insets.top + 2, paddingBottom: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Image source={require("../../assets/adaptive-icon.png")} style={{ width: 40, height: 40, borderRadius: 10 }} />
          <Text style={{ fontSize: 34, fontWeight: "700", color: theme.text, letterSpacing: 0.37 }}>LinkShell</Text>
        </View>
        <Text style={{ fontSize: 15, color: theme.textTertiary, marginTop: 2 }}>远程终端，触手可及</Text>
      </View>

      {/* Quick Actions */}
      <View style={{ paddingHorizontal: 20, paddingTop: 8, gap: 12 }}>
        {status.startsWith("error:") && connectionDetail ? (
          <View
            style={{
              backgroundColor: theme.errorLight,
              borderRadius: 12,
              borderCurve: "continuous" as const,
              paddingVertical: 12,
              paddingHorizontal: 14,
              flexDirection: "row",
              alignItems: "flex-start",
              gap: 10,
            }}
          >
            <AppSymbol name="exclamationmark.triangle.fill" size={18} color={theme.error} style={{ marginTop: 1 }} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: theme.error, fontSize: 15, fontWeight: "600" }}>连接失败</Text>
              <Text style={{ color: theme.error, fontSize: 13, lineHeight: 18 }}>{connectionDetail}</Text>
            </View>
          </View>
        ) : null}

        <Pressable
          style={({ pressed }) => ({
            borderRadius: 14,
            borderCurve: "continuous" as const,
            borderWidth: 1,
            borderColor: theme.mode === "dark" ? "rgba(173,198,255,0.25)" : "rgba(58,95,200,0.2)",
            paddingVertical: 16,
            paddingHorizontal: 20,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            opacity: pressed ? 0.8 : 1,
          })}
          onPress={handleNewConnection}
          disabled={isLoading}
        >
          <GlassBar
            blurTint={theme.mode === "dark" ? "systemThinMaterialDark" : "systemThinMaterialLight"}
            fallbackColor={theme.bgCard}
            style={[StyleSheet.absoluteFill, { borderRadius: 14 }]}
          />
          {isLoading ? (
            <ActivityIndicator size="small" color={theme.accent} />
          ) : (
            <AppSymbol name="plus.circle.fill" size={24} color={theme.accent} />
          )}
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.text, fontSize: 17, fontWeight: "600" }}>{isLoading ? "连接中…" : "新建连接"}</Text>
            <Text style={{ color: theme.textTertiary, fontSize: 13, marginTop: 2 }}>{isLoading ? "正在建立终端连接" : "扫码、配对码或选择网关"}</Text>
          </View>
          {isLoading ? null : <AppSymbol name="chevron.right" size={12} color={theme.textTertiary} />}
        </Pressable>

        {latest ? (
          <Pressable
            style={({ pressed }) => ({
              borderRadius: 14,
              borderCurve: "continuous" as const,
              paddingVertical: 14,
              paddingHorizontal: 20,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              opacity: pressed ? 0.7 : 1,
            })}
            onPress={() => handleResumeSession(latest.sessionId, latest.serverUrl)}
          >
            <GlassBar
              blurTint={theme.mode === "dark" ? "systemThinMaterialDark" : "systemThinMaterialLight"}
              fallbackColor={theme.bgCard}
              style={[StyleSheet.absoluteFill, { borderRadius: 14 }]}
            />
            <AppSymbol name="arrow.counterclockwise.circle.fill" size={24} color={theme.success} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.text, fontSize: 15, fontWeight: "600" }}>
                {latest.projectName ? `继续 ${latest.projectName}` : "继续上次会话"}
              </Text>
              <Text style={{ color: theme.textTertiary, fontSize: 13, marginTop: 1 }}>
                {latest.sessionId.slice(0, 8)} · {timeAgo(latest.connectedAt)}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 1 }}>
                <AppSymbol name={platformIcon(latest.platform)} size={12} color={theme.textTertiary} />
                <Text style={{ color: theme.textTertiary, fontSize: 12 }} numberOfLines={1}>
                  {latest.hostname ?? safeHost(latest.serverUrl)}
                </Text>
              </View>
            </View>
            <AppSymbol name="chevron.right" size={10} color={theme.textTertiary} />
          </Pressable>
        ) : null}
      </View>

      {/* Recent Sessions */}
      <Text style={{ fontSize: 13, fontWeight: "400", color: theme.textTertiary, textTransform: "uppercase", paddingHorizontal: 36, paddingTop: 28, paddingBottom: 6 }}>最近会话</Text>
      {history.length === 0 ? (
        <GlassBar
          blurTint={theme.mode === "dark" ? "systemThinMaterialDark" : "systemThinMaterialLight"}
          fallbackColor={theme.bgCard}
          style={{
            marginHorizontal: 20,
            borderRadius: 12,
            borderCurve: "continuous" as const,
            paddingVertical: 40,
            paddingHorizontal: 20,
            alignItems: "center",
            gap: 8,
          }}
        >
          <AppSymbol name="terminal.fill" size={36} color={theme.textTertiary} style={{ marginBottom: 4 }} />
          <Text style={{ color: theme.textSecondary, fontSize: 17, fontWeight: "600" }}>还没有会话记录</Text>
          <Text style={{ color: theme.textTertiary, fontSize: 14, textAlign: "center", lineHeight: 20 }}>
            点击上方「新建连接」扫码或手动配对{"\n"}连接后的记录会出现在这里
          </Text>
        </GlassBar>
      ) : (
        <GlassBar
          blurTint={theme.mode === "dark" ? "systemThinMaterialDark" : "systemThinMaterialLight"}
          fallbackColor={theme.bgCard}
          style={{
            marginHorizontal: 20,
            borderRadius: 12,
            borderCurve: "continuous" as const,
            overflow: "hidden",
          }}
        >
          {history.map((item, index) => (
            <SwipeableRow
              key={item.sessionId}
              item={item}
              index={index}
              theme={theme}
              swipeableRefs={swipeableRefs}
              onPress={() => handleResumeSession(item.sessionId, item.serverUrl)}
              onDelete={() => handleDeleteSession(item.sessionId)}
            />
          ))}
        </GlassBar>
      )}
    </ScrollView>
  );
}

function SwipeableRow({
  item,
  index,
  theme,
  swipeableRefs,
  onPress,
  onDelete,
}: {
  item: ConnectionRecord;
  index: number;
  theme: Theme;
  swipeableRefs: React.MutableRefObject<Map<string, Swipeable>>;
  onPress: () => void;
  onDelete: () => void;
}) {
  const renderRightActions = useCallback(
    (_progress: Animated.AnimatedInterpolation<number>, dragX: Animated.AnimatedInterpolation<number>) => {
      const scale = dragX.interpolate({
        inputRange: [-80, 0],
        outputRange: [1, 0.5],
        extrapolate: "clamp",
      });
      return (
        <Pressable
          style={{
            backgroundColor: "#ff3b30",
            justifyContent: "center",
            alignItems: "center",
            width: 80,
          }}
          onPress={onDelete}
        >
          <Animated.View style={{ transform: [{ scale }] }}>
            <AppSymbol name="trash.fill" size={20} color="#ffffff" />
            <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "500", marginTop: 2 }}>删除</Text>
          </Animated.View>
        </Pressable>
      );
    },
    [onDelete],
  );

  return (
    <Swipeable
      ref={(ref) => {
        if (ref) swipeableRefs.current.set(item.sessionId, ref);
        else swipeableRefs.current.delete(item.sessionId);
      }}
      renderRightActions={renderRightActions}
      overshootRight={false}
      onSwipeableWillOpen={() => {
        // Close other open swipeables
        swipeableRefs.current.forEach((swipeable, id) => {
          if (id !== item.sessionId) swipeable.close();
        });
      }}
    >
      <Pressable
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 12,
          paddingHorizontal: 16,
          gap: 12,
          backgroundColor: pressed ? theme.bgInput : "transparent",
          borderTopWidth: index > 0 ? StyleSheet.hairlineWidth : 0,
          borderTopColor: theme.separator,
        })}
        onPress={onPress}
      >
        <AppSymbol name="terminal.fill" size={18} color={theme.accent} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.text, fontSize: 15 }} numberOfLines={1}>
            {item.projectName || item.sessionId.slice(0, 8)}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <AppSymbol name={platformIcon(item.platform)} size={12} color={theme.textTertiary} />
            <Text style={{ color: theme.textTertiary, fontSize: 13 }} numberOfLines={1}>{item.hostname ?? safeHost(item.serverUrl)}</Text>
            <Text style={{ color: theme.textTertiary, fontSize: 13 }}> · {timeAgo(item.connectedAt)}</Text>
          </View>
        </View>
        <AppSymbol name="chevron.right" size={10} color={theme.textTertiary} />
      </Pressable>
    </Swipeable>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function platformIcon(platform: string | undefined): string {
  switch (platform) {
    case "darwin": return "apple.logo";
    case "linux": return "server.rack";
    case "win32": return "pc";
    default: return "desktopcomputer";
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}