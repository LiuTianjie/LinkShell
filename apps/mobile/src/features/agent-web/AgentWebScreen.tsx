import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useTheme } from "../../theme";
import { getDeviceToken } from "../../storage/device-token";
import { loadSession, type AuthSession } from "../../lib/supabase";
import type { AgentWorkspaceHandle } from "../../hooks/useAgentWorkspace";

export interface AgentWebScreenProps {
  /** Route / deep-link entry: resolve the host session from a conversation record. */
  conversationId?: string;
  workspace?: AgentWorkspaceHandle;
  /** Tab entry: drive directly from a connected host session (no preselected conversation). */
  hostGatewayUrl?: string;
  hostSessionId?: string;
  isRestoring?: boolean;
  onBack: () => void;
}

type TokenState =
  | { status: "loading" }
  | { status: "ready"; token: string | null; session: AuthSession | null }
  | { status: "missing-session" };

interface WebError {
  message: string;
  /** unauthorized → token rejected, suggest re-pair. */
  unauthorized?: boolean;
}

/**
 * Hosts the same-origin web-dashboard agent console inside a full-screen
 * WebView. The native side is a thin shell: it resolves which session to show
 * from the conversation record, hands the SPA its connection params via the
 * URL query string (Channel A) and pre-seeded localStorage (Channel B), and
 * renders `<gatewayHttpUrl>/` — never a reimplementation of the agent UI.
 *
 * Contract: apps/mobile/src/features/agent-web/DESIGN.md (frozen).
 */
