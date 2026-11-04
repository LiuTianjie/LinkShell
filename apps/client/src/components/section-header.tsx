import { View, type ColorValue } from "react-native";
import { Text } from "@/components/fixed-text";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

export function SectionHeader({ title, count, tone }: { title: string; count?: number; tone?: ColorValue }) {
  return (
    <View
      accessibilityRole="header"
      style={{ flexDirection: "row", alignItems: "baseline", gap: 6, paddingHorizontal: 6, paddingTop: 20, paddingBottom: 7 }}
    >
      <Text style={[type.subhead, { fontWeight: "600", color: tone ?? colors.secondaryLabel }]}>{title}</Text>
      {count ? (
        <Text style={[type.subhead, { fontWeight: "500", color: tone ?? colors.tertiaryLabel, fontVariant: ["tabular-nums"] }]}>
          {count}
        </Text>
      ) : null}
    </View>
  );
}
