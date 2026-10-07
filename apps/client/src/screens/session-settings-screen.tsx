import { useLocalSearchParams } from "expo-router";
import { Alert, ScrollView, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { SheetHeader } from "@/components/sheet-header";
import { ConfigMenu } from "@/components/config-menu";
import { useActions, useClient, useSessionSubscription } from "@/lib/client";
import { optionLabel, valueLabel } from "@/lib/labels";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

export function SessionSettingsScreen() {
  const { id, option: selected } = useLocalSearchParams<{ id: string; option?: string }>();
  useSessionSubscription(id);
  const config = useClient((state) => state.views[id]?.config);
  const online = useClient((state) => state.status === "online");
  const actions = useActions();
  const options = [...(config ?? [])].sort((a, b) => Number(b.id === selected) - Number(a.id === selected));
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
    <SheetHeader title="会话设置" />
    {options.length ? options.map((option) => <View key={option.id} style={{ padding: 12, borderRadius: 16, backgroundColor: colors.sheetCard, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <View style={{ flex: 1, gap: 4 }}><Text style={[type.body, { color: colors.label }]}>{optionLabel(option)}</Text>{option.category === "mode" ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{valueLabel(option, option.current)}</Text> : null}</View>
      <ConfigMenu option={option} disabled={!online} onChange={(value) => void actions.setConfig(id, option.id, value).catch((error: unknown) => Alert.alert("切换失败", error instanceof Error ? error.message : String(error)))} />
    </View>) : <Text style={[type.body, { color: colors.secondaryLabel }]}>Agent 尚未报告会话设置，接管会话后会自动更新。</Text>}
  </ScrollView>;
}
