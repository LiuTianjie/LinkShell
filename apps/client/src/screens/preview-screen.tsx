import { nativeStatusBar } from "@/lib/native-status-bar";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, BackHandler, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { usePageInsets } from "@/components/adaptive-page";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { WebView, type WebViewNavigation } from "react-native-webview";
import { Button } from "@/components/button";
import { Glass } from "@/components/glass";
import { HeaderActions } from "@/components/header-actions";
import { Icon, type IconProps } from "@/components/icon";
import { useConnection } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { openLink } from "@/lib/links";
import { forwardPort, type Forward } from "@/lib/preview";
import { revealPreviewFocus } from "@/lib/preview-focus";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

const DESKTOP_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

function ToolbarButton({ icon, label, disabled, onPress }: { icon: Pick<IconProps, "sf" | "md">; label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      android_ripple={{ color: colors.fill as string, borderless: true, radius: 22 }}
      style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.3 : 1 }}
    >
      <Icon {...icon} size={20} color={colors.accent} weight="medium" />
    </Pressable>
  );
}

/**
 * A page served on the computer (a dev server's `localhost:<port>`), opened
 * through the encrypted channel as if it ran on the phone.
 */
export function PreviewScreen() {
  const params = useLocalSearchParams<{ port: string; title?: string }>();
  return <PreviewContent key={params.port} port={Number(params.port)} initialTitle={params.title} />;
}

