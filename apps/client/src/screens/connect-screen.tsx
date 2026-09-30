import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { LiveDot } from "@/components/status";
import { useClient, useConnection } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { normalizeHostUrl } from "@/lib/settings";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

const HOST_COMMAND = "linkshell host --dev-port 7878";

export function ConnectScreen() {
  const { url, setUrl, link } = useConnection();
  const status = useClient((state) => state.status);
  const detail = useClient((state) => state.statusDetail);
  const machine = useClient((state) => state.machine);
  const [draft, setDraft] = useState(url);
  const [invalid, setInvalid] = useState(false);
  const online = status === "online";
  const normalized = normalizeHostUrl(draft);
  const changed = normalized !== null && normalized !== url;

  const connect = () => {
    if (!normalized) {
      setInvalid(true);
      haptics.error();
      return;
    }
    haptics.medium();
    if (normalized === url) link.reconnectNow();
    else setUrl(normalized);
    router.back();
  };

  return (
    <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 22, gap: 18 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={[type.title, { flex: 1, color: colors.label }]}>连接电脑</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="关闭"
          hitSlop={10}
          style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}
        >
          <Icon sf="xmark" md="close" size={13} color={colors.secondaryLabel} weight="bold" />
        </Pressable>
      </View>

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

      <Button title={changed ? "连接" : "重新连接"} variant="primary" size="large" onPress={connect} />

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
    </View>
  );
}
