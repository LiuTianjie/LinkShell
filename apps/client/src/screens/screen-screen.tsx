import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { Button } from "@/components/button";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { useConnection, useStreamPath } from "@/lib/client";
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
  const { link, streams, computer } = useConnection();
  const path = useStreamPath();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [display, setDisplay] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The path the picture is on. It follows `path` to the direct channel when
  // one comes up (the stream is opened again there), and back when it is lost;
  // while a direct path is still being looked for, the start waits a moment for it.
  const [via, setVia] = useState<"direct" | "relay" | null>(path === "connecting" ? null : path);
  useEffect(() => {
    if (path !== "connecting") return setVia(path);
    const timer = setTimeout(() => setVia((current) => current ?? "relay"), 3000);
    return () => clearTimeout(timer);
  }, [path]);

  useEffect(() => {
    if (!via) return;
    let started: Forward | undefined;
    let cancelled = false;
    setFailure(null);
    setViewer(null);
    link
      .call("screen.start", {}, 20_000)
      .then(async ({ port, token, displays }) => {
        const forward = await forwardPort(streams, port);
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
  }, [link, streams, attempt, via]);

  const current = viewer?.displays.find((entry) => entry.index === display);
  // Through a gateway the picture is lighter: it is someone's relay, not a wire between the two devices.
  const quality = via === "relay" && computer.kind !== "direct" ? "&q=low" : "";
  const uri = viewer && display !== null ? `${viewer.forward.url}?token=${encodeURIComponent(viewer.token)}&display=${display}${quality}` : null;

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
      <Stack.Screen
        options={{
          title: "屏幕",
          headerTitle: () => (
            <View style={{ alignItems: Platform.OS === "ios" ? "center" : "flex-start" }}>
              <Text style={[type.headline, { color: "#ffffff" }]}>电脑屏幕</Text>
              {viewer ? (
                <Text style={[type.caption, { color: "rgba(255,255,255,0.6)" }]}>
                  {[current && viewer.displays.length > 1 ? current.name : null, via === "direct" ? "直连" : "经网关中转"].filter(Boolean).join(" · ")}
                </Text>
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
