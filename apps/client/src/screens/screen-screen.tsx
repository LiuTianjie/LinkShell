import { nativeStatusBar } from "@/lib/native-status-bar";
import * as Clipboard from "expo-clipboard";
import * as Device from "expo-device";
import { useKeepAwake } from "expo-keep-awake";
import { Stack } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Platform, ScrollView, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { LayoutProbe } from "../../modules/link-layout";
import { useLayoutGeometry } from "@/lib/use-layout-geometry";
import { safeContentInsets } from "@/lib/adaptive-insets";
import { Button } from "@/components/button";
import { HeaderActions } from "@/components/header-actions";
import { NativeScreenPane } from "@/components/native-screen-pane";
import { nativeScreenAvailable } from "../../modules/link-screen";
import { Icon } from "@/components/icon";
import { useConnection, useStreamPath } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { forwardPort, type Forward } from "@/lib/preview";
import { isScreenWidth, loadScreenMode, loadScreenShortcuts, loadScreenWidth, saveScreenMode, saveScreenShortcuts, saveScreenWidth, screenShortcuts, type ScreenMode } from "@/lib/settings";
import { initialScreenPlayback, screenPlayback } from "@/lib/screen-playback";
import { type } from "@/theme/type";

interface Viewer {
  forward: Forward;
  token: string;
  displays: { index: number; name: string }[];
}

// Resizable iOS windows follow their actual geometry; older phones retain the toolbar rotation control.
const resizableIOS = Platform.OS === "ios" && Number.parseInt(String(Platform.Version), 10) >= 27;
const canRotate = !resizableIOS && Device.deviceType !== Device.DeviceType.TABLET;
// An iPhone lies down one way, its camera to the left: the page then knows which side is all screen, and
// keeps its toolbar there (the system can't be asked which way a phone was turned until it has been).
// Android reports the camera's side as the larger inset, so either way will do.
const LANDSCAPE = Platform.OS === "ios" ? ScreenOrientation.OrientationLock.LANDSCAPE_RIGHT : ScreenOrientation.OrientationLock.LANDSCAPE;

/**
 * The computer's screen, live: the host's viewer page and H.264 stream,
 * opened through the encrypted forwarder like a port preview. The page has
 * the gestures and the toolbar (they come with the host); this screen gives it
 * what a page can't take: the whole display, its orientation, room above the
 * keyboard and word of whether it is up, the phone's clipboard, and a place to
 * keep the user's own shortcuts.
 */
