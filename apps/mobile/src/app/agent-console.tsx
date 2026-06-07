import React from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AgentWebScreen } from "../features/agent-web/AgentWebScreen";
import { useTheme } from "../theme";

/**
 * Full-screen host for the embedded web agent console, mounted OUTSIDE the
 * (tabs) group so the native bottom tab bar is covered while the console is
 * open. The Agent tab pushes here with the chosen host's gateway + session id;
 * back returns to the host picker (the Agent tab).
 */
export default function AgentConsoleRoute() {
  const router = useRouter();
  const { theme } = useTheme();
  const { gateway, session } = useLocalSearchParams<{
    gateway?: string;
    session?: string;
  }>();

  // bg matches the web canvas dark color (AgentWebScreen’s containerBg default).
  // Stops the Stack navigator’s default background from flashing through at the
  // top safe-area / status-bar region.
  const bg = theme.mode === "dark" ? "#0b0d0f" : "#ffffff";

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <AgentWebScreen
        hostGatewayUrl={gateway}
        hostSessionId={session}
        onBack={() => router.back()}
      />
    </View>
  );
}
