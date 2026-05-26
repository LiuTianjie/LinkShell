import React, { useCallback } from "react";
import { useRouter } from "expo-router";
import { useAppContext } from "../contexts/AppContext";
import { GatewayListScreen } from "../screens/GatewayListScreen";

function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export default function GatewayListRoute() {
  const router = useRouter();
  const ctx = useAppContext();
  const handleServerRemoved = useCallback((url: string) => {
    const normalized = normalizeServerUrl(url);
    const sessionsToDisconnect = [...ctx.manager.sessions.values()]
      .filter((session) => normalizeServerUrl(session.gatewayUrl) === normalized)
      .sort((a, b) => {
        if (a.sessionId === ctx.manager.activeSessionId) return 1;
        if (b.sessionId === ctx.manager.activeSessionId) return -1;
        return 0;
      });
    for (const session of sessionsToDisconnect) {
      ctx.manager.disconnectSession(session.sessionId);
    }
    ctx.agentWorkspace.removeByServerUrl(url).catch(() => {});
    ctx.agentWorkspace.refresh({ mergeCurrent: false }).catch(() => {});
    ctx.setSessionRefreshKey((k) => k + 1);
  }, [ctx.agentWorkspace, ctx.manager, ctx.setSessionRefreshKey]);

  return (
    <GatewayListScreen
      onBack={() => {
        ctx.setSessionRefreshKey((k) => k + 1);
        router.back();
      }}
      onAddGateway={() => {
        ctx.setSessionRefreshKey((k) => k + 1);
        router.back();
        setTimeout(() => ctx.setConnectionSheetVisible(true), 350);
      }}
      onGatewayChange={ctx.setGatewayBaseUrl}
      onServerRemoved={handleServerRemoved}
    />
  );
}
