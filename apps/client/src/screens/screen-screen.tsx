import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { Button } from "@/components/button";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { useConnection } from "@/lib/client";
import { forwardPort, type Forward } from "@/lib/preview";
import { type } from "@/theme/type";

interface Viewer {
  forward: Forward;
  token: string;
  displays: { index: number; name: string }[];
}

/**
 * The computer's screen, live: the host's viewer page and H.264 stream,
 * opened through the encrypted forwarder like a port preview.
 */
export function ScreenScreen() {
  const { link } = useConnection();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [display, setDisplay] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let started: Forward | undefined;
    let cancelled = false;
    setFailure(null);
    link
      .call("screen.start", {}, 20_000)
      .then(async ({ port, token, displays }) => {
        const forward = await forwardPort(link, port);
        if (cancelled) return forward.stop();
        started = forward;
        setViewer({ forward, token, displays });
        setDisplay((current) => current ?? displays[0]?.index ?? 0);
      })
      .catch((reason: unknown) => !cancelled && setFailure(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      cancelled = true;
      started?.stop();
    };
  }, [link, attempt]);

  const current = viewer?.displays.find((entry) => entry.index === display);
  const uri = viewer && display !== null ? `${viewer.forward.url}?token=${encodeURIComponent(viewer.token)}&display=${display}` : null;

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
      <Stack.Screen
        options={{
          title: "屏幕",
          headerTitle: () => (
            <View style={{ alignItems: Platform.OS === "ios" ? "center" : "flex-start" }}>
              <Text style={[type.headline, { color: "#ffffff" }]}>电脑屏幕</Text>
              {current && (viewer?.displays.length ?? 0) > 1 ? (
                <Text style={[type.caption, { color: "rgba(255,255,255,0.6)" }]}>{current.name}</Text>
              ) : null}
            </View>
          ),
          headerTintColor: "#ffffff",
          headerStyle: { backgroundColor: "#000000" },
          headerShadowVisible: false,
          headerTransparent: false,
        }}
      />
      {(viewer?.displays.length ?? 0) > 1 ? (
        <HeaderActions
          actions={[
            {
              kind: "menu",
              key: "display",
              icon: { sf: "rectangle.on.rectangle", md: "screenshot_monitor" },
              label: "切换屏幕",
              items: viewer!.displays.map((entry) => ({
                title: entry.index === display ? `${entry.name} ✓` : entry.name,
                icon: { sf: "display", md: "desktop_windows" },
                onPress: () => setDisplay(entry.index),
              })),
            },
          ]}
        />
      ) : null}
      {failure ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 }}>
          <Icon sf="display" md="desktop_access_disabled" size={36} color="rgba(255,255,255,0.45)" />
          <Text style={[type.subhead, { color: "rgba(255,255,255,0.75)", textAlign: "center" }]}>{failure}</Text>
          <Button title="重试" variant="tonal" size="small" onPress={() => setAttempt((value) => value + 1)} />
        </View>
      ) : uri ? (
        <WebView
          key={uri}
          source={{ uri }}
          originWhitelist={["http://127.0.0.1*"]}
          bounces={false}
          scrollEnabled
          setBuiltInZoomControls
          setDisplayZoomControls={false}
          style={{ flex: 1, backgroundColor: "#000000" }}
          containerStyle={{ backgroundColor: "#000000" }}
        />
      ) : (
        <ActivityIndicator style={{ marginTop: 64 }} color="rgba(255,255,255,0.6)" />
      )}
    </View>
  );
}
