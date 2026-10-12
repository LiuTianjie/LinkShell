import { View } from "react-native";
import Animated, { FadeInDown, useReducedMotion } from "react-native-reanimated";
import type { TurnActivityState } from "@/lib/turn-activity";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Text } from "../fixed-text";
import { LiveDot } from "../status";

/** Lives below the latest message, outside the saved conversation. */
export function TurnActivity({ activity, onLayout }: { activity: TurnActivityState; onLayout: () => void }) {
  const reduceMotion = useReducedMotion();
  const color = activity.tone === "active" ? colors.running : activity.tone === "waiting" ? colors.waiting : activity.tone === "error" ? colors.danger : colors.tertiaryLabel;
  return (
    <Animated.View
      entering={reduceMotion ? undefined : FadeInDown.duration(180)}
      onLayout={onLayout}
      accessible
      accessibilityLabel={activity.label}
      accessibilityLiveRegion="polite"
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 6, minHeight: 44 }}
    >
      <View style={{ width: 12, alignItems: "center" }}><LiveDot size={6} color={color} live={activity.animated} /></View>
      <Text numberOfLines={2} style={[type.footnote, { flex: 1, color: colors.secondaryLabel }]}>{activity.label}</Text>
    </Animated.View>
  );
}
