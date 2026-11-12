import { nativeStatusBar } from "@/lib/native-status-bar";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Alert, BackHandler, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { usePageInsets } from "@/components/adaptive-page";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import { Button } from "@/components/button";
import { Glass } from "@/components/glass";
import { HeaderActions } from "@/components/header-actions";
import { Icon, type IconProps } from "@/components/icon";
import { useActions, useClient, useConnection } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { openLink } from "@/lib/links";
import { useLocale } from "@/lib/locale";
import { forwardPort, type Forward } from "@/lib/preview";
import { revealPreviewFocus } from "@/lib/preview-focus";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";

const DESKTOP_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const RUNTIME_ERROR_BRIDGE_JS = `(function(){
  if (window.__linkshellErrorBridgeInstalled) return;
  window.__linkshellErrorBridgeInstalled = true;
  var sent = 0;
  function report(msg) {
    if (!msg || sent >= 15) return;
    sent++;
    try {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
        type: "linkshell_preview_error",
        message: String(msg).slice(0, 600)
      }));
    } catch (_) {}
  }
  window.addEventListener("error", function(ev) {
    var loc = ev && ev.filename ? " (" + ev.filename + ":" + (ev.lineno || 0) + ")" : "";
    report((ev && (ev.message || (ev.error && ev.error.stack))) ? (ev.message + loc) : "Uncaught error");
  });
  window.addEventListener("unhandledrejection", function(ev) {
    var r = ev && ev.reason;
    report("Unhandled rejection: " + (r && (r.stack || r.message) ? (r.stack || r.message) : String(r)));
  });
  var origError = console.error;
  console.error = function() {
    try {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(a && (a.stack || a.message) ? (a.stack || a.message) : typeof a === "object" ? JSON.stringify(a) : String(a));
      }
      report(parts.join(" "));
    } catch (_) {}
    if (origError) return origError.apply(console, arguments);
  };
})(); true;`;

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
  const params = useLocalSearchParams<{ port: string; title?: string; sessionId?: string }>();
  return <PreviewContent key={params.port} port={Number(params.port)} initialTitle={params.title} sessionId={params.sessionId} />;
}

