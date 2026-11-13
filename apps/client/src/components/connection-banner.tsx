import { translateSocketError } from "@linkshell/client-core";
import { HOST_PROTOCOL } from "@linkshell/wire";
import { router } from "expo-router";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { useClient, useConnection, useConnectionStatus } from "@/lib/client";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";
import { Icon } from "./icon";

/** Normalizes transport/relay/LAN errors into user-facing Chinese without raw socket noise. */
export function formatConnectionDetail(detail?: string): string | undefined {
  const raw = detail?.trim();
  if (!raw) return undefined;
  const translated = translateSocketError(raw);
  if (/^bad_identity$/i.test(translated) || /invalid .*signature|identity mismatch/i.test(translated)) {
    return "电脑的身份校验没有通过，请重新配对";
  }
  if (/^not_paired$/i.test(translated)) return "这台电脑不再信任这台设备，请重新配对";
  if (/^not_allowed$/i.test(translated)) return "没有权限连接这台电脑";
  if (/^not_admitted$/i.test(translated)) return "电脑当前未获网关准入";
  if (/^accounts_disabled$/i.test(translated)) return "当前网关未开启账号登录，请扫码配对";
  if (/^(?:invalid_lan_frame|lan_decrypt_failed)$/i.test(translated)) return "局域网加密握手失败，正在重连";
  if (/^(?:lan_error|gateway_fallback_failed)$/i.test(translated)) return "局域网或网关连接切换失败";
  if (/^(?:closed|connection (?:closed|lost)|stopped)$/i.test(translated)) return "连接已断开";
  if (/^not connected to the gateway$/i.test(translated)) return "没有连上网关";
  if (/^no answer from the gateway$/i.test(translated)) return "网关没有响应";
  if (/^no answer from the computer$/i.test(translated)) return "电脑没有响应";
  if (/could not connect to the server|cannot connect to host/i.test(translated)) {
    return "无法连接到服务器，请检查网络设置";
  }
  if (/hostname could not be found|dns/i.test(translated)) {
    return "找不到服务器地址，请检查网络设置";
  }
  if (/operation couldn['’]t be completed|NWError|POSIXError|kCFStreamError|NSURLErrorDomain|OSStatus/i.test(translated)) {
    return "网络连接异常，请检查网络设置";
  }
  if (!/[\u4e00-\u9fff]/.test(translated)) {
    return "网络连接异常，请检查网络设置";
  }
  return translated;
}

/** Shown while the host is unreachable; tapping opens the connection sheet. */
export function ConnectionBanner() {
  const status = useConnectionStatus();
  const detail = useClient((state) => state.statusDetail);
  const formattedDetail = formatConnectionDetail(detail);
  const { link } = useConnection();
  // An absent revision is a host from before revisions: older than this app either way.
  const outdated = useClient((state) => !!state.machine && (state.machine.protocol ?? 0) < HOST_PROTOCOL);
  if (status === "online" && outdated) {
    return (
      <View style={{ marginTop: 8, flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.card }}>
        <Icon sf="arrow.down.circle" md="system_update" size={18} color={colors.secondaryLabel} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>电脑上的 LinkShell 比 App 旧</Text>
          <Text numberOfLines={3} style={[type.footnote, { color: colors.secondaryLabel }]}>部分新功能暂时用不了：桌面版会自动更新，命令行版在电脑上运行 linkshell upgrade</Text>
        </View>
      </View>
    );
  }
  if (status === "online" || status === "idle") return null;
  if (status === "locked") {
    return (
      <Pressable
        onPress={() => router.push("/unlock")}
        accessibilityRole="button"
        accessibilityHint="输入访问密码"
        style={{ marginTop: 8, flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.card }}
      >
        <Icon sf="lock.fill" md="lock" size={18} color={colors.secondaryLabel} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>这台电脑设置了访问密码</Text>
          <Text numberOfLines={2} style={[type.footnote, { color: colors.secondaryLabel }]}>轻点输入密码后继续</Text>
        </View>
        <Icon sf="chevron.right" md="chevron_right" size={13} color={colors.tertiaryLabel} weight="semibold" />
      </Pressable>
    );
  }
  const connecting = status === "connecting";
  return (
    <Pressable
      onPress={() => router.push("/connect")}
      onLongPress={() => link.reconnectNow(true)}
      accessibilityRole="button"
      accessibilityHint="打开连接设置"
      style={{
        marginTop: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 14,
        borderRadius: radius.card,
        borderCurve: "continuous",
        backgroundColor: colors.card,
      }}
    >
      {/* A connection that fails is an error (danger), not something waiting on the user (amber). */}
      {connecting ? (
        <ActivityIndicator color={colors.secondaryLabel} />
      ) : (
        <Icon sf="wifi.exclamationmark" md="wifi_off" size={20} color={colors.danger} />
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>
          {connecting ? "正在连接电脑…" : "电脑暂时连不上"}
        </Text>
        <Text numberOfLines={2} style={[type.footnote, { color: colors.secondaryLabel }]}>
          {connecting ? "稍等片刻" : `${formattedDetail ? `${formattedDetail} · ` : ""}会自动重试，轻点查看连接设置`}
        </Text>
      </View>
      <Icon sf="chevron.right" md="chevron_right" size={13} color={colors.tertiaryLabel} weight="semibold" />
    </Pressable>
  );
}
