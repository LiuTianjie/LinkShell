import { BlurView } from "expo-blur";
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable, type GlassViewProps } from "expo-glass-effect";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform, StyleSheet, useColorScheme, View, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "@/theme/colors";

const liquidGlass = isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

function useReduceTransparency(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceTransparencyEnabled().then(setReduce);
    const subscription = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setReduce);
    return () => subscription.remove();
  }, []);
  return reduce;
}

/**
 * Floating chrome: liquid glass on iOS 26, a material blur before that, and a
 * solid surface when the user asked for less transparency. Never clip it or
 * fade it; it clips itself to its own borderRadius.
 */
export function Glass({
  style,
  interactive = false,
  tint,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  interactive?: boolean;
  tint?: GlassViewProps["tintColor"];
  children?: React.ReactNode;
}) {
  const reduceTransparency = useReduceTransparency();
  const dark = useColorScheme() === "dark";
  if (Platform.OS === "android") {
    // Android can only blur a declared target view; floating chrome over live
    // content gets a frosted solid surface instead, like Material 3's elevated sheets.
    return (
      <View
        style={[
          {
            backgroundColor: tint ?? (dark ? "rgba(38,39,46,0.97)" : "rgba(252,252,255,0.97)"),
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: dark ? "rgba(255,255,255,0.10)" : "rgba(10,12,40,0.08)",
            boxShadow: dark ? "0 6px 24px rgba(0,0,0,0.5)" : "0 6px 24px rgba(20,24,60,0.12)",
          },
          style,
        ]}
      >
        {children}
      </View>
    );
  }
  if (reduceTransparency) {
    return <View style={[{ backgroundColor: tint ?? colors.cardRaised, borderCurve: "continuous" }, style]}>{children}</View>;
  }
  if (liquidGlass) {
    return (
      <GlassView style={[{ borderCurve: "continuous" }, style]} isInteractive={interactive} tintColor={tint}>
        {children}
      </GlassView>
    );
  }
  return (
    <BlurView
      tint="systemChromeMaterial"
      intensity={90}
      style={[{ overflow: "hidden", borderCurve: "continuous", backgroundColor: tint }, style]}
    >
      {children}
    </BlurView>
  );
}

export const hasLiquidGlass = liquidGlass;
