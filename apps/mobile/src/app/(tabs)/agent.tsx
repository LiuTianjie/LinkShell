import React from "react";
import { useRouter } from "expo-router";
import { useAppContext } from "../../contexts/AppContext";
import { SessionListScreen } from "../../screens/SessionListScreen";

/**
 * The Agent tab is a thin host picker. A user's hosts can live on different
 * gateways at once (LAN embedded / self-hosted / Pro official), and a single
 * WebView is same-origin to ONE gateway — so we pick a host here, then push the
 * web console as a FULL-SCREEN route (outside the tab group) so the native tab
 * bar is hidden while the console is open. `SessionListScreen` already
 * aggregates hosts across every gateway (per-server /sessions + Pro
 * /sessions/mine). Back from the console returns to this picker.
 *
 * Note: we intentionally do NOT auto-jump into a console on mount — that would
 * trap the user (back lands on this tab, which would immediately re-push).
 */
export default function AgentTab() {
  const ctx = useAppContext();
  const router = useRouter();

  return (
    <SessionListScreen
      gatewayBaseUrl={ctx.gatewayBaseUrl}
      onSelectSession={(sessionId, serverUrl) =>
        router.push({
          pathname: "/agent-console",
          params: { gateway: serverUrl ?? ctx.gatewayBaseUrl, session: sessionId },
        })
      }
      onSessionRemoved={ctx.handleRemoveSession}
      refreshKey={ctx.sessionRefreshKey}
      deviceToken={ctx.manager.deviceToken}
    />
  );
}
