import React from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAppContext } from "../../contexts/AppContext";
import { AgentConversationScreen } from "../../screens/AgentConversationScreen";

export default function AgentConversationRoute() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const router = useRouter();
  const ctx = useAppContext();

  return (
    <AgentConversationScreen
      conversationId={conversationId ?? ""}
      workspace={ctx.agentWorkspace}
      onBack={() => router.back()}
    />
  );
}
