import { AgentTile } from "@/components/agent-tile";
import type { UsageReport } from "@linkshell/wire";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { Segmented } from "@/components/segmented";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString();
const BAR = "#36aa92";
const CHART = 132;
const card = { padding: 16, borderRadius: 20, borderCurve: "continuous", backgroundColor: colors.card } as const;
const METRICS = [
  { value: "tokens", label: "Token" },
  { value: "records", label: "记录" },
] as const;

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <View accessible accessibilityLabel={`${label} ${value} ${unit}`} style={[card, { width: "47%", flexGrow: 1, gap: 6 }]}>
      <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{label}</Text>
      <Text style={{ color: colors.label, fontSize: 26, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
        {value}
        <Text style={{ fontSize: 13, fontWeight: "500", color: colors.secondaryLabel }}> {unit}</Text>
      </Text>
    </View>
  );
}

/** Totals, a daily chart and each model's share, for a range that has usage (an empty one gets the screen's empty state). */
export function UsageDashboard({ report }: { report: UsageReport }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [metric, setMetric] = useState<"tokens" | "records">("tokens");
  const amount = (day: UsageReport["daily"][number]) => (metric === "tokens" ? day.totalTokens : day.records);
  const maximum = Math.max(1, ...report.daily.map(amount));
  const active = report.daily.find((day) => day.date === selected);
  const unit = metric === "tokens" ? "Token" : "条";
  // About six dates are labelled, counted back from today so the last one never crowds its neighbour.
  const every = Math.max(1, Math.ceil(report.daily.length / 6));
  const labelled = (index: number) => (report.daily.length - 1 - index) % every === 0;
  const cache = (report.totals.cacheReadTokens / Math.max(1, report.totals.totalTokens)) * 100;
  const labelOf = (id: string) => {
    const entry = report.agents?.find((agent) => agent.id === id);
    return agentLook(id, entry?.label).short;
  };
  const models = [...report.models].sort((a, b) => b.totalTokens - a.totalTokens);
  const top = Math.max(1, models[0]?.totalTokens ?? 1);
  const silent = report.agent === "all" ? (report.agents ?? []).filter((entry) => entry.status === "no_data") : [];

  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Stat label="总用量" value={compact(report.totals.totalTokens)} unit="Token" />
        <Stat label="会话" value={report.totals.sessions.toLocaleString()} unit="个" />
        <Stat label="用量记录" value={report.totals.records.toLocaleString()} unit="条" />
        <Stat label="缓存读取" value={cache.toFixed(cache >= 10 ? 0 : 1)} unit="%" />
      </View>

      {report.daily.length > 1 ? (
        <View style={[card, { gap: 14 }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[type.headline, { color: colors.label }]}>每天</Text>
              <Text accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}>
                {active ? `${active.date.slice(5).replace("-", " 月 ")} 日 · ${amount(active).toLocaleString()} ${unit}` : "轻点柱子看当天"}
              </Text>
            </View>
            <Segmented size="small" label="按什么统计" options={METRICS} value={metric} onChange={setMetric} />
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              {[0, 0.5, 1].map((at) => (
                <View key={at} style={{ position: "absolute", top: at * CHART, left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} />
              ))}
              <View style={{ flexDirection: "row", height: CHART + 22, gap: report.daily.length > 7 ? 3 : 10 }}>
                {report.daily.map((day, index) => {
                  const value = amount(day);
                  const lit = !selected || selected === day.date;
                  return (
                    <Pressable
                      key={day.date}
                      accessibilityRole="button"
                      accessibilityLabel={`${day.date}，${value.toLocaleString()} ${unit}`}
                      accessibilityState={{ selected: selected === day.date }}
                      onPress={() => setSelected((current) => (current === day.date ? null : day.date))}
                      style={{ flex: 1, alignItems: "center" }}
                    >
                      <View style={{ height: CHART, width: "100%", justifyContent: "flex-end", alignItems: "center" }}>
                        <View
                          style={{
                            width: "100%",
                            maxWidth: 32,
                            // A day with any use shows a sliver, so it doesn't read as none.
                            height: value ? Math.max(3, (value / maximum) * CHART) : 0,
                            backgroundColor: BAR,
                            borderRadius: report.daily.length > 7 ? 2 : 5,
                            borderCurve: "continuous",
                            opacity: lit ? 1 : 0.3,
                          }}
                        />
                      </View>
                      <Text numberOfLines={1} style={{ position: "absolute", top: CHART + 6, width: 44, textAlign: "center", fontSize: 10, color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }}>
                        {labelled(index) ? day.date.slice(5).replace("-", "/") : ""}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            {/* Each value centred on its gridline. */}
            <View style={{ width: 36, height: CHART }}>
              {[1, 0.5, 0].map((share) => (
                <Text
                  key={share}
                  style={{ position: "absolute", top: (1 - share) * CHART - 7, height: 14, lineHeight: 14, fontSize: 10, color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }}
                >
                  {compact(Math.round(maximum * share))}
                </Text>
              ))}
            </View>
          </View>
        </View>
      ) : null}

      {models.length ? (
        <View style={{ gap: 8 }}>
          <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "600", paddingHorizontal: 4 }]}>按模型</Text>
          <View style={[card, { paddingVertical: 4, paddingHorizontal: 0 }]}>
            {models.map((entry, index) => (
              <View
                key={`${entry.agent}:${entry.model}`}
                accessible
                accessibilityLabel={`${labelOf(entry.agent)} ${entry.model}，${compact(entry.totalTokens)} Token，输入 ${compact(entry.inputTokens)}，输出 ${compact(entry.outputTokens)}，缓存读取 ${compact(entry.cacheReadTokens)}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderTopWidth: index ? StyleSheet.hairlineWidth : 0,
                  borderTopColor: colors.separator,
                }}
              >
                <AgentTile agent={entry.agent} size={30} />
                <View style={{ flex: 1, gap: 5 }}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                    <Text numberOfLines={1} style={[type.subhead, { flex: 1, color: colors.label, fontWeight: "600" }]}>
                      {entry.model}
                    </Text>
                    <Text style={[type.subhead, { color: colors.label, fontWeight: "600", fontVariant: ["tabular-nums"] }]}>{compact(entry.totalTokens)}</Text>
                  </View>
                  {/* Each model's share of the biggest one, so the list reads at a glance. */}
                  <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.fill, overflow: "hidden" }}>
                    <View style={{ width: `${(entry.totalTokens / top) * 100}%`, height: 4, borderRadius: 2, backgroundColor: BAR }} />
                  </View>
                  <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}>
                    {labelOf(entry.agent)} · 输入 {compact(entry.inputTokens)} · 输出 {compact(entry.outputTokens)} · 缓存 {compact(entry.cacheReadTokens)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {silent.length ? (
        <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
          {/* Word joiners: the line may wrap anywhere in the names but never leaves "录。" alone. */}
          {silent.map((entry) => agentLook(entry.id, entry.label).short).join("、")}{" 暂\u2060无\u2060记\u2060录。"}
        </Text>
      ) : null}
    </>
  );
}
