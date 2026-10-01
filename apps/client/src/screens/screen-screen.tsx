import * as Device from "expo-device";
import { Stack } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Platform, Text, View } from "react-native";
import { useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Button } from "@/components/button";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { useConnection, useStreamPath } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { forwardPort, type Forward } from "@/lib/preview";
import { loadScreenMode, saveScreenMode, type ScreenMode } from "@/lib/settings";
import { type } from "@/theme/type";

interface Viewer {
  forward: Forward;
  token: string;
  displays: { index: number; name: string }[];
}

// A tablet turns with the hand holding it; a phone's screen is turned from the viewer's toolbar.
const canRotate = Device.deviceType !== Device.DeviceType.TABLET;
// An iPhone lies down one way, its camera to the left: the page then knows which side is all screen, and
// keeps its toolbar there (the system can't be asked which way a phone was turned until it has been).
// Android reports the camera's side as the larger inset, so either way will do.
const LANDSCAPE = Platform.OS === "ios" ? ScreenOrientation.OrientationLock.LANDSCAPE_RIGHT : ScreenOrientation.OrientationLock.LANDSCAPE;

/**
 * The computer's screen, live: the host's viewer page and H.264 stream,
 * opened through the encrypted forwarder like a port preview. The page has
 * the gestures and the toolbar (they come with the host); this screen gives it
 * what a page can't take: the whole display, its orientation, and room above
 * the keyboard.
 */
export function ScreenScreen() {
  const { link, streams, computer } = useConnection();
  const path = useStreamPath();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [display, setDisplay] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const web = useRef<WebView>(null);
  const insets = useSafeAreaInsets();
  // The mode the page opens in is the one last chosen; after that the page reports its own.
  const [initialMode] = useState(loadScreenMode);
  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const [fullscreen, setFullscreen] = useState(false);
  const [landscape, setLandscape] = useState(false);
  // Landscape has no room for a header, so it is always the full screen; leaving the full screen stands the phone up again.
  const present = useCallback((full: boolean, turned: boolean) => {
    const land = canRotate && turned;
    setFullscreen(full || land);
    setLandscape(land);
  }, []);

  const turnedOnce = useRef(false);
  useEffect(() => {
    if (!canRotate || (!landscape && !turnedOnce.current)) return;
    turnedOnce.current = true;
    void ScreenOrientation.lockAsync(landscape ? LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, [landscape]);
  // The rest of the app is upright.
  useEffect(
    () => () => {
      if (turnedOnce.current) void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    },
    [],
  );

  // A screen that failed has only the header to leave by.
  useEffect(() => {
    if (failure) present(false, false);
  }, [failure, present]);

  // Android's back leaves the full screen before it leaves the viewer.
  useEffect(() => {
    if (!fullscreen) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      present(false, false);
      return true;
    });
    return () => subscription.remove();
  }, [fullscreen, present]);

  const keyboardOpen = useKeyboardState((state) => state.isVisible);
  // What the page is told about the display it has: under the header only the sides and the bottom are the phone's edges.
  const chrome = useMemo(
    () =>
      JSON.stringify({
        fullscreen,
        landscape,
        canRotate,
        // Lying down that way, the right is the side without the camera.
        clear: landscape && Platform.OS === "ios" ? "right" : null,
        // The keyboard covers the bottom edge while it is up.
        insets: { top: fullscreen ? insets.top : 0, right: insets.right, bottom: keyboardOpen ? 0 : insets.bottom, left: insets.left },
      }),
    [fullscreen, landscape, keyboardOpen, insets.top, insets.right, insets.bottom, insets.left],
  );
  const tellPage = useCallback((state: string) => web.current?.injectJavaScript(`window.linkshellChrome && window.linkshellChrome(${state}); true;`), []);
  useEffect(() => tellPage(chrome), [chrome, tellPage]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: { type?: string; on?: boolean; mode?: string; kind?: string };
      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (message.type === "fullscreen") present(message.on === true, message.on === true && landscape);
      else if (message.type === "landscape") present(fullscreen, message.on === true);
      else if (message.type === "haptic") (message.kind === "medium" ? haptics.medium : haptics.light)();
      else if (message.type === "ready" || message.type === "mode") {
        if (message.mode === "view" || message.mode === "trackpad" || message.mode === "touch") {
          setMode(message.mode);
          if (message.type === "mode") saveScreenMode(message.mode);
        }
        // A page that has just loaded (again) learns where it stands.
        if (message.type === "ready") tellPage(chrome);
      }
    },
    [present, landscape, fullscreen, tellPage, chrome],
  );

  // The page ends above the keyboard, frame by frame, so its key bar sits on the keys.
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({ paddingBottom: Math.max(-keyboardHeight.value, 0) }));
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
  const uri = viewer && display !== null ? `${viewer.forward.url}?token=${encodeURIComponent(viewer.token)}&display=${display}${quality}&mode=${initialMode}` : null;

  return (
    <Animated.View style={[{ flex: 1, backgroundColor: "#000000" }, lift]}>
      <StatusBar style="light" hidden={fullscreen} animated />
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
          headerShown: !fullscreen,
          navigationBarHidden: fullscreen,
          autoHideHomeIndicator: fullscreen,
          // A swipe from the edge belongs to the computer's pointer once it is being moved.
          gestureEnabled: !fullscreen && mode === "view",
        }}
      />
      {/* The header's buttons keep the header: they go with it. */}
      {!fullscreen && (viewer?.displays.length ?? 0) > 1 ? (
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
          ref={web}
          source={{ uri }}
          originWhitelist={["http://127.0.0.1*"]}
          onMessage={onMessage}
          injectedJavaScriptBeforeContentLoaded={`window.__linkshellChrome = ${chrome}; true;`}
          // The page moves and zooms the picture itself, and puts its own keys above the keyboard.
          bounces={false}
          scrollEnabled={false}
          overScrollMode="never"
          setBuiltInZoomControls={false}
          textZoom={100}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          hideKeyboardAccessoryView
          keyboardDisplayRequiresUserAction={false}
          style={{ flex: 1, backgroundColor: "#000000" }}
          containerStyle={{ backgroundColor: "#000000" }}
        />
      ) : (
        <ActivityIndicator style={{ marginTop: 64 }} color="rgba(255,255,255,0.6)" />
      )}
    </Animated.View>
  );
}
