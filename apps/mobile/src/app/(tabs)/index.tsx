import React from "react";
import { useAppContext } from "../../contexts/AppContext";
import { HomeScreen } from "../../screens/HomeScreen";

export default function HomeTab() {
  const ctx = useAppContext();
  return (
    <HomeScreen
      gatewayBaseUrl={ctx.gatewayBaseUrl}
      status={ctx.displayStatus}
      connectionDetail={ctx.activeSession?.connectionDetail ?? null}
      onOpenConnectionSheet={() => ctx.setConnectionSheetVisible(true)}
      onConnectSession={ctx.handleConnectSession}
      onOpenRecentProject={ctx.handleOpenRecentProject}
      refreshKey={ctx.sessionRefreshKey}
    />
  );
}
