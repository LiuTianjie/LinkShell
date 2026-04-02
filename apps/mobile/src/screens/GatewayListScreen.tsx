import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Swipeable } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppSymbol } from "../components/AppSymbol";
import { useTheme, type Theme } from "../theme";
import {
  loadServers,
  removeServerWithHistory,
  setDefaultServer,
  type SavedServer,
} from "../storage/servers";
import { fetchWithTimeout } from "../utils/fetch-with-timeout";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface GatewayListScreenProps {
  onBack: () => void;
  onAddGateway: () => void;
  onGatewayChange: (url: string) => void;
}

export function GatewayListScreen({
  onBack,
  onAddGateway,
  onGatewayChange,
}: GatewayListScreenProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [testResult, setTestResult] = useState<Record<string, boolean | null>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const swipeableRefs = useRef<Map<string, Swipeable>>(new Map());

  const refresh = useCallback(async () => {
    const list = await loadServers();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setServers(list);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleTest = useCallback(async (url: string) => {
    setTesting(url);
    setTestResult((prev) => ({ ...prev, [url]: null }));
    try {
      const res = await fetchWithTimeout(`${url}/healthz`);
      setTestResult((prev) => ({ ...prev, [url]: res.ok }));
    } catch {
      setTestResult((prev) => ({ ...prev, [url]: false }));
    }
    setTesting(null);
  }, []);

  const handleDelete = useCallback(
    (server: SavedServer) => {
      Alert.alert(
        "删除网关",
        `确定删除「${server.name}」吗？\n该网关的所有会话记录也会被清除。`,
        [
          { text: "取消", style: "cancel" },
          {
            text: "删除",
            style: "destructive",
            onPress: async () => {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              const updated = await removeServerWithHistory(server.url);
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setServers(updated);
              swipeableRefs.current.delete(server.url);
              // If deleted server was the active one, switch to the new default
              if (updated.length > 0) {
                const newDefault = updated.find((s) => s.isDefault) ?? updated[0]!;
                onGatewayChange(newDefault.url);
              }
            },
          },
        ],
      );
    },
    [onGatewayChange],
  );

  const handleSetDefault = useCallback(
    async (url: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const updated = await setDefaultServer(url);
      onGatewayChange(url);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setServers(updated);
    },
    [onGatewayChange],
  );

  const cardStyle = {
    marginHorizontal: 20,
    backgroundColor: theme.bgCard,
    borderRadius: 12,
    borderCurve: "continuous" as const,
    overflow: "hidden" as const,
    boxShadow:
      theme.mode === "light" ? "0 0.5px 2px rgba(0,0,0,0.06)" : undefined,
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 20) }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View
          style={{
            paddingHorizontal: 20,
            paddingTop: insets.top + 2,
            paddingBottom: 8,
          }}
        >
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onBack();
            }}
            style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 8 }}
          >
            <AppSymbol name="chevron.left" size={17} color={theme.accent} />
            <Text style={{ fontSize: 17, color: theme.accent }}>设置</Text>
          </Pressable>
          <Text
            style={{
              fontSize: 34,
              fontWeight: "700",
              color: theme.text,
              letterSpacing: 0.37,
            }}
          >
            网关
          </Text>
          <Text
            style={{ fontSize: 15, color: theme.textTertiary, marginTop: 2 }}
          >
            {servers.length > 0
              ? `${servers.length} 个网关服务器`
              : "连接后自动添加"}
          </Text>
        </View>

        {/* Server list */}
        {servers.length === 0 ? (
          <View style={[cardStyle, { paddingVertical: 40, paddingHorizontal: 20, alignItems: "center", gap: 8 }]}>
            <AppSymbol name="server.rack" size={36} color={theme.textTertiary} style={{ marginBottom: 4 }} />
            <Text style={{ color: theme.textSecondary, fontSize: 17, fontWeight: "600" }}>还没有网关</Text>
            <Text style={{ color: theme.textTertiary, fontSize: 14, textAlign: "center", lineHeight: 20 }}>
              通过扫码或配对码连接后{"\n"}网关会自动保存到这里
            </Text>
          </View>
        ) : (
          <View style={cardStyle}>
            {servers.map((server, index) => (
              <React.Fragment key={server.url}>
                {index > 0 && (
                  <View
                    style={{
                      height: StyleSheet.hairlineWidth,
                      backgroundColor: theme.separator,
                      marginLeft: 58,
                    }}
                  />
                )}
                <SwipeableServerRow
                  server={server}
                  theme={theme}
                  testResult={testResult[server.url]}
                  isTesting={testing === server.url}
                  swipeableRefs={swipeableRefs}
                  onDelete={() => handleDelete(server)}
                  onTest={() => handleTest(server.url)}
                  onSetDefault={() => handleSetDefault(server.url)}
                />
              </React.Fragment>
            ))}
          </View>
        )}

        {/* Add button */}
        <Pressable
          style={({ pressed }) => ({
            marginHorizontal: 20,
            marginTop: 20,
            backgroundColor: pressed
              ? theme.mode === "dark"
                ? "rgba(173,198,255,0.12)"
                : "rgba(58,95,200,0.10)"
              : theme.bgCard,
            borderRadius: 12,
            borderCurve: "continuous" as const,
            borderWidth: 1,
            borderColor:
              theme.mode === "dark"
                ? "rgba(173,198,255,0.25)"
                : "rgba(58,95,200,0.2)",
            paddingVertical: 14,
            paddingHorizontal: 16,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          })}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onAddGateway();
          }}
        >
          <AppSymbol name="plus.circle.fill" size={18} color={theme.accent} />
          <Text
            style={{ fontSize: 16, fontWeight: "600", color: theme.accent }}
          >
            添加网关
          </Text>
        </Pressable>
        <Text
          style={{
            fontSize: 13,
            color: theme.textTertiary,
            paddingHorizontal: 36,
            paddingTop: 6,
          }}
        >
          跳转首页扫码或输入配对码来添加新网关。
        </Text>
      </ScrollView>
    </View>
  );
}

