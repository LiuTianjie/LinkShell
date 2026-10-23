import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { usePageInsets } from "@/components/adaptive-page";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Icon } from "@/components/icon";
import { LiveDot } from "@/components/status";
import { useClient, useConnection, useHasComputer } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { reconnectRelays, useComputers } from "@/lib/computers";
import { normalizeHostUrl } from "@/lib/settings";
import { SheetHeader } from "@/components/sheet-header";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

const HOST_COMMAND = "linkshell host --dev-port 7878";
// The host's TCP port listens on loopback only and is for development: a phone can't reach it,
// so a release build has no address form, only the connection it already has.
const LAN_FORM = __DEV__;

export function ConnectScreen() {
  const insets = usePageInsets();
  const { url, computer, setUrl, link } = useConnection();
  const status = useClient((state) => state.status);
  const detail = useClient((state) => state.statusDetail);
  const machine = useClient((state) => state.machine);
  // Through a gateway: `url` is the gateway's, not an address to type in or save as a LAN computer.
  const throughGateway = computer.kind === "relay";
  const hasComputer = useHasComputer();
  const [draft, setDraft] = useState(throughGateway ? "" : url);
  const [invalid, setInvalid] = useState(false);
  const online = status === "online";
  const normalized = normalizeHostUrl(draft);
  const changed = normalized !== null && normalized !== url;

  const reconnect = () => {
    haptics.medium();
    // No computer yet: there is no connection to make again.
    if (hasComputer) {
      reconnectRelays();
      link.reconnectNow();
    }
    router.back();
  };

  const connect = () => {
    if (throughGateway && draft.trim() === "") return reconnect();
    if (!normalized) {
      setInvalid(true);
      haptics.error();
      return;
    }
    haptics.medium();
    if (normalized === url && useComputers.getState().saved.direct.some((entry) => entry.url === normalized)) link.reconnectNow();
    else setUrl(normalized);
    router.back();
  };

  return (
    <KeyboardAwareScrollView contentInsetAdjustmentBehavior="never" style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 24, gap: 18 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" bottomOffset={20}>
      <SheetHeader
        title="连接电脑"
        actions={[{ key: "connect", label: LAN_FORM && changed ? "连接" : "重新连接", icon: { sf: "link", md: "link" }, onPress: LAN_FORM ? connect : reconnect, prominent: true }]}
      />

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <LiveDot size={8} color={online ? colors.ok : status === "connecting" ? colors.running : colors.waiting} live={status !== "stopped"} />
        <Text style={[type.subhead, { color: colors.secondaryLabel, flex: 1 }]}>
          {online
            ? `已连接 ${machine?.hostname.replace(/\.local$/, "") ?? ""}`
            : status === "connecting"
              ? "正在连接…"
              : `连不上${detail ? ` · ${detail}` : ""}`}
        </Text>
      </View>

      {LAN_FORM ? (
        <>
      <View style={{ gap: 8 }}>
        <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "600" }]}>电脑地址</Text>
        <TextInput
          value={draft}
          onChangeText={(value) => {
            setDraft(value);
            setInvalid(false);
          }}
          onSubmitEditing={connect}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          placeholder="ws://192.168.1.10:7878"
          placeholderTextColor={colors.placeholder as string}
          style={{
            fontFamily: mono,
            fontSize: 15,
            color: colors.label,
            backgroundColor: colors.fill,
            borderRadius: 14,
            borderCurve: "continuous",
            paddingHorizontal: 14,
            paddingVertical: 13,
            borderWidth: invalid ? 1 : 0,
            borderColor: colors.danger,
          }}
        />
        {invalid ? <Text style={[type.footnote, { color: colors.danger }]}>地址格式不对，例如 192.168.1.10:7878</Text> : null}
      </View>


      <View style={{ gap: 8, paddingTop: 4 }}>
        <Text style={[type.footnote, { color: colors.secondaryLabel }]}>在电脑终端里运行下面的命令，保持它在运行：</Text>
        <Pressable
          onPress={() => {
            void Clipboard.setStringAsync(HOST_COMMAND);
            haptics.success();
          }}
          accessibilityRole="button"
          accessibilityHint="复制命令"
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            padding: 12,
            borderRadius: 14,
            borderCurve: "continuous",
            backgroundColor: colors.code,
          }}
        >
          <Text selectable style={{ flex: 1, fontFamily: mono, fontSize: 13, color: colors.codeText }}>
            {HOST_COMMAND}
          </Text>
          <Icon sf="doc.on.doc" md="content_copy" size={14} color={colors.secondaryLabel} />
        </Pressable>
      </View>
        </>
      ) : (
        <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
          {hasComputer
            ? "连接会自动重试。一直连不上时，确认电脑开着、联网，并且 LinkShell 在运行（终端里运行 linkshell status 查看）。"
            : "还没有添加电脑：在电脑上运行 linkshell pair，再用这台手机扫码。"}
        </Text>
      )}
    </KeyboardAwareScrollView>
  );
}
