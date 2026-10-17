import type { UsageQuery, UsageReport } from "@linkshell/wire";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { Button } from "@/components/button";
import { usePageInsets } from "@/components/adaptive-page";
import { useConnection } from "@/lib/client";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

const number = (value: number) => value.toLocaleString();
function Metric({ label, value }: { label: string; value: number }) {
  return <View style={{ minWidth: "43%", flexGrow: 1, gap: 6, padding: 16, borderRadius: 16, backgroundColor: colors.card }}>
    <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{label}</Text>
    <Text selectable style={{ fontSize: 23, fontWeight: "600", color: colors.label }}>{number(value)}</Text>
  </View>;
}

export function UsageScreen() {
  const { link } = useConnection();
  const insets = usePageInsets();
  const [days, setDays] = useState<UsageQuery["days"]>(7);
  const [agent, setAgent] = useState<UsageQuery["agent"]>("all");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError(null); setReport(null);
    try {
      const next = await link.call("usage.summary", { days, agent }, 120_000);
      if (generation.current === request) setReport(next);
    } catch (reason) {
      if (generation.current === request) setError(`无法读取用量，请确认电脑在线并已更新 LinkShell。${reason instanceof Error ? reason.message : String(reason)}`);
    } finally { if (generation.current === request) setLoading(false); }
  }, [link, days, agent]);
  useFocusEffect(useCallback(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]));
  const maximum = Math.max(1, ...report?.daily.map(day => day.totalTokens) ?? []);
  return <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24, gap: 22 }}>
    <Text style={[type.subhead, { color: colors.secondaryLabel }]}>当前电脑的 Codex / Claude 本地会话用量，包含终端和子代理。最多每分钟同步一次。</Text>
    <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
      {([1, 7, 30] as const).map(value => <Button key={value} title={value === 1 ? "今天" : `${value} 天`} variant={days === value ? "primary" : "tonal"} size="small" onPress={() => setDays(value)} />)}
    </View>
    <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
      {(["all", "codex", "claude"] as const).map(value => <Button key={value} title={{ all: "全部", codex: "Codex", claude: "Claude" }[value]} variant={agent === value ? "primary" : "tonal"} size="small" onPress={() => setAgent(value)} />)}
      <Button title="刷新" size="small" busy={loading} onPress={() => void refresh()} />
    </View>
    {loading ? <ActivityIndicator color={colors.accent} accessibilityLabel="正在读取用量" /> : null}
    {error ? <Text selectable style={[type.footnote, { color: colors.danger }]}>{error}</Text> : null}
    {report ? <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Metric label="总 Token" value={report.totals.totalTokens} />
        <Metric label="用量记录" value={report.totals.records} />
        <Metric label="输入（不含缓存）" value={report.totals.inputTokens} />
        <Metric label="输出" value={report.totals.outputTokens} />
        <Metric label="缓存读取" value={report.totals.cacheReadTokens} />
        <Metric label="缓存写入" value={report.totals.cacheWriteTokens} />
      </View>
      <Text style={[type.footnote, { color: colors.secondaryLabel }]}>共 {number(report.totals.sessions)} 个会话 · 按电脑时区 {report.timezone} 汇总</Text>
      <Text style={[type.headline, { color: colors.label }]}>每日用量</Text>
      <View style={{ gap: 14 }}>
        {report.daily.map(day => <View key={day.date} accessible accessibilityLabel={`${day.date}，${number(day.totalTokens)} Token`} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ fontFamily: mono, fontSize: 11, color: colors.secondaryLabel, width: 42 }}>{day.date.slice(5)}</Text>
          <View style={{ flex: 1, height: 8, backgroundColor: colors.fill, borderRadius: 4 }}>
            <View style={{ width: `${day.totalTokens / maximum * 100}%`, height: 8, backgroundColor: colors.accent, borderRadius: 4 }} />
          </View>
          <Text style={{ fontFamily: mono, fontSize: 11, color: colors.label, width: 94, textAlign: "right" }}>{number(day.totalTokens)}</Text>
        </View>)}
      </View>
      <Text style={[type.headline, { color: colors.label }]}>模型分布</Text>
      {report.models.length === 0 ? <Text style={[type.subhead, { color: colors.secondaryLabel }]}>所选时间内暂无用量记录。</Text> : null}
      {report.models.map(model => <View key={`${model.agent}:${model.model}`} style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
        <View style={{ flex: 1, gap: 5 }}>
          <Text selectable style={[type.subhead, { color: colors.label }]}>{model.model}</Text>
          <Text style={[type.caption, { color: colors.secondaryLabel }]}>{model.agent} · {number(model.records)} 条记录</Text>
        </View>
        <Text style={[type.footnote, { color: colors.label }]}>{number(model.totalTokens)} Token</Text>
      </View>)}
      {report.warnings.map(warning => <Text key={warning} style={[type.footnote, { color: colors.waiting }]}>{warning}</Text>)}
      <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{new Date(report.generatedAt).toLocaleTimeString()} 更新。仅统计日志已记录的 Token，不代表订阅剩余额度或实际账单；其他代理暂未纳入。</Text>
    </> : null}
  </ScrollView>;
}