/* ── Swipeable Row ──────────────────────────── */

function SwipeableServerRow({
  server,
  theme,
  testResult,
  isTesting,
  swipeableRefs,
  onDelete,
  onTest,
  onSetDefault,
}: {
  server: SavedServer;
  theme: Theme;
  testResult: boolean | null | undefined;
  isTesting: boolean;
  swipeableRefs: React.MutableRefObject<Map<string, Swipeable>>;
  onDelete: () => void;
  onTest: () => void;
  onSetDefault: () => void;
}) {
  const renderRightActions = useCallback(
    (
      _progress: Animated.AnimatedInterpolation<number>,
      dragX: Animated.AnimatedInterpolation<number>,
    ) => {
      const scale = dragX.interpolate({
        inputRange: [-80, 0],
        outputRange: [1, 0.6],
        extrapolate: "clamp",
      });
      return (
        <Pressable
          style={{
            backgroundColor: theme.error,
            justifyContent: "center",
            alignItems: "center",
            width: 80,
          }}
          onPress={onDelete}
        >
          <Animated.View style={{ transform: [{ scale }], alignItems: "center", gap: 2 }}>
            <AppSymbol name="trash.fill" size={18} color="#ffffff" />
            <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "600" }}>删除</Text>
          </Animated.View>
        </Pressable>
      );
    },
    [onDelete, theme.error],
  );

  return (
    <Swipeable
      ref={(ref) => {
        if (ref) swipeableRefs.current.set(server.url, ref);
        else swipeableRefs.current.delete(server.url);
      }}
      renderRightActions={renderRightActions}
      overshootRight={false}
    >
      <View
        style={{
          backgroundColor: theme.bgCard,
          paddingVertical: 12,
          paddingHorizontal: 16,
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View
            style={{
              width: 30,
              height: 30,
              borderRadius: 7,
              borderCurve: "continuous",
              backgroundColor: "#34c759",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <AppSymbol name="server.rack" size={16} color="#ffffff" />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text
                style={{
                  color: theme.text,
                  fontSize: 16,
                  fontWeight: "600",
                }}
                numberOfLines={1}
              >
                {server.name}
              </Text>
              {server.isDefault && (
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
              )}
            </View>
            <Text
              style={{ color: theme.textTertiary, fontSize: 13 }}
              numberOfLines={1}
            >
              {server.url}
            </Text>
          </View>
        </View>

        {/* Action row */}
        <View style={{ flexDirection: "row", gap: 8, paddingLeft: 40 }}>
          <Pressable
            style={{
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 8,
              backgroundColor: theme.bgInput,
            }}
            onPress={onTest}
          >
            <Text
              style={[
                { color: theme.textSecondary, fontSize: 12, fontWeight: "600" },
                testResult === true && { color: theme.success },
                testResult === false && { color: theme.error },
              ]}
            >
              {isTesting
                ? "检测中…"
                : testResult === true
                  ? "可用 ✓"
                  : testResult === false
                    ? "失败 ✗"
                    : "检测连接"}
            </Text>
          </Pressable>

          {!server.isDefault && (
            <Pressable
              style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 8,
                backgroundColor: theme.bgInput,
              }}
              onPress={onSetDefault}
            >
              <Text
                style={{
                  color: theme.textSecondary,
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                设为默认
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    </Swipeable>
  );
}
