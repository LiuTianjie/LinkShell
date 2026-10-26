import { nativeStatusBar } from "@/lib/native-status-bar";
import * as Clipboard from "expo-clipboard";
import { useKeepAwake } from "expo-keep-awake";
import { Stack, useIsFocused, useNavigation, type NativeStackNavigationProp } from "expo-router";
import { useHeaderHeight, type ParamListBase } from "expo-router/react-navigation";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Platform, ScrollView, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { useKeyboardState, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { clearOrientationRequest, LayoutProbe, requestLandscape } from "../../modules/link-layout";
import { useLayoutGeometry } from "@/lib/use-layout-geometry";
import { safeContentInsets } from "@/lib/adaptive-insets";
import { Button } from "@/components/button";
import { HeaderActions } from "@/components/header-actions";
import { ScreenConnectionLoading } from "@/components/screen-connection-loading";
import { Icon } from "@/components/icon";
import { useConnection } from "@/lib/client";
import { useScreenSession, type ScreenPageMessage, type ScreenPresentation, type ScreenViewport } from "@/lib/screen-session";
import { haptics } from "@/lib/haptics";
import { loadScreenShortcuts, saveScreenShortcuts, screenShortcuts } from "@/lib/settings";
import { type } from "@/theme/type";

/**
 * The computer's screen, live: the host's viewer page and H.264 stream,
 * opened through the encrypted forwarder like a port preview. The page has
 * the gestures and the toolbar (they come with the host); this screen gives it
 * what a page can't take: the whole display, its orientation, room above the
 * keyboard and word of whether it is up, the phone's clipboard, and a place to
 * keep the user's own shortcuts.
 */
export function ScreenScreen() {
  const { computer } = useConnection();
  const { viewer, failure, preparing, generation, display, mode, playback, attach, detach, present: publishPresentation, inject, focus, selectDisplay, retry } = useScreenSession();
  const owner = useRef({}).current;
  const focusGeneration = useRef(0);
  const routeActive = useRef(false);
  const anchor = useRef<View>(null);
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const focused = useIsFocused();
  const [viewport, setViewport] = useState<ScreenViewport | null>(null);
  const headerHeight = useHeaderHeight();
  const safeArea = useSafeAreaInsets();
  const geometry = useLayoutGeometry();
  const layout = geometry.metrics;
  const insets = safeContentInsets(layout, safeArea);
  const [shortcuts, setShortcuts] = useState(loadScreenShortcuts);
  const relayOnly = playback === "relay";
  const measureAnchor = useCallback(() => {
    if (!routeActive.current) return;
    const generationAtMeasure = focusGeneration.current;
    anchor.current?.measureInWindow((x, y, width, height) => {
      if (!routeActive.current || focusGeneration.current !== generationAtMeasure) return;
      if (width <= 0 || height <= 0) return;
      setViewport((previous) => previous?.x === x && previous.y === y && previous.width === width && previous.height === height ? previous : { x, y, width, height });
    });
  }, []);
  const [fullscreen, setFullscreen] = useState(false);
  const clipInsets = useMemo(() => ({
    top: fullscreen ? 0 : Math.max(insets.top, headerHeight),
    left: fullscreen ? 0 : insets.left,
    right: fullscreen ? 0 : insets.right,
  }), [fullscreen, headerHeight, insets.top, insets.left, insets.right]);
  const window = useWindowDimensions();
  // Measure the picture's frame independently of the requested rotation (including folding and resizing).
  const landscape = window.width > window.height;
  const present = useCallback((full: boolean) => {
    inject(owner, `window.linkshellPresent && window.linkshellPresent(${full}); true;`);
    setFullscreen(full);
    if (full) void requestLandscape().catch((error: unknown) => console.warn("[screen] landscape request failed", error));
    else void clearOrientationRequest().catch(() => {});
  }, [inject, owner]);

  // A screen that failed has only the header to leave by.
  useEffect(() => {
    if (failure) present(false);
  }, [failure, present]);

  // Android's back leaves the full screen before it leaves the viewer.
  useEffect(() => {
    if (!focused || !fullscreen) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      present(false);
      return true;
    });
    return () => subscription.remove();
  }, [focused, fullscreen, present]);

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
        mode,
        // Hide the separate rotation control when connected to an older host.
        canRotate: false,
        canRetryScreen: true,
        fontScale: window.fontScale,
        // This app lets the page play video in place: the page may take the picture as a video track.
        video: !relayOnly,
        nativePicture: playback === "native",
        relayFallback: Platform.OS === "ios" && !relayOnly,
        clear: null,
        // Whether the keyboard is on the screen: the system tells the app, and a page only its field's focus,
        // which a phone leaves standing when it takes the keyboard away.
        keyboard: keyboardOpen,
        shortcuts,
        divisions: layout?.divisions ?? [],
        // The keyboard covers the bottom edge while it is up.
        insets: { top: fullscreen ? insets.top : Math.max(insets.top, headerHeight), right: insets.right, bottom: keyboardOpen ? 0 : insets.bottom, left: insets.left },
      }),
    [fullscreen, landscape, window.fontScale, headerHeight, keyboardOpen, shortcuts, layout?.divisions, insets.top, insets.right, insets.bottom, insets.left, relayOnly, playback, mode],
  );
  const onMessage = useCallback(
    (message: ScreenPageMessage, generation: number) => {
      if (message.type === "fullscreen") present(message.on === true);
      else if (message.type === "haptic") (message.kind === "medium" ? haptics.medium : haptics.light)();
      else if (message.type === "keyboard") {
        focus(owner);
        clearTimeout(keyboardRetry.current);
        keyboardRetry.current = setTimeout(() => {
          if (!keyboardUp.current) inject(owner, "window.linkshellKeyboard && window.linkshellKeyboard(); true;", generation);
        }, 900);
      } else if (message.type === "shortcuts") {
        const kept = screenShortcuts(message.list);
        saveScreenShortcuts(kept);
        setShortcuts(kept);
      } else if (message.type === "clipboard") {
        const focusAtRead = focusGeneration.current;
        void Clipboard.getStringAsync()
          .catch(() => "")
          .then((text) => {
            if (focusGeneration.current === focusAtRead) inject(owner, `window.linkshellClipboard && window.linkshellClipboard(${JSON.stringify(text.slice(0, 20_000))}); true;`, generation);
          });
      } else if (message.type === "ready" && Platform.OS === "android") focus(owner);
    },
    [present, focus, inject, owner],
  );

  // The page ends above the keyboard, frame by frame, so its key bar sits on the keys.
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({ paddingBottom: Math.max(-keyboardHeight.value, 0) }));
  const routePresentation = useRef<ScreenPresentation>(null!);
  routePresentation.current = { viewport, clipInsets, chrome, keyboardLift: lift, onMessage };
  useLayoutEffect(() => {
    if (!focused) return;
    const resume = () => {
      if (!navigation.isFocused()) return;
      if (!routeActive.current) {
        routeActive.current = true;
        attach(owner);
        publishPresentation(owner, routePresentation.current);
      }
      measureAnchor();
    };
    const leave = () => {
      if (!routeActive.current) return;
      routeActive.current = false;
      focusGeneration.current += 1;
      clearTimeout(keyboardRetry.current);
      detach(owner);
    };
    resume();
    // The retained receiver is outside the native stack and cannot follow its pop animation.
    // Hide it before a JS pop, or as a native swipe starts, instead of waiting for blur.
    const remove = navigation.addListener("beforeRemove", leave);
    const start = navigation.addListener("transitionStart", ({ data }) => { if (data.closing) leave(); });
    const end = navigation.addListener("transitionEnd", ({ data }) => { if (!data.closing) resume(); });
    const cancel = navigation.addListener("gestureCancel", resume);
    return () => {
      remove();
      start();
      end();
      cancel();
      leave();
      void clearOrientationRequest().catch(() => {});
    };
  }, [focused, navigation, attach, detach, owner, measureAnchor, publishPresentation]);
  useLayoutEffect(() => {
    if (!focused || !routeActive.current) return;
    measureAnchor();
    publishPresentation(owner, { viewport, clipInsets, chrome, keyboardLift: lift, onMessage });
  }, [focused, measureAnchor, publishPresentation, owner, viewport, clipInsets, chrome, lift, onMessage]);
  const current = viewer?.displays.find((entry) => entry.index === display);
  const streamVia = viewer?.via;

  return (
    <View ref={anchor} collapsable={false} onLayout={(event) => { geometry.onLayout(event); measureAnchor(); }} style={{ flex: 1, backgroundColor: "#000000" }}>
      {focused ? <ScreenKeepAwake /> : null}
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
                onPress: () => selectDisplay(entry.index),
              })),
            }] : []),
          ]}
        />
      ) : null}
      {failure ? (
        <ScrollView style={{ flex: 1 }} contentInsetAdjustmentBehavior="never" contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center", paddingTop: Math.max(insets.top, fullscreen ? 0 : headerHeight) + 24, paddingBottom: insets.bottom + 24, paddingLeft: insets.left + 24, paddingRight: insets.right + 24, gap: 12 }}>
          <Icon sf="display" md="desktop_access_disabled" size={36} color="rgba(255,255,255,0.45)" />
          <Text style={[type.subhead, { color: "rgba(255,255,255,0.75)", textAlign: "center" }]}>{failure}</Text>
          <Button title="重试" variant="tonal" size="small" onPress={retry} />
        </ScrollView>
      ) : !viewer ? (
        <ScreenConnectionLoading key={generation} preparing={preparing} onRetry={retry} top={Math.max(insets.top, fullscreen ? 0 : headerHeight)} bottom={insets.bottom} />
      ) : null}
    </View>
  );
}


function ScreenKeepAwake() {
  useKeepAwake("screen");
  return null;
}
