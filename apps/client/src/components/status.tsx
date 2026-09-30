import type { SessionState } from "@linkshell/wire";
import { View, type ColorValue } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { colors } from "@/theme/colors";

const ring = {
  from: { transform: [{ scale: 1 }], opacity: 0.55 },
  to: { transform: [{ scale: 2.6 }], opacity: 0 },
};

/** A dot that softly radiates while something is live. */
export function LiveDot({ color = colors.running, size = 8, live = true }: { color?: ColorValue; size?: number; live?: boolean }) {
  const reduceMotion = useReducedMotion();
  return (
    <View style={{ width: size, height: size }}>
      {live && !reduceMotion ? (
        <Animated.View
          style={{
            position: "absolute",
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            animationName: ring,
            animationDuration: "1600ms",
            animationIterationCount: "infinite",
            animationTimingFunction: "ease-out",
          }}
        />
      ) : null}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}

export function stateColor(state: SessionState): ColorValue {
  switch (state) {
    case "running":
      return colors.running;
    case "waiting":
      return colors.waiting;
    case "error":
      return colors.danger;
    case "offline":
      return colors.tertiaryLabel;
    default:
      return colors.ok;
  }
}

export function stateLabel(state: SessionState): string {
  switch (state) {
    case "running":
      return "运行中";
    case "waiting":
      return "等待你";
    case "error":
      return "出错";
    case "offline":
      return "离线";
    default:
      return "空闲";
  }
}