export function PreviewContent({
  port,
  initialTitle,
  sessionId,
  embedded = false,
}: {
  port: number;
  initialTitle?: string;
  sessionId?: string;
  embedded?: boolean;
}) {
  const { streams } = useConnection();
  const actions = useActions();
  const sessions = useClient((state) => state.sessions);
  const { t, pick } = useLocale();
  const insets = usePageInsets();
  const web = useRef<WebView>(null);
  const keyboardOpen = useKeyboardState((state) => state.isVisible);
  const focusRevealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revealEditor = useCallback(() => {
    if (Platform.OS !== "ios" || !keyboardOpen) return;
    clearTimeout(focusRevealTimer.current);
    focusRevealTimer.current = setTimeout(() => web.current?.injectJavaScript(revealPreviewFocus), 80);
  }, [keyboardOpen]);
  useEffect(() => () => clearTimeout(focusRevealTimer.current), [keyboardOpen]);
  const [forward, setForward] = useState<Forward | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [nav, setNav] = useState<Pick<WebViewNavigation, "title" | "url" | "canGoBack" | "canGoForward"> | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [runtimeErrors, setRuntimeErrors] = useState<string[]>([]);
  const [sendingErrors, setSendingErrors] = useState(false);

  const targetSessionId = useMemo(() => {
    if (sessionId && sessions[sessionId]) return sessionId;
    const candidates = Object.values(sessions)
      .filter((s) => !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return candidates[0]?.id;
  }, [sessionId, sessions]);

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
    setRuntimeErrors([]);
    if (forward) setGeneration((value) => value + 1);
    else setConnectionAttempt((value) => value + 1);
  };

  const onWebViewMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const parsed = JSON.parse(event.nativeEvent.data) as { type?: string; message?: string };
      if (parsed?.type === "linkshell_preview_error" && typeof parsed.message === "string") {
        const clean = parsed.message.trim();
        if (!clean) return;
        setRuntimeErrors((prev) => (prev.includes(clean) || prev.length >= 15 ? prev : [...prev, clean]));
      }
    } catch {
      // Ignore unrelated postMessage traffic from previewed web apps.
    }
  }, []);

  const sendErrorsToAgent = async () => {
    if (!targetSessionId || runtimeErrors.length === 0 || sendingErrors) return;
    setSendingErrors(true);
    try {
      const prompt = `${t("ports.sendErrorsPromptPrefix")} (localhost:${port})\n\n\`\`\`\n${runtimeErrors.join("\n\n")}\n\`\`\``;
      const res = await actions.send(targetSessionId, [{ type: "text", text: prompt }]);
      if (res === "failed") {
        throw new Error(pick({ zh: "发送失败，请重试", en: "Failed to send errors to session", ja: "エラーの送信に失敗しました" }));
      }
      haptics.success();
      setRuntimeErrors([]);
      if (!embedded) {
        router.push({ pathname: "/session/[id]", params: { id: targetSessionId } });
      }
    } catch (reason) {
      haptics.error();
      Alert.alert(
        pick({ zh: "发送失败", en: "Send failed", ja: "送信失敗" }),
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setSendingErrors(false);
    }
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
            label: pick({ zh: "更多", en: "More", ja: "その他" }),
            items: [
              {
                title: t("common.refresh"),
                icon: { sf: "arrow.clockwise", md: "refresh" },
                onPress: () => {
                  setRuntimeErrors([]);
                  web.current?.reload();
                },
              },
              {
                title: desktop
                  ? pick({ zh: "手机版网页", en: "Mobile Site", ja: "モバイル表示" })
                  : pick({ zh: "电脑版网页", en: "Desktop Site", ja: "PC表示" }),
                icon: desktop ? { sf: "iphone", md: "smartphone" } : { sf: "desktopcomputer", md: "desktop_windows" },
                onPress: () => {
                  setDesktop((value) => !value);
                  setGeneration((value) => value + 1);
                },
              },
              { title: t("nav.ports"), icon: { sf: "network", md: "lan" }, onPress: () => router.push("/ports") },
            ],
          },
        ]}
      />
      )}
      </>}

      {!embedded && Platform.OS === "ios" && !fullscreen && !keyboardOpen ? <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel, paddingHorizontal: 16, paddingBottom: 8 }]}>{shown(nav?.url)}</Text> : null}
      <KeyboardAvoidingView behavior="padding" automaticOffset={Platform.OS === "ios"} enabled={Platform.OS === "ios"} style={{ flex: 1 }}>
        {forward && !failure ? (
          <WebView
            key={`${generation}-${desktop}`}
            ref={web}
            source={{ uri: forward.url }}
            userAgent={desktop ? DESKTOP_AGENT : undefined}
            injectedJavaScriptBeforeContentLoaded={RUNTIME_ERROR_BRIDGE_JS}
            onMessage={onWebViewMessage}
            onLayout={revealEditor}
            onLoadProgress={({ nativeEvent }) => setProgress(nativeEvent.progress)}
            onNavigationStateChange={(state) => setNav(state)}
            onError={({ nativeEvent }) => setFailure(nativeEvent.description || pick({ zh: "页面加载失败", en: "Failed to load page", ja: "ページの読み込みに失敗しました" }))}
            onShouldStartLoadWithRequest={(request) => {
              if (local(request.url) || /^(about|data|blob|javascript):/.test(request.url)) return true;
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
            <Text style={[type.headline, { color: colors.label }]}>
              {pick({ zh: `打不开 localhost:${port}`, en: `Cannot reach localhost:${port}`, ja: `localhost:${port} に接続できません` })}
            </Text>
            <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center" }]}>
              {pick({
                zh: "电脑上这个端口可能没有在运行服务，启动后再试。",
                en: "No HTTP service appears to be listening on this port on your computer.",
                ja: "PC 上でこのポートが起動していない可能性があります。起動後に再試行してください。",
              })}
            </Text>
            <Button title={t("common.retry")} variant="tonal" size="small" onPress={retry} />
          </ScrollView>
        ) : (
          <ActivityIndicator style={{ marginTop: 48 }} color={colors.secondaryLabel} />
        )}
        {progress > 0 && progress < 1 && !failure ? (
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2 }}>
            <View style={{ width: `${progress * 100}%`, height: 2, backgroundColor: colors.accent }} />
          </View>
        ) : null}

        {/* Runtime JS error bridge banner */}
        {runtimeErrors.length > 0 && targetSessionId && !fullscreen ? (
          <View
            style={{
              marginHorizontal: 12,
              marginBottom: 8,
              paddingHorizontal: 12,
              paddingVertical: 9,
              borderRadius: radius.card,
              borderCurve: "continuous",
              backgroundColor: colors.dangerSoft,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
              <Icon sf="exclamationmark.triangle.fill" md="error" size={15} color={colors.danger} />
              <Text numberOfLines={1} style={[type.footnote, { color: colors.danger, fontWeight: "600", flexShrink: 1 }]}>
                {t("ports.errorsCount", { count: runtimeErrors.length })}
              </Text>
            </View>
            <Pressable
              onPress={() => void sendErrorsToAgent()}
              disabled={sendingErrors}
              accessibilityRole="button"
              style={({ pressed }) => ({
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 999,
                backgroundColor: colors.danger,
                opacity: pressed || sendingErrors ? 0.75 : 1,
              })}
            >
              <Text style={[type.caption, { color: "#ffffff", fontWeight: "600" }]}>
                {t("ports.sendErrorsToAgent", { count: runtimeErrors.length })}
              </Text>
            </Pressable>
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
          accessibilityLabel={pick({ zh: "退出全屏", en: "Exit Fullscreen", ja: "全画面を終了" })}
          hitSlop={10}
          style={{ position: "absolute", right: Math.max(insets.right, 0) + 14, bottom: Math.max(insets.bottom, 12) + 6, opacity: 0.9 }}
        >
          <Glass interactive style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" }}>
            <Icon sf="arrow.down.right.and.arrow.up.left" md="fullscreen_exit" size={16} color={colors.label} weight="semibold" />
          </Glass>
        </Pressable>
      ) : Platform.OS === "ios" && !embedded ? (
        <Stack.Toolbar placement="bottom">
          <Stack.Toolbar.Button icon="chevron.left" accessibilityLabel={pick({ zh: "后退", en: "Back", ja: "戻る" })} disabled={!nav?.canGoBack} onPress={() => web.current?.goBack()}>
            {pick({ zh: "后退", en: "Back", ja: "戻る" })}
          </Stack.Toolbar.Button>
          <Stack.Toolbar.Button icon="chevron.right" accessibilityLabel={pick({ zh: "前进", en: "Forward", ja: "進む" })} disabled={!nav?.canGoForward} onPress={() => web.current?.goForward()}>
            {pick({ zh: "前进", en: "Forward", ja: "進む" })}
          </Stack.Toolbar.Button>
          <Stack.Toolbar.Button
            icon={progress > 0 && progress < 1 ? "xmark" : "arrow.clockwise"}
            accessibilityLabel={progress > 0 && progress < 1 ? t("session.stop") : t("common.refresh")}
            onPress={() => (progress > 0 && progress < 1 ? web.current?.stopLoading() : failure ? retry() : web.current?.reload())}
          >{progress > 0 && progress < 1 ? t("session.stop") : t("common.refresh")}</Stack.Toolbar.Button>
          <Stack.Toolbar.Spacer />
          <Stack.Toolbar.Button icon="arrow.up.left.and.arrow.down.right" accessibilityLabel={t("screen.fullscreen")} onPress={() => setFullscreen(true)}>
            {t("screen.fullscreen")}
          </Stack.Toolbar.Button>
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
        <ToolbarButton icon={{ sf: "chevron.left", md: "arrow_back_ios_new" }} label={pick({ zh: "后退", en: "Back", ja: "戻る" })} disabled={!nav?.canGoBack} onPress={() => web.current?.goBack()} />
        <ToolbarButton icon={{ sf: "chevron.right", md: "arrow_forward_ios" }} label={pick({ zh: "前进", en: "Forward", ja: "進む" })} disabled={!nav?.canGoForward} onPress={() => web.current?.goForward()} />
        <ToolbarButton
          icon={progress > 0 && progress < 1 ? { sf: "xmark", md: "close" } : { sf: "arrow.clockwise", md: "refresh" }}
          label={progress > 0 && progress < 1 ? t("session.stop") : t("common.refresh")}
          onPress={() => (progress > 0 && progress < 1 ? web.current?.stopLoading() : failure ? retry() : web.current?.reload())}
        />
        {embedded ? null : <ToolbarButton icon={{ sf: "arrow.up.left.and.arrow.down.right", md: "fullscreen" }} label={t("screen.fullscreen")} onPress={() => setFullscreen(true)} />}
      </View>
      )}
    </View>
  );
}