export function PreviewContent({ port, initialTitle, embedded = false }: { port: number; initialTitle?: string; embedded?: boolean }) {
  const { streams } = useConnection();
  const insets = usePageInsets();
  const web = useRef<WebView>(null);
  const keyboardOpen = useKeyboardState((state) => state.isVisible);
  const focusRevealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revealEditor = useCallback(() => {
    if (Platform.OS !== "ios" || !keyboardOpen) return;
    clearTimeout(focusRevealTimer.current);
    // Wait for the last keyboard/rotation frame, then let the page finish its own layout.
    focusRevealTimer.current = setTimeout(() => web.current?.injectJavaScript(revealPreviewFocus), 80);
  }, [keyboardOpen]);
  useEffect(() => () => clearTimeout(focusRevealTimer.current), [keyboardOpen]);
  const [forward, setForward] = useState<Forward | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [nav, setNav] = useState<Pick<WebViewNavigation, "title" | "url" | "canGoBack" | "canGoForward"> | null>(null);
  const [desktop, setDesktop] = useState(false);
  // The page alone: no header, toolbar or status bar.
  const [fullscreen, setFullscreen] = useState(false);
  // Remounts the WebView (a retry, or a new user agent).
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let active: Forward | undefined;
    let cancelled = false;
    forwardPort(streams, port)
      .then((started) => {
        if (cancelled) started.stop();
        else {
          active = started;
          setForward(started);
        }
      })
      .catch((reason: unknown) => !cancelled && setFailure(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      cancelled = true;
      active?.stop();
    };
  }, [streams, port, connectionAttempt]);

  // Shown as the computer's address, not the phone's loopback.
  const shown = (url: string | undefined) => {
    if (!url || !forward) return `localhost:${port}`;
    const path = url.replace(/^https?:\/\/(127\.0\.0\.1|localhost):\d+/, "");
    return `localhost:${port}${path === "/" ? "" : path}`;
  };
  const title = nav?.title && !/^https?:\/\//.test(nav.title) && !nav.title.startsWith("127.0.0.1") ? nav.title : (initialTitle ?? `localhost:${port}`);
  const local = (url: string) => {
    if (!forward) return false;
    const origin = /^https?:\/\/([^/:]+):(\d+)/.exec(url);
    return !!origin && (origin[1] === "127.0.0.1" || origin[1] === "localhost") && Number(origin[2]) === forward.localPort;
  };

  useEffect(() => {
    if (!fullscreen) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setFullscreen(false);
      return true;
    });
    return () => sub.remove();
  }, [fullscreen]);

  const retry = () => {
    setFailure(null);
    setProgress(0);
    if (forward) setGeneration((value) => value + 1);
    else setConnectionAttempt((value) => value + 1);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.plain, paddingTop: fullscreen ? insets.top : 0 }}>
      {embedded ? keyboardOpen ? null : <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel, paddingHorizontal: 16, paddingBottom: 10 }]}>{shown(nav?.url)}</Text> : <>
      {!nativeStatusBar ? <StatusBar hidden={fullscreen} animated /> : null}
      <Stack.Screen
        options={{
          headerShown: !fullscreen,
          ...(nativeStatusBar ? { statusBarHidden: fullscreen, statusBarStyle: "auto", statusBarAnimation: "fade" } as const : {}),
          title,
          headerTitle: Platform.OS === "ios" ? undefined : () => (
            <View style={{ alignItems: Platform.OS === "ios" ? "center" : "flex-start", maxWidth: 240 }}>
              <Text numberOfLines={1} style={[type.headline, { color: colors.label }]}>
                {title}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Icon sf="lock.fill" md="lock" size={9} color={colors.tertiaryLabel} />
                <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel }]}>
                  {shown(nav?.url)}
                </Text>
              </View>
            </View>
          ),
          headerShadowVisible: false,
          headerTransparent: false,
          headerStyle: { backgroundColor: colors.plain as string },
        }}
      />
      {fullscreen ? null : (
      <HeaderActions
        actions={[
          {
            kind: "menu",
            key: "more",
            icon: { sf: "ellipsis", md: "more_vert" },
            label: "更多",
            items: [
              { title: "刷新", icon: { sf: "arrow.clockwise", md: "refresh" }, onPress: () => web.current?.reload() },
              {
                title: desktop ? "手机版网页" : "电脑版网页",
                icon: desktop ? { sf: "iphone", md: "smartphone" } : { sf: "desktopcomputer", md: "desktop_windows" },
                onPress: () => {
                  setDesktop((value) => !value);
                  setGeneration((value) => value + 1);
                },
              },
              { title: "其他端口", icon: { sf: "network", md: "lan" }, onPress: () => router.push("/ports") },
            ],
          },
        ]}
      />
      )}
      </>}

      {!embedded && Platform.OS === "ios" && !fullscreen && !keyboardOpen ? <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel, paddingHorizontal: 16, paddingBottom: 8 }]}>{shown(nav?.url)}</Text> : null}
      {/* Padding remeasures on rotation with the keyboard open; the native header stays outside this frame. */}
      <KeyboardAvoidingView behavior="padding" automaticOffset={Platform.OS === "ios"} enabled={Platform.OS === "ios"} style={{ flex: 1 }}>
        {forward && !failure ? (
          <WebView
            key={`${generation}-${desktop}`}
            ref={web}
            source={{ uri: forward.url }}
            userAgent={desktop ? DESKTOP_AGENT : undefined}
            onLayout={revealEditor}
            onLoadProgress={({ nativeEvent }) => setProgress(nativeEvent.progress)}
            onNavigationStateChange={(state) => setNav(state)}
            onError={({ nativeEvent }) => setFailure(nativeEvent.description || "页面加载失败")}
            onShouldStartLoadWithRequest={(request) => {
              if (local(request.url) || /^(about|data|blob|javascript):/.test(request.url)) return true;
              // A link off the dev server: open it in the in-app browser.
              if (/^https?:/.test(request.url) && request.isTopFrame !== false) {
                void openLink(request.url);
                return false;
              }
              return true;
            }}
            allowsBackForwardNavigationGestures
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            pullToRefreshEnabled
            setSupportMultipleWindows={false}
            domStorageEnabled
            textZoom={100}
            contentInsetAdjustmentBehavior={Platform.OS === "ios" && !embedded && !fullscreen ? "automatic" : "never"}
            style={{ flex: 1, backgroundColor: colors.plain }}
          />
        ) : failure ? (
          <ScrollView style={{ flex: 1 }} contentInsetAdjustmentBehavior="never" contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 }}>
            <Icon sf="network.slash" md="cloud_off" size={36} color={colors.tertiaryLabel} />
            <Text style={[type.headline, { color: colors.label }]}>打不开 localhost:{port}</Text>
            <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center" }]}>电脑上这个端口可能没有在运行服务，启动后再试。</Text>
            <Button title="重试" variant="tonal" size="small" onPress={retry} />
          </ScrollView>
        ) : (
          <ActivityIndicator style={{ marginTop: 48 }} color={colors.secondaryLabel} />
        )}
        {progress > 0 && progress < 1 && !failure ? (
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2 }}>
            <View style={{ width: `${progress * 100}%`, height: 2, backgroundColor: colors.accent }} />
          </View>
        ) : null}
      </KeyboardAvoidingView>

      {keyboardOpen ? null : fullscreen ? (
        <Pressable
          onPress={() => {
            haptics.selection();
            setFullscreen(false);
          }}
          accessibilityRole="button"
          accessibilityLabel="退出全屏"
          hitSlop={10}
          style={{ position: "absolute", right: Math.max(insets.right, 0) + 14, bottom: Math.max(insets.bottom, 12) + 6, opacity: 0.9 }}
        >
          <Glass interactive style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" }}>
            <Icon sf="arrow.down.right.and.arrow.up.left" md="fullscreen_exit" size={16} color={colors.label} weight="semibold" />
          </Glass>
        </Pressable>
      ) : Platform.OS === "ios" && !embedded ? (
        <Stack.Toolbar placement="bottom">
          <Stack.Toolbar.Button icon="chevron.left" accessibilityLabel="后退" disabled={!nav?.canGoBack} onPress={() => web.current?.goBack()}>后退</Stack.Toolbar.Button>
          <Stack.Toolbar.Button icon="chevron.right" accessibilityLabel="前进" disabled={!nav?.canGoForward} onPress={() => web.current?.goForward()}>前进</Stack.Toolbar.Button>
          <Stack.Toolbar.Button
            icon={progress > 0 && progress < 1 ? "xmark" : "arrow.clockwise"}
            accessibilityLabel={progress > 0 && progress < 1 ? "停止" : "刷新"}
            onPress={() => (progress > 0 && progress < 1 ? web.current?.stopLoading() : failure ? retry() : web.current?.reload())}
          >{progress > 0 && progress < 1 ? "停止" : "刷新"}</Stack.Toolbar.Button>
          <Stack.Toolbar.Spacer />
          <Stack.Toolbar.Button icon="arrow.up.left.and.arrow.down.right" accessibilityLabel="全屏" onPress={() => setFullscreen(true)}>全屏</Stack.Toolbar.Button>
        </Stack.Toolbar>
      ) : (
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-around",
          alignItems: "center",
          paddingTop: 4,
          paddingBottom: embedded ? 8 : Math.max(insets.bottom, 8),
          backgroundColor: colors.plain,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.separator,
        }}
      >
        <ToolbarButton icon={{ sf: "chevron.left", md: "arrow_back_ios_new" }} label="后退" disabled={!nav?.canGoBack} onPress={() => web.current?.goBack()} />
        <ToolbarButton icon={{ sf: "chevron.right", md: "arrow_forward_ios" }} label="前进" disabled={!nav?.canGoForward} onPress={() => web.current?.goForward()} />
        <ToolbarButton
          icon={progress > 0 && progress < 1 ? { sf: "xmark", md: "close" } : { sf: "arrow.clockwise", md: "refresh" }}
          label={progress > 0 && progress < 1 ? "停止" : "刷新"}
          onPress={() => (progress > 0 && progress < 1 ? web.current?.stopLoading() : failure ? retry() : web.current?.reload())}
        />
        {embedded ? null : <ToolbarButton icon={{ sf: "arrow.up.left.and.arrow.down.right", md: "fullscreen" }} label="全屏" onPress={() => setFullscreen(true)} />}
      </View>
      )}
    </View>
  );
}
