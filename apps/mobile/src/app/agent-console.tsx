import React from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AgentWebScreen } from "../features/agent-web/AgentWebScreen";

/**
 * Full-screen host for the embedded web agent console, mounted OUTSIDE the
 * (tabs) group so the native bottom tab bar is covered while the console is
 * open. The Agent tab pushes here with the chosen host's gateway + session id;
 * back returns to the host picker (the Agent tab).
 */
export default function AgentConsoleRoute() {
  const router = useRouter();
  const { gateway, session } = useLocalSearchParams<{
    gateway?: string;
    session?: string;
  }>();

  return (
    <AgentWebScreen
      hostGatewayUrl={gateway}
      hostSessionId={session}
      onBack={() => router.back()}
    />
  );
}
