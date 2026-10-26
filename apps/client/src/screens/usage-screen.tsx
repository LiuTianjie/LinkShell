import { AgentTile } from "@/components/agent-tile";
import { UsageDashboard } from "@/components/usage-dashboard";
import type { UsageQuery, UsageReport } from "@linkshell/wire";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { usePageInsets } from "@/components/adaptive-page";
import { HeaderActions } from "@/components/header-actions";
import { Segmented } from "@/components/segmented";
import { EmptyState, LoadingState } from "@/components/state-views";
import { useConnection } from "@/lib/client";
import { haptics } from "@/lib/haptics";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

const RANGES = [
  { value: 1, label: "今天" },
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
] as const;

/** One agent to filter by: its tile and short name, the chosen one on a card. */
function AgentChip({ agent, label, selected, onPress }: { agent?: string; label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        if (selected) return;
        haptics.selection();
        onPress();
      }}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 34,
        paddingLeft: agent ? 5 : 14,
        paddingRight: 12,
        borderRadius: 17,
        borderCurve: "continuous",
        backgroundColor: selected ? colors.accentSoft : pressed ? colors.fillStrong : colors.card,
        borderWidth: 1,
        borderColor: selected ? colors.accent : "transparent",
      })}
    >
      {agent ? <AgentTile agent={agent} size={24} /> : null}
      <Text style={{ fontSize: 13, fontWeight: selected ? "600" : "500", color: selected ? colors.accent : colors.label }}>{label}</Text>
    </Pressable>
  );
}

export function UsageScreen() {
  const { link } = useConnection();
  const insets = usePageInsets();
  const [days, setDays] = useState<UsageQuery["days"]>(7);
  const [agent, setAgent] = useState<UsageQuery["agent"]>("all");
  const [agents, setAgents] = useState<NonNullable<UsageReport["agents"]>>([]);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pulled, setPulled] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    // The last report stays up, dimmed, while the next one is read: a filter
    // change doesn't blank the page for the seconds the logs take to scan.
    setLoading(true);
    setError(null);
    try {
      const next = await link.call("usage.summary", { days, agent }, 120_000);
      if (generation.current === request) {
        setReport(next);
        setAgents(next.agents ?? []);
      }
    } catch (reason) {
      if (generation.current === request) setError(`无法读取用量，请确认电脑在线并已更新 LinkShell。${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      if (generation.current === request) {
        setLoading(false);
        setPulled(false);
      }
    }
  }, [link, days, agent]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
      return () => {
        generation.current++;
      };
    }, [refresh]),
  );

  const current = report && report.days === days && report.agent === agent ? report : null;
  const empty = current?.totals.records === 0;
  const chosen = agents.find((entry) => entry.id === agent);

  return (
    <>
      <HeaderActions actions={[{ kind: "button", key: "refresh", icon: { sf: "arrow.clockwise", md: "refresh" }, label: "重新统计", onPress: () => void refresh() }]} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl
            refreshing={pulled}
            onRefresh={() => {
              setPulled(true);
              void refresh();
            }}
          />
        }
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 28, gap: 18 }}
      >
        <View style={{ gap: 12 }}>
          <Segmented label="时间范围" options={RANGES} value={days} onChange={setDays} />
          {agents.length > 1 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              accessibilityRole="radiogroup"
              accessibilityLabel="Agent"
              style={{ marginHorizontal: -16 }}
              contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
            >
              <AgentChip label="全部" selected={agent === "all"} onPress={() => setAgent("all")} />
              {agents.map((entry) => (
                <AgentChip key={entry.id} agent={entry.id} label={agentLook(entry.id, entry.label).short} selected={agent === entry.id} onPress={() => setAgent(entry.id)} />
              ))}
            </ScrollView>
          ) : null}
        </View>

        {error ? <Text selectable style={[type.footnote, { color: colors.danger, paddingHorizontal: 4 }]}>{error}</Text> : null}

        {!report && loading ? (
          <LoadingState label="正在统计这台电脑上的用量…" />
        ) : empty ? (
          <EmptyState
            icon={{ sf: "chart.bar", md: "bar_chart" }}
            title={days === 1 ? "今天还没有用量记录" : `近 ${days} 天没有用量记录`}
            message={chosen && chosen.status === "no_data" ? chosen.note : "这里只统计 Agent 日志里记下的 Token。"}
          />
        ) : report ? (
          <View style={{ gap: 18, opacity: current ? 1 : 0.45 }}>
            <UsageDashboard key={`${report.days}-${report.agent}`} report={report} />
            <View style={{ gap: 6, paddingHorizontal: 4 }}>
              {report.warnings.map((warning) => (
                <Text key={warning} style={[type.footnote, { color: colors.waiting }]}>
                  {warning}
                </Text>
              ))}
              <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
                {new Date(report.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} 统计 · 只算日志里记下的 Token，不代表剩余额度或账单
              </Text>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}
