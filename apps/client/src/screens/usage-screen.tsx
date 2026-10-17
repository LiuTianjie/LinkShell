import { AgentTile } from "@/components/agent-tile";
import { UsageDashboard } from "@/components/usage-dashboard";
import type { UsageQuery, UsageReport } from "@linkshell/wire";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { Button } from "@/components/button";
import { usePageInsets } from "@/components/adaptive-page";
import { useConnection } from "@/lib/client";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

export function UsageScreen() {
  const { link } = useConnection();
  const insets = usePageInsets();
  const [days, setDays] = useState<UsageQuery["days"]>(7);
  const [agent, setAgent] = useState<UsageQuery["agent"]>("all");
  const [agents, setAgents] = useState<NonNullable<UsageReport["agents"]>>([]);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError(null); setReport(null);
    try {
      const next = await link.call("usage.summary", { days, agent }, 120_000);
      if (generation.current === request) { setReport(next); setAgents(next.agents ?? []); }
    } catch (reason) {
      if (generation.current === request) setError(`无法读取用量，请确认电脑在线并已更新 LinkShell。${reason instanceof Error ? reason.message : String(reason)}`);
    } finally { if (generation.current === request) setLoading(false); }
  }, [link, days, agent]);
  useFocusEffect(useCallback(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]));

  return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24, gap: 22 }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <Text style={[type.caption, { color: colors.secondaryLabel }]}>Agent 用量 · 本机统计</Text>
      <Button title="立即同步" size="small" busy={loading} onPress={() => void refresh()} />
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4, padding: 4, backgroundColor: colors.fill, borderRadius: 9 }}>
      {[{ id: "all", label: "全部" }, ...agents].map(({ id: value, label }) => <Pressable key={value} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: agent === value }} onPress={() => setAgent(value)} style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, backgroundColor: agent === value ? colors.card : "transparent" }}>
        {value === "all" ? <Text style={{ color: colors.label, fontSize: 13, fontWeight: "600", lineHeight: 24 }}>全部</Text> : <AgentTile agent={value} size={24} />}
      </Pressable>)}
    </ScrollView>
    <View style={{ flexDirection: "row", gap: 8 }}>
      {([1, 7, 30] as const).map(value => <Button key={value} title={value === 1 ? "今天" : `${value} 天`} variant={days === value ? "primary" : "tonal"} size="small" onPress={() => setDays(value)} />)}
    </View>
    {loading ? <ActivityIndicator color={colors.accent} accessibilityLabel="正在读取用量" /> : null}
    {error ? <Text selectable style={[type.footnote, { color: colors.danger }]}>{error}</Text> : null}
    {report ? <>
      <UsageDashboard key={`${days}-${agent}`} report={report} days={days} />
      {report.warnings.map(warning => <Text key={warning} style={[type.footnote, { color: colors.waiting }]}>{warning}</Text>)}
      <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{new Date(report.generatedAt).toLocaleTimeString()} 更新。仅统计日志已记录的 Token，不代表订阅剩余额度或实际账单。</Text>
    </> : null}
  </ScrollView>;
}
