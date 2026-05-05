import { useEffect } from "react";
import { AppState, NativeEventEmitter, NativeModules, Platform } from "react-native";
import type { AgentWorkspaceHandle } from "./useAgentWorkspace";
import { confirmAction } from "../native/LiveActivity";

type AgentPermissionAction = {
  kind?: "agent_permission" | string;
  sessionId?: string;
  conversationId?: string;
  requestId?: string;
  outcome?: "allow" | "deny" | "cancelled";
  optionId?: string;
};

export function useAgentLiveActivityActions(workspace: AgentWorkspaceHandle) {
  useEffect(() => {
    if (Platform.OS !== "ios" || !NativeModules.ActionBridgeModule) return;

    const checkPendingActions = () => {
      NativeModules.ActionBridgeModule.checkPendingActions?.().catch?.(() => {});
    };

    const emitter = new NativeEventEmitter(NativeModules.ActionBridgeModule);
    const sub = emitter.addListener("onQuickAction", (event: AgentPermissionAction) => {
      if (event.kind !== "agent_permission") return;
      if (!event.conversationId || !event.requestId || !event.outcome) return;

      workspace.respondPermission(
        event.conversationId,
        event.requestId,
        event.outcome,
        event.optionId,
      );
      confirmAction(event.requestId);
    });

    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") checkPendingActions();
    });

    checkPendingActions();

    return () => {
      sub.remove();
      appStateSub.remove();
    };
  }, [workspace]);
}
