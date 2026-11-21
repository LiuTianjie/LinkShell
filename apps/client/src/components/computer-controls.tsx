import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { Text } from "./fixed-text";
import { Icon, type IconProps } from "./icon";
import { useClient, useConnection } from "@/lib/client";
import { computerDisplayName, useComputerNames } from "@/lib/computer-names";
import { computerDescription, computerProfile } from "@/lib/computer-profile";
import { useComputers } from "@/lib/computers";
import { useLocale } from "@/lib/locale";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";

export function useComputerPresentation() {
  const { computer } = useConnection();
  const machine = useClient((s) => s.machine);
  const cache = useComputers((s) => s.saved.profiles?.[computer.key]);
  const names = useComputerNames((s) => s.names);
  const { t, pick, locale } = useLocale();
  const profile = computerProfile(computer, cache, machine);
  const hybrid = computer.kind === "relay" ? Boolean(computer.lanUrl) : Boolean(computer.fallbackGateway);
  const transport = hybrid
    ? pick({ zh: "局域网优先 · 中继备用", en: "LAN first · Relay fallback", ja: "LAN 優先・リレー併用" })
    : computer.kind === "relay"
      ? t("connection.gatewayRelay")
      : t("connection.lanDirect");
  return {
    computer,
    machine,
    profile,
    name: computerDisplayName(computer, names),
    description: computerDescription(profile, locale),
    transport,
  };
}

export function ComputerSheetHeading({ title }: { title: string }) {
  const { t } = useLocale();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 14 }}>
      <Text accessibilityRole="header" style={[type.title, { flex: 1, color: colors.label }]}>
        {title}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        onPress={() => router.back()}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.fill,
          }}
        >
          <Icon sf="xmark" md="close" size={16} color={colors.label} />
        </View>
      </Pressable>
    </View>
  );
}

export function ComputerAction({
  label,
  detail,
  icon,
  expanded,
  onPress,
}: {
  label: string;
  detail?: string;
  icon?: Pick<IconProps, "sf" | "md">;
  expanded?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={expanded == null ? undefined : { expanded }}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={({ pressed }) => ({
        minHeight: 46,
        paddingVertical: 8,
        paddingHorizontal: 4,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderRadius: radius.control,
        backgroundColor: pressed ? colors.fill : "transparent",
      })}
    >
      {icon ? <Icon {...icon} size={18} color={colors.secondaryLabel} /> : null}
      <Text style={[type.callout, { flex: 1, color: colors.label, fontWeight: "600" }]}>{label}</Text>
      {detail ? (
        <Text
          numberOfLines={2}
          style={[type.footnote, { maxWidth: "49%", textAlign: "right", color: colors.secondaryLabel }]}
        >
          {detail}
        </Text>
      ) : null}
      <Icon
        sf={expanded == null ? "chevron.right" : expanded ? "chevron.up" : "chevron.down"}
        md={expanded == null ? "chevron_right" : expanded ? "expand_less" : "expand_more"}
        size={13}
        color={colors.secondaryLabel}
      />
    </Pressable>
  );
}
