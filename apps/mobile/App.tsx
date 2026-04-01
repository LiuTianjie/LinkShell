import AsyncStorage from "@react-native-async-storage/async-storage";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionSheet } from "./src/components/ConnectionSheet";
import { useAppState } from "./src/hooks/useAppState";
import { useSession } from "./src/hooks/useSession";
import { HomeScreen } from "./src/screens/HomeScreen";
import { ScannerScreen } from "./src/screens/ScannerScreen";
import { SessionListScreen } from "./src/screens/SessionListScreen";
import { SessionScreen } from "./src/screens/SessionScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { addToHistory } from "./src/storage/history";
import { ThemeProvider, useTheme } from "./src/theme";
import { parsePairingLink } from "./src/utils/pairing-link";

const DEFAULT_GATEWAY = "http://localhost:8787";
const LAST_SESSION_KEY = "@linkshell/last_session";

const Tab = createBottomTabNavigator();

function TabIcon({ kind, focused, color }: { kind: "home" | "sessions" | "settings"; focused: boolean; color: string }) {
  return (
    <View style={styles.tabIconWrap}>
      {kind === "home" ? (
        <>
          <View style={[styles.homeRoof, { borderBottomColor: color, opacity: focused ? 1 : 0.78 }]} />
          <View style={[styles.homeBody, { borderColor: color, opacity: focused ? 1 : 0.78 }]} />
        </>
      ) : null}
      {kind === "sessions" ? (
        <>
          <View style={[styles.listLine, { backgroundColor: color, opacity: focused ? 1 : 0.78 }]} />
          <View style={[styles.listLine, { backgroundColor: color, opacity: focused ? 1 : 0.78 }]} />
          <View style={[styles.listLineShort, { backgroundColor: color, opacity: focused ? 1 : 0.78 }]} />
        </>
      ) : null}
      {kind === "settings" ? (
        <>
          <View style={[styles.settingRail, { backgroundColor: color, opacity: focused ? 1 : 0.78 }]} />
          <View style={[styles.settingKnobTop, { backgroundColor: color, opacity: focused ? 1 : 0.78 }]} />
          <View style={[styles.settingRail, { backgroundColor: color, opacity: focused ? 1 : 0.78 }]} />
          <View style={[styles.settingKnobBottom, { backgroundColor: color, opacity: focused ? 1 : 0.78 }]} />
        </>
      ) : null}
    </View>
  );
}

function AppInner() {
  const { theme } = useTheme();
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState(DEFAULT_GATEWAY);
  const [activeScreen, setActiveScreen] = useState<"tabs" | "scanner" | "terminal">("tabs");
  const [pendingPairing, setPendingPairing] = useState<{ code: string; gateway?: string } | null>(null);
  const [connectionSheetVisible, setConnectionSheetVisible] = useState(false);
  const lastSavedSessionRef = React.useRef<string | null>(null);

  const session = useSession({ gatewayBaseUrl });

  const isInSession =
    session.status === "connected" ||
    session.status === "reconnecting" ||
    session.status === "session_exited" ||
    (session.status as string) === "host_disconnected";

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
      setGatewayBaseUrl(pendingPairing.gateway);
      return;
    }

    let cancelled = false;
    const pairing = pendingPairing;
    setPendingPairing(null);

    const run = async () => {
      const sid = await session.claim(pairing.code);
      if (!cancelled && sid) {
        setConnectionSheetVisible(false);
        setActiveScreen("terminal");
      }
    };

    run().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gatewayBaseUrl, pendingPairing, session.claim]);

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
          terminalLines={session.terminalLines}
          onSendInput={session.sendInput}
          onSendResize={session.sendResize}
          onClaimControl={session.claimControl}
          onReleaseControl={session.releaseControl}
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
            tabBarItemStyle: {
              paddingVertical: 2,
            },
            tabBarActiveTintColor: theme.tabActive,
            tabBarInactiveTintColor: theme.tabInactive,
            tabBarLabelStyle: { fontSize: 11, fontWeight: "600", marginBottom: 0 },
            tabBarIconStyle: { marginTop: 1 },
          }}
        >
          <Tab.Screen
            name="Home"
            options={{
              tabBarLabel: "首页",
              tabBarIcon: ({ focused, color }) => (
                <TabIcon kind="home" focused={focused} color={color} />
              ),
            }}
          >
            {() => (
              <HomeScreen
                gatewayBaseUrl={gatewayBaseUrl}
                status={session.status}
                onOpenConnectionSheet={() => setConnectionSheetVisible(true)}
                onConnectSession={handleConnectSession}
              />
            )}
          </Tab.Screen>

          <Tab.Screen
            name="Sessions"
            options={{
              tabBarLabel: "会话",
              tabBarIcon: ({ focused, color }) => (
                <TabIcon kind="sessions" focused={focused} color={color} />
              ),
            }}
          >
            {() => (
              <SessionListScreen
                gatewayBaseUrl={gatewayBaseUrl}
                onSelectSession={handleConnectSession}
              />
            )}
          </Tab.Screen>

          <Tab.Screen
            name="Settings"
            options={{
              tabBarLabel: "设置",
              tabBarIcon: ({ focused, color }) => (
                <TabIcon kind="settings" focused={focused} color={color} />
              ),
            }}
          >
            {() => <SettingsScreen />}
          </Tab.Screen>
        </Tab.Navigator>
      </NavigationContainer>

      <ConnectionSheet
        visible={connectionSheetVisible}
        gatewayBaseUrl={gatewayBaseUrl}
        status={session.status}
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

export default function App(): JSX.Element {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AppInner />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  tabIconWrap: {
    width: 22,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  homeRoof: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 6,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    marginBottom: -1,
  },
  homeBody: {
    width: 12,
    height: 8,
    borderWidth: 1.6,
    borderTopWidth: 0,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
  },
  listLine: {
    width: 14,
    height: 2,
    borderRadius: 99,
  },
  listLineShort: {
    width: 10,
    height: 2,
    borderRadius: 99,
  },
  settingRail: {
    width: 14,
    height: 2,
    borderRadius: 99,
  },
  settingKnobTop: {
    width: 5,
    height: 5,
    borderRadius: 99,
    alignSelf: "flex-start",
    marginLeft: 2,
    marginTop: -4,
    marginBottom: -1,
  },
  settingKnobBottom: {
    width: 5,
    height: 5,
    borderRadius: 99,
    alignSelf: "flex-end",
    marginRight: 2,
    marginTop: -4,
  },
});
