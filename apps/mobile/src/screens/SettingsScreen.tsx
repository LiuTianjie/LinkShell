import React, { useCallback, useEffect, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Switch, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "@react-navigation/native";
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

export function SettingsScreen({
  gatewayBaseUrl,
  onGatewayChange,
  onOpenGatewayList,
}: SettingsScreenProps) {
  const { theme, toggleTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const isDark = theme.mode === "dark";

  const [serverCount, setServerCount] = useState(0);
  const [defaultServerName, setDefaultServerName] = useState("");
  const [historyCount, setHistoryCount] = useState(0);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showSupport, setShowSupport] = useState(false);

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

  // Refresh counts every time settings tab gains focus (e.g. after gateway deletion)
  useFocusEffect(
    useCallback(() => {
      refreshCounts();
    }, [refreshCounts]),
  );

  const handleClearHistory = useCallback(() => {
    if (historyCount === 0) return;
    Alert.alert(
      "清除历史记录",
      `确定要清除全部 ${historyCount} 条连接记录吗？`,
      [
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
      ],
    );
  }, [historyCount]);

  const cardStyle = {
    marginHorizontal: 20,
    backgroundColor: theme.bgCard,
    borderRadius: 12,
    borderCurve: "continuous" as const,
    overflow: "hidden" as const,
    boxShadow:
      theme.mode === "light" ? "0 0.5px 2px rgba(0,0,0,0.06)" : undefined,
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
          <Text
            style={{
              fontSize: 34,
              fontWeight: "700",
              color: theme.text,
              letterSpacing: 0.37,
            }}
          >
            设置
          </Text>
        </View>

        {/* Appearance Section */}
        <Text style={[sectionLabel, { paddingTop: 24 }]}>外观</Text>
        <View style={cardStyle}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingVertical: 11,
              paddingHorizontal: 16,
              gap: 12,
            }}
          >
            <View
              style={{
                width: 30,
                height: 30,
                borderRadius: 7,
                borderCurve: "continuous",
                backgroundColor: "#5856d6",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AppSymbol name="moon.fill" size={16} color="#ffffff" />
            </View>
            <Text style={{ flex: 1, fontSize: 17, color: theme.text }}>
              深色模式
            </Text>
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
        <Text
          style={{
            fontSize: 13,
            color: theme.textTertiary,
            paddingHorizontal: 36,
            paddingTop: 6,
          }}
        >
          在深色和浅色主题间切换。
        </Text>

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
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 17, color: theme.text }}>管理网关</Text>
              <Text
                style={{
                  fontSize: 13,
                  color: theme.textTertiary,
                  marginTop: 1,
                }}
              >
                {serverCount > 0
                  ? `${serverCount} 个网关 · 默认: ${defaultServerName}`
                  : "尚未添加网关"}
              </Text>
            </View>
            <AppSymbol
              name="chevron.right"
              size={13}
              color={theme.textTertiary}
            />
          </Pressable>
        </View>
        <Text
          style={{
            fontSize: 13,
            color: theme.textTertiary,
            paddingHorizontal: 36,
            paddingTop: 6,
          }}
        >
          添加、测试和管理中继网关服务器。
        </Text>

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
            <View
              style={{
                width: 30,
                height: 30,
                borderRadius: 7,
                borderCurve: "continuous",
                backgroundColor: "#ff3b30",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AppSymbol name="trash.fill" size={16} color="#ffffff" />
            </View>
            <Text style={{ flex: 1, fontSize: 17, color: theme.text }}>
              清除历史记录
            </Text>
            <Text style={{ fontSize: 17, color: theme.textTertiary }}>
              {historyCount} 条
            </Text>
          </Pressable>
        </View>
        <Text
          style={{
            fontSize: 13,
            color: theme.textTertiary,
            paddingHorizontal: 36,
            paddingTop: 6,
          }}
        >
          清除所有已保存的连接记录。
        </Text>

        {/* About Section */}
        <Text style={sectionLabel}>关于</Text>
        <View style={cardStyle}>
          <SettingsRow
            icon="app.badge.fill"
            iconBg="#007aff"
            label="版本"
            value="1.0.7"
            theme={theme}
          />
          <View
            style={{
              height: 0.5,
              backgroundColor: theme.separator,
              marginLeft: 58,
            }}
          />
          <Pressable
            onPress={() => setShowPrivacy(true)}
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
                backgroundColor: "#5856d6",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AppSymbol name="lock.shield.fill" size={16} color="#ffffff" />
            </View>
            <Text style={{ flex: 1, fontSize: 17, color: theme.text }}>
              隐私政策
            </Text>
            <AppSymbol
              name="chevron.right"
              size={13}
              color={theme.textTertiary}
            />
          </Pressable>
          <View
            style={{
              height: 0.5,
              backgroundColor: theme.separator,
              marginLeft: 58,
            }}
          />
          <Pressable
            onPress={() => setShowSupport(true)}
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
                backgroundColor: "#ff9500",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AppSymbol name="questionmark.circle.fill" size={16} color="#ffffff" />
            </View>
            <Text style={{ flex: 1, fontSize: 17, color: theme.text }}>
              技术支持
            </Text>
            <AppSymbol
              name="chevron.right"
              size={13}
              color={theme.textTertiary}
            />
          </Pressable>
        </View>
        <Text
          style={{
            fontSize: 13,
            color: theme.textTertiary,
            paddingHorizontal: 36,
            paddingTop: 6,
          }}
        >
          面向 AI 编码代理的远程终端应用。
        </Text>
      </ScrollView>

      {/* Privacy Policy Modal */}
      <InfoModal
        visible={showPrivacy}
        onClose={() => setShowPrivacy(false)}
        title="隐私政策"
        theme={theme}
        content={PRIVACY_TEXT}
      />

      {/* Support Modal */}
      <InfoModal
        visible={showSupport}
        onClose={() => setShowSupport(false)}
        title="技术支持"
        theme={theme}
        content={SUPPORT_TEXT}
      />
    </View>
  );
}

function SettingsRow({
  icon,
  iconBg,
  label,
  value,
  theme,
}: {
  icon: string;
  iconBg: string;
  label: string;
  value: string;
  theme: any;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 11,
        paddingHorizontal: 16,
        gap: 12,
      }}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 7,
          borderCurve: "continuous" as const,
          backgroundColor: iconBg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <AppSymbol name={icon} size={16} color="#ffffff" />
      </View>
      <Text style={{ flex: 1, fontSize: 17, color: theme.text }}>{label}</Text>
      <Text style={{ fontSize: 17, color: theme.textTertiary }}>{value}</Text>
    </View>
  );
}

