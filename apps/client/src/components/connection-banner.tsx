import { router } from "expo-router";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { useClient, useConnection } from "@/lib/client";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "./icon";

/** Shown while the host is unreachable; tapping opens the connection sheet. */
export function ConnectionBanner() {
  const status = useClient((state) => state.status);
  const detail = useClient((state) => state.statusDetail);
  const { link } = useConnection();
  if (status === "online" || status === "idle") return null;
  const connecting = status === "connecting";
  return (
    <Pressable
      onPress={() => router.push("/connect")}
      onLongPress={() => link.reconnectNow()}
      accessibilityRole="button"
      accessibilityHint="打开连接设置"
      style={{
        marginTop: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 14,
        borderRadius: 20,
        borderCurve: "continuous",
        backgroundColor: connecting ? colors.card : colors.waitingSoft,
      }}
    >
      {connecting ? (
        <ActivityIndicator color={colors.secondaryLabel} />
      ) : (
        <Icon sf="wifi.exclamationmark" md="wifi_off" size={20} color={colors.waiting} />
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>
          {connecting ? "正在连接电脑…" : "电脑暂时连不上"}
        </Text>
        <Text numberOfLines={2} style={[type.footnote, { color: colors.secondaryLabel }]}>
          {connecting ? "稍等片刻" : `${detail ? `${detail} · ` : ""}会自动重试，轻点查看连接设置`}
        </Text>
      </View>
      <Icon sf="chevron.right" md="chevron_right" size={13} color={colors.tertiaryLabel} weight="semibold" />
    </Pressable>
  );
}
