import React from "react";
import { useAppContext } from "../../contexts/AppContext";
import { SessionListScreen } from "../../screens/SessionListScreen";

export default function SessionsTab() {
  const ctx = useAppContext();
  return (
    <SessionListScreen
      gatewayBaseUrl={ctx.gatewayBaseUrl}
      onSelectSession={ctx.handleConnectSession}
      refreshKey={ctx.sessionRefreshKey}
    />
  );
}
