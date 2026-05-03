import React, { useCallback, useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Stack } from "expo-router/stack";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionSheet } from "../components/ConnectionSheet";
import { AppProvider, type AppContextValue } from "../contexts/AppContext";
import { useAppState } from "../hooks/useAppState";
import { useAgentWorkspace } from "../hooks/useAgentWorkspace";
import { useSessionManager } from "../hooks/useSessionManager";
import type { SessionInfo } from "../hooks/useSessionManager";
import { addToHistory, enrichHistory } from "../storage/history";
import type { ProjectRecord } from "../storage/projects";
import { touchProject, upsertProject } from "../storage/projects";
import { addServer } from "../storage/servers";
import { ThemeProvider, useTheme } from "../theme";
import { fetchWithTimeout } from "../utils/fetch-with-timeout";
import { parsePairingLink } from "../utils/pairing-link";
import { useLiveActivity } from "../hooks/useLiveActivity";
import { useLiveActivityLifecycle } from "../hooks/useLiveActivityLifecycle";

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
  const router = useRouter();
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState(DEFAULT_GATEWAY);
  const [pendingPairing, setPendingPairing] = useState<{ code: string; gateway?: string } | null>(null);
  const [connectionSheetVisible, setConnectionSheetVisible] = useState(false);
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [folderPickerVisible, setFolderPickerVisible] = useState(false);
  const [pendingProjectOpen, setPendingProjectOpen] = useState<{
    sessionId: string;
    cwd: string;
  } | null>(null);
  const lastSavedSessionsRef = useRef(new Set<string>());
  const lastProjectSyncRef = useRef(new Map<string, string>());

  const manager = useSessionManager();
  const agentWorkspace = useAgentWorkspace(manager);

  const activeSession: SessionInfo | undefined = manager.activeSessionId
    ? manager.sessions.get(manager.activeSessionId)
    : undefined;

  const displayStatus = activeSession?.status ?? "idle";

  const navigateTo = useCallback((screen: "tabs" | "scanner" | "terminal") => {
    if (screen === "terminal") router.push("/session");
    else if (screen === "scanner") router.push("/scanner");
    else router.back();
  }, [router]);

  const handlePairingScanned = useCallback((payload: { code: string; gateway?: string }) => {
    setPendingPairing(payload);
  }, []);

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
                router.push("/session");
                setTimeout(() => manager.sendInput(data), 100);
              }
            }
            return;
          }
        }
      } catch {}
      const parsed = parsePairingLink(rawUrl);
      if (!parsed) return;
      router.dismiss();
      setPendingPairing(parsed);
      setConnectionSheetVisible(false);
    };
    Linking.getInitialURL().then(applyLink).catch(() => {});
    const sub = Linking.addEventListener("url", ({ url }) => applyLink(url));
    return () => sub.remove();
  }, [manager, router]);

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
      if (sid) { setConnectionSheetVisible(false); router.push("/session"); }
      else { router.dismiss(); setConnectionSheetVisible(true); }
    }).catch(() => {
      if (!active) return;
      router.dismiss(); setConnectionSheetVisible(true);
    });
    return () => { active = false; };
  }, [gatewayBaseUrl, pendingPairing, manager, router]);

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
      const authHeaders: Record<string, string> = {};
      if (manager.deviceToken) authHeaders["Authorization"] = `Bearer ${manager.deviceToken}`;
      fetchWithTimeout(`${info.gatewayUrl}/sessions`, { headers: authHeaders })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: any) => {
          if (!body) return;
          const match = body.sessions?.find((s: any) => s.id === sid);
          if (match) enrichHistory(sid, match);
        })
        .catch(() => {});
    }
  }, [manager.sessions]);

  // Sync session/terminal cwd metadata into project storage for the homepage.
  useEffect(() => {
    const pending: Promise<unknown>[] = [];

    for (const [sid, info] of manager.sessions) {
      const base = {
        serverUrl: info.gatewayUrl,
        sessionId: sid,
        hostname: info.hostname ?? undefined,
        platform: undefined,
        provider: info.provider ?? undefined,
      };

      const queueProjectSync = (project: {
        cwd: string | null;
        projectName?: string | null;
        provider?: string | null;
        terminalId?: string | null;
      }) => {
        const cwd = project.cwd?.trim();
        if (!cwd) return;
        const signature = [
          base.serverUrl,
          base.sessionId,
          cwd,
          project.projectName ?? "",
          base.hostname ?? "",
          project.provider ?? base.provider ?? "",
          project.terminalId ?? "",
        ].join("\u0000");
        const key = `${base.serverUrl}:${base.sessionId}:${cwd}`;
        if (lastProjectSyncRef.current.get(key) === signature) return;
        lastProjectSyncRef.current.set(key, signature);
        pending.push(
          upsertProject({
            ...base,
            cwd,
            projectName: project.projectName ?? undefined,
            provider: project.provider ?? base.provider,
            lastTerminalId: project.terminalId ?? undefined,
          }),
        );
      };

      queueProjectSync({
        cwd: info.cwd,
        projectName: info.projectName,
        provider: info.provider,
        terminalId: info.activeTerminalId,
      });

      for (const terminal of info.terminals.values()) {
        queueProjectSync({
          cwd: terminal.cwd,
          projectName: terminal.projectName,
          provider: terminal.provider,
          terminalId: terminal.terminalId,
        });
      }
    }

    if (pending.length === 0) return;
    Promise.all(pending)
      .then(() => setSessionRefreshKey((key) => key + 1))
      .catch(() => {});
  }, [manager.sessions]);

  // Live Activity
  useLiveActivity(manager);
  useLiveActivityLifecycle(manager);

  // App state
  const handleForeground = useCallback(async () => {
    if (manager.sessions.size === 0) {
      try {
        const raw = await AsyncStorage.getItem(LAST_SESSION_KEY);
        if (raw) {
          const last = JSON.parse(raw) as { gateway: string; sessionId: string };
          setGatewayBaseUrl(last.gateway);
          manager.connectToSession(last.sessionId, last.gateway);
          router.push("/session");
        }
      } catch {}
    }
  }, [manager, router]);

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
    if (sid) { setConnectionSheetVisible(false); router.push("/session"); }
  }, [manager, gatewayBaseUrl, router]);

  const handleConnectSession = useCallback((sessionId: string, serverUrl?: string) => {
    const target = serverUrl ?? gatewayBaseUrl;
    if (target !== gatewayBaseUrl) setGatewayBaseUrl(target);
    setConnectionSheetVisible(false);
    manager.connectToSession(sessionId, target);
    router.push("/session");
  }, [gatewayBaseUrl, manager, router]);

  const handleOpenRecentProject = useCallback((record: ProjectRecord) => {
    if (!record.cwd) return;
    const target = record.serverUrl ?? gatewayBaseUrl;
    if (target !== gatewayBaseUrl) setGatewayBaseUrl(target);
    setConnectionSheetVisible(false);
    manager.connectToSession(record.sessionId, target);
    setPendingProjectOpen({ sessionId: record.sessionId, cwd: record.cwd });
    touchProject({
      serverUrl: target,
      sessionId: record.sessionId,
      cwd: record.cwd,
      lastTerminalId: record.lastTerminalId,
    })
      .then(() => setSessionRefreshKey((key) => key + 1))
      .catch(() => {});
    router.push("/session");
  }, [gatewayBaseUrl, manager, router]);

  useEffect(() => {
    if (!pendingProjectOpen) return;
    const info = manager.sessions.get(pendingProjectOpen.sessionId);
    if (!info) return;
    if (manager.activeSessionId !== pendingProjectOpen.sessionId) {
      manager.setActiveSessionId(pendingProjectOpen.sessionId);
      return;
    }
    if (
      info.status === "idle" ||
      info.status === "claiming" ||
      info.status === "connecting" ||
      info.status === "reconnecting"
    ) {
      return;
    }
    if (info.status === "connected") {
      const existingTerminal = [...info.terminals.values()].find(
        (terminal) =>
          terminal.cwd === pendingProjectOpen.cwd &&
          terminal.status === "running",
      );
      manager.spawnTerminal(pendingProjectOpen.cwd);
      touchProject({
        serverUrl: info.gatewayUrl,
        sessionId: pendingProjectOpen.sessionId,
        cwd: pendingProjectOpen.cwd,
        lastTerminalId: existingTerminal?.terminalId ?? info.activeTerminalId ?? undefined,
      })
        .then(() => setSessionRefreshKey((key) => key + 1))
        .catch(() => {});
    }
    setPendingProjectOpen(null);
  }, [manager, manager.activeSessionId, manager.sessions, pendingProjectOpen]);

  const handleDisconnectSession = useCallback((sessionId: string) => {
    manager.disconnectSession(sessionId);
    if (manager.sessions.size <= 1) {
      AsyncStorage.removeItem(LAST_SESSION_KEY);
      router.back();
    }
  }, [manager, router]);

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
    agentWorkspace,
    activeSession,
    displayStatus,
    sessionRefreshKey,
    sessionTabs,
    terminalTabs,
    handleClaim,
    handleConnectSession,
    handleOpenRecentProject,
    handleDisconnectSession,
    handlePairingScanned,
    navigateTo,
    setConnectionSheetVisible,
    setSessionRefreshKey,
    folderPickerVisible,
    setFolderPickerVisible,
  };

  return (
    <AppProvider value={ctxValue}>
      <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="session" options={{ gestureEnabled: false }} />
        <Stack.Screen name="agent/[conversationId]" options={{ gestureEnabled: true }} />
        <Stack.Screen name="scanner" options={{ presentation: "modal" }} />
        <Stack.Screen name="gateway-list" />
      </Stack>
      <ConnectionSheet
        visible={connectionSheetVisible}
        gatewayBaseUrl={gatewayBaseUrl}
        status={displayStatus}
        connectionDetail={activeSession?.connectionDetail ?? null}
        onClose={() => setConnectionSheetVisible(false)}
        onGatewayChange={setGatewayBaseUrl}
        onClaim={handleClaim}
        onOpenScanner={() => {
          setConnectionSheetVisible(false);
          router.push("/scanner");
        }}
      />
    </AppProvider>
  );
}
