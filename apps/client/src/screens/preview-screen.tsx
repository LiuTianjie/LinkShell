import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewNavigation } from "react-native-webview";
import { Button } from "@/components/button";
import { HeaderActions } from "@/components/header-actions";
import { Icon, type IconProps } from "@/components/icon";
import { useConnection } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { openLink } from "@/lib/links";
import { forwardPort, type Forward } from "@/lib/preview";
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
      style={{ width: 44, height: 40, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.3 : 1 }}
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
  const port = Number(params.port);
  const { link } = useConnection();
  const insets = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  const [forward, setForward] = useState<Forward | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [nav, setNav] = useState<Pick<WebViewNavigation, "title" | "url" | "canGoBack" | "canGoForward"> | null>(null);
  const [desktop, setDesktop] = useState(false);
  // Remounts the WebView (a retry, or a new user agent).
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let active: Forward | undefined;
    let cancelled = false;
    forwardPort(link, port)
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
  }, [link, port]);

  // Shown as the computer's address, not the phone's loopback.
  const shown = (url: string | undefined) => {
    if (!url || !forward) return `localhost:${port}`;
    const path = url.replace(/^https?:\/\/(127\.0\.0\.1|localhost):\d+/, "");
    return `localhost:${port}${path === "/" ? "" : path}`;
  };
  const title = nav?.title && !/^https?:\/\//.test(nav.title) && !nav.title.startsWith("127.0.0.1") ? nav.title : (params.title ?? `localhost:${port}`);
  const local = (url: string) => {
    if (!forward) return false;
    const origin = /^https?:\/\/([^/:]+):(\d+)/.exec(url);
    return !!origin && (origin[1] === "127.0.0.1" || origin[1] === "localhost") && Number(origin[2]) === forward.localPort;
  };

  const retry = () => {
    setFailure(null);
    setProgress(0);
    setGeneration((value) => value + 1);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.plain }}>
      <Stack.Screen
        options={{
          title,
          headerTitle: () => (
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

      <View style={{ flex: 1 }}>
        {forward && !failure ? (
          <WebView
            key={`${generation}-${desktop}`}
            ref={web}
            source={{ uri: forward.url }}
            userAgent={desktop ? DESKTOP_AGENT : undefined}
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
            style={{ flex: 1, backgroundColor: colors.plain }}
          />
        ) : failure ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 }}>
            <Icon sf="network.slash" md="cloud_off" size={36} color={colors.tertiaryLabel} />
            <Text style={[type.headline, { color: colors.label }]}>打不开 localhost:{port}</Text>
            <Text style={[type.subhead, { color: colors.secondaryLabel, textAlign: "center" }]}>电脑上这个端口可能没有在运行服务，启动后再试。</Text>
            <Button title="重试" variant="tonal" size="small" onPress={retry} />
          </View>
        ) : (
          <ActivityIndicator style={{ marginTop: 48 }} color={colors.secondaryLabel} />
        )}
        {progress > 0 && progress < 1 && !failure ? (
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2 }}>
            <View style={{ width: `${progress * 100}%`, height: 2, backgroundColor: colors.accent }} />
          </View>
        ) : null}
      </View>

      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-around",
          alignItems: "center",
          paddingTop: 4,
          paddingBottom: Math.max(insets.bottom, 8),
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
        <ToolbarButton
          icon={desktop ? { sf: "iphone", md: "smartphone" } : { sf: "desktopcomputer", md: "desktop_windows" }}
          label={desktop ? "手机版网页" : "电脑版网页"}
          onPress={() => {
            setDesktop((value) => !value);
            setGeneration((value) => value + 1);
          }}
        />
      </View>
    </View>
  );
}
