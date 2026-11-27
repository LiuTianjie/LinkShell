import * as Clipboard from "expo-clipboard";
import { formatConnectionDetail } from "@/components/connection-banner";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Switch, View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { usePageInsets } from "@/components/adaptive-page";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { LinkDot } from "@/components/status";
import { useClient, useConnection, useConnectionStatus, useHasComputer } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import {
  isLanDiscoveryAvailable,
  lanHostDisplayName,
  lanHostUrl,
  listComputers,
  matchLanHostToComputer,
  normalizeLanUrl,
  reconnectRelays,
  useComputers,
  type DiscoveredLanHost,
} from "@/lib/computers";
import { useNativeLanDiscovery } from "@/lib/lan-discovery-native";
import { useLocale } from "@/lib/locale";
import { SheetHeader } from "@/components/sheet-header";
import { colors } from "@/theme/colors";
import { mono, radius, type } from "@/theme/type";

const HOST_COMMAND = "linkshell host --daemon";

export function ConnectScreen() {
  const insets = usePageInsets();
  const { t, pick } = useLocale();
  const { url, computer, setUrl, link } = useConnection();
  const status = useConnectionStatus();
  const detail = useClient((state) => state.statusDetail);
  const machine = useClient((state) => state.machine);
  const throughGateway = computer.kind === "relay";
  const hasComputer = useHasComputer();
  const initialDraft = throughGateway ? (computer.lanUrl ?? "") : url;
  const [draft, setDraft] = useState(initialDraft);
  const [lanE2ee, setLanE2ee] = useState(throughGateway ? Boolean(computer.lanE2ee) : false);
  const [invalid, setInvalid] = useState(false);
  const savedComputers = useComputers((state) => state.saved);
  const liveComputers = useComputers((state) => state.live);
  const lanHosts = useComputers((state) => state.lanHosts);
  const discoverySupported = isLanDiscoveryAvailable();
  useNativeLanDiscovery(true);
  const allComputers = useMemo(
    () => listComputers({ saved: savedComputers, live: liveComputers, lanHosts }),
    [savedComputers, liveComputers, lanHosts],
  );
  const online = status === "online";
  const normalized = normalizeLanUrl(draft);
  const changed = Boolean(normalized && normalized !== initialDraft);

  const connectDiscoveredHost = (host: DiscoveredLanHost) => {
    const discoveredUrl = lanHostUrl(host);
    if (!discoveredUrl) return;
    haptics.medium();
    const computers = useComputers.getState();
    const matched = allComputers.find((item) => Boolean(matchLanHostToComputer(host, item)));
    if (matched) {
      if (matched.kind === "relay") {
        computers.setLanUrl(matched.key, discoveredUrl, {
          e2ee: matched.key === computer.key ? lanE2ee : (matched.lanE2ee ?? true),
        });
      }
      if (matched.key !== computer.key) {
        computers.select(matched.key);
      } else {
        setDraft(discoveredUrl);
        setInvalid(false);
        link.reconnectNow(true);
      }
      router.back();
      return;
    }
    const key = computers.addDirect(discoveredUrl, lanHostDisplayName(host));
    computers.select(key);
    if (!hasComputer) {
      router.dismissAll();
      router.navigate("/");
    } else {
      router.back();
    }
  };

  const reconnect = (force = false) => {
    haptics.medium();
    if (hasComputer) {
      reconnectRelays();
      link.reconnectNow(force);
    }
    router.back();
  };

  const connect = () => {
    if (throughGateway && draft.trim() === "") {
      const hadLan = Boolean(computer.lanUrl);
      if (hadLan) {
        useComputers.getState().setLanUrl(computer.key, undefined);
      }
      return reconnect(hadLan);
    }
    if (!normalized) {
      setInvalid(true);
      haptics.error();
      return;
    }
    haptics.medium();
    if (throughGateway) {
      useComputers.getState().setLanUrl(computer.key, normalized, { e2ee: lanE2ee });
      link.reconnectNow(true);
    } else if (normalized === url && useComputers.getState().saved.direct.some((entry) => entry.url === normalized)) {
      link.reconnectNow(true);
    } else {
      setUrl(normalized);
    }
    if (!hasComputer) {
      router.dismissAll();
      router.navigate("/");
    } else {
      router.back();
    }
  };

  const addSeparateDirect = () => {
    if (!normalized) {
      setInvalid(true);
      haptics.error();
      return;
    }
    haptics.medium();
    const label = pick({ zh: "局域网电脑", en: "LAN Computer", ja: "LAN コンピュータ" });
    const computers = useComputers.getState();
    computers.select(computers.addDirect(normalized, label));
    if (!hasComputer) {
      router.dismissAll();
      router.navigate("/");
    } else {
      router.back();
    }
  };

  return (
    <KeyboardAwareScrollView
      contentInsetAdjustmentBehavior="never"
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 24, gap: 18 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      bottomOffset={20}
    >
      <SheetHeader
        title={t("connection.lanDirect")}
        actions={[
          {
            key: "connect",
            label: changed ? t("common.save") : t("connection.reconnect"),
            icon: { sf: "link", md: "link" },
            onPress: connect,
            prominent: true,
          },
        ]}
      />

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <LinkDot health={online ? "online" : status === "connecting" ? "connecting" : detail ? "error" : "offline"} />
        <Text style={[type.subhead, { color: colors.secondaryLabel, flex: 1 }]}>
          {online
            ? `${t("connection.online")} ${machine?.hostname.replace(/\.local$/, "") ?? ""}`
            : status === "connecting"
              ? t("connection.connecting")
              : `${t("connection.offline")}${formatConnectionDetail(detail) ? ` · ${formatConnectionDetail(detail)}` : ""}`}
        </Text>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "600" }]}>
          {pick({
            zh: throughGateway ? `当前电脑的局域网直连地址（${computer.machine.name}）` : "电脑局域网地址",
            en: throughGateway ? `LAN fast-path address (${computer.machine.name})` : "Computer LAN Address",
            ja: throughGateway ? `LAN 直結アドレス (${computer.machine.name})` : "コンピュータの LAN アドレス",
          })}
        </Text>
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
            borderRadius: radius.control,
            borderCurve: "continuous",
            paddingHorizontal: 14,
            paddingVertical: 13,
            borderWidth: invalid ? 1 : 0,
            borderColor: colors.danger,
          }}
        />
        {invalid ? (
          <Text style={[type.footnote, { color: colors.danger }]}>
            {pick({
              zh: "地址格式无效，例如 192.168.1.10:7878 或 ws://macbook.local:7878",
              en: "Invalid address. Example: 192.168.1.10:7878 or ws://macbook.local:7878",
              ja: "形式が正しくありません（例: 192.168.1.10:7878）",
            })}
          </Text>
        ) : (
          <Text style={[type.caption, { color: colors.tertiaryLabel }]}>
            {throughGateway
              ? pick({
                  zh: "在同一 Wi-Fi 下优先走局域网毫秒级直连；离开局域网时自动无缝回退至加密网关。",
                  en: "Connects directly over local Wi-Fi and falls back automatically to the encrypted gateway when away.",
                  ja: "同一 Wi-Fi では LAN 直結を優先し、外出時は暗号化ゲートウェイへ自動フォールバックします。",
                })
              : pick({
                  zh: "输入同一 Wi-Fi 下电脑的 IP 或 .local 主机名（默认端口 7878）。",
                  en: "Enter your computer's local IP or .local hostname on the same Wi-Fi (default port 7878).",
                  ja: "同じ Wi-Fi 上の IP または .local ホスト名を入力してください（既定ポート 7878）。",
                })}
          </Text>
        )}
      </View>

      {throughGateway ? (
        <View style={{ gap: 10 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              backgroundColor: colors.card,
              borderRadius: radius.control,
              borderCurve: "continuous",
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[type.callout, { color: colors.label }]}>
                {pick({
                  zh: "局域网端到端隧道握手",
                  en: "LAN E2EE Tunnel Handshake",
                  ja: "LAN エンドツーエンド暗号化トンネル",
                })}
              </Text>
              <Text style={[type.caption, { color: colors.secondaryLabel }]}>
                {pick({
                  zh: "复用配对密钥在局域网校验身份并全程加密（裸开发端口请保持关闭）",
                  en: "Verify host identity & encrypt LAN frames (keep off for plain --dev-port)",
                  ja: "ペアリング鍵で認証・暗号化します（--dev-port の場合はオフ）",
                })}
              </Text>
            </View>
            <Switch value={lanE2ee} onValueChange={setLanE2ee} />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {computer.lanUrl ? (
              <Button
                title={pick({ zh: "清除局域网直连地址", en: "Clear LAN Fast-Path", ja: "LAN 設定をクリア" })}
                variant="tonal"
                onPress={() => {
                  useComputers.getState().setLanUrl(computer.key, undefined);
                  setDraft("");
                  link.reconnectNow(true);
                  router.back();
                }}
              />
            ) : null}
            {normalized ? (
              <Button
                title={pick({ zh: "另存为独立局域网电脑", en: "Add as Standalone LAN Host", ja: "独立した LAN ホストとして追加" })}
                variant="plain"
                onPress={addSeparateDirect}
              />
            ) : null}
          </View>
        </View>
      ) : null}

      {discoverySupported || lanHosts.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "600" }]}>
            {pick({ zh: "局域网发现的电脑", en: "Discovered on LAN", ja: "LAN 上のコンピュータ" })}
          </Text>
          {lanHosts.length > 0 ? (
            <View
              style={{
                backgroundColor: colors.card,
                borderRadius: radius.control,
                borderCurve: "continuous",
                overflow: "hidden",
              }}
            >
              {lanHosts.map((host, index) => {
                const discoveredUrl = lanHostUrl(host);
                if (!discoveredUrl) return null;
                const matched = allComputers.find((item) => Boolean(matchLanHostToComputer(host, item)));
                const isCurrent = matched?.key === computer.key;
                const badge = isCurrent
                  ? pick({ zh: "当前电脑", en: "Current", ja: "現在の端末" })
                  : matched
                    ? pick({ zh: "已添加", en: "Saved", ja: "保存済み" })
                    : pick({ zh: "局域网新主机", en: "New Host", ja: "新規" });
                return (
                  <View key={`${discoveredUrl}-${host.machineId ?? host.fingerprint ?? host.name}`}>
                    {index > 0 ? (
                      <View style={{ marginLeft: 14, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} />
                    ) : null}
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => connectDiscoveredHost(host)}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 10,
                        paddingHorizontal: 14,
                        paddingVertical: 11,
                        backgroundColor: pressed ? colors.fill : "transparent",
                      })}
                    >
                      <Icon sf="wifi" md="wifi" size={16} color={colors.accent} />
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                          <Text numberOfLines={1} style={[type.callout, { color: colors.label, flexShrink: 1 }]}>
                            {lanHostDisplayName(host)}
                          </Text>
                          <View
                            style={{
                              paddingHorizontal: 6,
                              paddingVertical: 2,
                              borderRadius: radius.chip,
                              backgroundColor: isCurrent ? colors.accentSoft : colors.fill,
                            }}
                          >
                            <Text style={[type.caption2, { color: isCurrent ? colors.accent : colors.secondaryLabel }]}>
                              {badge}
                            </Text>
                          </View>
                        </View>
                        <Text numberOfLines={1} style={[type.caption, { fontFamily: mono, color: colors.secondaryLabel }]}>
                          {discoveredUrl}
                        </Text>
                      </View>
                      <Text style={[type.subhead, { color: colors.accent, fontWeight: "600" }]}>
                        {isCurrent
                          ? pick({ zh: "直连", en: "Use", ja: "接続" })
                          : pick({ zh: "连接", en: "Connect", ja: "接続" })}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          ) : (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                backgroundColor: colors.card,
                borderRadius: radius.control,
                borderCurve: "continuous",
                paddingHorizontal: 14,
                paddingVertical: 12,
              }}
            >
              <Icon sf="dot.radiowaves.left.and.right" md="wifi_tethering" size={16} color={colors.secondaryLabel} />
              <Text style={[type.caption, { color: colors.secondaryLabel, flex: 1 }]}>
                {pick({
                  zh: "正在搜索同一 Wi-Fi 下的电脑（mDNS）…",
                  en: "Searching for LinkShell hosts on this Wi-Fi (mDNS)...",
                  ja: "同じ Wi-Fi 上のコンピュータを検索しています…",
                })}
              </Text>
            </View>
          )}
        </View>
      ) : null}

      <View style={{ gap: 8, paddingTop: 4 }}>
        <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
          {pick({
            zh: "在电脑终端确保 Host 守护进程已启动：",
            en: "Ensure the Host daemon is running on your computer:",
            ja: "コンピュータ側で Host デーモンが起動していることを確認してください:",
          })}
        </Text>
        <Pressable
          onPress={() => {
            void Clipboard.setStringAsync(HOST_COMMAND);
            haptics.success();
          }}
          accessibilityRole="button"
          accessibilityLabel={t("common.copy")}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            padding: 12,
            borderRadius: radius.control,
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
    </KeyboardAwareScrollView>
  );
}
