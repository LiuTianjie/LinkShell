import { AgentTile } from "@/components/agent-tile";
import type { UsageReport } from "@linkshell/wire";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { Segmented } from "@/components/segmented";
import { useLocale } from "@/lib/locale";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";

const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString();
const CHART = 132;
const card = { padding: 16, borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.card } as const;

export function formatApiComputeValue(usd: number | undefined): string {
  const safe = typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : 0;
  return `USD ${safe.toFixed(2)}`;
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View accessible accessibilityLabel={`${label} ${value} ${unit ?? ""}`} style={[card, { width: "47%", flexGrow: 1, gap: 6 }]}>
      <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{label}</Text>
      <Text style={[type.title1, { color: colors.label, fontVariant: ["tabular-nums"] }]}>
        {value}
        {unit ? <Text style={[type.footnote, { fontWeight: "500", color: colors.secondaryLabel }]}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

export function UsageDashboard({ report }: { report: UsageReport }) {
  const { t, pick } = useLocale();
  const [selected, setSelected] = useState<string | null>(null);
  const [metric, setMetric] = useState<"tokens" | "records">("tokens");

  const metricsOptions = useMemo(
    () =>
      [
        { value: "tokens", label: "Token" },
        { value: "records", label: pick({ zh: "记录", en: "Records", ja: "記録" }) },
      ] as const,
    [pick],
  );

  const amount = (day: UsageReport["daily"][number]) => (metric === "tokens" ? day.totalTokens : day.records);
  const maximum = Math.max(1, ...report.daily.map(amount));
  const active = report.daily.find((day) => day.date === selected);
  const unit = metric === "tokens" ? "Token" : "";
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

  const estimatedUsd = report.estimatedCostUsd ?? report.totals.estimatedCostUsd;
  const remoteTurns = report.remoteStats?.remoteTurns ?? 0;
  const remoteApprovals = report.remoteStats?.remoteApprovals ?? 0;

  return (
    <>
      {/* Usage ROI & Remote Value Summary */}
      <View
        style={[
          card,
          {
            gap: 12,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.separator,
          },
        ]}
      >
        <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "600" }]}>
              {t("usage.estimatedApiValue")}
            </Text>
            <Text style={[type.title1, { color: colors.label, fontVariant: ["tabular-nums"] }]}>
              {formatApiComputeValue(estimatedUsd)}
            </Text>
          </View>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <View style={{ alignItems: "flex-end", gap: 2 }}>
              <Text style={[type.caption, { color: colors.secondaryLabel }]}>{t("usage.remoteTurns")}</Text>
              <Text style={[type.headline, { color: colors.label, fontVariant: ["tabular-nums"] }]}>{remoteTurns.toLocaleString()}</Text>
            </View>
            <View style={{ alignItems: "flex-end", gap: 2 }}>
              <Text style={[type.caption, { color: colors.secondaryLabel }]}>{t("usage.remoteApprovals")}</Text>
              <Text style={[type.headline, { color: colors.accent, fontVariant: ["tabular-nums"] }]}>{remoteApprovals.toLocaleString()}</Text>
            </View>
          </View>
        </View>
        <Text style={[type.caption, { color: colors.tertiaryLabel }]}>
          {t("usage.subscriptionReferenceNote")}
        </Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Stat label={t("usage.totalTokens")} value={compact(report.totals.totalTokens)} unit="Token" />
        <Stat label={t("usage.sessions")} value={report.totals.sessions.toLocaleString()} />
        <Stat label={pick({ zh: "用量记录", en: "Records", ja: "記録数" })} value={report.totals.records.toLocaleString()} />
        <Stat label={pick({ zh: "缓存读取", en: "Cache Read", ja: "キャッシュ読込" })} value={cache.toFixed(cache >= 10 ? 0 : 1)} unit="%" />
      </View>

      {report.daily.length > 1 ? (
        <View style={[card, { gap: 14 }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[type.headline, { color: colors.label }]}>
                {pick({ zh: "每日趋势", en: "Daily Trend", ja: "日次推移" })}
              </Text>
              <Text accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}>
                {active
                  ? `${active.date} · ${amount(active).toLocaleString()} ${unit}`
                  : pick({ zh: "轻点柱子看当天", en: "Tap a bar to inspect day", ja: "バーをタップして詳細を表示" })}
              </Text>
            </View>
            <Segmented size="small" label="Metric" options={metricsOptions} value={metric} onChange={setMetric} />
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
                      accessibilityLabel={`${day.date} ${value.toLocaleString()} ${unit}`}
                      accessibilityState={{ selected: selected === day.date }}
                      onPress={() => setSelected((current) => (current === day.date ? null : day.date))}
                      style={{ flex: 1, alignItems: "center" }}
                    >
                      <View style={{ height: CHART, width: "100%", justifyContent: "flex-end", alignItems: "center" }}>
                        <View
                          style={{
                            width: "100%",
                            maxWidth: 32,
                            height: value ? Math.max(3, (value / maximum) * CHART) : 0,
                            backgroundColor: colors.accent,
                            borderRadius: report.daily.length > 7 ? 2 : 5,
                            borderCurve: "continuous",
                            opacity: lit ? 1 : 0.3,
                          }}
                        />
                      </View>
                      <Text numberOfLines={1} style={[type.caption, { position: "absolute", top: CHART + 6, width: 44, textAlign: "center", color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }]}>
                        {labelled(index) ? day.date.slice(5).replace("-", "/") : ""}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <View style={{ width: 36, height: CHART }}>
              {[1, 0.5, 0].map((share) => (
                <Text
                  key={share}
                  style={[type.caption, { position: "absolute", top: (1 - share) * CHART - type.caption.lineHeight / 2, height: type.caption.lineHeight, color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }]}
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
          <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: "600", paddingHorizontal: 4 }]}>
            {pick({ zh: "按模型", en: "By Model", ja: "モデル別" })}
          </Text>
          <View style={[card, { paddingVertical: 4, paddingHorizontal: 0 }]}>
            {models.map((entry, index) => (
              <View
                key={`${entry.agent}:${entry.model}`}
                accessible
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
                    <Text style={[type.subhead, { color: colors.label, fontWeight: "600", fontVariant: ["tabular-nums"] }]}>
                      {compact(entry.totalTokens)}
                    </Text>
                  </View>
                  <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.fill, overflow: "hidden" }}>
                    <View style={{ width: `${(entry.totalTokens / top) * 100}%`, height: 4, borderRadius: 2, backgroundColor: colors.accent }} />
                  </View>
                  <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}>
                    {labelOf(entry.agent)} · In {compact(entry.inputTokens)} · Out {compact(entry.outputTokens)} · Cache {compact(entry.cacheReadTokens)}
                    {entry.estimatedCostUsd ? ` · ${formatApiComputeValue(entry.estimatedCostUsd)}` : ""}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {silent.length ? (
        <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4 }]}>
          {silent.map((entry) => agentLook(entry.id, entry.label).short).join(", ")}:{" "}
          {pick({ zh: "暂无记录。", en: "No usage yet.", ja: "記録なし。" })}
        </Text>
      ) : null}
    </>
  );
}
