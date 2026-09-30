import { Text, View } from "react-native";
import Animated, { FadeOut, useReducedMotion } from "react-native-reanimated";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

const pulse = {
  "0%": { opacity: 0.45 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.45 },
};

function Bar({ width, height = 14, align = "flex-start", radius = 7 }: { width: `${number}%` | number; height?: number; align?: "flex-start" | "flex-end"; radius?: number }) {
  return <View style={{ width, height, borderRadius: radius, backgroundColor: colors.fill, alignSelf: align }} />;
}

/** Placeholder conversation shown while a session's history loads. */
export function TimelineSkeleton({ label }: { label: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <Animated.View
      exiting={FadeOut.duration(200)}
      pointerEvents="none"
      style={{ position: "absolute", left: 0, right: 0, top: 120, paddingHorizontal: 16, gap: 22 }}
    >
      <Animated.View
        style={[
          { gap: 22 },
          reduceMotion ? null : { animationName: pulse, animationDuration: "1400ms", animationIterationCount: "infinite", animationTimingFunction: "ease-in-out" },
        ]}
      >
        <Bar width="62%" height={40} align="flex-end" radius={20} />
        <View style={{ gap: 9 }}>
          <Bar width="92%" />
          <Bar width="86%" />
          <Bar width="54%" />
        </View>
        <View style={{ gap: 8 }}>
          <Bar width="70%" height={26} radius={9} />
          <Bar width="64%" height={26} radius={9} />
        </View>
        <View style={{ gap: 9 }}>
          <Bar width="90%" />
          <Bar width="40%" />
        </View>
      </Animated.View>
      <Text style={[type.footnote, { color: colors.tertiaryLabel, textAlign: "center" }]}>{label}</Text>
    </Animated.View>
  );
}