export function AgentWebScreen({
  conversationId,
  workspace,
  hostGatewayUrl,
  hostSessionId,
  isRestoring,
  onBack,
}: AgentWebScreenProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);

  const [tokenState, setTokenState] = useState<TokenState>({ status: "loading" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<WebError | null>(null);
  const [pageThemeColor, setPageThemeColor] = useState<string | null>(null);
  const [webViewKey, setWebViewKey] = useState(0);
  const canGoBackRef = useRef(false);

  // Resolve the host session two ways: a directly-supplied host (tab entry) wins;
  // otherwise fall back to the conversation record (deep-link / route entry).
  const conversation = conversationId ? workspace?.getConversation(conversationId) : undefined;
  const serverUrl = hostGatewayUrl ?? conversation?.serverUrl ?? null;
  const sessionId = hostSessionId ?? conversation?.sessionId ?? null;
  const resolvedTheme = theme.mode; // "dark" | "light"

  // Resolve credentials once (both SecureStore-backed, async). Re-runs only when
  // the resolved host (serverUrl/sessionId STRINGS, not the conversation object,
  // whose identity churns on every store notify) changes. We hand the WebView
  // BOTH a device token (TOFU / paired-host path) AND the Supabase session (so
  // the embedded web app boots genuinely logged-in — required for Pro users
  // whose sessions are owned by userId via /sessions/mine and never paired).
  useEffect(() => {
    let cancelled = false;
    if (!serverUrl || !sessionId) {
      setTokenState({ status: "missing-session" });
      return;
    }
    setTokenState({ status: "loading" });
    Promise.all([
      getDeviceToken().catch(() => null),
      loadSession().catch(() => null),
    ])
      .then(([token, session]) => {
        if (!cancelled) setTokenState({ status: "ready", token, session });
      })
      .catch(() => {
        if (!cancelled) setTokenState({ status: "ready", token: null, session: null });
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, sessionId]);

  const token = tokenState.status === "ready" ? tokenState.token : null;
  const authSession = tokenState.status === "ready" ? tokenState.session : null;

  // Channel A — URL query string (authoritative). Built only once token + base
  // are known.
  const uri = useMemo(() => {
    if (tokenState.status !== "ready" || !serverUrl || !sessionId) return null;
    const q = new URLSearchParams({
      embed: "1",
      session: sessionId,
      gateway: serverUrl,
      token: token ?? "",
      theme: resolvedTheme,
    });
    return `${serverUrl}/?${q.toString()}`;
  }, [tokenState.status, serverUrl, sessionId, token, resolvedTheme]);

  // Channel B — pre-seed localStorage before content loads so reloads (which may
  // drop the query string) still land on the right view. All interpolated values
  // are JSON.stringify-escaped to avoid breaking out of the JS string literal.
  const beforeLoadJs = useMemo(() => {
    if (!serverUrl || !sessionId) return undefined;
    const gatewayLit = JSON.stringify(serverUrl);
    const tokenLit = JSON.stringify(token ?? "");
    const themeLit = JSON.stringify(resolvedTheme);
    const viewLit = JSON.stringify(
      JSON.stringify({
        version: 1,
        data: { name: "console", sessionId },
      }),
    );
    // Reshape mobile's AuthSession → web's StoredSession envelope. Web keeps
    // `plan` at the TOP level of `session` (mobile nests it under user.plan),
    // and reads localStorage key "linkshell_session" as { version:1, session }.
    // Injecting it here means the embedded web app boots genuinely logged-in
    // (bearer JWT + Pro /sessions/mine), not just device-token-authed.
    const sessionStmt = authSession
      ? `localStorage.setItem('linkshell_session', ${JSON.stringify(
          JSON.stringify({
            version: 1,
            session: {
              accessToken: authSession.accessToken,
              refreshToken: authSession.refreshToken,
              expiresAt: authSession.expiresAt,
              user: { id: authSession.user.id, email: authSession.user.email },
              plan: authSession.user.plan,
            },
          }),
        )});`
      : // No mobile login → ensure no stale web session leaks in; web falls back
        // to device-token auth.
        `localStorage.removeItem('linkshell_session');`;
    return `
      (function () {
        try {
          localStorage.setItem('linkshell_gateway_url', ${gatewayLit});
          localStorage.setItem('linkshell_device_token', ${tokenLit});
          localStorage.setItem('linkshell_theme', ${themeLit});
          localStorage.setItem('linkshell_view', ${viewLit});
          localStorage.setItem('linkshell_embed', '1');
          ${sessionStmt}
        } catch (e) {}
      })();
      true;
    `;
  }, [serverUrl, sessionId, token, resolvedTheme, authSession]);

  // After-load theme-color extractor (mirrors BrowserView) so the native
  // container background matches the page and avoids a notch flash.
  const injectedJs = useMemo(
    () => `
    (function() {
      function getThemeColor() {
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta && meta.content) return meta.content;
        var style = window.getComputedStyle(document.body);
        var bg = style.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
        var htmlStyle = window.getComputedStyle(document.documentElement);
        var htmlBg = htmlStyle.backgroundColor;
        if (htmlBg && htmlBg !== 'rgba(0, 0, 0, 0)' && htmlBg !== 'transparent') return htmlBg;
        return null;
      }
      var color = getThemeColor();
      if (color) window.ReactNativeWebView.postMessage(JSON.stringify({type:'themeColor',color:color}));
    })();
    true;
  `,
    [],
  );

  // Host→page theme sync if the user flips theme while the WebView is mounted.
  useEffect(() => {
    if (!uri) return;
    webViewRef.current?.injectJavaScript(
      `window.__linkshellSetTheme && window.__linkshellSetTheme(${JSON.stringify(resolvedTheme)}); true;`,
    );
  }, [resolvedTheme, uri]);

  const handleMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      let msg: { type?: string; color?: string; message?: string; url?: string };
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "themeColor":
          if (msg.color) setPageThemeColor(msg.color);
          break;
        case "ready":
          setLoading(false);
          break;
        case "requestClose":
          onBack();
          break;
        case "error":
          setError({ message: msg.message || "页面加载出错。" });
          break;
        case "unauthorized":
          setError({
            message: "设备令牌已失效，请重新配对该主机。",
            unauthorized: true,
          });
          break;
        case "openExternal":
          if (msg.url) Linking.openURL(msg.url).catch(() => {});
          break;
        default:
          break;
      }
    },
    [onBack],
  );

  const handleRetry = useCallback(() => {
    setError(null);
    setLoading(true);
    setWebViewKey((k) => k + 1);
  }, []);

  // Android hardware back: navigate within the WebView first, else exit.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBackRef.current) {
        webViewRef.current?.goBack();
        return true;
      }
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  // The native frame (safe-area insets + pre-paint background) must match the
  // embedded web app's canvas, NOT the mobile theme.bg (#131314), or the notch
  // / home-indicator strips look grayer than the web content. These mirror the
  // web's --c-canvas tokens (dark: 11 13 15, light: #fff). Once the page paints,
  // pageThemeColor (from the in-page extractor) takes over.
  const webCanvas = resolvedTheme === "dark" ? "#0b0d0f" : "#ffffff";
  const containerBg = pageThemeColor || webCanvas;

  // No usable host session (not hydrated yet, removed, or none connected).
  if (tokenState.status === "missing-session") {
    return (
      <View
        style={[
          styles.center,
          { backgroundColor: theme.bg, paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        {isRestoring ? (
          <ActivityIndicator size="small" color={theme.accent} />
        ) : (
          <>
            <Text style={[styles.errorTitle, { color: theme.text }]}>没有可用的会话</Text>
            <Text style={[styles.errorBody, { color: theme.textSecondary }]}>
              请先连接一台主机，连接后即可在这里使用 Agent。
            </Text>
            <Pressable
              onPress={onBack}
              style={({ pressed }) => [
                styles.retryBtn,
                { backgroundColor: pressed ? theme.accent : theme.accentLight },
              ]}
            >
              <Text style={[styles.retryText, { color: theme.accent }]}>返回</Text>
            </Pressable>
          </>
        )}
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: containerBg, paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      {uri ? (
        <WebView
          key={webViewKey}
          ref={webViewRef}
          source={{ uri }}
          style={{ flex: 1, backgroundColor: containerBg }}
          onLoadStart={() => {
            setLoading(true);
            setError(null);
          }}
          onLoadEnd={() => setLoading(false)}
          onNavigationStateChange={(navState) => {
            canGoBackRef.current = navState.canGoBack;
          }}
          onError={({ nativeEvent }) =>
            setError({ message: nativeEvent.description || "页面加载失败。" })
          }
          onHttpError={({ nativeEvent }) =>
            setError({
              message: `服务器返回错误 (${nativeEvent.statusCode})。`,
              unauthorized: nativeEvent.statusCode === 401 || nativeEvent.statusCode === 403,
            })
          }
          injectedJavaScriptBeforeContentLoaded={beforeLoadJs}
          injectedJavaScript={injectedJs}
          onMessage={handleMessage}
          pullToRefreshEnabled
          sharedCookiesEnabled
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
        />
      ) : (
        <View style={[styles.center, { flex: 1 }]}>
          <ActivityIndicator size="small" color={theme.accent} />
        </View>
      )}

      {loading && uri && !error && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color={theme.accent} />
        </View>
      )}

      {error && (
        <View style={[styles.errorOverlay, { backgroundColor: theme.bg }]}>
          <Text style={[styles.errorTitle, { color: theme.text }]}>
            {error.unauthorized ? "无法连接会话" : "加载失败"}
          </Text>
          <Text style={[styles.errorBody, { color: theme.textSecondary }]}>{error.message}</Text>
          {error.unauthorized && (
            <Text style={[styles.errorHint, { color: theme.textTertiary }]}>
              请在主机端重新配对，获取新的设备令牌后再试。
            </Text>
          )}
          <View style={styles.errorActions}>
            <Pressable
              onPress={handleRetry}
              style={({ pressed }) => [
                styles.retryBtn,
                { backgroundColor: pressed ? theme.accent : theme.accentLight },
              ]}
            >
              <Text style={[styles.retryText, { color: theme.accent }]}>重试</Text>
            </Pressable>
            <Pressable
              onPress={onBack}
              style={({ pressed }) => [
                styles.retryBtn,
                { backgroundColor: pressed ? theme.bgElevated : "transparent", borderColor: theme.border, borderWidth: 1 },
              ]}
            >
              <Text style={[styles.retryText, { color: theme.textSecondary }]}>返回</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 32,
  },
  errorTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
  errorBody: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  errorHint: {
    fontSize: 12,
    textAlign: "center",
    lineHeight: 18,
  },
  errorActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
  retryBtn: {
    paddingHorizontal: 20,
    height: 38,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
