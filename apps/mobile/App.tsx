import AsyncStorage from "@react-native-async-storage/async-storage";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
} from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppSymbol } from "./src/components/AppSymbol";
import { FolderPickerModal } from "./src/components/FolderPickerModal";
import { GlassBar } from "./src/components/GlassBar";
import { ConnectionSheet } from "./src/components/ConnectionSheet";
import { useAppState } from "./src/hooks/useAppState";
import { useSessionManager } from "./src/hooks/useSessionManager";
import type { SessionInfo } from "./src/hooks/useSessionManager";
import type { BrowseEntry } from "./src/hooks/useSessionManager";
import { GatewayListScreen } from "./src/screens/GatewayListScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { ScannerScreen } from "./src/screens/ScannerScreen";
import { SessionListScreen } from "./src/screens/SessionListScreen";
import { SessionScreen } from "./src/screens/SessionScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { addToHistory, enrichHistory } from "./src/storage/history";
import { addServer } from "./src/storage/servers";
import { ThemeProvider, useTheme } from "./src/theme";
import { fetchWithTimeout } from "./src/utils/fetch-with-timeout";
import { parsePairingLink } from "./src/utils/pairing-link";
import {
  isLiveActivityAvailable,
  startLiveActivity,
  updateLiveActivity,
  endLiveActivity,
  type ActivityState,
  type ExtendedActivityData,
  type SecondaryTerminal,
} from "./src/native/LiveActivity";
import { ThrottledTerminalParser } from "./src/utils/terminal-parser";

const DEFAULT_GATEWAY = "http://localhost:8787";
const LAST_SESSION_KEY = "@linkshell/last_session";

const Tab = createBottomTabNavigator();

function SFIcon({
  name,
  color,
  size = 22,
}: {
  name: string;
  color: string;
  size?: number;
}) {
  return <AppSymbol name={name} size={size} color={color} />;
}

// ── Folder Picker Modal ─────────────────────────────────────────────

