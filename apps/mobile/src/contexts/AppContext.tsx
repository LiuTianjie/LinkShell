import React, { createContext, useContext } from "react";
import type { SessionInfo } from "../hooks/useSessionManager";
import type { SessionManagerHandle } from "../hooks/useSessionManager";
import type { AgentWorkspaceHandle } from "../hooks/useAgentWorkspace";
import type { SessionTab, TerminalTab } from "../screens/SessionScreen";
import type { ProjectRecord } from "../storage/projects";

export interface AppContextValue {
  // Gateway
  gatewayBaseUrl: string;
  setGatewayBaseUrl: (url: string) => void;
  // Session manager
  manager: SessionManagerHandle;
  agentWorkspace: AgentWorkspaceHandle;
  activeSession: SessionInfo | undefined;
  // Display
  displayStatus: string;
  sessionRefreshKey: number;
  // Computed tabs
  sessionTabs: SessionTab[];
  terminalTabs: TerminalTab[];
  // Actions
  handleClaim: (code: string, gateway?: string) => void;
  handleConnectSession: (sessionId: string, serverUrl?: string) => void;
  handleOpenRecentProject: (record: ProjectRecord) => void;
  handleDisconnectSession: (sessionId: string) => void;
  handlePairingScanned: (payload: { code: string; gateway?: string }) => void;
  navigateTo: (s: "tabs" | "scanner" | "terminal") => void;
  // UI state
  setConnectionSheetVisible: (v: boolean) => void;
  setSessionRefreshKey: React.Dispatch<React.SetStateAction<number>>;
  folderPickerVisible: boolean;
  setFolderPickerVisible: (v: boolean) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ value, children }: { value: AppContextValue; children: React.ReactNode }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used within AppProvider");
  return ctx;
}
