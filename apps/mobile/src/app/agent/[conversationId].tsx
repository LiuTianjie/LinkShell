import React, { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAppContext } from "../../contexts/AppContext";
import { AgentConversationScreen } from "../../screens/AgentConversationScreen";
import { getValidSession } from "../../lib/supabase";

export default function AgentConversationRoute() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const router = useRouter();
  const ctx = useAppContext();
  const resumedConversationRef = useRef<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);

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

  useEffect(() => {
    getValidSession().then((session) => setAuthToken(session?.accessToken ?? null));
  }, [conversationId]);

  return (
    <AgentConversationScreen
      conversationId={conversationId ?? ""}
      workspace={ctx.agentWorkspace}
      deviceToken={ctx.manager.deviceToken}
      authToken={authToken}
      onBack={() => router.back()}
    />
  );
}
