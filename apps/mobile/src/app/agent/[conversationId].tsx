import React, { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAppContext } from "../../contexts/AppContext";
// Agent console is now the real web-dashboard console embedded in a WebView
// (true 1:1 parity). The old native screen (../../features/agent) is kept
// orphaned for one-line rollback until this is device-verified.
import { AgentWebScreen as AgentConversationScreen } from "../../features/agent-web/AgentWebScreen";
import { useTheme } from "../../theme";

export default function AgentConversationRoute() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const router = useRouter();
  const ctx = useAppContext();
  const { theme } = useTheme();
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

  const bg = theme.mode === "dark" ? "#0b0d0f" : "#ffffff";

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <AgentConversationScreen
        conversationId={conversationId ?? ""}
        workspace={ctx.agentWorkspace}
        isRestoring={restoring}
        onBack={() => router.back()}
      />
    </View>
  );
}
