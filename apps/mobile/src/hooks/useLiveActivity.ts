import { useEffect } from "react";
import { AppState, NativeModules, NativeEventEmitter, Platform } from "react-native";
import type { SessionManagerHandle } from "./useSessionManager";
import { confirmAction } from "../native/LiveActivity";

// This hook only handles ActionBridge: receiving quick actions from the widget.
// Live Activity lifecycle (start/update/end) is managed in App.tsx.

export function useLiveActivity(manager: SessionManagerHandle) {
  useEffect(() => {
    if (Platform.OS !== "ios" || !NativeModules.ActionBridgeModule) return;
    const checkPendingActions = () => {
      NativeModules.ActionBridgeModule.checkPendingActions?.().catch?.(() => {});
    };
    const emitter = new NativeEventEmitter(NativeModules.ActionBridgeModule);
    const sub = emitter.addListener(
      "onQuickAction",
      (event: { sessionId: string; terminalId: string; input: string; requestId: string }) => {
        const info = manager.sessions.get(event.sessionId);
        if (!info) return;

        if (event.requestId && (event.input === "allow" || event.input === "deny")) {
          manager.sendPermissionDecision(
            event.sessionId,
            event.terminalId,
            event.requestId,
            event.input,
          );
        } else {
          manager.setActiveSessionId(event.sessionId);
          if (event.terminalId && event.terminalId !== "default") {
            manager.switchTerminal(event.terminalId);
          }
          setTimeout(() => manager.sendInput(event.input), 50);
        }

        if (event.requestId) {
          confirmAction(event.requestId);
        }
      },
    );
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") checkPendingActions();
    });
    checkPendingActions();
    return () => {
      sub.remove();
      appStateSub.remove();
    };
  }, [manager]);
}
