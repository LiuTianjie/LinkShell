import type { McpApp } from "@linkshell/wire";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, useColorScheme, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { usePageInsets } from "@/components/adaptive-page";
import { Text } from "@/components/fixed-text";
import { HeaderActions } from "@/components/header-actions";
import { ScrollableState } from "@/components/scrollable-state";
import { EmptyState, LoadingState, LockedComputer, unreachable, WaitingForComputer } from "@/components/state-views";
import { useActions, useClient, useConnection } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { describeActionError, useLocale } from "@/lib/locale";
import {
  appCsp,
  appDocument,
  appResourceMeta,
  decodeBase64Utf8,
  isAppPage,
  isSafeExternalUrl,
  McpAppBridgeController,
  mcpAppTabId,
  mcpAppTitle,
  mcpContentBlocks,
  type AppHostContext,
} from "@/lib/mcp-app";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";

interface LoadedMcpPage {
  key: string;
  html: string;
}

export function McpAppScreen() {
  const { id, app: initialAppKey } = useLocalSearchParams<{ id: string; app?: string }>();
  const insets = usePageInsets();
  const scheme = useColorScheme();
  const { locale, pick } = useLocale();
  const { link } = useConnection();
  const actions = useActions();
  const online = useClient((state) => state.status === "online");
  const offline = useClient((state) => unreachable(state.status));
  const locked = useClient((state) => state.status === "locked");

  const webRef = useRef<WebView | null>(null);
  const bridgeRef = useRef<McpAppBridgeController | null>(null);

  const [apps, setApps] = useState<McpApp[]>([]);
  const [appsLoaded, setAppsLoaded] = useState(false);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | undefined>(initialAppKey);
  const [refreshSeq, setRefreshSeq] = useState(0);

  const [loadedPage, setLoadedPage] = useState<LoadedMcpPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | undefined>(undefined);
  const [reportedSize, setReportedSize] = useState<{ width?: number; height?: number } | null>(null);

  const loadApps = useCallback(async () => {
    if (!online || !id) return;
    setAppsError(null);
    try {
      const res = await link.call("mcp.apps", { sessionId: id }, 20_000);
      const next = Array.isArray(res?.apps) ? res.apps : [];
      setApps(next);
      setAppsLoaded(true);
    } catch (reason: unknown) {
      setAppsLoaded(true);
      setAppsError(describeActionError(reason));
    }
  }, [id, link, online]);

  useEffect(() => {
    if (!online || !id) return;
    void loadApps();
  }, [id, loadApps, online, refreshSeq]);

  const selectedApp = useMemo(() => {
    if (apps.length === 0) return undefined;
    if (selectedKey) {
      const exact = apps.find((app) => mcpAppTabId(app.server, app.resourceUri) === selectedKey);
      if (exact) return exact;
    }
    return apps[0];
  }, [apps, selectedKey]);

  useEffect(() => {
    if (!online || !id || !selectedApp) {
      setLoadedPage(null);
      setPageError(null);
      setReportedSize(null);
      return;
    }
    let cancelled = false;
    setPageLoading(true);
    setPageError(null);
    setReportedSize(null);

    void link
      .call(
        "mcp.resource",
        {
          sessionId: id,
          server: selectedApp.server,
          uri: selectedApp.resourceUri,
          connector: selectedApp.connector,
        },
        20_000,
      )
      .then((res) => {
        if (cancelled) return;
        const rawHtml = res.text ?? (res.blob ? decodeBase64Utf8(res.blob) : "");
        if (!rawHtml || (res.mimeType && !isAppPage(res.mimeType))) {
          setLoadedPage(null);
          setPageError(
            pick({
              zh: "该 MCP 资源不是可交互页面",
              en: "This MCP resource is not an interactive page",
              ja: "この MCP リソースはインタラクティブページではありません",
            }),
          );
          return;
        }
        const meta = appResourceMeta(res.meta);
        const csp = appCsp(meta.csp);
        setLoadedPage({
          key: mcpAppTabId(selectedApp.server, selectedApp.resourceUri),
          html: appDocument(rawHtml, csp),
        });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setLoadedPage(null);
        setPageError(describeActionError(reason));
      })
      .finally(() => {
        if (!cancelled) setPageLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, link, online, pick, refreshSeq, selectedApp]);

  const themeMode: "light" | "dark" = scheme === "dark" ? "dark" : "light";

  useEffect(() => {
    if (!id || !selectedApp || !loadedPage) {
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
      return;
    }

    const context: AppHostContext = {
      theme: themeMode,
      displayMode: "fullscreen",
      availableDisplayModes: ["fullscreen"],
      platform: "mobile",
      locale,
      ...(containerSize ? { containerDimensions: containerSize } : {}),
    };

    const controller = new McpAppBridgeController(
      (script) => webRef.current?.injectJavaScript(script),
      {
        callTool: (name, args) =>
          link.call(
            "mcp.call",
            {
              sessionId: id,
              server: selectedApp.server,
              tool: name,
              arguments: args,
              connector: selectedApp.connector,
            },
            30_000,
          ),
        readResource: (uri) =>
          link.call(
            "mcp.resource",
            {
              sessionId: id,
              server: selectedApp.server,
              uri,
              connector: selectedApp.connector,
            },
            20_000,
          ),
        openLink: (url) => {
          if (isSafeExternalUrl(url)) {
            void Linking.openURL(url).catch(() => {});
          }
        },
        message: async (content) => {
          const blocks = mcpContentBlocks(content);
          const text = blocks
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text)
            .join("\n\n")
            .trim();
          if (text) {
            const outcome = await actions.send(id, [{ type: "text", text }]);
            if (outcome === "failed") {
              Alert.alert(
                pick({ zh: "发送失败", en: "Send failed", ja: "送信失敗" }),
                pick({
                  zh: "MCP 应用消息未能发送到会话。",
                  en: "Failed to forward MCP app message to the session.",
                  ja: "MCP アプリのメッセージを送信できませんでした。",
                }),
              );
            }
          }
        },
        onSizeChanged: (next) => {
          setReportedSize(next);
        },
        ready: () => {},
      },
      context,
    );
    bridgeRef.current = controller;

    return () => {
      void controller.teardown();
      controller.dispose();
      if (bridgeRef.current === controller) {
        bridgeRef.current = null;
      }
    };
  }, [actions, containerSize, id, link, loadedPage, locale, pick, selectedApp, themeMode]);

  useEffect(() => {
    bridgeRef.current?.setContext({ theme: themeMode });
  }, [themeMode]);

  useEffect(() => {
    if (containerSize) {
      bridgeRef.current?.setContext({ containerDimensions: containerSize });
    }
  }, [containerSize]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    void bridgeRef.current?.receive(event.nativeEvent.data);
  }, []);

  const title = selectedApp
    ? mcpAppTitle(selectedApp)
    : pick({ zh: "MCP 应用", en: "MCP Apps", ja: "MCP アプリ" });

  return (
    <View style={{ flex: 1, backgroundColor: colors.plain }}>
      <Stack.Screen
        options={{
          title,
        }}
      />
      <HeaderActions
        actions={[
          {
            kind: "button",
            key: "refresh",
            icon: { sf: "arrow.clockwise", md: "refresh" },
            label: pick({ zh: "刷新", en: "Refresh", ja: "更新" }),
            onPress: () => {
              haptics.selection();
              setRefreshSeq((value) => value + 1);
            },
          },
        ]}
      />

      {apps.length > 1 ? (
        <View
          style={{
            borderBottomWidth: 0.5,
            borderBottomColor: colors.separator,
            backgroundColor: colors.background,
          }}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 10, gap: 8 }}
          >
            {apps.map((app) => {
              const key = mcpAppTabId(app.server, app.resourceUri);
              const active = selectedApp && mcpAppTabId(selectedApp.server, selectedApp.resourceUri) === key;
              return (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  accessibilityState={{ selected: Boolean(active) }}
                  onPress={() => {
                    haptics.selection();
                    setSelectedKey(key);
                  }}
                  style={({ pressed }) => ({
                    paddingHorizontal: 12,
                    paddingVertical: 7,
                    borderRadius: radius.chip,
                    borderCurve: "continuous",
                    backgroundColor: active ? colors.accentFill : pressed ? colors.fillStrong : colors.fill,
                  })}
                >
                  <Text
                    numberOfLines={1}
                    style={[
                      type.subhead,
                      { color: active ? colors.onAccent : colors.label, fontWeight: active ? "600" : "500" },
                    ]}
                  >
                    {mcpAppTitle(app)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <View
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          if (width > 0 && height > 0) {
            setContainerSize((prev) =>
              prev && prev.width === width && prev.height === height ? prev : { width, height },
            );
          }
        }}
        style={{ flex: 1, minHeight: 0, paddingBottom: insets.bottom }}
      >
        {locked ? (
          <LockedComputer />
        ) : offline ? (
          <WaitingForComputer what={pick({ zh: "MCP 应用", en: "MCP Apps", ja: "MCP アプリ" })} />
        ) : appsError ? (
          <ScrollableState>
            <EmptyState
              icon={{ sf: "exclamationmark.triangle", md: "warning" }}
              title={pick({ zh: "无法获取 MCP 应用", en: "Unable to load MCP Apps", ja: "MCP アプリを取得できません" })}
              message={appsError}
              action={{
                title: pick({ zh: "重试", en: "Retry", ja: "再試行" }),
                onPress: () => setRefreshSeq((value) => value + 1),
              }}
            />
          </ScrollableState>
        ) : !appsLoaded || (selectedApp && pageLoading && !loadedPage) ? (
          <ScrollableState>
            <LoadingState label={pick({ zh: "正在加载 MCP 应用…", en: "Loading MCP App...", ja: "読み込み中…" })} />
          </ScrollableState>
        ) : apps.length === 0 ? (
          <ScrollableState>
            <EmptyState
              icon={{ sf: "puzzlepiece.extension", md: "extension" }}
              title={pick({ zh: "暂无可用的 MCP 应用", en: "No MCP Apps available", ja: "MCP アプリがありません" })}
              message={pick({
                zh: "当前会话关联的 MCP 服务没有提供可交互界面资源。",
                en: "None of the MCP servers in this session provide interactive UI apps.",
                ja: "このセッションの MCP サーバーには対話型 UI アプリがありません。",
              })}
              action={{
                title: pick({ zh: "刷新", en: "Refresh", ja: "更新" }),
                onPress: () => setRefreshSeq((value) => value + 1),
              }}
            />
          </ScrollableState>
        ) : pageError ? (
          <ScrollableState>
            <EmptyState
              icon={{ sf: "exclamationmark.triangle", md: "warning" }}
              title={pick({ zh: "应用页面加载失败", en: "Failed to load app page", ja: "読み込みに失敗しました" })}
              message={pageError}
              action={{
                title: pick({ zh: "重试", en: "Retry", ja: "再試行" }),
                onPress: () => setRefreshSeq((value) => value + 1),
              }}
            />
          </ScrollableState>
        ) : loadedPage ? (
          <View
            style={{
              flex: 1,
              ...(reportedSize?.height && (!containerSize?.height || reportedSize.height < containerSize.height)
                ? { maxHeight: Math.max(240, reportedSize.height) }
                : null),
            }}
          >
            <WebView
              ref={webRef}
              key={`${loadedPage.key}-${refreshSeq}`}
              source={{ html: loadedPage.html }}
              originWhitelist={["about:blank"]}
              javaScriptEnabled
              allowFileAccess={false}
              allowFileAccessFromFileURLs={false}
              allowUniversalAccessFromFileURLs={false}
              domStorageEnabled={false}
              thirdPartyCookiesEnabled={false}
              mixedContentMode="never"
              onMessage={handleMessage}
              onShouldStartLoadWithRequest={(request) => {
                if (request.url === "about:blank" || request.url.startsWith("about:blank#")) {
                  return true;
                }
                if (isSafeExternalUrl(request.url)) {
                  void Linking.openURL(request.url).catch(() => {});
                }
                return false;
              }}
              style={{ flex: 1, backgroundColor: colors.plain as string }}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}
