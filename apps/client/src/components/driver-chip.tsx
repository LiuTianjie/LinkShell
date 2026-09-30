import type { SessionDriver } from "@linkshell/wire";
import { Text, View } from "react-native";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "./icon";

/** Who is driving a handoff session: the desktop terminal or this phone. */
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
        borderRadius: 6,
        backgroundColor: desktop ? colors.fill : colors.accentSoft,
      }}
    >
      <Icon
        sf={desktop ? "laptopcomputer" : "iphone"}
        md={desktop ? "laptop_mac" : "smartphone"}
        size={11}
        color={desktop ? colors.secondaryLabel : colors.accent}
      />
      <Text style={[type.caption2, { color: desktop ? colors.secondaryLabel : colors.accent, fontWeight: "600" }]}>
        {desktop ? "电脑" : "手机"}
      </Text>
    </View>
  );
}
