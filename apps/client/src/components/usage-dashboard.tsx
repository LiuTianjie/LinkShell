import { AgentTile } from "@/components/agent-tile";
import type { UsageReport } from "@linkshell/wire";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { colors } from "@/theme/colors";

const compact = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString();
const palette = ["#36aa92", "#638edb", "#d9a65c", "#a48bc6"];
const panel = { padding: 20, borderRadius: 20, backgroundColor: colors.card, gap: 18 };
export function UsageDashboard({ report, days }: { report: UsageReport; days: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [chartMetric, setChartMetric] = useState<"tokens" | "records">("tokens");
  const maximum = Math.max(1, ...report.daily.map(d => chartMetric === "tokens" ? d.totalTokens : d.records));
  const active = report.daily.find(d => d.date === selected);
  const selectedAgent = report.agents?.find(entry => entry.id === report.agent);
  const noData = report.totals.records === 0;
  return <>
    <Text style={{ color: colors.secondaryLabel, fontSize: 12 }}>{selectedAgent ? `${selectedAgent.label} · ${selectedAgent.note}` : `全部 Agent · ${report.agents?.filter(entry => entry.status === "available").length ?? 0} / ${report.agents?.length ?? 0} 个有用量数据`}</Text>
    {noData ? <Text style={{ color: colors.secondaryLabel, fontSize: 13 }}>所选范围暂无可用数据；未上报用量不等于零消耗。</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      {[["总用量", compact(report.totals.totalTokens), "Token"], ["用量记录", report.totals.records.toLocaleString(), "条"], ["会话", report.totals.sessions.toLocaleString(), "个"], ["缓存读取占比", (report.totals.cacheReadTokens / Math.max(1, report.totals.totalTokens) * 100).toFixed(1), "%"]].map(([label, value, unit]) => <View key={label} style={{ width: "47%", flexGrow: 1, padding: 16, gap: 12, borderWidth: 1, borderColor: colors.separator, borderRadius: 12 }}>
        <Text style={{ color: colors.secondaryLabel, fontSize: 11 }}>{label}</Text>
        <Text style={{ color: colors.label, fontSize: 26, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{noData ? "—" : value} <Text style={{ fontSize: 11, color: colors.secondaryLabel }}>{unit}</Text></Text>
      </View>)}
    </View>
    <View style={panel}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ color: colors.label, fontSize: 14, fontWeight: "600", flex: 1 }}>使用趋势</Text>
        {(["tokens", "records"] as const).map(metric => <Pressable key={metric} accessibilityRole="button" accessibilityState={{ selected: chartMetric === metric }} onPress={() => setChartMetric(metric)} style={{ padding: 8, backgroundColor: chartMetric === metric ? colors.fill : "transparent", borderRadius: 6 }}><Text style={{ color: colors.label, fontSize: 11 }}>{metric === "tokens" ? "Token" : "记录"}</Text></Pressable>)}
      </View>
      <Text style={{ color: colors.secondaryLabel, fontSize: 11 }}>每日汇总 · K = 千 / M = 百万 / B = 十亿</Text>
      <Text style={{ color: colors.label, fontSize: 12, minHeight: 18 }}>{active ? `${active.date} · ${(chartMetric === "tokens" ? active.totalTokens : active.records).toLocaleString()} ${chartMetric === "tokens" ? "Token" : "条"}` : "轻点柱形，查看当日完整用量"}</Text>
      <View style={{ height: 160, flexDirection: "row", gap: 8 }}>
        <View style={{ justifyContent: "space-between", width: 40, paddingBottom: 24 }}>{[maximum, maximum / 2, 0].map((v, i) => <Text key={i} style={{ fontSize: 9, color: colors.secondaryLabel }}>{compact(v)}</Text>)}</View>
        <View style={{ flex: 1 }}>
          {[0, 0.5, 1].map(v => <View key={v} style={{ position: "absolute", top: v * 136, width: "100%", height: 1, backgroundColor: colors.separator, opacity: 0.4 }} />)}
          <View style={{ flexDirection: "row", height: 160, gap: days > 7 ? 3 : 8 }}>
            {report.daily.map((day, i) => <Pressable key={day.date} accessibilityRole="button" accessibilityLabel={`${day.date}，${(chartMetric === "tokens" ? day.totalTokens : day.records).toLocaleString()} ${chartMetric === "tokens" ? "Token" : "条"}`} accessibilityState={{ selected: selected === day.date }} onPress={() => setSelected(day.date)} style={{ flex: 1, alignItems: "center", justifyContent: "flex-end" }}>
              <View style={{ width: "100%", maxWidth: 40, height: (chartMetric === "tokens" ? day.totalTokens : day.records) / maximum * 136, backgroundColor: palette[0], borderTopLeftRadius: 4, borderTopRightRadius: 4, opacity: !selected || selected === day.date ? 1 : 0.3 }} />
              <View style={{ height: 24, justifyContent: "flex-end", overflow: "visible" }}><Text numberOfLines={1} style={{ fontSize: 9, color: colors.secondaryLabel, width: 34, textAlign: "center" }}>{i % Math.max(1, Math.ceil(days / 5)) === 0 ? day.date.slice(5) : ""}</Text></View>
            </Pressable>)}
          </View>
        </View>
      </View>
      {report.totals.totalTokens === 0 ? <Text style={{ color: colors.secondaryLabel, fontSize: 12 }}>这段时间暂无用量记录。</Text> : null}
    </View>
    {report.agent === "all" ? <View style={{ gap: 8 }}>
      {report.agents?.filter(entry => entry.status === "no_data").map(entry => <Text key={entry.id} style={{ color: colors.secondaryLabel, fontSize: 11 }}>{entry.label} · 暂无可用数据</Text>)}
    </View> : null}
    <View style={{ gap: 14 }}>
      <Text style={{ color: colors.label, fontSize: 14, fontWeight: "600" }}>模型明细</Text>
      <Text style={{ color: colors.secondaryLabel, fontSize: 10 }}>按 Agent / 模型汇总 · 单位 Token · 横滑查看完整明细</Text>
      <ScrollView horizontal>
        <View>
          <View style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: colors.separator, paddingVertical: 12 }}>{["Agent", "模型", "记录（条）", "输入", "输出", "缓存读取", "总 Token"].map((label, i) => <Text key={label} style={{ width: i === 1 ? 180 : 85, color: colors.secondaryLabel, fontSize: 11 }}>{label}</Text>)}</View>
          {report.models.map(entry => <View key={`${entry.agent}:${entry.model}`} style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: colors.separator, paddingVertical: 16 }}>{[report.agents?.find(agent => agent.id === entry.agent)?.label ?? entry.agent, entry.model, entry.records.toLocaleString(), compact(entry.inputTokens), compact(entry.outputTokens), compact(entry.cacheReadTokens), compact(entry.totalTokens)].map((value, i) => i === 0 ? <View key={i} style={{ width: 85, flexDirection: "row", alignItems: "center", gap: 5 }}><AgentTile agent={entry.agent} size={18} /><Text numberOfLines={1} style={{ color: colors.label, fontSize: 11, flex: 1 }}>{value}</Text></View> : <Text key={i} numberOfLines={1} style={{ width: i === 1 ? 180 : 85, color: colors.label, fontSize: 12, fontVariant: ["tabular-nums"] }}>{value}</Text>)}</View>)}
          {report.models.length === 0 ? <Text style={{ color: colors.secondaryLabel, paddingVertical: 20 }}>所选范围暂无模型用量</Text> : null}
        </View>
      </ScrollView>
      <Text style={{ color: colors.secondaryLabel, fontSize: 10 }}>输入不含缓存；缓存读取占比按 Token 计算，并非请求命中率。</Text>
    </View>
  </>;
}
