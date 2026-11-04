import { View } from "react-native";
import { Text } from "@/components/fixed-text";
import Animated, { FadeOut } from "react-native-reanimated";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";

function Bar({ width, height = 14, align = "flex-start", corner = height / 2 }: { width: `${number}%` | number; height?: number; align?: "flex-start" | "flex-end"; corner?: number }) {
  return <View style={{ width, height, borderRadius: corner, borderCurve: "continuous", backgroundColor: colors.fill, alignSelf: align }} />;
}

/** Placeholder conversation shown while a session's history loads. It holds still: the label says it's loading, and nothing pulses. */
export function TimelineSkeleton({ label, top = 16 }: { label: string; top?: number }) {
  return (
    <Animated.View
      exiting={FadeOut.duration(200)}
      pointerEvents="none"
      style={{ position: "absolute", left: 0, right: 0, top, paddingHorizontal: 16, gap: 22 }}
    >
      <View style={{ gap: 22 }}>
        <Bar width="62%" height={40} align="flex-end" corner={radius.card} />
        <View style={{ gap: 9 }}>
          <Bar width="92%" />
          <Bar width="86%" />
          <Bar width="54%" />
        </View>
        <View style={{ gap: 8 }}>
          <Bar width="70%" height={26} corner={radius.chip} />
          <Bar width="64%" height={26} corner={radius.chip} />
        </View>
        <View style={{ gap: 9 }}>
          <Bar width="90%" />
          <Bar width="40%" />
        </View>
      </View>
      <Text style={[type.footnote, { color: colors.tertiaryLabel, textAlign: "center" }]}>{label}</Text>
    </Animated.View>
  );
}