function InfoModal({
  visible,
  onClose,
  title,
  theme,
  content,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  theme: any;
  content: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 20,
            paddingTop: insets.top + 8,
            paddingBottom: 12,
            borderBottomWidth: 0.5,
            borderBottomColor: theme.separator,
          }}
        >
          <Text style={{ fontSize: 20, fontWeight: "700", color: theme.text }}>
            {title}
          </Text>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => ({
              width: 30,
              height: 30,
              borderRadius: 15,
              backgroundColor: theme.bgInput,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <AppSymbol name="xmark" size={12} color={theme.textSecondary} />
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={{
            padding: 20,
            paddingBottom: Math.max(insets.bottom, 20) + 20,
          }}
          showsVerticalScrollIndicator={false}
        >
          <Text
            style={{
              fontSize: 15,
              lineHeight: 24,
              color: theme.textSecondary,
            }}
          >
            {content}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const PRIVACY_TEXT = `LinkShell 隐私政策

最后更新日期：2026 年 4 月 10 日

LinkShell（以下简称"本应用"）由开发者刘天杰（以下简称"我们"）开发和运营。我们重视您的隐私，本政策说明本应用如何收集、使用和保护您的信息。

一、我们收集的信息

本应用收集的信息极为有限：

• 设备令牌：用于标识您的设备并维持会话连接，存储在您的设备本地。
• 终端数据：您与远程终端之间的输入输出数据通过中继服务器传输，服务器不持久化存储这些数据。
• 摄像头：仅用于扫描配对二维码，不拍摄或存储任何照片或视频。
• 麦克风：仅用于语音输入功能，音频在设备端处理，不上传或存储。

二、我们不收集的信息

• 不收集个人身份信息（姓名、邮箱、电话等）
• 不收集位置信息
• 不收集使用分析或行为数据
• 不使用任何第三方分析或广告 SDK
• 不使用 Cookie 或跟踪技术

三、数据传输

本应用通过 WebSocket 连接将您的手机与电脑终端桥接。终端数据经由中继服务器转发，仅在内存中短暂缓存用于会话恢复，不写入磁盘或数据库。WebRTC 远程桌面功能建立点对点连接，视频流不经过服务器。

四、数据存储

• 会话配置和设备令牌存储在您的设备本地
• 服务器端不持久化存储任何用户数据
• 会话断开后，所有相关数据从服务器内存中清除

五、第三方服务

本应用使用 Google STUN 服务器（stun:stun.l.google.com:19302）用于 WebRTC 连接建立。除此之外，不与任何第三方共享数据。

六、开源

本应用完全开源，源代码可在 GitHub 查阅：github.com/LiuTianjie/LinkShell

七、儿童隐私

本应用不面向 13 岁以下儿童，不会有意收集儿童的个人信息。

八、隐私政策变更

如本政策有更新，我们将在此页面发布修订版本并更新日期。

九、联系我们

如有任何隐私相关问题，请通过以下方式联系：
GitHub Issues：github.com/LiuTianjie/LinkShell/issues`;

const SUPPORT_TEXT = `LinkShell 技术支持

感谢使用 LinkShell。如果您在使用过程中遇到任何问题，以下信息可能对您有帮助。

常见问题

Q：扫码后连不上？
A：请确认手机和电脑在同一网络下，或使用远程 Gateway 地址。检查电脑终端中 linkshell-cli 是否正在运行。

Q：终端输出有延迟？
A：网络状况会影响传输速度。如使用远程 Gateway，延迟取决于服务器与您的网络距离。

Q：远程桌面点了开始没反应？
A：请确认 CLI 启动时使用了 --screen 参数，并确保电脑上已安装 ffmpeg。

Q：语音输入无法使用？
A：请在系统设置中确认已授予 LinkShell 麦克风和语音识别权限。

Q：连接频繁断开？
A：检查网络稳定性。应用会自动重连，如持续断开请尝试重新扫码配对。

CLI 安装

npm install -g linkshell-cli

或直接运行：

npx linkshell-cli

获取帮助

• GitHub Issues：github.com/LiuTianjie/LinkShell/issues
• 源代码：github.com/LiuTianjie/LinkShell

系统要求

• iOS 16.0 及以上
• CLI 端需要 Node.js 18 及以上
• 远程桌面功能需要安装 ffmpeg`;
