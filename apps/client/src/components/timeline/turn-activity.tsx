import { ELAPSED_FROM, formatElapsed } from "@linkshell/client-core";
import { useIsFocused } from "expo-router/react-navigation";
import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import Animated, { FadeInDown, useReducedMotion } from "react-native-reanimated";
import type { TurnActivityState } from "@/lib/turn-activity";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Text } from "../fixed-text";
import { LiveDot } from "../status";

const working = {
  "0%": { opacity: 0.45, transform: [{ scaleY: 0.45 }] },
  "40%": { opacity: 1, transform: [{ scaleY: 1 }] },
  "80%": { opacity: 0.45, transform: [{ scaleY: 0.45 }] },
  "100%": { opacity: 0.45, transform: [{ scaleY: 0.45 }] },
};

/** How long the turn has run, counted on the phone: the clock needs nothing from the computer. */
function Elapsed({ since, visible }: { since: number; visible: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);
  const elapsed = now - since;
  if (elapsed < ELAPSED_FROM) return null;
  return <Text style={[type.footnote, { color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }]}>{formatElapsed(elapsed)}</Text>;
}

/** Lives below the latest message, outside the saved conversation. */
export function TurnActivity({ activity, onLayout }: { activity: TurnActivityState; onLayout: () => void }) {
  const reduceMotion = useReducedMotion();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => subscription.remove();
  }, []);
  const visible = focused && foreground;
  const animate = activity.animated && visible && !reduceMotion;
  const color = activity.tone === "active" ? colors.running : activity.tone === "waiting" ? colors.waiting : activity.tone === "error" ? colors.danger : colors.tertiaryLabel;
  return (
    <Animated.View
      entering={reduceMotion || !visible ? undefined : FadeInDown.duration(180)}
      onLayout={onLayout}
      accessible
      accessibilityLabel={activity.label}
      accessibilityLiveRegion="polite"
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 6, minHeight: 44 }}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 26, height: 20, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 }}>
        {activity.animated ? [0, 1, 2].map((index) => (
          <Animated.View
            key={index}
            style={[
              { width: 4, height: 14, borderRadius: 2, backgroundColor: color },
              animate ? { animationName: working, animationDuration: "1100ms", animationDelay: `${index * 140}ms`, animationIterationCount: "infinite", animationTimingFunction: "ease-in-out" } : null,
            ]}
          />
        )) : <LiveDot size={8} color={color} live={false} />}
      </View>
      <Text numberOfLines={2} style={[type.subhead, { flexShrink: 1, color: activity.tone === "active" ? colors.label : colors.secondaryLabel }]}>{activity.label}</Text>
      {activity.startedAt !== undefined ? <Elapsed since={activity.startedAt} visible={visible} /> : null}
    </Animated.View>
  );
}
