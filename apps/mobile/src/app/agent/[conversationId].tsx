import React, { useEffect, useRef } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAppContext } from "../../contexts/AppContext";
import { AgentConversationScreen } from "../../screens/AgentConversationScreen";

export default function AgentConversationRoute() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const router = useRouter();
  const ctx = useAppContext();
  const resumedConversationRef = useRef<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    if (!ctx.agentWorkspace.getConversation(conversationId)) return;
    if (resumedConversationRef.current === conversationId) return;
    resumedConversationRef.current = conversationId;
    ctx.agentWorkspace.resumeConversation(conversationId)
      .then((result) => {
        if (!result && resumedConversationRef.current === conversationId) {
          resumedConversationRef.current = null;
        }
      })
      .catch(() => {
        if (resumedConversationRef.current === conversationId) {
          resumedConversationRef.current = null;
        }
      });
  }, [conversationId, ctx.agentWorkspace]);

  return (
    <AgentConversationScreen
      conversationId={conversationId ?? ""}
      workspace={ctx.agentWorkspace}
      onBack={() => router.back()}
    />
  );
}
