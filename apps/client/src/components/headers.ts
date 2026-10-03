import type { NativeStackNavigationOptions } from "expo-router/native-stack";
import { Platform } from "react-native";
import { colors } from "@/theme/colors";

/**
 * iOS: large-title header over a grouped background, content scrolling under it.
 * Android has no large titles and no automatic content insets, so it gets a
 * solid, flat app bar in the page colour with a Material-sized title.
 */
export function largeTitleHeader(): NativeStackNavigationOptions {
  return Platform.OS === "ios"
    ? {
        headerTransparent: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerLargeStyle: { backgroundColor: "transparent" },
        headerLargeTitleEnabled: true,
        headerBlurEffect: "none",
        headerBackButtonDisplayMode: "minimal",
        contentStyle: { backgroundColor: colors.background },
      }
    : {
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.background as string },
        headerTitleStyle: { fontSize: 22, fontWeight: "600", color: colors.label as string },
        headerTintColor: colors.label as string,
        contentStyle: { backgroundColor: colors.background },
      };
}
