import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { HostLink, TunnelSocket } from "@linkshell/client-core";
import type { MachineInfo } from "@linkshell/wire";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { usePageInsets } from "@/components/adaptive-page";
import { Text, TextInput } from "@/components/fixed-text";
import { SheetHeader } from "@/components/sheet-header";
import { COMPUTER_NAME_LIMIT, renameComputer, syncComputerName, useComputerNames } from "@/lib/computer-names";
import { listComputers, relayFor, useComputers } from "@/lib/computers";
import { accessToken, useConnection } from "@/lib/client";
import { deviceIdentity } from "@/lib/identity";
import { createSocket } from "@/lib/socket";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

export function RenameComputerScreen() {
  const { computer: key } = useLocalSearchParams<{ computer: string }>();
  return <ComputerNameForm key={key} computerKey={key} />;
}

function ComputerNameForm({ computerKey }: { computerKey: string }) {
  const insets = usePageInsets();
  const names = useComputerNames((state) => state.names);
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const computer = listComputers({ saved, live }).find((item) => item.key === computerKey);
  const active = useConnection();
  const [value, setValue] = useState(() => names[computerKey] ?? "");
  const [error, setError] = useState("");
  const [machine, setMachine] = useState<MachineInfo>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const target = useRef<HostLink | undefined>(undefined);
  useEffect(() => {
    if (!computer) { setLoading(false); return; }
    let cancelled = false;
    const shared = active.computer.key === computer.key;
    const link = shared ? active.link : computer.kind === "direct"
      ? new HostLink({ url: computer.url, createSocket, accessToken: accessToken(computer) })
      : new HostLink({ url: computer.key, accessToken: accessToken(computer),
        createSocket: () => new TunnelSocket(relayFor(computer.gateway), deviceIdentity(), computer.machine) });
    target.current = link;
    setLoading(true);
    setSaving(false);
    setError("");
    setMachine(undefined);
    if (!shared) link.start();
    void link.call("machine.info", {}, 15_000).then((info) => {
      if (cancelled) return;
      setMachine(info);
      setValue(info.naming?.configured ? info.naming.customName ?? "" : names[computerKey] ?? "");
      syncComputerName(computer, info);
      if (!info.naming) setError("请先更新这台电脑上的 LinkShell，更新后即可在所有端同步名称。");
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; target.current = undefined; if (!shared) link.stop(); };
    // Refreshing the display name must not replace the connection or the user's draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computer?.key, computerKey, active.computer.key, active.link]);
  const save = async (name: string) => {
    const link = target.current;
    if (!computer || !link || !machine?.naming || saving) return;
    setSaving(true);
    setError("");
    try {
      await renameComputer(computer, name, link);
      if (target.current !== link) return;
      haptics.success();
      router.back();
    } catch (reason) {
      if (target.current !== link) return;
      haptics.error();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (target.current === link) setSaving(false);
    }
  };

  return <KeyboardAwareScrollView contentInsetAdjustmentBehavior="never" style={{ flex: 1, backgroundColor: colors.sheet }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: insets.bottom + 24, gap: 14 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" bottomOffset={20}>
    <SheetHeader title="电脑名称" actions={[{ key: "save", label: saving ? "同步中" : "保存", icon: { sf: "checkmark", md: "check" }, onPress: () => void save(value), disabled: !computer || loading || saving || !machine?.naming, prominent: true }]} />
    <View style={{ backgroundColor: colors.sheetCard, borderRadius: 16, borderCurve: "continuous", paddingHorizontal: 16 }}>
      <TextInput value={value} onChangeText={(text) => { setValue(text); setError(""); }} autoFocus selectTextOnFocus
        accessibilityLabel="电脑名称" placeholder="例如：办公室 Mac mini" placeholderTextColor={colors.placeholder as string}
        returnKeyType="done" onSubmitEditing={() => void save(value)} maxLength={COMPUTER_NAME_LIMIT} editable={Boolean(computer && machine?.naming && !loading && !saving)}
        style={[type.body, { fontSize: 17, minHeight: 52, color: colors.label, paddingVertical: 13 }]} />
    </View>
    <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
      {computer ? loading ? "正在读取电脑名称…" : `${machine ? `原名：${machine.naming?.defaultName ?? machine.hostname}` : "连接电脑后可读取原名"}\n名称保存在这台电脑上，并同步到所有端。留空可恢复原名。` : "这台电脑已不在设备列表中。"}
    </Text>
    {(machine?.naming?.customName || names[computerKey]) && computer ? <Pressable accessibilityRole="button" disabled={loading || saving || !machine?.naming} onPress={() => void save("")} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", paddingHorizontal: 4, opacity: pressed || loading || saving ? 0.6 : 1 })}>
      <Text style={[type.body, { color: colors.accent }]}>恢复原名</Text>
    </Pressable> : null}
    {error ? <Text accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.danger, paddingHorizontal: 4 }]}>{error}</Text> : null}
  </KeyboardAwareScrollView>;
}
