import "@/lib/crypto-polyfill";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { Fragment } from "react";
import { Platform, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { nativeStatusBar } from "@/lib/native-status-bar";
import { ClientProvider } from "@/lib/client";
import { colors, palette } from "@/theme/colors";

const light = { ...DefaultTheme, colors: { ...DefaultTheme.colors, primary: palette.light.accent, background: "#f2f2f7" } };
const dark = { ...DarkTheme, colors: { ...DarkTheme.colors, primary: palette.dark.accent, background: "#000000" } };

// Sheets hold forms and lists, so they get the app's solid grouped background:
// iOS's glass material would show the page behind through every field.
export default function RootLayout() {
  const scheme = useColorScheme();
  const sheetContent = { backgroundColor: colors.sheet };
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider value={scheme === "dark" ? dark : light}>
          <ClientProvider>
            {/* Android's literal theme colors must reach memoized rows and native
                views too; rebuild the tree when the system appearance changes. */}
            <Fragment key={Platform.OS === "android" ? (scheme ?? "light") : "tree"}>
              {!nativeStatusBar ? <StatusBar style="auto" /> : null}
              <Stack screenOptions={{ headerBackButtonDisplayMode: "minimal", ...(nativeStatusBar ? { statusBarStyle: "auto", statusBarHidden: false } as const : {}), headerStyle: { backgroundColor: colors.background as string } }}>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="session/[id]/index" options={{ title: "", headerTransparent: true, headerShadowVisible: false }} />
                <Stack.Screen name="session/[id]/workflow/[call]" options={{ title: "工作流" }} />
                <Stack.Screen name="session/[id]/workflows" options={{ title: "工作流" }} />
                <Stack.Screen name="session/[id]/workflow-agent/[call]" options={{ title: "Agent 详情", headerShadowVisible: false }} />
                <Stack.Screen
                  name="session/[id]/changes"
                  options={{ title: "改动", headerTransparent: Platform.OS === "ios", headerShadowVisible: false }}
                />
                <Stack.Screen
                  name="session/[id]/agent/[call]"
                  options={{
                    presentation: "formSheet",
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.62, 1],
                    sheetInitialDetentIndex: 0,
                    sheetCornerRadius: 28,
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
                    sheetCornerRadius: 28,
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
                    sheetCornerRadius: 28,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
                <Stack.Screen name="session/[id]/task/[task]" options={{ presentation: "formSheet", sheetGrabberVisible: true, sheetAllowedDetents: [0.92], sheetExpandsWhenScrolledToEdge: false, sheetCornerRadius: 28, contentStyle: sheetContent, headerShown: true }} />
                <Stack.Screen
                  name="session/[id]/goal"
                  options={{ presentation: "formSheet", sheetGrabberVisible: true, sheetAllowedDetents: [0.92], sheetExpandsWhenScrolledToEdge: false, sheetCornerRadius: 28, contentStyle: sheetContent, headerShown: true }}
                />
                <Stack.Screen
                  name="session/[id]/settings"
                  options={{ presentation: "formSheet", sheetGrabberVisible: true, sheetAllowedDetents: [0.7, 0.92], sheetExpandsWhenScrolledToEdge: false, sheetCornerRadius: 28, contentStyle: sheetContent, headerShown: true }}
                />
                <Stack.Screen
                  name="new"
                  options={{
                    presentation: "formSheet",
                    sheetExpandsWhenScrolledToEdge: false,
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.92],
                    sheetCornerRadius: 28,
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
                    sheetCornerRadius: 28,
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
                    sheetCornerRadius: 28,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
                <Stack.Screen name="preview" options={{ title: "预览" }} />
                <Stack.Screen
                  name="rename"
                  options={{
                    presentation: "formSheet",
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.42],
                    sheetCornerRadius: 28,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
                <Stack.Screen name="archived" options={{ title: "已归档" }} />
                <Stack.Screen name="screen" options={{ title: "屏幕" }} />
                <Stack.Screen
                  name="ports"
                  options={{
                    presentation: "formSheet",
                    sheetExpandsWhenScrolledToEdge: false,
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.7, 0.92],
                    sheetCornerRadius: 28,
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
                <Stack.Screen name="account" options={{ title: "账号与电脑", headerLargeTitleEnabled: false, headerTransparent: false, headerShadowVisible: false }} />
                <Stack.Screen
                  name="connect"
                  options={{
                    presentation: "formSheet",
                    sheetExpandsWhenScrolledToEdge: false,
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.6, 0.92],
                    contentStyle: sheetContent,
                    headerShown: true,
                  }}
                />
              </Stack>
            </Fragment>
          </ClientProvider>
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
