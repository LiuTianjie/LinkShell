import { useCallback, useEffect, useRef } from "react";
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

type QueuedPermissionAction = Required<Pick<AgentPermissionAction, "conversationId" | "requestId" | "outcome">> &
  Pick<AgentPermissionAction, "sessionId" | "optionId"> & {
    queuedAt: number;
    attempts: number;
  };

const ACTION_RETRY_TTL_MS = 45_000;

function actionKey(action: Pick<QueuedPermissionAction, "conversationId" | "requestId" | "outcome" | "optionId">): string {
  return `${action.conversationId}:${action.requestId}:${action.outcome}:${action.optionId ?? ""}`;
}

export function useAgentLiveActivityActions(workspace: AgentWorkspaceHandle) {
  const pendingActionsRef = useRef<QueuedPermissionAction[]>([]);
  const completedActionsRef = useRef<string[]>([]);

  const processPendingActions = useCallback(() => {
    if (pendingActionsRef.current.length === 0) return;
    const now = Date.now();
    const remaining: QueuedPermissionAction[] = [];

    for (const action of pendingActionsRef.current) {
      const key = actionKey(action);
      if (completedActionsRef.current.includes(key)) continue;
      const conversation = workspace.getConversation(action.conversationId);
      const hasSourceSession = conversation
        ? workspace.connectedSessions.some((session) =>
            session.sessionId === action.sessionId ||
            session.sessionId === conversation.sessionId,
          )
        : false;

      if (!conversation || !hasSourceSession) {
        if (now - action.queuedAt < ACTION_RETRY_TTL_MS) {
          remaining.push({ ...action, attempts: action.attempts + 1 });
        }
        continue;
      }

      const accepted = workspace.respondPermission(
        action.conversationId,
        action.requestId,
        action.outcome,
        action.optionId,
      );
      if (accepted) {
        completedActionsRef.current = [...completedActionsRef.current.slice(-49), key];
      } else if (now - action.queuedAt < ACTION_RETRY_TTL_MS) {
        remaining.push({ ...action, attempts: action.attempts + 1 });
      }
    }

    pendingActionsRef.current = remaining;
  }, [workspace]);

  const enqueueAction = useCallback((event: AgentPermissionAction) => {
    if (event.kind !== "agent_permission") return;
    if (!event.conversationId || !event.requestId || !event.outcome) return;

    const next: QueuedPermissionAction = {
      conversationId: event.conversationId,
      requestId: event.requestId,
      outcome: event.outcome,
      sessionId: event.sessionId,
      optionId: event.optionId || undefined,
      queuedAt: Date.now(),
      attempts: 0,
    };
    const key = actionKey(next);
    if (completedActionsRef.current.includes(key)) return;
    if (!pendingActionsRef.current.some((action) => actionKey(action) === key)) {
      pendingActionsRef.current = [...pendingActionsRef.current, next];
    }
    workspace.suppressPermissionRequest(
      next.conversationId,
      next.requestId,
      next.outcome,
      next.optionId,
    );
    confirmAction(next.requestId);
    processPendingActions();
  }, [processPendingActions, workspace]);

  useEffect(() => {
    if (Platform.OS !== "ios" || !NativeModules.ActionBridgeModule) return;

    const checkPendingActions = () => {
      NativeModules.ActionBridgeModule.checkPendingActions?.().catch?.(() => {});
    };

    const emitter = new NativeEventEmitter(NativeModules.ActionBridgeModule);
    const sub = emitter.addListener("onQuickAction", (event: AgentPermissionAction) => {
      enqueueAction(event);
    });

    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") checkPendingActions();
    });

    checkPendingActions();

    return () => {
      sub.remove();
      appStateSub.remove();
    };
  }, [enqueueAction]);

  useEffect(() => {
    processPendingActions();
  }, [processPendingActions, workspace.conversations, workspace.connectedSessions]);
}
