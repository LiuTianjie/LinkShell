import React from "react";
import { Platform, View, type ViewProps } from "react-native";
import { BlurView } from "expo-blur";
import {
  GlassView,
  isLiquidGlassAvailable,
} from "expo-glass-effect";

const liquidGlass = isLiquidGlassAvailable();

interface GlassBarProps extends ViewProps {
  /** "regular" (default) or "clear" */
  glassStyle?: "regular" | "clear";
  /** expo-blur intensity for iOS < 26 fallback (default 80) */
  blurIntensity?: number;
  /** expo-blur tint — use system material variants for glass-like look */
  blurTint?: "light" | "dark" | "default" | "systemThinMaterialDark" | "systemThinMaterialLight" | "systemChromeMaterialDark" | "systemChromeMaterialLight" | "systemUltraThinMaterialDark" | "systemUltraThinMaterialLight";
  /** fallback background color for Android / unsupported */
  fallbackColor?: string;
  children?: React.ReactNode;
}

export function GlassBar({
  glassStyle = "regular",
  blurIntensity = 80,
  blurTint = "systemThinMaterialDark",
  fallbackColor = "rgba(30,30,30,0.85)",
  style,
  children,
  ...rest
}: GlassBarProps) {
  if (liquidGlass) {
    return (
      <GlassView
        glassEffectStyle={glassStyle}
        style={[{ overflow: "hidden" }, style]}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }

  if (Platform.OS === "ios") {
    return (
      <BlurView
        intensity={blurIntensity}
        tint={blurTint}
        style={[{ overflow: "hidden" }, style]}
        {...rest}
      >
        {children}
      </BlurView>
    );
  }

  return (
    <View style={[{ backgroundColor: fallbackColor, overflow: "hidden" }, style]} {...rest}>
      {children}
    </View>
  );
}
