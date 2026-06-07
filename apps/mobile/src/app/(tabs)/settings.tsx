import React from "react";
import { useRouter } from "expo-router";
import { useAppContext } from "../../contexts/AppContext";
import { SettingsScreen } from "../../screens/SettingsScreen";
import { removeServerWithHistory } from "../../storage/servers";

function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export default function SettingsTab() {
  const ctx = useAppContext();
  const router = useRouter();

  return (
    <SettingsScreen
      gatewayBaseUrl={ctx.gatewayBaseUrl}
      onGatewayChange={ctx.setGatewayBaseUrl}
      onOpenGatewayList={() => router.push("/gateway-list")}
      onAuthChanged={(removedGatewayUrls) => {
        if (removedGatewayUrls?.length) {
          const removed = new Set(removedGatewayUrls.map(normalizeServerUrl));
          for (const session of [...ctx.manager.sessions.values()]) {
            if (removed.has(normalizeServerUrl(session.gatewayUrl))) {
              ctx.manager.disconnectSession(session.sessionId);
            }
          }
          // The official (Pro) gateway gets persisted as a normal saved server
          // when a session connects (addServer on connect). After sign-out the
          // /sessions/mine listing is gone, so it would otherwise linger as a
          // plain server the user can't authenticate to — remove it outright.
          (async () => {
            for (const url of removedGatewayUrls) {
              await removeServerWithHistory(url).catch(() => {});
            }
            ctx.setSessionRefreshKey((k) => k + 1);
          })();
        }
        ctx.agentWorkspace.refresh({ mergeCurrent: false }).catch(() => {});
        ctx.setSessionRefreshKey((k) => k + 1);
      }}
    />
  );
}
