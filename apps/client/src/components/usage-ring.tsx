import { Alert, Pressable } from "react-native";
import { Text } from "@/components/fixed-text";
import Svg, { Circle } from "react-native-svg";
import { compactNumber } from "@/lib/format";
import { palette } from "@/theme/colors";
import { useColorScheme } from "react-native";

/** How full the context window is, as a small ring. */
export function UsageRing({ used, window }: { used?: number; window?: number }) {
  const dark = useColorScheme() === "dark";
  if (!used || !window) return null;
  const ratio = Math.min(1, used / window);
  const size = 15;
  const stroke = 2.2;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const color = ratio > 0.85 ? "#e5484d" : ratio > 0.65 ? "#e8830c" : dark ? palette.dark.secondaryLabel : palette.light.secondaryLabel;
  return (
    // A gauge with its number, so it never reads as a loading spinner.
    <Pressable
      hitSlop={8}
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", minWidth: 44, minHeight: 44, gap: 4 }}
      accessibilityRole="button"
      accessibilityLabel={`上下文已用 ${Math.round(ratio * 100)}%`}
      onPress={() =>
        Alert.alert(
          `上下文已用 ${Math.round(ratio * 100)}%`,
          `${compactNumber(used)} / ${compactNumber(window)} tokens。快满时 Agent 会自动压缩较早的内容。`,
        )
      }
    >
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={dark ? "rgba(255,255,255,0.15)" : "rgba(16,16,28,0.12)"} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <Text style={{ fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"], color }}>{Math.round(ratio * 100)}%</Text>
    </Pressable>
  );
}
