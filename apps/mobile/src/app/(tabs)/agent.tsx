import React from "react";
import { useRouter } from "expo-router";
import { useAppContext } from "../../contexts/AppContext";
import { AgentWorkspaceScreen } from "../../screens/AgentWorkspaceScreen";

export default function AgentTab() {
  const ctx = useAppContext();
  const router = useRouter();

  return (
    <AgentWorkspaceScreen
      workspace={ctx.agentWorkspace}
      onOpenConnectionSheet={() => ctx.setConnectionSheetVisible(true)}
      onOpenConversation={(conversationId) => router.push(`/agent/${encodeURIComponent(conversationId)}`)}
    />
  );
}
