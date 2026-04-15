import React, { useEffect, useState } from "react";
import { useAppContext } from "../contexts/AppContext";
import { SessionScreen } from "../screens/SessionScreen";
import { FolderPickerModal } from "../components/FolderPickerModal";
import { useTheme } from "../theme";
import { getValidSession } from "../lib/supabase";

export default function SessionRoute() {
  const ctx = useAppContext();
  const { theme } = useTheme();
  const { manager, activeSession } = ctx;
  const [authToken, setAuthToken] = useState<string | null>(null);

  useEffect(() => {
    getValidSession().then((s) => setAuthToken(s?.accessToken ?? null));
  }, [activeSession?.sessionId]);

  if (!activeSession) return null;

  return (
    <>
      <SessionScreen
        sessionId={activeSession.sessionId}
        status={activeSession.status}
        deviceId={activeSession.deviceId}
        controllerId={activeSession.controllerId}
        connectionDetail={activeSession.connectionDetail}
        terminalStream={activeSession.terminalStream}
        screenStatus={activeSession.screenStatus}
        screenFrame={activeSession.screenFrame}
        pendingOffer={activeSession.pendingOffer}
        pendingIceCandidates={activeSession.pendingIceCandidates}
        onSendInput={manager.sendInput}
        onSendImage={manager.sendImage}
        onSendResize={manager.sendResize}
        onClaimControl={manager.claimControl}
        onReleaseControl={manager.releaseControl}
        onStartScreen={manager.startScreen}
        onStopScreen={manager.stopScreen}
        onScreenSignal={manager.sendScreenSignal}
        onReconnect={manager.reconnect}
        onDisconnect={() => ctx.handleDisconnectSession(activeSession.sessionId)}
        sessionTabs={ctx.sessionTabs}
        activeTabId={manager.activeSessionId}
        onSwitchSession={manager.setActiveSessionId}
        onCloseSession={ctx.handleDisconnectSession}
        terminalTabs={ctx.terminalTabs}
        activeTerminalId={activeSession.activeTerminalId}
        onSwitchTerminal={manager.switchTerminal}
        onAddTerminal={() => {
          ctx.setFolderPickerVisible(true);
          manager.browseDirectory(activeSession.cwd ?? "~");
        }}
        terminals={activeSession.terminals}
        onKillTerminal={manager.killTerminal}
        onRemoveTerminal={manager.removeTerminal}
        gatewayUrl={activeSession.gatewayUrl}
        deviceToken={manager.deviceToken}
        authToken={authToken}
      />
      <FolderPickerModal
        visible={ctx.folderPickerVisible}
        browseResult={activeSession.browseResult}
        terminals={activeSession.terminals}
        onBrowse={manager.browseDirectory}
        onMkdir={manager.mkdirRemote}
        onSelect={(path: string) => manager.spawnTerminal(path)}
        onClose={() => ctx.setFolderPickerVisible(false)}
        theme={theme}
      />
    </>
  );
}
