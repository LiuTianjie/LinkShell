import React, { useState } from "react";
import { useAppContext } from "../../contexts/AppContext";
import { SessionListScreen } from "../../screens/SessionListScreen";
import { AgentWebScreen } from "../../features/agent-web/AgentWebScreen";

function isUsableStatus(status: string): boolean {
  return (
    status === "connected" ||
    status === "reconnecting" ||
    status === "connecting" ||
    status === "host_disconnected"
  );
}

/**
 * The Agent tab opens the real web console (1:1 with the web app) inside a
 * WebView. Because a user's hosts can live on DIFFERENT gateways at once (a LAN
 * embedded gateway, a self-hosted gateway, the Pro official gateway) and a
 * single WebView is same-origin to ONE gateway, we keep a thin host-selection
 * layer in front: `SessionListScreen` already aggregates hosts across every
 * gateway (per-server `/sessions` + Pro `/sessions/mine`). Picking a host opens
 * the console pointed at that host's gateway; the web console's own drawer then
 * handles conversation switching/creation.
 *
 * If a host is already active we skip straight into its console (the common
 * single-host case — honors "tap Agent → straight in"); otherwise we show the
 * picker. The console's back affordance returns to the picker (which is exactly
 * what its "← 会话" label means), so multi-gateway users can switch hosts.
 */
export default function AgentTab() {
  const ctx = useAppContext();
  const active = ctx.activeSession;
  const [host, setHost] = useState<{ gatewayUrl: string; sessionId: string } | null>(
    () =>
      active && isUsableStatus(active.status)
        ? { gatewayUrl: active.gatewayUrl, sessionId: active.sessionId }
        : null,
  );

  if (host) {
    return (
      <AgentWebScreen
        hostGatewayUrl={host.gatewayUrl}
        hostSessionId={host.sessionId}
        onBack={() => setHost(null)}
      />
    );
  }

  return (
    <SessionListScreen
      gatewayBaseUrl={ctx.gatewayBaseUrl}
      onSelectSession={(sessionId, serverUrl) =>
        setHost({ gatewayUrl: serverUrl ?? ctx.gatewayBaseUrl, sessionId })
      }
      onSessionRemoved={ctx.handleRemoveSession}
      refreshKey={ctx.sessionRefreshKey}
      deviceToken={ctx.manager.deviceToken}
    />
  );
}
