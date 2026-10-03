import "@/lib/crypto-polyfill";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { Fragment } from "react";
import { Platform, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ClientProvider } from "@/lib/client";
import { colors, palette } from "@/theme/colors";

const light = { ...DefaultTheme, colors: { ...DefaultTheme.colors, primary: palette.light.accent, background: "#f2f2f7" } };
const dark = { ...DarkTheme, colors: { ...DarkTheme.colors, primary: palette.dark.accent, background: "#000000" } };

// Sheets hold forms and lists, so they get the app's solid grouped background:
// iOS's glass material would show the page behind through every field.
const sheetContent = { backgroundColor: colors.sheet };

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider value={scheme === "dark" ? dark : light}>
          <ClientProvider>
            {/* Android resolves the theme's colour resources when a view is created, and the
                activity handles a day/night switch itself, so existing views would keep the old
                colours. Rebuild the navigation tree on a switch, as Android would by default. */}
            <Fragment key={Platform.OS === "android" ? (scheme ?? "light") : "tree"}>
              <StatusBar style="auto" />
              <Stack screenOptions={{ headerBackButtonDisplayMode: "minimal" }}>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="session/[id]/index" options={{ title: "", headerTransparent: true, headerShadowVisible: false }} />
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
                    headerShown: false,
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
                    headerShown: false,
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
                    headerShown: false,
                  }}
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
                    headerShown: false,
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
                    headerShown: false,
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
                    headerShown: false,
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
                    headerShown: false,
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
                    headerShown: false,
                  }}
                />
                <Stack.Screen name="account" options={{ title: "账号与电脑", headerLargeTitle: true, headerTransparent: Platform.OS === "ios", headerShadowVisible: false }} />
                <Stack.Screen
                  name="connect"
                  options={{
                    presentation: "formSheet",
                    sheetExpandsWhenScrolledToEdge: false,
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.6, 0.92],
                    contentStyle: sheetContent,
                    headerShown: false,
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
