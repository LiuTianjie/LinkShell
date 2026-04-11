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
import { WebView } from "react-native-webview";
import { AppSymbol } from "./AppSymbol";
import { useTheme } from "../theme";

interface BrowserViewProps {
  gatewayUrl: string;
  sessionId: string;
  deviceToken: string | null;
}

export function BrowserView({
  gatewayUrl,
  sessionId,
  deviceToken,
}: BrowserViewProps) {
  const { theme } = useTheme();
  const webViewRef = useRef<WebView>(null);
  const [port, setPort] = useState("3000");
  const [activePort, setActivePort] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentUrl, setCurrentUrl] = useState("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  const tunnelUrl = activePort
    ? `${gatewayUrl}/tunnel/${encodeURIComponent(sessionId)}/${activePort}/${deviceToken ? `?token=${encodeURIComponent(deviceToken)}` : ""}`
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

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {/* URL bar */}
      <View
        style={[
          styles.urlBar,
          {
            backgroundColor: theme.bgCard,
            borderBottomColor: theme.separator,
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

        {/* Refresh */}
        <Pressable onPress={handleRefresh} style={styles.navBtn}>
          <AppSymbol
            name="arrow.clockwise"
            size={15}
            color={theme.textSecondary}
          />
        </Pressable>
      </View>

      {/* Current URL display */}
      {currentUrl ? (
        <View
          style={[
            styles.urlDisplay,
            { backgroundColor: theme.bgCard, borderBottomColor: theme.separator },
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
            ref={webViewRef}
            source={{ uri: tunnelUrl }}
            style={{ backgroundColor: theme.bg }}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            onNavigationStateChange={(navState) => {
              setCanGoBack(navState.canGoBack);
              setCanGoForward(navState.canGoForward);
              setCurrentUrl(navState.url);
            }}
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
        </View>
      )}
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
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 6,
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
});
