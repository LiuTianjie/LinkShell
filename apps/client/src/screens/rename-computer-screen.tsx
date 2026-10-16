import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { usePageInsets } from "@/components/adaptive-page";
import { Text, TextInput } from "@/components/fixed-text";
import { SheetHeader } from "@/components/sheet-header";
import { COMPUTER_NAME_LIMIT, renameComputer, useComputerNames } from "@/lib/computer-names";
import { listComputers, useComputers } from "@/lib/computers";
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
  const original = computer?.kind === "relay" ? computer.machine.name : computer?.name;
  const [value, setValue] = useState(() => names[computerKey] ?? "");
  const [error, setError] = useState("");
  const save = (name: string) => {
    if (!computer) return;
    try {
      renameComputer(computer.key, name);
      haptics.success();
      router.back();
    } catch (reason) {
      haptics.error();
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return <KeyboardAwareScrollView contentInsetAdjustmentBehavior="never" style={{ flex: 1, backgroundColor: colors.sheet }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: insets.bottom + 24, gap: 14 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" bottomOffset={20}>
    <SheetHeader title="电脑名称" actions={[{ key: "save", label: "保存", icon: { sf: "checkmark", md: "check" }, onPress: () => save(value), disabled: !computer, prominent: true }]} />
    <View style={{ backgroundColor: colors.sheetCard, borderRadius: 16, borderCurve: "continuous", paddingHorizontal: 16 }}>
      <TextInput value={value} onChangeText={(text) => { setValue(text); setError(""); }} autoFocus selectTextOnFocus
        accessibilityLabel="电脑名称" placeholder="例如：办公室 Mac mini" placeholderTextColor={colors.placeholder as string}
        returnKeyType="done" onSubmitEditing={() => save(value)} maxLength={COMPUTER_NAME_LIMIT} editable={Boolean(computer)}
        style={[type.body, { fontSize: 17, minHeight: 52, color: colors.label, paddingVertical: 13 }]} />
    </View>
    <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
      {computer ? `原名：${original}\n这个名字仅保存在当前手机中。留空可恢复原名。` : "这台电脑已不在设备列表中。"}
    </Text>
    {names[computerKey] && computer ? <Pressable accessibilityRole="button" onPress={() => save("")} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", paddingHorizontal: 4, opacity: pressed ? 0.6 : 1 })}>
      <Text style={[type.body, { color: colors.accent }]}>恢复原名</Text>
    </Pressable> : null}
    {error ? <Text accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.danger, paddingHorizontal: 4 }]}>{error}</Text> : null}
  </KeyboardAwareScrollView>;
}
