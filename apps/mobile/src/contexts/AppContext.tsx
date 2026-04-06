import React, { createContext, useContext } from "react";
import type { SessionInfo } from "../hooks/useSessionManager";
import type { SessionManagerHandle } from "../hooks/useSessionManager";

export interface AppContextValue {
  // Gateway
  gatewayBaseUrl: string;
  setGatewayBaseUrl: (url: string) => void;
  // Session manager
  manager: SessionManagerHandle;
  activeSession: SessionInfo | undefined;
  // Display
  displayStatus: string;
  sessionRefreshKey: number;
  // Actions
  handleClaim: (code: string, gateway?: string) => void;
  handleConnectSession: (sessionId: string, serverUrl?: string) => void;
  handleDisconnectSession: (sessionId: string) => void;
  // UI state
  setConnectionSheetVisible: (v: boolean) => void;
  setGatewayListVisible: (v: boolean) => void;
  setActiveScreen: (s: "tabs" | "scanner" | "terminal") => void;
  setSessionRefreshKey: React.Dispatch<React.SetStateAction<number>>;
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
