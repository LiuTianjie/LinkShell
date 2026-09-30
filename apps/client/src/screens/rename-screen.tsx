import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import { useActions, useClient } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { sessionTitle } from "@/lib/describe";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

/** Names a session (in the agent too, where it keeps names: Codex, Claude). */
export function RenameScreen() {
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
    <View style={{ flex: 1, backgroundColor: colors.sheet, paddingHorizontal: 16, gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 4, paddingTop: 22 }}>
        <Text style={[type.title, { flex: 1, color: colors.label }]}>重命名</Text>
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
          style={[type.body, { fontSize: 17, height: 52, color: colors.label, paddingVertical: 0 }]}
        />
      </View>
      <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
        留空则恢复 Agent 自己起的名字。Codex 和 Claude 会同步这个名字。
      </Text>
      {error ? <Text style={[type.footnote, { color: colors.danger, paddingHorizontal: 4 }]}>{error}</Text> : null}
      <Button title="保存" variant="primary" size="large" wide disabled={saving} onPress={() => void save()} />
    </View>
  );
}
