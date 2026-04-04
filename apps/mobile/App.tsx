import AsyncStorage from "@react-native-async-storage/async-storage";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Dimensions, Linking, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppSymbol } from "./src/components/AppSymbol";
import { ConnectionSheet } from "./src/components/ConnectionSheet";
import { useAppState } from "./src/hooks/useAppState";
import { useSessionManager } from "./src/hooks/useSessionManager";
import type { SessionInfo } from "./src/hooks/useSessionManager";
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
} from "./src/native/LiveActivity";
import type { SessionActivityState } from "./src/native/LiveActivity";
import { ThrottledTerminalParser } from "./src/utils/terminal-parser";

const DEFAULT_GATEWAY = "http://localhost:8787";
const LAST_SESSION_KEY = "@linkshell/last_session";

const Tab = createBottomTabNavigator();

function SFIcon({ name, color, size = 22 }: { name: string; color: string; size?: number }) {
  return <AppSymbol name={name} size={size} color={color} />;
}

function AppInner() {
  const { theme } = useTheme();
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState(DEFAULT_GATEWAY);
  const [activeScreen, setActiveScreen] = useState<"tabs" | "scanner" | "terminal">("tabs");
  const [pendingPairing, setPendingPairing] = useState<{ code: string; gateway?: string } | null>(null);
  const [connectionSheetVisible, setConnectionSheetVisible] = useState(false);
  const [gatewayListVisible, setGatewayListVisible] = useState(false);
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const gatewaySlideAnim = useRef(new Animated.Value(Dimensions.get("window").width)).current;
  const lastSavedSessionsRef = useRef(new Set<string>());

  const manager = useSessionManager();

  // Derive active session info
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

  // Deep link handling (pairing + live activity quick actions)
  useEffect(() => {
    const applyLink = (rawUrl: string | null) => {
      if (!rawUrl) return;

      // Handle live activity quick action: linkshell://input?session=X&data=Y
      try {
        const url = new URL(rawUrl);
        if (url.host === "input" || url.pathname === "//input") {
          const sessionId = url.searchParams.get("session");
          const data = url.searchParams.get("data");
          if (sessionId && data) {
            // Switch to the session and send input
            const info = manager.sessions.get(sessionId);
            if (info) {
              manager.setActiveSessionId(sessionId);
              setActiveScreen("terminal");
              // Small delay to ensure session is active before sending
              setTimeout(() => manager.sendInput(data), 100);
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
      if (sid) {
        setConnectionSheetVisible(false);
        setActiveScreen("terminal");
      } else {
        setActiveScreen("tabs");
        setConnectionSheetVisible(true);
      }
    }).catch(() => {
      if (!active) return;
      setActiveScreen("tabs");
      setConnectionSheetVisible(true);
    });

    return () => { active = false; };
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
      fetchWithTimeout(`${info.gatewayUrl}/sessions`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { sessions: Array<{ id: string; hostname?: string; provider?: string; platform?: string; projectName?: string; cwd?: string }> } | null) => {
          if (!body) return;
          const match = body.sessions.find((s) => s.id === sid);
          if (match) enrichHistory(sid, match);
        })
        .catch(() => {});
    }
  }, [manager.sessions]);

  // Live Activity: track ALL sessions, not just active one
  const liveActivityActiveRef = useRef(false);
  const parsersRef = useRef(new Map<string, { parser: ThrottledTerminalParser; unsub: () => void; status: string; lastLine: string; quickActions: { label: string; input: string }[]; connectedAt: number }>());

  useEffect(() => {
    const currentSessions = manager.sessions;
    const activeSid = manager.activeSessionId;

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
        quickActions: [] as { label: string; input: string }[],
        connectedAt: Date.now(),
      };

      entry.parser = new ThrottledTerminalParser((result) => {
        entry.status = result.status;
        entry.lastLine = result.lastLine;
        entry.quickActions = result.quickActions;
        // Trigger live activity update
        pushLiveActivityUpdate();
      }, 1000);

      entry.unsub = info.terminalStream.subscribe((event) => {
        if (event.type === "append") entry.parser.push(event.chunk);
      });

      parsersRef.current.set(sid, entry);
    }

    // Start or end live activity based on session count
    const hasConnected = [...currentSessions.values()].some((s) => s.status === "connected");

    if (hasConnected && !liveActivityActiveRef.current) {
      isLiveActivityAvailable().then((ok) => {
        if (!ok) return;
        liveActivityActiveRef.current = true;
        pushLiveActivityUpdate();
      });
    } else if (!hasConnected && liveActivityActiveRef.current) {
      liveActivityActiveRef.current = false;
      endLiveActivity();
      for (const entry of parsersRef.current.values()) {
        entry.parser.destroy();
        entry.unsub();
      }
      parsersRef.current.clear();
    }

    function pushLiveActivityUpdate() {
      if (!liveActivityActiveRef.current) return;
      const now = Date.now();
      const states: SessionActivityState[] = [];

      for (const [sid, info] of currentSessions) {
        if (info.status !== "connected") continue;
        const entry = parsersRef.current.get(sid);
        states.push({
          sessionId: sid,
          status: entry?.status ?? "idle",
          lastLine: entry?.lastLine ?? "",
          projectName: info.projectName || info.hostname || sid.slice(0, 8),
          provider: info.provider || "claude",
          quickActions: entry?.quickActions ?? [],
          tokensUsed: 0,
          elapsedSeconds: Math.floor((now - (entry?.connectedAt ?? now)) / 1000),
        });
      }

      // Sort: waiting > thinking > outputting > idle
      const priority: Record<string, number> = { waiting: 0, thinking: 1, outputting: 2, idle: 3 };
      states.sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9));

      const aid = activeSid ?? states[0]?.sessionId ?? "";

      if (states.length === 0) return;

      if (!liveActivityActiveRef.current) return;
      // Start or update
      startLiveActivity(states, aid).catch(() => {
        updateLiveActivity(states, aid);
      });
    }

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
  }, [manager.activeSessionId, manager.sessions]);

  // App state: foreground/background
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
        await AsyncStorage.setItem(
          LAST_SESSION_KEY,
          JSON.stringify({ gateway: info.gatewayUrl, sessionId: manager.activeSessionId }),
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

  const handleDisconnectSession = useCallback((sessionId: string) => {
    endLiveActivity();
    manager.disconnectSession(sessionId);
    if (manager.sessions.size <= 1) {
      // Last session being removed
      AsyncStorage.removeItem(LAST_SESSION_KEY);
      setActiveScreen("tabs");
    }
  }, [manager]);

  const handleDisconnectAll = useCallback(() => {
    endLiveActivity();
    manager.disconnectAll();
    AsyncStorage.removeItem(LAST_SESSION_KEY);
    setActiveScreen("tabs");
  }, [manager]);

  // Build session tabs list for SessionScreen
  const sessionTabs = Array.from(manager.sessions.entries()).map(([sid, info]) => ({
    sessionId: sid,
    label: info.projectName || info.hostname || sid.slice(0, 8),
    status: info.status,
  }));

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

  const navTheme = theme.mode === "dark"
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
            // TODO: navigate to ProjectPickerScreen
            // For now, prompt is handled via deep link or future UI
          }}
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
              backgroundColor: theme.tabBg,
              borderTopColor: theme.tabBorder,
              borderTopWidth: StyleSheet.hairlineWidth,
              elevation: 0,
            },
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
            {() => <SettingsScreen gatewayBaseUrl={gatewayBaseUrl} onGatewayChange={setGatewayBaseUrl} onOpenGatewayList={() => {
              setGatewayListVisible(true);
              gatewaySlideAnim.setValue(Dimensions.get("window").width);
              Animated.timing(gatewaySlideAnim, {
                toValue: 0,
                duration: 300,
                useNativeDriver: true,
              }).start();
            }} />}
          </Tab.Screen>
        </Tab.Navigator>
      </NavigationContainer>

      {gatewayListVisible ? (
        <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: gatewaySlideAnim }] }]}>
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
