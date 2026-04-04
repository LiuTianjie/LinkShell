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
import { useSession } from "./src/hooks/useSession";
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
  const lastSavedSessionRef = React.useRef<string | null>(null);

  const session = useSession({ gatewayBaseUrl });

  const isInSession =
    session.status === "connected" ||
    session.status === "connecting" ||
    session.status === "claiming" ||
    session.status === "reconnecting" ||
    session.status === "session_exited" ||
    session.status === "host_disconnected" ||
    session.status.startsWith("error:");

  const currentScreen = isInSession ? "terminal" : activeScreen;

  useEffect(() => {
    const applyLink = (rawUrl: string | null) => {
      if (!rawUrl) return;
      const parsed = parsePairingLink(rawUrl);
      if (!parsed) return;
      setActiveScreen("tabs");
      setPendingPairing(parsed);
      setConnectionSheetVisible(false);
    };

    Linking.getInitialURL().then(applyLink).catch(() => {});
    const sub = Linking.addEventListener("url", ({ url }) => applyLink(url));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!pendingPairing) return;
    if (pendingPairing.gateway && pendingPairing.gateway !== gatewayBaseUrl) {
      console.log('[LinkShell] Gateway differs, updating:', pendingPairing.gateway);
      setGatewayBaseUrl(pendingPairing.gateway);
      return;
    }

    const pairing = pendingPairing;
    setPendingPairing(null);

    console.log('[LinkShell] Claiming with code:', pairing.code, 'gateway:', gatewayBaseUrl);

    let active = true;
    session.claim(pairing.code).then((sid) => {
      if (!active) return;
      console.log('[LinkShell] Claim result:', sid ? 'success' : 'failed');
      if (sid) {
        setConnectionSheetVisible(false);
        setActiveScreen("terminal");
      } else {
        setActiveScreen("tabs");
        setConnectionSheetVisible(true);
      }
    }).catch((err) => {
      if (!active) return;
      console.warn('[LinkShell] Claim error:', err);
      setActiveScreen("tabs");
      setConnectionSheetVisible(true);
    });

    return () => { active = false; };
  }, [gatewayBaseUrl, pendingPairing, session]);

  useEffect(() => {
    if (!session.sessionId) {
      lastSavedSessionRef.current = null;
      return;
    }
    if (lastSavedSessionRef.current === session.sessionId) return;

    lastSavedSessionRef.current = session.sessionId;
    addToHistory({ serverUrl: gatewayBaseUrl, sessionId: session.sessionId }).catch(() => {
      lastSavedSessionRef.current = null;
    });
    // Also ensure gateway is saved in the servers list
    addServer(gatewayBaseUrl).catch(() => {});
    // Enrich history with hostname/platform from gateway API
    fetchWithTimeout(`${gatewayBaseUrl}/sessions`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { sessions: Array<{ id: string; hostname?: string; provider?: string; platform?: string }> } | null) => {
        if (!body) { console.log("[LinkShell] enrich: no body from /sessions"); return; }
        const info = body.sessions.find((s) => s.id === session.sessionId);
        console.log("[LinkShell] enrich session", session.sessionId, "match:", JSON.stringify(info ?? null));
        if (info) enrichHistory(session.sessionId, info);
      })
      .catch(() => {});
  }, [gatewayBaseUrl, session.sessionId]);

  const handleForeground = useCallback(async () => {
    if (session.sessionId && session.status === "disconnected") {
      try {
        const raw = await AsyncStorage.getItem(LAST_SESSION_KEY);
        if (raw) {
          const last = JSON.parse(raw) as { gateway: string; sessionId: string };
          setGatewayBaseUrl(last.gateway);
          setActiveScreen("terminal");
          session.connectToSession(last.sessionId, last.gateway);
        }
      } catch {}
    }
  }, [session]);

  const handleBackground = useCallback(async () => {
    if (session.sessionId) {
      await AsyncStorage.setItem(
        LAST_SESSION_KEY,
        JSON.stringify({ gateway: gatewayBaseUrl, sessionId: session.sessionId }),
      );
    }
  }, [gatewayBaseUrl, session.sessionId]);

  useAppState(handleForeground, handleBackground);

  const handleClaim = useCallback(
    async (code: string) => {
      const sid = await session.claim(code);
      if (sid) {
        setConnectionSheetVisible(false);
        setActiveScreen("terminal");
      }
    },
    [session],
  );

  const handleConnectSession = useCallback(
    (sessionId: string, serverUrl?: string) => {
      const target = serverUrl ?? gatewayBaseUrl;
      if (target !== gatewayBaseUrl) setGatewayBaseUrl(target);
      setConnectionSheetVisible(false);
      setActiveScreen("terminal");
      session.connectToSession(sessionId, target);
    },
    [gatewayBaseUrl, session],
  );

  const handleDisconnect = useCallback(() => {
    session.disconnect();
    AsyncStorage.removeItem(LAST_SESSION_KEY);
    setActiveScreen("tabs");
  }, [session]);

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

  if (currentScreen === "terminal") {
    return (
      <>
        <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
        <SessionScreen
          sessionId={session.sessionId}
          status={session.status}
          deviceId={session.deviceId}
          controllerId={session.controllerId}
          connectionDetail={session.connectionDetail}
          terminalStream={session.terminalStream}
          screenStatus={session.screenStatus}
          screenFrame={session.screenFrame}
          pendingOffer={session.pendingOffer}
          pendingIceCandidates={session.pendingIceCandidates}
          onSendInput={session.sendInput}
          onSendImage={session.sendImage}
          onSendResize={session.sendResize}
          onClaimControl={session.claimControl}
          onReleaseControl={session.releaseControl}
          onStartScreen={session.startScreen}
          onStopScreen={session.stopScreen}
          onScreenSignal={session.sendScreenSignal}
          onReconnect={session.reconnect}
          onDisconnect={handleDisconnect}
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
                status={session.status}
                connectionDetail={session.connectionDetail}
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
        status={session.status}
        connectionDetail={session.connectionDetail}
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

const styles = StyleSheet.create({});
