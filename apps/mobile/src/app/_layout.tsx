import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Dimensions, Linking, StyleSheet } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionSheet } from "../components/ConnectionSheet";
import { AppProvider, type AppContextValue } from "../contexts/AppContext";
import { useAppState } from "../hooks/useAppState";
import { useSessionManager } from "../hooks/useSessionManager";
import type { SessionInfo } from "../hooks/useSessionManager";
import { ScannerScreen } from "../screens/ScannerScreen";
import { SessionScreen } from "../screens/SessionScreen";
import { addToHistory, enrichHistory } from "../storage/history";
import { addServer } from "../storage/servers";
import { ThemeProvider, useTheme } from "../theme";
import type { Theme } from "../theme";
import { fetchWithTimeout } from "../utils/fetch-with-timeout";
import { parsePairingLink } from "../utils/pairing-link";
import {
  isLiveActivityAvailable,
  startLiveActivity,
  updateLiveActivity,
  endLiveActivity,
} from "../native/LiveActivity";
import type { SessionActivityState } from "../native/LiveActivity";
import { ThrottledTerminalParser } from "../utils/terminal-parser";
import { FolderPickerModal } from "../components/FolderPickerModal";

const DEFAULT_GATEWAY = "http://localhost:8787";
const LAST_SESSION_KEY = "@linkshell/last_session";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AppInner />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function AppInner() {
  const { theme } = useTheme();
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState(DEFAULT_GATEWAY);
  const [activeScreen, setActiveScreen] = useState<"tabs" | "scanner" | "terminal">("tabs");
  const [pendingPairing, setPendingPairing] = useState<{ code: string; gateway?: string } | null>(null);
  const [connectionSheetVisible, setConnectionSheetVisible] = useState(false);
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [folderPickerVisible, setFolderPickerVisible] = useState(false);
  const lastSavedSessionsRef = useRef(new Set<string>());

  const manager = useSessionManager();

  const activeSession: SessionInfo | undefined = manager.activeSessionId
    ? manager.sessions.get(manager.activeSessionId)
    : undefined;

  const hasAnySessions = manager.sessions.size > 0;

  const isInSession = hasAnySessions && (
    activeScreen === "terminal" ||
    (activeSession && (
      activeSession.status === "connected" ||
      activeSession.status === "connecting" ||
      activeSession.status === "claiming" ||
      activeSession.status === "reconnecting" ||
      activeSession.status === "session_exited" ||
      activeSession.status === "host_disconnected" ||
      activeSession.status.startsWith("error:")
    ))
  );

  const currentScreen = isInSession ? "terminal" : activeScreen;
  const displayStatus = activeSession?.status ?? "idle";

  // Deep link handling
  useEffect(() => {
    const applyLink = (rawUrl: string | null) => {
      if (!rawUrl) return;
      try {
        const url = new URL(rawUrl);
        if (url.host === "input" || url.pathname === "//input") {
          const sessionId = url.searchParams.get("session");
          const terminalId = url.searchParams.get("terminal");
          const data = url.searchParams.get("data");
          const bg = url.searchParams.get("bg") === "1";
          if (sessionId && data) {
            const info = manager.sessions.get(sessionId);
            if (info) {
              if (bg) {
                manager.setActiveSessionId(sessionId);
                if (terminalId && terminalId !== "default") manager.switchTerminal(terminalId);
                setTimeout(() => manager.sendInput(data), 50);
              } else {
                manager.setActiveSessionId(sessionId);
                if (terminalId && terminalId !== "default") manager.switchTerminal(terminalId);
                setActiveScreen("terminal");
                setTimeout(() => manager.sendInput(data), 100);
              }
            }
            return;
          }
        }
      } catch {}
      const parsed = parsePairingLink(rawUrl);
      if (!parsed) return;
      setActiveScreen("tabs");
      setPendingPairing(parsed);
      setConnectionSheetVisible(false);
    };
    Linking.getInitialURL().then(applyLink).catch(() => {});
    const sub = Linking.addEventListener("url", ({ url }) => applyLink(url));
    return () => sub.remove();
  }, [manager]);

  // Process pending pairing
  useEffect(() => {
    if (!pendingPairing) return;
    const gateway = pendingPairing.gateway ?? gatewayBaseUrl;
    if (pendingPairing.gateway && pendingPairing.gateway !== gatewayBaseUrl) {
      setGatewayBaseUrl(pendingPairing.gateway);
      return;
    }
    const pairing = pendingPairing;
    setPendingPairing(null);
    let active = true;
    manager.claim(pairing.code, gateway).then((sid) => {
      if (!active) return;
      if (sid) { setConnectionSheetVisible(false); setActiveScreen("terminal"); }
      else { setActiveScreen("tabs"); setConnectionSheetVisible(true); }
    }).catch(() => {
      if (!active) return;
      setActiveScreen("tabs"); setConnectionSheetVisible(true);
    });
    return () => { active = false; };
  }, [gatewayBaseUrl, pendingPairing, manager]);

  // Save to history
  useEffect(() => {
    for (const [sid, info] of manager.sessions) {
      if (lastSavedSessionsRef.current.has(sid)) continue;
      if (info.status === "idle" || info.status === "claiming") continue;
      lastSavedSessionsRef.current.add(sid);
      addToHistory({ serverUrl: info.gatewayUrl, sessionId: sid }).catch(() => {
        lastSavedSessionsRef.current.delete(sid);
      });
      addServer(info.gatewayUrl).catch(() => {});
      fetchWithTimeout(`${info.gatewayUrl}/sessions`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body: any) => {
          if (!body) return;
          const match = body.sessions?.find((s: any) => s.id === sid);
          if (match) enrichHistory(sid, match);
        })
        .catch(() => {});
    }
  }, [manager.sessions]);

  // Live Activity
  const liveActivityActiveRef = useRef(false);
  const parsersRef = useRef(new Map<string, { parser: ThrottledTerminalParser; unsub: () => void; status: string; lastLine: string; contextLines: string; quickActions: { label: string; input: string; needsInput: boolean }[]; provider: string; connectedAt: number }>());
  const sessionsRef = useRef(manager.sessions);
  const activeSidRef = useRef(manager.activeSessionId);
  sessionsRef.current = manager.sessions;
  activeSidRef.current = manager.activeSessionId;

  const pushLiveActivityUpdate = useCallback(() => {
    if (!liveActivityActiveRef.current) return;
    const currentSessions = sessionsRef.current;
    const activeSid = activeSidRef.current;
    const now = Date.now();
    const states: SessionActivityState[] = [];
    for (const [sid, info] of currentSessions) {
      if (info.status !== "connected") continue;
      const entry = parsersRef.current.get(sid);
      const activeTerm = info.activeTerminalId ? info.terminals.get(info.activeTerminalId) : undefined;
      const ss = activeTerm?.structuredStatus;
      const useStructured = ss && (now - ss.updatedAt) < 30_000;
      states.push({
        sessionId: sid,
        terminalId: info.activeTerminalId || "default",
        status: useStructured ? ss.phase : (entry?.status ?? "idle"),
        lastLine: entry?.lastLine ?? "",
        contextLines: useStructured && ss.permissionRequest ? ss.permissionRequest : (entry?.contextLines ?? ""),
        projectName: info.projectName || info.hostname || sid.slice(0, 8),
        provider: entry?.provider ?? info.provider ?? "claude",
        quickActions: entry?.quickActions ?? [],
        tokensUsed: 0,
        elapsedSeconds: Math.floor((now - (entry?.connectedAt ?? now)) / 1000),
      });
    }
    if (states.length === 0) return;
    const priority: Record<string, number> = { error: 0, waiting: 1, tool_use: 2, thinking: 3, outputting: 4, idle: 5 };
    states.sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9));
    const aid = activeSid ?? states[0]?.sessionId ?? "";
    const needsAlert = states.some((s) => s.quickActions.length > 0);
    updateLiveActivity(states, aid, needsAlert);
  }, []);

  useEffect(() => {
    const currentSessions = manager.sessions;
    for (const [sid, entry] of parsersRef.current) {
      if (!currentSessions.has(sid)) {
        entry.parser.destroy();
        entry.unsub();
        parsersRef.current.delete(sid);
      }
    }
    for (const [sid, info] of currentSessions) {
      if (info.status !== "connected") continue;
      if (parsersRef.current.has(sid)) continue;
      const entry = {
        parser: null as unknown as ThrottledTerminalParser,
        unsub: null as unknown as () => void,
        status: "idle",
        lastLine: "",
        contextLines: "",
        quickActions: [] as { label: string; input: string; needsInput: boolean }[],
        provider: info.provider || "claude",
        connectedAt: Date.now(),
      };
      entry.parser = new ThrottledTerminalParser((result) => {
        entry.status = result.status;
        entry.lastLine = result.lastLine;
        entry.contextLines = result.contextLines;
        entry.quickActions = result.quickActions;
        if (result.provider !== "unknown") entry.provider = result.provider;
        pushLiveActivityUpdate();
      }, 1000);
      entry.unsub = info.terminalStream.subscribe((event) => {
        if (event.type === "append") entry.parser.push(event.chunk);
      });
      parsersRef.current.set(sid, entry);
    }
    const hasConnected = [...currentSessions.values()].some((s) => s.status === "connected");
    if (hasConnected && !liveActivityActiveRef.current) {
      isLiveActivityAvailable().then((ok) => {
        if (!ok) return;
        const now = Date.now();
        const states: SessionActivityState[] = [];
        for (const [sid2, info2] of sessionsRef.current) {
          if (info2.status !== "connected") continue;
          const e = parsersRef.current.get(sid2);
          const activeTerm = info2.activeTerminalId ? info2.terminals.get(info2.activeTerminalId) : undefined;
          const ss = activeTerm?.structuredStatus;
          const useStructured = ss && (now - ss.updatedAt) < 30_000;
          states.push({
            sessionId: sid2,
            terminalId: info2.activeTerminalId || "default",
            status: useStructured ? ss.phase : (e?.status ?? "idle"),
            lastLine: e?.lastLine ?? "",
            contextLines: useStructured && ss.permissionRequest ? ss.permissionRequest : (e?.contextLines ?? ""),
            projectName: info2.projectName || info2.hostname || sid2.slice(0, 8),
            provider: e?.provider ?? info2.provider ?? "claude",
            quickActions: e?.quickActions ?? [],
            tokensUsed: 0,
            elapsedSeconds: Math.floor((now - (e?.connectedAt ?? now)) / 1000),
          });
        }
        if (states.length === 0) return;
        const aid = activeSidRef.current ?? states[0]?.sessionId ?? "";
        startLiveActivity(states, aid).then((id) => {
          if (id) liveActivityActiveRef.current = true;
        });
      });
    } else if (!hasConnected && liveActivityActiveRef.current) {
      liveActivityActiveRef.current = false;
      endLiveActivity();
      for (const e2 of parsersRef.current.values()) { e2.parser.destroy(); e2.unsub(); }
      parsersRef.current.clear();
    } else if (hasConnected && liveActivityActiveRef.current) {
      pushLiveActivityUpdate();
    }
  }, [manager.activeSessionId, manager.sessions, pushLiveActivityUpdate]);

  // Periodic refresh
  useEffect(() => {
    const id = setInterval(() => {
      if (liveActivityActiveRef.current) pushLiveActivityUpdate();
    }, 2000);
    return () => clearInterval(id);
  }, [pushLiveActivityUpdate]);

  useEffect(() => { return () => {
    if (liveActivityActiveRef.current) { endLiveActivity(); liveActivityActiveRef.current = false; }
    for (const entry of parsersRef.current.values()) { entry.parser.destroy(); entry.unsub(); }
    parsersRef.current.clear();
  }; }, []);

  // App state
  const handleForeground = useCallback(async () => {
    if (manager.sessions.size === 0) {
      try {
        const raw = await AsyncStorage.getItem(LAST_SESSION_KEY);
        if (raw) {
          const last = JSON.parse(raw) as { gateway: string; sessionId: string };
          setGatewayBaseUrl(last.gateway);
          setActiveScreen("terminal");
          manager.connectToSession(last.sessionId, last.gateway);
        }
      } catch {}
    }
  }, [manager]);

  const handleBackground = useCallback(async () => {
    if (manager.activeSessionId) {
      const info = manager.sessions.get(manager.activeSessionId);
      if (info) {
        await AsyncStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ gateway: info.gatewayUrl, sessionId: manager.activeSessionId }));
      }
    }
  }, [manager]);

  useAppState(handleForeground, handleBackground);

  const handleClaim = useCallback(async (code: string) => {
    const sid = await manager.claim(code, gatewayBaseUrl);
    if (sid) { setConnectionSheetVisible(false); setActiveScreen("terminal"); }
  }, [manager, gatewayBaseUrl]);

  const handleConnectSession = useCallback((sessionId: string, serverUrl?: string) => {
    const target = serverUrl ?? gatewayBaseUrl;
    if (target !== gatewayBaseUrl) setGatewayBaseUrl(target);
    setConnectionSheetVisible(false);
    setActiveScreen("terminal");
    manager.connectToSession(sessionId, target);
  }, [gatewayBaseUrl, manager]);

  const handleDisconnectSession = useCallback((sessionId: string) => {
    manager.disconnectSession(sessionId);
    if (manager.sessions.size <= 1) {
      liveActivityActiveRef.current = false;
      endLiveActivity();
      AsyncStorage.removeItem(LAST_SESSION_KEY);
      setActiveScreen("tabs");
    }
  }, [manager]);

  // Session/terminal tabs
  const sessionTabs = Array.from(manager.sessions.entries()).map(([sid, info]) => ({
    sessionId: sid,
    label: info.projectName || info.hostname || sid.slice(0, 8),
    status: info.status,
  }));

  const terminalTabs = activeSession
    ? Array.from(activeSession.terminals.entries()).map(([tid, t]) => ({
        terminalId: tid,
        label: t.projectName || tid.slice(0, 8),
        status: t.status,
      }))
    : [];

  const ctxValue: AppContextValue = {
    gatewayBaseUrl,
    setGatewayBaseUrl,
    manager,
    activeSession,
    displayStatus,
    sessionRefreshKey,
    handleClaim,
    handleConnectSession,
    handleDisconnectSession,
    setConnectionSheetVisible,
    setGatewayListVisible: () => {},
    setActiveScreen,
    setSessionRefreshKey,
  };

  // Terminal screen (full overlay)
  if (currentScreen === "terminal" && activeSession) {
    return (
      <AppProvider value={ctxValue}>
        <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
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
          onDisconnect={() => handleDisconnectSession(activeSession.sessionId)}
          sessionTabs={sessionTabs}
          activeTabId={manager.activeSessionId}
          onSwitchSession={manager.setActiveSessionId}
          onCloseSession={handleDisconnectSession}
          terminalTabs={terminalTabs}
          activeTerminalId={activeSession.activeTerminalId}
          onSwitchTerminal={manager.switchTerminal}
          onAddTerminal={() => {
            setFolderPickerVisible(true);
            manager.browseDirectory(activeSession.cwd ?? "~");
          }}
          terminals={activeSession.terminals}
          onKillTerminal={manager.killTerminal}
          onRemoveTerminal={manager.removeTerminal}
        />
        <FolderPickerModal
          visible={folderPickerVisible}
          browseResult={activeSession.browseResult}
          terminals={activeSession.terminals}
          onBrowse={manager.browseDirectory}
          onSelect={(path: string) => manager.spawnTerminal(path)}
          onClose={() => setFolderPickerVisible(false)}
          theme={theme}
        />
      </AppProvider>
    );
  }

  // Scanner screen (full overlay)
  if (currentScreen === "scanner") {
    return (
      <AppProvider value={ctxValue}>
        <StatusBar style="light" />
        <ScannerScreen
          onClose={() => setActiveScreen("tabs")}
          onScan={(payload) => { setActiveScreen("tabs"); setPendingPairing(payload); }}
        />
      </AppProvider>
    );
  }

  // Tabs (expo-router Slot renders NativeTabs)
  return (
    <AppProvider value={ctxValue}>
      <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
      <Slot />
      <ConnectionSheet
        visible={connectionSheetVisible}
        gatewayBaseUrl={gatewayBaseUrl}
        status={displayStatus}
        connectionDetail={activeSession?.connectionDetail ?? null}
        onClose={() => setConnectionSheetVisible(false)}
        onGatewayChange={setGatewayBaseUrl}
        onClaim={handleClaim}
        onOpenScanner={() => { setConnectionSheetVisible(false); setActiveScreen("scanner"); }}
      />
    </AppProvider>
  );
}
