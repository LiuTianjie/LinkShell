import { router, useLocalSearchParams } from "expo-router";
import { Button } from "@/components/button";
import { Alert, Platform, ScrollView, Switch, View } from "react-native";
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
  const summary = useClient((state) => state.sessions[id]);
  const tier = useClient((state) => state.machine?.agents.find((agent) => agent.id === summary?.agent)?.tier);
  const acp = useClient((state) => state.machine?.agents.find((agent) => agent.id === summary?.agent)?.capabilities.acp);
  const usage = useClient((state) => state.views[id]?.usage);
  const driver = useClient((state) => state.views[id]?.driver) ?? summary?.driver;
  // A Codex session another Codex process holds runs its turns with that process's settings.
  const heldElsewhere = tier === "multi_client" && driver === "desktop";
  const online = useClient((state) => state.status === "online");
  const actions = useActions();
  const options = [...(config ?? [])].sort((a, b) => Number(b.id === selected) - Number(a.id === selected));
  return <ScrollView contentContainerStyle={{ padding: 16, paddingTop: Platform.OS === "android" ? 24 : 16, gap: 12 }} keyboardShouldPersistTaps="handled">
    <SheetHeader title="会话设置" />
    {heldElsewhere ? <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>会话开在电脑的另一个 Codex 里，这些设置要在那边改。</Text> : null}
    {options.length ? options.map((option) => <View key={option.id} style={{ padding: 12, borderRadius: 16, backgroundColor: colors.sheetCard, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <View style={{ flex: 1, gap: 4 }}><Text style={[type.body, { color: colors.label }]}>{optionLabel(option)}</Text>{option.description ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{option.description}</Text> : option.category === "mode" ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{valueLabel(option, option.current)}</Text> : null}</View>
      {option.type === "boolean" ? <Switch accessibilityLabel={optionLabel(option)} disabled={!online || heldElsewhere} value={option.current === "on"} onValueChange={(value) => void actions.setConfig(id, option.id, value ? "on" : "off").catch((error: unknown) => Alert.alert("切换失败", error instanceof Error ? error.message : String(error)))} /> : <ConfigMenu option={option} disabled={!online || heldElsewhere} onChange={(value) => void actions.setConfig(id, option.id, value).catch((error: unknown) => Alert.alert("切换失败", error instanceof Error ? error.message : String(error)))} />}
    </View>) : <Text style={[type.body, { color: colors.secondaryLabel }]}>Agent 尚未报告会话设置，接管会话后会自动更新。</Text>}
    {usage?.tokens ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>输入 {usage.tokens.inputTokens.toLocaleString()} · 输出 {usage.tokens.outputTokens.toLocaleString()} · 总计 {usage.tokens.totalTokens.toLocaleString()} tokens</Text> : null}
    {usage?.cost ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>累计费用 {usage.cost.currency} {usage.cost.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</Text> : null}
    {acp && summary ? <Button title="会话工具与附加目录" onPress={() => router.push({ pathname: "/acp", params: { agent: summary.agent, sessionId: id } })} /> : null}
  </ScrollView>;
}