export function ScreenScreen() {
  const { link, streams, computer } = useConnection();
  const path = useStreamPath();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [display, setDisplay] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const web = useRef<WebView>(null);
  const headerHeight = useHeaderHeight();
  // Watching is not touching: the phone must not lock while the screen is being watched.
  useKeepAwake("screen");
  const safeArea = useSafeAreaInsets();
  const geometry = useLayoutGeometry();
  const layout = geometry.metrics;
  // The native header overlays a stable WebView frame; safe areas reserve its controls.
  const insets = safeContentInsets(layout, safeArea);
  // The mode the page opens in is the one last chosen; after that the page reports its own.
  const [initialMode] = useState(loadScreenMode);
  const [mode, setMode] = useState<ScreenMode>(initialMode);
  // The user's own shortcuts: the page shows and edits them, and they are kept here.
  const [shortcuts, setShortcuts] = useState(loadScreenShortcuts);
  // How wide the video may be. The page changes it itself (it loads again with the new one); it is kept here
  // for the next time, when the page is at another address and has forgotten.
  const [width, setWidth] = useState(loadScreenWidth);
  const [playback, updatePlayback] = useReducer(screenPlayback, nativeScreenAvailable, initialScreenPlayback);
  const relayOnly = playback.mode === "relay";
  const previousLink = useRef(link);
  useEffect(() => {
    if (previousLink.current === link) return;
    previousLink.current = link;
    setDisplay(null);
    updatePlayback({ type: "restart", nativeAvailable: nativeScreenAvailable });
  }, [link]);
  const [fullscreen, setFullscreen] = useState(false);
  const window = useWindowDimensions();
  const [turned, setLandscape] = useState(false);
  const landscape = resizableIOS ? window.width > window.height : turned;
  // Landscape has no room for a header, so it is always the full screen; leaving the full screen stands the phone up again.
  const present = useCallback((full: boolean, turned: boolean) => {
    const land = canRotate && turned;
    web.current?.injectJavaScript(`window.linkshellPresent && window.linkshellPresent(${full || land}); true;`);
    setFullscreen(full || land);
    setLandscape(land);
  }, []);

  const turnedOnce = useRef(false);
  useEffect(() => {
    if (!canRotate || (!landscape && !turnedOnce.current)) return;
    turnedOnce.current = true;
    void ScreenOrientation.lockAsync(landscape ? LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, [landscape]);
  // Restore the app's adaptive orientation when leaving the viewer.
  useEffect(
    () => () => {
      if (turnedOnce.current) void ScreenOrientation.unlockAsync().catch(() => {});
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
  const keyboardUp = useRef(keyboardOpen);
  keyboardUp.current = keyboardOpen;
  const keyboardRetry = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(keyboardRetry.current), []);
  // What the page is told about the display it has: under the header only the sides and the bottom are the phone's edges.
  const chrome = useMemo(
    () =>
      JSON.stringify({
        fullscreen,
        landscape,
        canRotate,
        fontScale: window.fontScale,
        // This app lets the page play video in place: the page may take the picture as a video track.
        video: !relayOnly,
        relayFallback: Platform.OS === "ios" && !relayOnly,
        // Lying down that way, the right is the side without the camera.
        clear: landscape && Platform.OS === "ios" && !resizableIOS ? "right" : null,
        // Whether the keyboard is on the screen: the system tells the app, and a page only its field's focus,
        // which a phone leaves standing when it takes the keyboard away.
        keyboard: keyboardOpen,
        shortcuts,
        divisions: layout?.divisions ?? [],
        // The keyboard covers the bottom edge while it is up.
        insets: { top: fullscreen ? insets.top : Math.max(insets.top, headerHeight), right: insets.right, bottom: keyboardOpen ? 0 : insets.bottom, left: insets.left },
      }),
    [fullscreen, landscape, window.fontScale, headerHeight, keyboardOpen, shortcuts, layout?.divisions, insets.top, insets.right, insets.bottom, insets.left, relayOnly],
  );
  const tellPage = useCallback((state: string) => web.current?.injectJavaScript(`window.linkshellChrome && window.linkshellChrome(${state}); true;`), []);
  useEffect(() => tellPage(chrome), [chrome, tellPage]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: { type?: string; on?: boolean; mode?: string; kind?: string; list?: unknown; width?: unknown };
      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      // Full screen is lying down: a computer's screen is wide. The rotate button still stands it up again.
      if (message.type === "screenFallback" && Platform.OS === "ios") {
        updatePlayback({ type: "unavailable", mode: "standard", generation: playback.generation });
      } else if (message.type === "fullscreen") present(message.on === true, message.on === true);
      else if (message.type === "landscape") present(fullscreen, message.on === true);
      else if (message.type === "haptic") (message.kind === "medium" ? haptics.medium : haptics.light)();
      else if (message.type === "keyboard") {
        // The page is asking for the keyboard, and the system gives one only to the view the keys go to. That
        // is not always the web view: something of the app's may have taken them, or the system let go of them
        // while the app was put aside. Should no keyboard have come up after that, the page asks once more.
        web.current?.requestFocus();
        clearTimeout(keyboardRetry.current);
        keyboardRetry.current = setTimeout(() => {
          if (!keyboardUp.current) web.current?.injectJavaScript("window.linkshellKeyboard && window.linkshellKeyboard(); true;");
        }, 900);
      } else if (message.type === "shortcuts") {
        const kept = screenShortcuts(message.list);
        saveScreenShortcuts(kept);
        setShortcuts(kept);
      } else if (message.type === "clipboard") {
        // Into the page's text box, for the user to look over and send: nothing goes to the computer from here.
        void Clipboard.getStringAsync()
          .catch(() => "")
          .then((text) => web.current?.injectJavaScript(`window.linkshellClipboard && window.linkshellClipboard(${JSON.stringify(text.slice(0, 20_000))}); true;`));
      } else if (message.type === "width") {
        if (isScreenWidth(message.width)) saveScreenWidth(message.width);
      } else if (message.type === "ready" || message.type === "mode") {
        if (message.mode === "view" || message.mode === "trackpad" || message.mode === "touch") {
          setMode(message.mode);
          if (message.type === "mode") saveScreenMode(message.mode);
        }
        // A page that has just loaded (again) learns where it stands.
        if (message.type === "ready") {
          tellPage(chrome);
          // Android gives a web view the focus on a tap the page lets through, and this page takes every touch
          // for the computer: without the focus its keyboard button raises no keyboard.
          if (Platform.OS === "android") web.current?.requestFocus();
        }
      }
    },
    [present, fullscreen, tellPage, chrome, playback.generation],
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
  const streamVia = relayOnly ? "relay" : via;

  useEffect(() => {
    if (!streamVia) return;
    let started: Forward | undefined;
    let cancelled = false;
    setFailure(null);
    setViewer(null);
    link
      .call("screen.start", {}, 20_000)
      .then(async ({ port, token, displays }) => {
        const forward = await forwardPort(streams, port, { direct: !relayOnly });
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
  }, [link, streams, attempt, streamVia, relayOnly]);

  const current = viewer?.displays.find((entry) => entry.index === display);
  // Through a gateway the picture is lighter: it is someone's relay, not a wire between the two devices.
  const quality = streamVia === "relay" && computer.kind !== "direct" ? "&q=low" : "";
  // video=1: this app plays video in place. Said here as well as in `chrome`, which on Android can reach the page after its script has run.
  const fallback = Platform.OS === "ios" && !relayOnly ? "&fallback=relay" : "";
  const uri = viewer && display !== null ? `${viewer.forward.url}?token=${encodeURIComponent(viewer.token)}&display=${display}${quality}&mode=${initialMode}&video=${relayOnly ? 0 : 1}&width=${width}${fallback}` : null;

  return (
    <Animated.View onLayout={geometry.onLayout} style={[{ flex: 1, backgroundColor: "#000000" }, lift]}>
      <LayoutProbe onMetrics={geometry.onMetrics} revision={geometry.revision} />
      {!nativeStatusBar ? <StatusBar style="light" hidden={fullscreen} animated /> : null}
      <Stack.Screen
        options={{
          title: "电脑屏幕",
          ...(nativeStatusBar ? { statusBarHidden: fullscreen, statusBarStyle: "light", statusBarAnimation: "fade" } as const : {}),
          headerTitle: Platform.OS === "ios" ? undefined : () => (
            <View style={{ alignItems: Platform.OS === "ios" ? "center" : "flex-start", maxWidth: Math.max(120, Math.min(360, window.width - insets.left - insets.right - 144)) }}>
              <Text style={[type.headline, { color: "#ffffff" }]}>电脑屏幕</Text>
              {viewer ? (
                <Text numberOfLines={1} style={[type.caption, { color: "rgba(255,255,255,0.6)" }]}>
                  {[current && viewer.displays.length > 1 ? current.name : null, streamVia === "direct" || computer.kind === "direct" ? "直连" : "经网关中转"].filter(Boolean).join(" · ")}
                </Text>
              ) : null}
            </View>
          ),
          headerTintColor: "#ffffff",
          headerStyle: { backgroundColor: "#000000" },
          headerShadowVisible: false,
          // Keep the live surface in one coordinate space while the system controls come and go.
          headerTransparent: true,
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
            ...((viewer?.displays.length ?? 0) > 1 ? [{
              kind: "menu" as const,
              key: "display",
              icon: { sf: "rectangle.on.rectangle" as const, md: "screenshot_monitor" as const },
              label: "切换屏幕",
              items: viewer!.displays.map((entry) => ({
                title: entry.index === display ? `${entry.name} ✓` : entry.name,
                icon: { sf: "display" as const, md: "desktop_windows" as const },
                onPress: () => setDisplay(entry.index),
              })),
            }] : []),
          ]}
        />
      ) : null}
      {failure ? (
        <ScrollView style={{ flex: 1 }} contentInsetAdjustmentBehavior="never" contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center", paddingTop: Math.max(insets.top, fullscreen ? 0 : headerHeight) + 24, paddingBottom: insets.bottom + 24, paddingLeft: insets.left + 24, paddingRight: insets.right + 24, gap: 12 }}>
          <Icon sf="display" md="desktop_access_disabled" size={36} color="rgba(255,255,255,0.45)" />
          <Text style={[type.subhead, { color: "rgba(255,255,255,0.75)", textAlign: "center" }]}>{failure}</Text>
          <Button title="重试" variant="tonal" size="small" onPress={() => { updatePlayback({ type: "restart", nativeAvailable: nativeScreenAvailable }); setAttempt((value) => value + 1); }} />
        </ScrollView>
      ) : uri && playback.mode === "native" ? (
        <NativeScreenPane key={uri} url={uri} mode={mode} onMode={(next) => { setMode(next); saveScreenMode(next); }}
          width={width} onWidth={(next) => { setWidth(next); saveScreenWidth(next); }} shortcuts={shortcuts}
          fullscreen={fullscreen} onFullscreen={() => present(!fullscreen, !fullscreen)} canRotate={canRotate} onRotate={() => present(fullscreen, !landscape)}
          onUnavailable={() => updatePlayback({ type: "unavailable", mode: "native", generation: playback.generation })} top={Math.max(insets.top, fullscreen ? 0 : headerHeight)} bottom={insets.bottom} left={insets.left} right={insets.right} />
      ) : uri ? (
        <WebView
          key={uri}
          ref={web}
          source={{ uri }}
          originWhitelist={["http://127.0.0.1*"]}
          onMessage={onMessage}
          onError={({ nativeEvent }) => {
            if (Platform.OS === "ios" && !relayOnly) updatePlayback({ type: "unavailable", mode: "standard", generation: playback.generation });
            else setFailure(nativeEvent.description || "屏幕页面加载失败，请重试");
          }}
          onContentProcessDidTerminate={() => {
            if (!relayOnly) updatePlayback({ type: "unavailable", mode: "standard", generation: playback.generation });
            else setFailure("屏幕显示已中断，请重新连接");
          }}
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
          // The picture is a video the page plays where it is, at once, without being asked to.
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          style={{ flex: 1, backgroundColor: "#000000" }}
          containerStyle={{ backgroundColor: "#000000" }}
        />
      ) : (
        <ActivityIndicator style={{ marginTop: 64 }} color="rgba(255,255,255,0.6)" />
      )}
    </Animated.View>
  );
}
