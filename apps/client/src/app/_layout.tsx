import "@/lib/crypto-polyfill";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { useMemo } from "react";
import { Platform, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { nativeStatusBar } from "@/lib/native-status-bar";
import { ClientProvider } from "@/lib/client";
import { ScreenSessionProvider } from "@/lib/screen-session";
import { AndroidAttentionSync } from "@/components/android-attention-sync";
import { fixedHeaderFontSize } from "@/components/headers";
import { IOSAttentionSync } from "@/components/ios-attention-sync";
import { LanDiscoverySync } from "@/components/lan-discovery-sync";
import { LiveActivityActionNavigation } from "@/components/live-activity-action-navigation";
import { NotificationActionSync } from "@/components/notification-action-sync";
import { ShortcutUrlHandler } from "@/components/shortcut-url-handler";
import { useLocale } from "@/lib/locale";
import { colors, palette } from "@/theme/colors";
import { radius, type } from "@/theme/type";

export const unstable_settings = {
  // Keep a home screen beneath Live Activity deep links, including cold launches.
  anchor: "(tabs)",
};

const light = { ...DefaultTheme, colors: { ...DefaultTheme.colors, primary: palette.light.accent, background: "#f2f2f7" } };
const dark = { ...DarkTheme, colors: { ...DarkTheme.colors, primary: palette.dark.accent, background: "#000000" } };

// Sheets hold forms and lists, so they get the app's solid grouped background:
// iOS's glass material would show the page behind through every field.
export default function RootLayout() {
  const scheme = useColorScheme();
  const isDark = scheme === "dark";
  const { t, pick } = useLocale();
  // Derive theme-dependent options reactively instead of keying/remounting `<Stack>`,
  // which would wipe the user's navigation stack and local screen state on Android theme toggle.
  const sheetContent = useMemo(
    () => ({ backgroundColor: colors.sheet }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `colors.sheet` is a getter reading system scheme on Android.
    [isDark],
  );
  const stackScreenOptions = useMemo(
    () => ({
      headerBackButtonDisplayMode: "minimal" as const,
      ...(nativeStatusBar ? ({ statusBarStyle: "auto", statusBarHidden: false } as const) : {}),
      headerStyle: { backgroundColor: colors.background as string },
      ...(Platform.OS === "android"
        ? {
            headerTintColor: colors.label as string,
            headerTitleStyle: {
              fontSize: fixedHeaderFontSize(type.title3.fontSize),
              fontWeight: "600" as const,
              color: colors.label as string,
            },
            contentStyle: { backgroundColor: colors.background },
          }
        : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `colors.*` getters track Android scheme changes.
    [isDark],
  );
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider value={isDark ? dark : light}>
          <ClientProvider>
            <ScreenSessionProvider>
            {Platform.OS === "ios" ? <IOSAttentionSync /> : null}
            {Platform.OS === "ios" ? <LiveActivityActionNavigation /> : null}
            {Platform.OS === "android" ? <AndroidAttentionSync /> : null}
            <LanDiscoverySync />
            <NotificationActionSync />
            <ShortcutUrlHandler />
            {!nativeStatusBar ? <StatusBar style={scheme ? (isDark ? "light" : "dark") : "auto"} /> : null}
            <Stack screenOptions={stackScreenOptions}>
                {/* Its title is what a pushed page's back button says to VoiceOver: not the group's "(tabs)". */}
                <Stack.Screen name="(tabs)" options={{ headerShown: false, title: pick({ zh: "返回", en: "Back", ja: "戻る" }) }} />
                <Stack.Screen name="usage" options={{ title: t("nav.usage") }} />
                <Stack.Screen name="activity" options={{ title: pick({ zh: "任务", en: "Activity", ja: "アクティビティ" }) }} />
                <Stack.Screen name="acp" options={{ title: "ACP", contentStyle: sheetContent }} />
                <Stack.Screen name="session/[id]/index" options={{ title: "", headerTransparent: true, headerStyle: { backgroundColor: "transparent" }, headerShadowVisible: false }} />
                <Stack.Screen name="session/[id]/workflow/[call]" options={{ title: pick({ zh: "工作流", en: "Workflow", ja: "ワークフロー" }) }} />
                <Stack.Screen name="session/[id]/workflows" options={{ title: pick({ zh: "工作流", en: "Workflows", ja: "ワークフロー" }) }} />
                <Stack.Screen name="session/[id]/workflow-agent/[call]" options={{ title: pick({ zh: "Agent 详情", en: "Agent Detail", ja: "Agent 詳細" }), headerShadowVisible: false }} />
                <Stack.Screen
                  name="session/[id]/changes"
                  options={{ title: t("nav.changes"), headerTransparent: Platform.OS === "ios", headerShadowVisible: false }}
                />
                <Stack.Screen
                  name="session/[id]/mcp"
                  options={{ title: pick({ zh: "MCP 应用", en: "MCP Apps", ja: "MCP アプリ" }) }}
                />
                <Stack.Screen
                  name="session/[id]/agent/[call]"
                  options={{
                    presentation: "formSheet",
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.62, 1],
                    sheetInitialDetentIndex: 0,
                    sheetCornerRadius: radius.panel,
                    sheetExpandsWhenScrolledToEdge: true,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
                <Stack.Screen
                  name="session/[id]/agents"
                  options={{
                    presentation: "formSheet",
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.62, 1],
                    sheetInitialDetentIndex: 0,
                    sheetCornerRadius: radius.panel,
                    sheetExpandsWhenScrolledToEdge: true,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
                <Stack.Screen
                  name="session/[id]/commands"
                  options={{
                    presentation: "formSheet",
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.92],
                    // The list scrolls inside the sheet; the search field stays put.
                    sheetExpandsWhenScrolledToEdge: false,
                    sheetCornerRadius: radius.panel,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
                <Stack.Screen name="session/[id]/task/[task]" options={{ presentation: "formSheet", sheetGrabberVisible: true, sheetAllowedDetents: [0.92], sheetExpandsWhenScrolledToEdge: false, sheetCornerRadius: radius.panel, contentStyle: sheetContent, headerShown: true }} />
                <Stack.Screen
                  name="session/[id]/goal"
                  options={{ presentation: "formSheet", sheetGrabberVisible: true, sheetAllowedDetents: [0.92], sheetExpandsWhenScrolledToEdge: false, sheetCornerRadius: radius.panel, contentStyle: sheetContent, headerShown: true }}
                />
                <Stack.Screen
                  name="session/[id]/side"
                  options={{ presentation: "formSheet", sheetGrabberVisible: true, sheetAllowedDetents: [0.62, 0.92], sheetInitialDetentIndex: 1, sheetExpandsWhenScrolledToEdge: false, sheetCornerRadius: radius.panel, contentStyle: sheetContent, headerShown: true }}
                />
                <Stack.Screen
                  name="session/[id]/settings"
                  // A few rows: the sheet is as tall as they are.
                  options={{ presentation: "formSheet", sheetGrabberVisible: true, sheetAllowedDetents: "fitToContents", sheetExpandsWhenScrolledToEdge: false, sheetCornerRadius: radius.panel, contentStyle: sheetContent, headerShown: true }}
                />
                <Stack.Screen
                  name="new"
                  options={{
                    presentation: "formSheet",
                    sheetExpandsWhenScrolledToEdge: false,
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.92],
                    sheetCornerRadius: radius.panel,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
                <Stack.Screen
                  name="browse"
                  options={{
                    presentation: "formSheet",
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.92],
                    // The list scrolls inside the sheet; the header stays put.
                    sheetExpandsWhenScrolledToEdge: false,
                    sheetCornerRadius: radius.panel,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
                <Stack.Screen
                  name="pair"
                  options={{
                    presentation: "formSheet",
                    sheetExpandsWhenScrolledToEdge: false,
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.92],
                    sheetCornerRadius: radius.panel,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
                <Stack.Screen name="preview" options={{ title: t("nav.ports") }} />
                <Stack.Screen
                  name="rename"
                  options={{
                    presentation: "formSheet",
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.42],
                    sheetCornerRadius: radius.panel,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
                <Stack.Screen name="archived" options={{ title: t("nav.archived") }} />
                <Stack.Screen name="rename-computer" options={{ presentation: "formSheet", sheetGrabberVisible: true, sheetAllowedDetents: [0.5], sheetCornerRadius: radius.panel, contentStyle: sheetContent, headerShown: true }} />
                <Stack.Screen name="unlock" options={{ presentation: "formSheet", sheetGrabberVisible: true, sheetAllowedDetents: [0.5], sheetCornerRadius: radius.panel, contentStyle: sheetContent, headerShown: true }} />
                <Stack.Screen
                  name="screen"
                  options={{
                    title: t("nav.screen"),
                    headerTransparent: true,
                    headerStyle: { backgroundColor: Platform.OS === "ios" ? "transparent" : "#000000" },
                    headerShadowVisible: false,
                    headerTintColor: "#ffffff",
                    headerTitleStyle: { color: "#ffffff" },
                    contentStyle: { backgroundColor: "#000000" },
                    ...(Platform.OS === "ios" ? { unstable_nativeProps: { headerConfig: { experimental_userInterfaceStyle: "dark" } } } : {}),
                  }}
                />
                <Stack.Screen
                  name="ports"
                  options={{
                    presentation: "formSheet",
                    sheetExpandsWhenScrolledToEdge: false,
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: "fitToContents",
                    sheetCornerRadius: radius.panel,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
                <Stack.Screen name="computer-details" options={{ presentation: "formSheet", sheetGrabberVisible: true, sheetAllowedDetents: [0.78, 1], sheetCornerRadius: radius.panel, contentStyle: sheetContent, headerShown: false }} />
                <Stack.Screen
                  name="computers"
                  options={{
                    presentation: "formSheet",
                    sheetGrabberVisible: true,
                    // As tall as the list: two computers don't need half the screen.
                    sheetAllowedDetents: "fitToContents",
                    sheetExpandsWhenScrolledToEdge: false,
                    sheetCornerRadius: radius.panel,
                    contentStyle: sheetContent,
                    headerShown: false,
                  }}
                />
                <Stack.Screen name="account" options={{ title: t("nav.account"), headerLargeTitleEnabled: false, headerTransparent: false, headerShadowVisible: false }} />
                <Stack.Screen
                  name="connect"
                  options={{
                    presentation: "formSheet",
                    sheetExpandsWhenScrolledToEdge: false,
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: Platform.OS === "ios" && Platform.isPad ? [0.92] : [0.6, 0.92],
                    sheetCornerRadius: radius.panel,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
              </Stack>
            </ScreenSessionProvider>
          </ClientProvider>
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
