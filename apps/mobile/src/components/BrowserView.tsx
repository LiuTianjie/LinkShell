import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { AppSymbol } from "./AppSymbol";
import { useTheme } from "../theme";

type ViewportMode = "mobile" | "desktop";

interface BrowserViewProps {
  gatewayUrl: string;
  sessionId: string;
  deviceToken: string | null;
  authToken: string | null;
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
}

const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function BrowserView({
  gatewayUrl,
  sessionId,
  deviceToken,
  authToken,
  onToggleFullscreen,
  isFullscreen,
}: BrowserViewProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const [port, setPort] = useState("3000");
  const [activePort, setActivePort] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentUrl, setCurrentUrl] = useState("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [viewportMode, setViewportMode] = useState<ViewportMode>("mobile");
  const [webViewKey, setWebViewKey] = useState(0);
  const [pageThemeColor, setPageThemeColor] = useState<string | null>(null);

  const tunnelUrl = activePort
    ? `${gatewayUrl}/tunnel/${encodeURIComponent(sessionId)}/${activePort}/${deviceToken ? `?token=${encodeURIComponent(deviceToken)}` : authToken ? `?auth_token=${encodeURIComponent(authToken)}` : ""}`
    : null;

  const handleGo = useCallback(() => {
    const p = port.trim();
    if (!p || isNaN(Number(p)) || Number(p) < 1 || Number(p) > 65535) return;
    setActivePort(p);
    Keyboard.dismiss();
  }, [port]);

  const handleRefresh = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  const handleGoBack = useCallback(() => {
    webViewRef.current?.goBack();
  }, []);

  const handleGoForward = useCallback(() => {
    webViewRef.current?.goForward();
  }, []);

  const toggleViewport = useCallback(() => {
    setViewportMode((m) => (m === "mobile" ? "desktop" : "mobile"));
    setWebViewKey((k) => k + 1);
  }, []);

  // JS to force desktop viewport — runs BEFORE page content loads
  // Also uses MutationObserver to prevent frameworks from resetting viewport
  const BEFORE_LOAD_JS = viewportMode === "desktop" ? `
    (function() {
      function forceDesktop() {
        var vp = document.querySelector('meta[name="viewport"]');
        if (vp) {
          vp.setAttribute('content', 'width=1024');
        } else {
          var m = document.createElement('meta');
          m.name = 'viewport';
          m.content = 'width=1024';
          document.head.appendChild(m);
        }
      }
      forceDesktop();
      new MutationObserver(function() { forceDesktop(); })
        .observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    })();
    true;
  ` : undefined;

  const webViewDesktopProps = viewportMode === "desktop" ? {
    userAgent: DESKTOP_USER_AGENT,
    contentMode: "desktop" as const,
    injectedJavaScriptBeforeContentLoaded: BEFORE_LOAD_JS,
  } : {};

  // JS to extract theme-color — runs AFTER page loads
  const INJECTED_JS = `
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
  `;

  const handleWebViewMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === "themeColor" && msg.color) {
        setPageThemeColor(msg.color);
      }
    } catch {}
  }, []);

  const safeBg = pageThemeColor || theme.bg;

  // Fullscreen: just WebView + floating exit button
  if (isFullscreen && tunnelUrl) {
    return (
      <View style={[styles.container, { backgroundColor: safeBg, paddingTop: insets.top }]}>
        <WebView
          key={webViewKey}
          ref={webViewRef}
          source={{ uri: tunnelUrl }}
          style={{ flex: 1, backgroundColor: safeBg }}
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
          onNavigationStateChange={(navState) => {
            setCanGoBack(navState.canGoBack);
            setCanGoForward(navState.canGoForward);
            setCurrentUrl(navState.url);
          }}
          injectedJavaScript={INJECTED_JS}
          onMessage={handleWebViewMessage}
          {...webViewDesktopProps}
          sharedCookiesEnabled
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
        />
        {loading && (
          <View style={[styles.loadingOverlay, { top: insets.top + 8 }]}>
            <ActivityIndicator size="small" color={theme.accent} />
          </View>
        )}
        {/* Floating exit fullscreen button */}
        <Pressable
          onPress={onToggleFullscreen}
          style={[
            styles.floatingBtn,
            {
              top: insets.top + 6,
              left: 12,
              backgroundColor: "rgba(0,0,0,0.55)",
            },
          ]}
        >
          <AppSymbol
            name="arrow.down.right.and.arrow.up.left"
            size={14}
            color="#fff"
          />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bgTerminal }]}>
      {/* Current URL display — top */}
      {currentUrl ? (
        <View
          style={[
            styles.urlDisplay,
            { backgroundColor: theme.bgTerminal, borderBottomColor: theme.separator },
          ]}
        >
          <Text
            style={[styles.urlText, { color: theme.textTertiary }]}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {currentUrl}
          </Text>
        </View>
      ) : null}

      {/* WebView or placeholder */}
      {tunnelUrl ? (
        <View style={styles.webViewContainer}>
          <WebView
            key={webViewKey}
            ref={webViewRef}
            source={{ uri: tunnelUrl }}
            style={{ backgroundColor: theme.bgTerminal }}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            onNavigationStateChange={(navState) => {
              setCanGoBack(navState.canGoBack);
              setCanGoForward(navState.canGoForward);
              setCurrentUrl(navState.url);
            }}
            injectedJavaScript={INJECTED_JS}
            onMessage={handleWebViewMessage}
            {...webViewDesktopProps}
            sharedCookiesEnabled
            javaScriptEnabled
            domStorageEnabled
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
          />
          {loading && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="small" color={theme.accent} />
            </View>
          )}
        </View>
      ) : (
        <View style={styles.placeholder}>
          <AppSymbol name="globe" size={48} color={theme.textTertiary} />
          <Text style={[styles.placeholderText, { color: theme.textSecondary }]}>
            输入端口号预览远程服务
          </Text>
          <Text
            style={[styles.placeholderHint, { color: theme.textTertiary }]}
          >
            例如: 3000, 5173, 8080
          </Text>
          <View style={styles.versionHint}>
            <Text style={[styles.versionText, { color: theme.textTertiary }]}>
              需要 linkshell-cli {"\u2265"} 0.2.53 / gateway {"\u2265"} 0.2.17
            </Text>
            <Text style={[styles.versionText, { color: theme.textTertiary }]}>
              npm i -g linkshell-cli 更新
            </Text>
          </View>
        </View>
      )}

      {/* Bottom bar — Safari style */}
      <View
        style={[
          styles.urlBar,
          {
            backgroundColor: theme.bgTerminal,
            borderTopColor: theme.separator,
            paddingBottom: Math.max(insets.bottom, 8),
          },
        ]}
      >
        {/* Nav buttons */}
        <Pressable
          onPress={handleGoBack}
          disabled={!canGoBack}
          style={styles.navBtn}
        >
          <AppSymbol
            name="chevron.left"
            size={16}
            color={canGoBack ? theme.text : theme.textTertiary}
          />
        </Pressable>
        <Pressable
          onPress={handleGoForward}
          disabled={!canGoForward}
          style={styles.navBtn}
        >
          <AppSymbol
            name="chevron.right"
            size={16}
            color={canGoForward ? theme.text : theme.textTertiary}
          />
        </Pressable>

        {/* Port input */}
        <View
          style={[
            styles.portInputWrap,
            { backgroundColor: theme.bgInput, borderColor: theme.borderLight },
          ]}
        >
          <Text style={[styles.portLabel, { color: theme.textSecondary }]}>
            :
          </Text>
          <TextInput
            style={[styles.portInput, { color: theme.text }]}
            value={port}
            onChangeText={setPort}
            keyboardType="number-pad"
            returnKeyType="go"
            onSubmitEditing={handleGo}
            placeholder="3000"
            placeholderTextColor={theme.textTertiary}
            selectTextOnFocus
          />
        </View>

        {/* Go button */}
        <Pressable
          onPress={handleGo}
          style={({ pressed }) => [
            styles.goBtn,
            {
              backgroundColor: pressed ? theme.accent : theme.accentLight,
            },
          ]}
        >
          <Text style={[styles.goBtnText, { color: theme.accent }]}>Go</Text>
        </Pressable>

        {/* Viewport toggle */}
        <Pressable onPress={toggleViewport} style={styles.navBtn}>
          <AppSymbol
            name={viewportMode === "mobile" ? "desktopcomputer" : "iphone"}
            size={15}
            color={theme.textSecondary}
          />
        </Pressable>

        {/* Refresh */}
        <Pressable onPress={handleRefresh} style={styles.navBtn}>
          <AppSymbol
            name="arrow.clockwise"
            size={15}
            color={theme.textSecondary}
          />
        </Pressable>

        {/* Fullscreen */}
        {onToggleFullscreen && tunnelUrl && (
          <Pressable onPress={onToggleFullscreen} style={styles.navBtn}>
            <AppSymbol
              name="arrow.up.left.and.arrow.down.right"
              size={14}
              color={theme.textSecondary}
            />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  urlBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  navBtn: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  portInputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
    height: 32,
  },
  portLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
  portInput: {
    flex: 1,
    fontSize: 14,
    fontVariant: ["tabular-nums"],
    paddingVertical: 0,
  },
  goBtn: {
    paddingHorizontal: 12,
    height: 30,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  goBtnText: {
    fontSize: 13,
    fontWeight: "700",
  },
  urlDisplay: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  urlText: {
    fontSize: 11,
  },
  webViewContainer: {
    flex: 1,
  },
  loadingOverlay: {
    position: "absolute",
    top: 8,
    right: 8,
  },
  floatingBtn: {
    position: "absolute",
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  placeholderText: {
    fontSize: 15,
    fontWeight: "500",
  },
  placeholderHint: {
    fontSize: 13,
  },
  versionHint: {
    marginTop: 16,
    alignItems: "center",
    gap: 4,
  },
  versionText: {
    fontSize: 11,
  },
});