function AppInner() {
  const { theme } = useTheme();
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState(DEFAULT_GATEWAY);
  const [activeScreen, setActiveScreen] = useState<
    "tabs" | "scanner" | "terminal"
  >("tabs");
  const [pendingPairing, setPendingPairing] = useState<{
    code: string;
    gateway?: string;
  } | null>(null);
  const [connectionSheetVisible, setConnectionSheetVisible] = useState(false);
  const [gatewayListVisible, setGatewayListVisible] = useState(false);
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [folderPickerVisible, setFolderPickerVisible] = useState(false);
  const gatewaySlideAnim = useRef(
    new Animated.Value(Dimensions.get("window").width),
  ).current;
  const lastSavedSessionsRef = useRef(new Set<string>());

  const manager = useSessionManager();

  // Derive active session info
  const activeSession: SessionInfo | undefined = manager.activeSessionId
    ? manager.sessions.get(manager.activeSessionId)
    : undefined;

  const hasAnySessions = manager.sessions.size > 0;

  const isInSession =
    hasAnySessions &&
    (activeScreen === "terminal" ||
      (activeSession &&
        (activeSession.status === "connected" ||
          activeSession.status === "connecting" ||
          activeSession.status === "claiming" ||
          activeSession.status === "reconnecting" ||
          activeSession.status === "session_exited" ||
          activeSession.status === "host_disconnected" ||
          activeSession.status.startsWith("error:"))));

  const currentScreen = isInSession ? "terminal" : activeScreen;

  // Deep link handling (pairing + live activity quick actions)
  useEffect(() => {
    const applyLink = (rawUrl: string | null) => {
      if (!rawUrl) return;

      // Handle live activity quick action: linkshell://input?session=X&terminal=T&data=Y&bg=1
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
                // Background send — don't switch screen or bring app to front
                manager.setActiveSessionId(sessionId);
                if (terminalId && terminalId !== "default") {
                  manager.switchTerminal(terminalId);
                }
                setTimeout(() => manager.sendInput(data), 50);
              } else {
                // Foreground — switch to session + terminal
                manager.setActiveSessionId(sessionId);
                if (terminalId && terminalId !== "default") {
                  manager.switchTerminal(terminalId);
                }
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

    Linking.getInitialURL()
      .then(applyLink)
      .catch(() => {});
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
    manager
      .claim(pairing.code, gateway)
      .then((sid) => {
        if (!active) return;
        if (sid) {
          setConnectionSheetVisible(false);
          setActiveScreen("terminal");
        } else {
          setActiveScreen("tabs");
          setConnectionSheetVisible(true);
        }
      })
      .catch(() => {
        if (!active) return;
        setActiveScreen("tabs");
        setConnectionSheetVisible(true);
      });

    return () => {
      active = false;
    };
  }, [gatewayBaseUrl, pendingPairing, manager]);

  // Save to history when sessions connect
  useEffect(() => {
    for (const [sid, info] of manager.sessions) {
      if (lastSavedSessionsRef.current.has(sid)) continue;
      if (info.status === "idle" || info.status === "claiming") continue;

      lastSavedSessionsRef.current.add(sid);
      addToHistory({ serverUrl: info.gatewayUrl, sessionId: sid }).catch(() => {
        lastSavedSessionsRef.current.delete(sid);
      });
      addServer(info.gatewayUrl).catch(() => {});

      // Enrich history with metadata
      const authHeaders: Record<string, string> = {};
      if (manager.deviceToken)
        authHeaders["Authorization"] = `Bearer ${manager.deviceToken}`;
      fetchWithTimeout(`${info.gatewayUrl}/sessions`, { headers: authHeaders })
        .then((res) => (res.ok ? res.json() : null))
        .then(
          (
            body: {
              sessions: Array<{
                id: string;
                hostname?: string;
                provider?: string;
                platform?: string;
                projectName?: string;
                cwd?: string;
              }>;
            } | null,
          ) => {
            if (!body) return;
            const match = body.sessions.find((s) => s.id === sid);
            if (match) enrichHistory(sid, match);
          },
        )
        .catch(() => {});
    }
  }, [manager.sessions]);

  // Live Activity: track ALL sessions, not just active one
  const liveActivityActiveRef = useRef(false);
  const parsersRef = useRef(
    new Map<
      string,
      {
        parser: ThrottledTerminalParser;
        unsub: () => void;
        status: string;
        lastLine: string;
        contextLines: string;
        quickActions: { label: string; input: string; needsInput: boolean; desc?: string }[];
        provider: string;
        connectedAt: number;
      }
    >(),
  );
  const sessionsRef = useRef(manager.sessions);
  const activeSidRef = useRef(manager.activeSessionId);
  sessionsRef.current = manager.sessions;
  activeSidRef.current = manager.activeSessionId;

  const pushLiveActivityUpdate = useCallback(() => {
    if (!liveActivityActiveRef.current) return;
    const currentSessions = sessionsRef.current;
    const now = Date.now();

    // Collect all terminal candidates
    const candidates: {
      sid: string;
      tid: string;
      phase: string;
      project: string;
      provider: string;
      tool: string;
      elapsed: number;
      hasPermission: boolean;
      permCount: number;
      toolDescription: string;
      contextLines: string;
      permissionTool: string;
      permissionContext: string;
      permissionRequestId: string;
      quickActions: { label: string; input: string; needsInput: boolean; desc?: string }[];
    }[] = [];

    for (const [sid, info] of currentSessions) {
      if (info.status !== "connected") continue;
      const entry = parsersRef.current.get(sid);

      const activeTerm = info.activeTerminalId
        ? info.terminals.get(info.activeTerminalId)
        : undefined;
      const ss = activeTerm?.structuredStatus;
      const useStructured = ss && now - ss.updatedAt < 30_000;
      const hasPermission = !!ss?.topPermission;

      candidates.push({
        sid,
        tid: info.activeTerminalId || "default",
        phase: useStructured ? ss.phase : (entry?.status ?? "idle"),
        project: (info.projectName || info.hostname || sid.slice(0, 8)).slice(0, 30),
        provider: (activeTerm?.provider && activeTerm.provider !== "custom" ? activeTerm.provider : null)
          ?? (info.provider && info.provider !== "custom" ? info.provider : null)
          ?? info.provider ?? "claude",
        tool: ss?.toolName || "",
        elapsed: Math.floor((now - (entry?.connectedAt ?? now)) / 1000),
        hasPermission,
        permCount: ss?.pendingPermissionCount ?? 0,
        toolDescription: (ss?.toolInput || ss?.summary || "").slice(0, 500),
        contextLines: (useStructured && ss.permissionRequest ? ss.permissionRequest : (entry?.contextLines ?? "")).slice(0, 500),
        permissionTool: ss?.topPermission?.toolName || "",
        permissionContext: (ss?.topPermission?.permissionRequest || ss?.topPermission?.toolInput || "").slice(0, 400),
        permissionRequestId: ss?.topPermission?.requestId || "",
        quickActions: hasPermission
          ? [
              { label: "允许", input: "allow", needsInput: false },
              { label: "拒绝", input: "deny", needsInput: false },
              ...(entry?.quickActions?.filter((a) => a.input !== "allow" && a.input !== "deny").map((a) => ({ ...a, desc: a.desc ?? a.label })) ?? []),
            ]
          : (entry?.quickActions?.map((a) => ({ ...a, desc: a.desc ?? a.label })) ?? []),
      });
    }

    if (candidates.length === 0) return;

    // Sort: hasPermission first, then by phase priority
    const priority: Record<string, number> = {
      error: 0, waiting: 1, tool_use: 2, thinking: 3, outputting: 4, idle: 5,
    };
    candidates.sort((a, b) => {
      if (a.hasPermission !== b.hasPermission) return a.hasPermission ? -1 : 1;
      return (priority[a.phase] ?? 9) - (priority[b.phase] ?? 9);
    });

    const primary = candidates[0];
    const totalPermCount = candidates.reduce((sum, c) => sum + c.permCount, 0);

    const state: ActivityState = {
      sid: primary.sid,
      tid: primary.tid,
      phase: primary.phase,
      project: primary.project,
      provider: primary.provider,
      tool: primary.tool,
      elapsed: primary.elapsed,
      hasPermission: primary.hasPermission,
      permCount: primary.permCount,
      otherCount: candidates.length - 1,
      totalPermCount,
    };

    const secondaryTerminals: SecondaryTerminal[] = candidates.slice(1, 6).map((c) => ({
      sid: c.sid,
      tid: c.tid,
      provider: c.provider,
      phase: c.phase,
      hasPermission: c.hasPermission,
    }));

    const extended: ExtendedActivityData = {
      sid: primary.sid,
      tid: primary.tid,
      toolDescription: primary.toolDescription,
      contextLines: primary.contextLines,
      permissionTool: primary.permissionTool,
      permissionContext: primary.permissionContext,
      permissionRequestId: primary.permissionRequestId,
      quickActions: primary.quickActions,
      secondaryTerminals,
    };

    const needsAlert = candidates.some((c) => c.hasPermission);
    updateLiveActivity(state, extended, needsAlert);
  }, []);

  useEffect(() => {
    const currentSessions = manager.sessions;

    // Remove parsers for sessions that no longer exist
    for (const [sid, entry] of parsersRef.current) {
      if (!currentSessions.has(sid)) {
        entry.parser.destroy();
        entry.unsub();
        parsersRef.current.delete(sid);
      }
    }

    // Add parsers for new sessions
    for (const [sid, info] of currentSessions) {
      if (info.status !== "connected") continue;
      if (parsersRef.current.has(sid)) continue;

      const entry = {
        parser: null as unknown as ThrottledTerminalParser,
        unsub: null as unknown as () => void,
        status: "idle",
        lastLine: "",
        contextLines: "",
        quickActions: [] as {
          label: string;
          input: string;
          needsInput: boolean;
        }[],
        provider: info.provider || "claude",
        connectedAt: Date.now(),
      };

      entry.parser = new ThrottledTerminalParser((result) => {
        entry.status = result.status;
        entry.lastLine = result.lastLine;
        entry.contextLines = result.contextLines;
        entry.quickActions = result.quickActions;
        pushLiveActivityUpdate();
      }, 1000);

      entry.unsub = info.terminalStream.subscribe((event) => {
        if (event.type === "append") entry.parser.push(event.chunk);
      });

      parsersRef.current.set(sid, entry);
    }

    // Start or end live activity based on session count
    const hasConnected = [...currentSessions.values()].some(
      (s) => s.status === "connected",
    );

    if (hasConnected && !liveActivityActiveRef.current) {
      isLiveActivityAvailable().then((ok) => {
        if (!ok) return;
        const now = Date.now();
        const candidates: {
          sid: string; tid: string; phase: string; project: string;
          provider: string; tool: string; elapsed: number;
          hasPermission: boolean; permCount: number;
          toolDescription: string; contextLines: string;
          permissionTool: string; permissionContext: string;
          permissionRequestId: string;
          quickActions: { label: string; input: string; needsInput: boolean; desc?: string }[];
        }[] = [];

        for (const [sid, info] of sessionsRef.current) {
          if (info.status !== "connected") continue;
          const e = parsersRef.current.get(sid);
          const activeTerm = info.activeTerminalId
            ? info.terminals.get(info.activeTerminalId)
            : undefined;
          const ss = activeTerm?.structuredStatus;
          const hasPermission = !!ss?.topPermission;

          candidates.push({
            sid,
            tid: info.activeTerminalId || "default",
            phase: ss?.phase || (e?.status ?? "idle"),
            project: (info.projectName || info.hostname || sid.slice(0, 8)).slice(0, 30),
            provider: e?.provider ?? info.provider ?? "claude",
            tool: ss?.toolName || "",
            elapsed: Math.floor((now - (e?.connectedAt ?? now)) / 1000),
            hasPermission,
            permCount: ss?.pendingPermissionCount ?? 0,
            toolDescription: (ss?.toolInput || ss?.summary || "").slice(0, 500),
            contextLines: (e?.contextLines ?? "").slice(0, 500),
            permissionTool: ss?.topPermission?.toolName || "",
            permissionContext: (ss?.topPermission?.permissionRequest || ss?.topPermission?.toolInput || "").slice(0, 400),
            permissionRequestId: ss?.topPermission?.requestId || "",
            quickActions: hasPermission
              ? [
                  { label: "允许", input: "allow", needsInput: false, desc: "允许执行此操作" },
                  { label: "拒绝", input: "deny", needsInput: false, desc: "拒绝此操作" },
                ]
              : (e?.quickActions?.map((a) => ({ ...a, desc: a.desc ?? a.label })) ?? []),
          });
        }
        if (candidates.length === 0) return;

        const priority: Record<string, number> = {
          error: 0, waiting: 1, tool_use: 2, thinking: 3, outputting: 4, idle: 5,
        };
        candidates.sort((a, b) => {
          if (a.hasPermission !== b.hasPermission) return a.hasPermission ? -1 : 1;
          return (priority[a.phase] ?? 9) - (priority[b.phase] ?? 9);
        });

        const primary = candidates[0];
        const totalPermCount = candidates.reduce((sum, c) => sum + c.permCount, 0);

        const state: ActivityState = {
          sid: primary.sid, tid: primary.tid, phase: primary.phase,
          project: primary.project, provider: primary.provider,
          tool: primary.tool, elapsed: primary.elapsed,
          hasPermission: primary.hasPermission, permCount: primary.permCount,
          otherCount: candidates.length - 1, totalPermCount,
        };

        const secondaryTerminals: SecondaryTerminal[] = candidates.slice(1, 6).map((c) => ({
          sid: c.sid, tid: c.tid, provider: c.provider, phase: c.phase, hasPermission: c.hasPermission,
        }));

        const extended: ExtendedActivityData = {
          sid: primary.sid, tid: primary.tid,
          toolDescription: primary.toolDescription,
          contextLines: primary.contextLines,
          permissionTool: primary.permissionTool,
          permissionContext: primary.permissionContext,
          permissionRequestId: primary.permissionRequestId,
          quickActions: primary.quickActions,
          secondaryTerminals,
        };

        startLiveActivity(state, extended).then((id) => {
          if (id) liveActivityActiveRef.current = true;
        });
      });
    } else if (!hasConnected && liveActivityActiveRef.current) {
      liveActivityActiveRef.current = false;
      endLiveActivity();
      for (const entry of parsersRef.current.values()) {
        entry.parser.destroy();
        entry.unsub();
      }
      parsersRef.current.clear();
    } else if (hasConnected && liveActivityActiveRef.current) {
      // Sessions changed (added/removed/switched) — push update
      pushLiveActivityUpdate();
    }
  }, [manager.activeSessionId, manager.sessions, pushLiveActivityUpdate]);

  // Periodic Live Activity refresh — ensures structured status updates
  // (from hooks) are pushed even when there's no terminal output
  useEffect(() => {
    const id = setInterval(() => {
      if (liveActivityActiveRef.current) pushLiveActivityUpdate();
    }, 2000);
    return () => clearInterval(id);
  }, [pushLiveActivityUpdate]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      if (liveActivityActiveRef.current) {
        endLiveActivity();
        liveActivityActiveRef.current = false;
      }
      for (const entry of parsersRef.current.values()) {
        entry.parser.destroy();
        entry.unsub();
      }
      parsersRef.current.clear();
    };
  }, []);

  // App state: foreground/background
  const handleForeground = useCallback(async () => {
    if (manager.sessions.size === 0) {
      try {
        const raw = await AsyncStorage.getItem(LAST_SESSION_KEY);
        if (raw) {
          const last = JSON.parse(raw) as {
            gateway: string;
            sessionId: string;
          };
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
        await AsyncStorage.setItem(
          LAST_SESSION_KEY,
          JSON.stringify({
            gateway: info.gatewayUrl,
            sessionId: manager.activeSessionId,
          }),
        );
      }
    }
  }, [manager]);

  useAppState(handleForeground, handleBackground);

  const handleClaim = useCallback(
    async (code: string) => {
      const sid = await manager.claim(code, gatewayBaseUrl);
      if (sid) {
        setConnectionSheetVisible(false);
        setActiveScreen("terminal");
      }
    },
    [manager, gatewayBaseUrl],
  );

  const handleConnectSession = useCallback(
    (sessionId: string, serverUrl?: string) => {
      const target = serverUrl ?? gatewayBaseUrl;
      if (target !== gatewayBaseUrl) setGatewayBaseUrl(target);
      setConnectionSheetVisible(false);
      setActiveScreen("terminal");
      manager.connectToSession(sessionId, target);
    },
    [gatewayBaseUrl, manager],
  );

  const handleDisconnectSession = useCallback(
    (sessionId: string) => {
      manager.disconnectSession(sessionId);
      if (manager.sessions.size <= 1) {
        // Last session being removed — effect will end live activity
        liveActivityActiveRef.current = false;
        endLiveActivity();
        AsyncStorage.removeItem(LAST_SESSION_KEY);
        setActiveScreen("tabs");
      }
    },
    [manager],
  );

  const handleDisconnectAll = useCallback(() => {
    liveActivityActiveRef.current = false;
    endLiveActivity();
    for (const entry of parsersRef.current.values()) {
      entry.parser.destroy();
      entry.unsub();
    }
    parsersRef.current.clear();
    manager.disconnectAll();
    AsyncStorage.removeItem(LAST_SESSION_KEY);
    setActiveScreen("tabs");
  }, [manager]);

  // Build session tabs list for SessionScreen
  const sessionTabs = Array.from(manager.sessions.entries()).map(
    ([sid, info]) => ({
      sessionId: sid,
      label: info.projectName || info.hostname || sid.slice(0, 8),
      status: info.status,
    }),
  );

  // Build terminal tabs for active session
  const terminalTabs = activeSession
    ? Array.from(activeSession.terminals.entries()).map(([tid, t]) => ({
        terminalId: tid,
        label: t.projectName || tid.slice(0, 8),
        status: t.status,
      }))
    : [];

  // Compatibility: derive single-session-like status for ConnectionSheet
  const displayStatus = activeSession?.status ?? "idle";

  const navTheme =
    theme.mode === "dark"
      ? {
          ...DarkTheme,
          colors: {
            ...DarkTheme.colors,
            background: theme.bg,
            card: theme.tabBg,
            border: theme.tabBorder,
            primary: theme.accent,
            text: theme.text,
          },
        }
      : {
          ...DefaultTheme,
          colors: {
            ...DefaultTheme.colors,
            background: theme.bg,
            card: theme.tabBg,
            border: theme.tabBorder,
            primary: theme.accent,
            text: theme.text,
          },
        };

  if (currentScreen === "terminal" && activeSession) {
    return (
      <>
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
            // Browse the host's cwd or home
            manager.browseDirectory(activeSession.cwd ?? "~");
          }}
          terminals={activeSession.terminals}
          onKillTerminal={manager.killTerminal}
          onRemoveTerminal={manager.removeTerminal}
          gatewayUrl={activeSession.gatewayUrl}
          deviceToken={manager.deviceToken}
        />
        <FolderPickerModal
          visible={folderPickerVisible}
          browseResult={activeSession.browseResult}
          terminals={activeSession.terminals}
          onBrowse={manager.browseDirectory}
          onMkdir={manager.mkdirRemote}
          onSelect={(path) => manager.spawnTerminal(path)}
          onClose={() => setFolderPickerVisible(false)}
          theme={theme}
        />
      </>
    );
  }

  if (currentScreen === "scanner") {
    return (
      <>
        <StatusBar style="light" />
        <ScannerScreen
          onClose={() => setActiveScreen("tabs")}
          onScan={(payload) => {
            setActiveScreen("tabs");
            setPendingPairing(payload);
          }}
        />
      </>
    );
  }

  return (
    <>
      <NavigationContainer theme={navTheme}>
        <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
        <Tab.Navigator
          screenOptions={{
            headerShown: false,
            tabBarHideOnKeyboard: true,
            tabBarStyle: {
              backgroundColor: "transparent",
              borderTopWidth: 0,
              elevation: 0,
              position: "absolute",
            },
            tabBarBackground: () => (
              <GlassBar
                blurTint={
                  theme.mode === "dark"
                    ? "systemThinMaterialDark"
                    : "systemThinMaterialLight"
                }
                fallbackColor={theme.tabBg}
                style={StyleSheet.absoluteFill}
              />
            ),
            tabBarActiveTintColor: theme.tabActive,
            tabBarInactiveTintColor: theme.tabInactive,
            tabBarLabelStyle: { fontSize: 10, fontWeight: "500" },
          }}
        >
          <Tab.Screen
            name="Home"
            options={{
              tabBarLabel: "首页",
              tabBarIcon: ({ color }) => (
                <SFIcon name="house.fill" color={color} />
              ),
            }}
          >
            {() => (
              <HomeScreen
                gatewayBaseUrl={gatewayBaseUrl}
                status={displayStatus}
                connectionDetail={activeSession?.connectionDetail ?? null}
                onOpenConnectionSheet={() => setConnectionSheetVisible(true)}
                onConnectSession={handleConnectSession}
                refreshKey={sessionRefreshKey}
              />
            )}
          </Tab.Screen>

          <Tab.Screen
            name="Sessions"
            options={{
              tabBarLabel: "会话",
              tabBarIcon: ({ color }) => (
                <SFIcon name="list.bullet.rectangle.fill" color={color} />
              ),
            }}
          >
            {() => (
              <SessionListScreen
                gatewayBaseUrl={gatewayBaseUrl}
                onSelectSession={handleConnectSession}
                refreshKey={sessionRefreshKey}
                deviceToken={manager.deviceToken}
              />
            )}
          </Tab.Screen>

          <Tab.Screen
            name="Settings"
            options={{
              tabBarLabel: "设置",
              tabBarIcon: ({ color }) => (
                <SFIcon name="gearshape.fill" color={color} />
              ),
            }}
          >
            {() => (
              <SettingsScreen
                gatewayBaseUrl={gatewayBaseUrl}
                onGatewayChange={setGatewayBaseUrl}
                onOpenGatewayList={() => {
                  setGatewayListVisible(true);
                  gatewaySlideAnim.setValue(Dimensions.get("window").width);
                  Animated.timing(gatewaySlideAnim, {
                    toValue: 0,
                    duration: 300,
                    useNativeDriver: true,
                  }).start();
                }}
              />
            )}
          </Tab.Screen>
        </Tab.Navigator>
      </NavigationContainer>

      {gatewayListVisible ? (
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { transform: [{ translateX: gatewaySlideAnim }] },
          ]}
        >
          <GatewayListScreen
            onBack={() => {
              Animated.timing(gatewaySlideAnim, {
                toValue: Dimensions.get("window").width,
                duration: 300,
                useNativeDriver: true,
              }).start(() => {
                setGatewayListVisible(false);
                setSessionRefreshKey((k) => k + 1);
              });
            }}
            onAddGateway={() => {
              Animated.timing(gatewaySlideAnim, {
                toValue: Dimensions.get("window").width,
                duration: 300,
                useNativeDriver: true,
              }).start(() => {
                setGatewayListVisible(false);
                setSessionRefreshKey((k) => k + 1);
                setConnectionSheetVisible(true);
              });
            }}
            onGatewayChange={setGatewayBaseUrl}
          />
        </Animated.View>
      ) : null}

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
          setActiveScreen("scanner");
        }}
      />
    </>
  );
}

export default function App(): React.JSX.Element {
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
