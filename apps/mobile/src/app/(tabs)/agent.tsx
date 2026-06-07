import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppContext } from "../../contexts/AppContext";
import { AgentWebScreen } from "../../features/agent-web/AgentWebScreen";
import { AppSymbol } from "../../components/AppSymbol";
import { useTheme } from "../../theme";

function isUsableStatus(status: string): boolean {
  return (
    status === "connected" ||
    status === "reconnecting" ||
    status === "connecting" ||
    status === "host_disconnected"
  );
}

/**
 * The Agent tab now opens the real web console directly inside a WebView (1:1
 * with the web app) — no native list page in between. Conversation switching /
 * creation happens inside the web console's own drawer. The web console's
 * "← back" affordance posts requestClose → we switch to the Home tab.
 *
 * When no host session is connected there's nothing to show, so we render a
 * native prompt to connect instead of a blank/login WebView.
 */
export default function AgentTab() {
  const ctx = useAppContext();
  const router = useRouter();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  const sessions = [...ctx.manager.sessions.values()];
  const host =
    (ctx.activeSession && isUsableStatus(ctx.activeSession.status)
      ? ctx.activeSession
      : undefined) ??
    sessions.find((s) => isUsableStatus(s.status)) ??
    sessions[0];

  const goHome = () => router.navigate("/");

  if (!host) {
    return (
      <View
        style={[
          styles.center,
          { backgroundColor: theme.bg, paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        <View
          style={[styles.iconWrap, { backgroundColor: theme.accentLight }]}
        >
          <AppSymbol name="sparkles" size={26} color={theme.accent} />
        </View>
        <Text style={[styles.title, { color: theme.text }]}>还没有可用的主机</Text>
        <Text style={[styles.body, { color: theme.textSecondary }]}>
          连接一台运行 linkshell 的主机后，就能在这里直接使用 Agent。
        </Text>
        <Pressable
          onPress={() => ctx.setConnectionSheetVisible(true)}
          style={({ pressed }) => [
            styles.btn,
            { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Text style={styles.btnText}>连接主机</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <AgentWebScreen
      hostGatewayUrl={host.gatewayUrl}
      hostSessionId={host.sessionId}
      onBack={goHome}
    />
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 36,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  btn: {
    marginTop: 6,
    paddingHorizontal: 22,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
});
