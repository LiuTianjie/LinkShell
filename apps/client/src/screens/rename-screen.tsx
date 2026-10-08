import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { Text, TextInput } from "@/components/fixed-text";
import { usePageInsets } from "@/components/adaptive-page";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useActions, useClient } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { sessionTitle } from "@/lib/describe";
import { SheetHeader } from "@/components/sheet-header";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

/** Names a session (in the agent too, where it keeps names: Codex, Claude). */
export function RenameScreen() {
  const insets = usePageInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const summary = useClient((state) => state.sessions[id]);
  const actions = useActions();
  const [title, setTitle] = useState(() => (summary ? sessionTitle(summary) : ""));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await actions.rename(id, title.trim());
      haptics.success();
      router.back();
    } catch (reason) {
      haptics.error();
      setError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  };

  return (
    <KeyboardAwareScrollView contentInsetAdjustmentBehavior="never" style={{ flex: 1, backgroundColor: colors.sheet }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: insets.bottom + 24, gap: 14 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" bottomOffset={20}>
      <SheetHeader title="重命名" actions={[{ key: "save", label: "保存", icon: { sf: "checkmark", md: "check" }, onPress: () => void save(), disabled: saving, prominent: true }]} />
      <View style={{ backgroundColor: colors.sheetCard, borderRadius: 16, borderCurve: "continuous", paddingHorizontal: 16 }}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          autoFocus
          selectTextOnFocus
          placeholder="会话名称"
          placeholderTextColor={colors.placeholder as string}
          returnKeyType="done"
          onSubmitEditing={() => void save()}
          maxLength={120}
          style={[type.body, { fontSize: 17, minHeight: 52, color: colors.label, paddingVertical: 13 }]}
        />
      </View>
      <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
        留空则恢复 Agent 自己起的名字。Codex 和 Claude 会同步这个名字。
      </Text>
      {saving ? <Text accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>正在保存…</Text> : null}
      {error ? <Text style={[type.footnote, { color: colors.danger, paddingHorizontal: 4 }]}>{error}</Text> : null}
    </KeyboardAwareScrollView>
  );
}
