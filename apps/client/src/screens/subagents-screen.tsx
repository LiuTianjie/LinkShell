import type { SubagentInfo } from "@linkshell/wire";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { AdaptiveGrid, usePageInsets } from "@/components/adaptive-page";
import { SheetHeader } from "@/components/sheet-header";
import { Icon } from "@/components/icon";
import { PressableScale } from "@/components/pressable-scale";
import { EmptyState, LoadingState } from "@/components/state-views";
import { LiveDot } from "@/components/status";
import { SubagentGlyph } from "@/components/timeline/subagent";
import { TaskList } from "@/components/background-tasks";
import { WorkflowCardContent } from "@/components/workflow";
import { useActions, useClient } from "@/lib/client";
import { duration, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

function Row({ entry, last, now, onPress }: { entry: SubagentInfo; last: boolean; now: number; onPress: () => void }) {
  const failed = entry.failed === true;
  const outcome = entry.state === "unknown" ? "结果待确认" : entry.state === "stopped" ? "已停止" : entry.state === "paused" ? "已暂停" : failed ? "失败" : "已完成";
  const state = entry.running
    ? entry.state === "paused" ? "已暂停" : `已运行 ${duration(now - entry.startedAt)}`
    : `${outcome} · ${relativeTime(entry.endedAt ?? entry.startedAt, now)}`;
  return (
    <PressableScale
      onPress={onPress}
      pressedScale={0.985}
      accessibilityRole="button"
      accessibilityLabel={[entry.name ?? entry.agentType ?? "子 Agent", entry.task, entry.running ? "运行中" : outcome].join("，")}
      accessibilityHint="查看这个子 Agent 的全部过程"
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 14 }}>
        <SubagentGlyph failed={failed} size={32} />
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 11,
            paddingRight: 14,
            borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
            borderBottomColor: colors.separator,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={2} style={[type.subhead, { color: colors.label, fontWeight: "500" }]}>
              {entry.task || entry.agentType || "子 Agent"}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              {entry.running ? <LiveDot size={6} /> : null}
              <Text
                numberOfLines={1}
                style={[type.footnote, { flex: 1, color: entry.running ? colors.running : failed ? colors.danger : colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}
              >
                {(entry.name ?? entry.agentType) && entry.task ? <Text style={{ color: colors.secondaryLabel }}>{entry.name ?? entry.agentType} · </Text> : null}
                {state}
              </Text>
            </View>
          </View>
          <Icon sf="chevron.right" md="chevron_right" size={11} color={colors.tertiaryLabel} weight="semibold" />
        </View>
      </View>
    </PressableScale>
  );
}

/**
 * The session's sub-agents, newest first: the ones still working and the ones
 * that finished long ago, without scrolling back to where each was started.
 */
export function SubagentsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = usePageInsets();
  const { loadSubagents, loadTasks } = useActions();
  const records = useClient((state) => state.tasks[id]);
  const taskCounts = useClient((state) => state.sessions[id]?.tasks);
  const tasks = useMemo(() => Object.values(records ?? {}).sort((a, b) => b.startedAt - a.startedAt), [records]);
  const listed = useClient((state) => state.subagents[id]);
  const workflows = useClient((state) => state.workflows[id]);
  const runs = useMemo(() => Object.values(workflows ?? {}).sort((a, b) => b.startedAt - a.startedAt), [workflows]);
  // The ones still working first, then newest first (as the computer lists them).
  const list = useMemo(() => {
    if (!listed) return undefined;
    const byId = new Map(listed.map((entry) => [entry.toolCallId, entry]));
    return listed.filter((entry) => {
      const visited = new Set<string>();
      let current: SubagentInfo | undefined = entry;
      while (current && !visited.has(current.toolCallId)) {
        if (current.workflow || workflows?.[current.toolCallId]) return false;
        visited.add(current.toolCallId);
        current = current.parentToolCallId ? byId.get(current.parentToolCallId) : undefined;
      }
      return true;
    }).sort((a, b) => Number(b.running) - Number(a.running));
  }, [listed, workflows]);
  const counts = useClient((state) => state.sessions[id]?.subagents);
  const online = useClient((state) => state.status === "online");
  const [error, setError] = useState<string | null>(null);
  const running = list?.some((entry) => entry.running) ?? false;
  const now = useNow(running ? 1000 : 30_000);

  // (Again) whenever one starts or finishes.
  useEffect(() => {
    if (!online) return;
    setError(null);
    Promise.all([loadSubagents(id), loadTasks(id)]).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [loadSubagents, loadTasks, id, online, counts?.total, counts?.running, taskCounts?.total, taskCounts?.running]);

  const open = (entry: SubagentInfo) => {
    haptics.selection();
    router.push({ pathname: "/session/[id]/agent/[call]", params: { id, call: entry.toolCallId } });
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetHeader title={tasks.length ? "后台任务与 Agent" : runs.length ? "Agent 与工作流" : "子 Agent"} />
      {list?.length || runs.length ? (
        <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }]}>
          {[list?.length ? `${list.length} 个子 Agent` : undefined, runs.length ? `${runs.length} 个工作流` : undefined].filter(Boolean).join(" · ")}
        </Text>
      ) : null}
      {/* Wrapped: a sheet stretches a scroll view that's a direct child of the screen over the whole sheet. */}
      <View style={{ flex: 1, overflow: "hidden" }}>
        <ScrollView contentInsetAdjustmentBehavior="never" style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: insets.bottom + 24 }}>
          {tasks.length ? <TaskList sessionId={id} tasks={tasks} /> : null}
          {runs.length ? <View style={{ marginBottom: list?.length ? 16 : 0 }}><AdaptiveGrid>{runs.map((record) => <WorkflowCardContent key={record.toolCallId} record={record} sessionId={id} />)}</AdaptiveGrid></View> : null}
          {!list ? (
            error ? (
              <EmptyState icon={{ sf: "exclamationmark.triangle", md: "warning" }} title="读取失败" message={error} />
            ) : (
              <LoadingState label="正在读取…" />
            )
          ) : list.length === 0 ? (
            runs.length || tasks.length ? null : <EmptyState icon={{ sf: "square.stack.3d.up", md: "layers" }} title="这个会话没有子 Agent" message="Agent 把任务分给子 Agent 后，会列在这里。" />
          ) : (
            <View style={{ backgroundColor: colors.sheetCard, borderRadius: 20, borderCurve: "continuous", overflow: "hidden" }}>
              {list.map((entry, index) => (
                <Row key={entry.toolCallId} entry={entry} last={index === list.length - 1} now={now} onPress={() => open(entry)} />
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}
