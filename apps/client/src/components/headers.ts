import type { NativeStackNavigationOptions } from "expo-router/native-stack";
import { PixelRatio, Platform } from "react-native";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

/**
 * Android native Toolbar interprets `titleFontSize` in `sp` (scaled by system fontScale),
 * while the rest of the app renders unscaled typography via `fixed-text.tsx`. Normalize
 * Android header sizes back to dp so titles stay consistent across system font settings.
 */
export function fixedHeaderFontSize(size: number, fontScale = PixelRatio?.getFontScale?.() ?? 1): number {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return Math.max(12, Math.round(size / scale));
}

/**
 * iOS: large-title header over a grouped background, content scrolling under it.
 * Android has no large titles and no automatic content insets, so it gets a
 * solid, flat app bar in the page colour with a Material-sized title.
 */
export function largeTitleHeader(_scheme?: string | null): NativeStackNavigationOptions {
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
        headerTitleStyle: {
          fontSize: fixedHeaderFontSize(type.title.fontSize),
          fontWeight: "600",
          color: colors.label as string,
        },
        headerTintColor: colors.label as string,
        contentStyle: { backgroundColor: colors.background },
      };
}
