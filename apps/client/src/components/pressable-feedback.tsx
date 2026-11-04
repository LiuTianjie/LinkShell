import { useState } from "react";
import { Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import { colors } from "@/theme/colors";

const CORNERS = [
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "borderCurve",
] as const;

/**
 * A held row's `fill` wash. It sits over the row's own background instead of
 * replacing it: in dark mode `fill` over the black page is the card's own
 * colour, so a replaced background would show no feedback at all. Put it
 * first inside the view that draws the background, with that view's corners.
 */
export function PressedWash({ pressed, style }: { pressed: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        style,
        {
          backgroundColor: colors.fill,
          opacity: pressed ? 1 : 0,
          transitionProperty: "opacity",
          transitionDuration: pressed ? "0ms" : "150ms",
          transitionTimingFunction: "ease-out",
        },
      ]}
    />
  );
}

/**
 * The app's press feedback for custom rows and buttons, which never scales: a
 * row gets the `fill` wash behind its content, a button drops to 60%. Pass
 * children as a function to draw the wash yourself (`PressedWash`) when the
 * background is on a child rather than on `style`.
 */
export function PressableFeedback({
  style,
  outerStyle,
  feedback = "row",
  children,
  ...props
}: Omit<PressableProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle>;
  /** Layout of the pressable itself in its parent (`flex: 1` to share a row); `style` is the visible row or button inside it. */
  outerStyle?: StyleProp<ViewStyle>;
  feedback?: "row" | "button";
  children: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode);
}) {
  const [pressed, setPressed] = useState(false);
  const custom = typeof children === "function";
  const flat = StyleSheet.flatten(style) ?? {};
  const corners = Object.fromEntries(CORNERS.filter((key) => flat[key] !== undefined).map((key) => [key, flat[key]])) as ViewStyle;
  return (
    <Pressable
      {...props}
      onPressIn={(event) => {
        setPressed(true);
        props.onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        props.onPressOut?.(event);
      }}
      pressRetentionOffset={16}
      style={outerStyle}
    >
      {feedback === "button" && !custom ? (
        <Animated.View
          style={[
            style,
            {
              opacity: (typeof flat.opacity === "number" ? flat.opacity : 1) * (pressed ? 0.6 : 1),
              transitionProperty: "opacity",
              transitionDuration: pressed ? "0ms" : "150ms",
              transitionTimingFunction: "ease-out",
            },
          ]}
        >
          {children}
        </Animated.View>
      ) : (
        <View style={style}>
          {custom ? null : <PressedWash pressed={pressed} style={corners} />}
          {custom ? children({ pressed }) : children}
        </View>
      )}
    </Pressable>
  );
}
