import { useState } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { cubicBezier } from "react-native-reanimated";

const EASE_OUT = cubicBezier(0.23, 1, 0.32, 1);

/** A pressable that dips to 97% while held — the app's one press feedback. */
export function PressableScale({
  style,
  outerStyle,
  pressedScale = 0.97,
  children,
  ...props
}: Omit<PressableProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle>;
  /** Layout of the pressable itself in its parent (`flex: 1` to share a row); `style` is what scales inside it. */
  outerStyle?: StyleProp<ViewStyle>;
  pressedScale?: number;
  children: React.ReactNode;
}) {
  const [pressed, setPressed] = useState(false);
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
      <Animated.View
        style={[
          {
            transform: [{ scale: pressed ? pressedScale : 1 }],
            transitionProperty: "transform",
            transitionDuration: "120ms",
            transitionTimingFunction: EASE_OUT,
          },
          style,
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}
