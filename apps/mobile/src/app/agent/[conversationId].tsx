import React, { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAppContext } from "../../contexts/AppContext";
import { AgentConversationScreen } from "../../screens/AgentConversationScreen";

export default function AgentConversationRoute() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const router = useRouter();
  const ctx = useAppContext();
  const resumedConversationRef = useRef<string | null>(null);
  const restoreRunRef = useRef(0);
  const mountedRef = useRef(true);
  const agentWorkspaceRef = useRef(ctx.agentWorkspace);
  const [restoring, setRestoring] = useState(false);
  const agentWorkspace = ctx.agentWorkspace;
  const isHydrated = agentWorkspace.isHydrated;

  useEffect(() => {
    agentWorkspaceRef.current = ctx.agentWorkspace;
  }, [ctx.agentWorkspace]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      restoreRunRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const workspace = agentWorkspaceRef.current;
    if (!conversationId) {
      setRestoring(false);
      return;
    }
    if (!workspace.getConversation(conversationId)) {
      setRestoring(!isHydrated);
      return;
    }
    if (resumedConversationRef.current === conversationId) return;
    resumedConversationRef.current = conversationId;
    const runId = restoreRunRef.current + 1;
    restoreRunRef.current = runId;
    setRestoring(true);
    const stopRestoring = () => {
      if (mountedRef.current && restoreRunRef.current === runId) {
        setRestoring(false);
      }
    };
    const timeout = setTimeout(stopRestoring, 4_500);
    workspace.resumeConversation(conversationId)
      .then((result) => {
        if (!result && resumedConversationRef.current === conversationId) {
          resumedConversationRef.current = null;
        }
      })
      .catch(() => {
        if (resumedConversationRef.current === conversationId) {
          resumedConversationRef.current = null;
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        stopRestoring();
      });
  }, [conversationId, isHydrated]);

  return (
    <AgentConversationScreen
      conversationId={conversationId ?? ""}
      workspace={ctx.agentWorkspace}
      isRestoring={restoring}
      onBack={() => router.back()}
    />
  );
}
