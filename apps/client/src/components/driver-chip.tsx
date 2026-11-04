import type { SessionDriver } from "@linkshell/wire";
import { View } from "react-native";
import { Text } from "@/components/fixed-text";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";
import { Icon } from "./icon";

/** Who is driving a handoff session: the desktop terminal or this phone. A grey tag either way: it's a fact, not a state. */
export function DriverChip({ driver }: { driver?: SessionDriver }) {
  if (driver !== "desktop" && driver !== "remote") return null;
  const desktop = driver === "desktop";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        paddingHorizontal: 6,
        height: 18,
        borderRadius: radius.chip,
        borderCurve: "continuous",
        backgroundColor: colors.fill,
      }}
    >
      <Icon
        sf={desktop ? "laptopcomputer" : "iphone"}
        md={desktop ? "laptop_mac" : "smartphone"}
        size={11}
        color={colors.secondaryLabel}
      />
      <Text style={[type.caption, { color: colors.secondaryLabel, fontWeight: "600" }]}>
        {desktop ? "电脑" : "手机"}
      </Text>
    </View>
  );
}
