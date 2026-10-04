import { workflowIsLive, type TimelineItem, type WorkflowRecord } from "@linkshell/client-core";
import type { Workflow, WorkflowAgent, WorkflowAgentState } from "@linkshell/wire";
import { router } from "expo-router";
import { memo, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useClient } from "@/lib/client";
import { compactNumber, duration } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useNow } from "@/lib/use-now";
import { workflowCounts, workflowCurrentPhase, workflowElapsed, workflowFromTool, workflowGroups, workflowStateText, type WorkflowGroup } from "@/lib/workflows";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "./icon";
import { PressableScale } from "./pressable-scale";
import { useTimelineSession } from "./timeline/context";

export function openWorkflow(sessionId: string, call: string) {
  haptics.selection();
  router.push({ pathname: "/session/[id]/workflow/[call]", params: { id: sessionId, call } });
}

export function WorkflowMark({ state, size = 16 }: { state?: WorkflowAgentState; size?: number }) {
  if (state === "running") return <ActivityIndicator size="small" color={colors.accent} />;
  if (state === "completed") return <Icon sf="checkmark.circle.fill" md="check_circle" size={size} color={colors.ok} />;
  if (state === "failed") return <Icon sf="exclamationmark.circle.fill" md="error" size={size} color={colors.danger} />;
  if (state === "paused") return <Icon sf="pause.circle" md="pause_circle" size={size} color={colors.waiting} />;
  if (state === "stopped") return <Icon sf="stop.circle" md="stop_circle" size={size} color={colors.secondaryLabel} />;
  return <Icon sf={state === "unknown" ? "questionmark.circle" : "circle.dotted"} md={state === "unknown" ? "help_outline" : "radio_button_unchecked"} size={size} color={colors.tertiaryLabel} />;
}

export function WorkflowSummary({ record, compact = false }: { record: WorkflowRecord; compact?: boolean }) {
  const { workflow } = record;
  const now = useNow(workflowIsLive(workflow) ? 1000 : null);
  const counts = workflowCounts(workflow);
  const phase = workflowCurrentPhase(workflow);
  const elapsed = workflowElapsed(record, now);
  return (
    <View style={{ gap: compact ? 8 : 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon sf="point.3.connected.trianglepath.dotted" md="account_tree" size={16} color={colors.accent} />
        <Text style={[type.caption, { flex: 1, color: colors.secondaryLabel, fontWeight: "600" }]}>工作流</Text>
        <WorkflowMark state={workflow.state} />
        <Text style={[type.caption, { color: workflow.state === "failed" ? colors.danger : colors.secondaryLabel }]}>
          {workflow.state ? workflowStateText[workflow.state] : "正在启动"}
        </Text>
      </View>
      <Text numberOfLines={compact ? 2 : undefined} style={[compact ? type.headline : type.title, { color: colors.label }]}>
        {workflow.name ?? record.task ?? "工作流"}
      </Text>
      {phase && !compact ? <Text numberOfLines={1} style={[type.subhead, { color: colors.accent }]}>{phase}</Text> : null}
      <View style={{ gap: 7 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 6 }}>
          <Text style={[type.subhead, { color: colors.label, fontWeight: "600", fontVariant: ["tabular-nums"] }]}>已完成 {counts.completed}</Text>
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>/ 已启动 {counts.started} 个 Agent</Text>
          {counts.failed > 0 ? <Text style={[type.footnote, { color: colors.danger }]}>{counts.failed} 个失败</Text> : null}
        </View>
        {counts.started > 0 ? (
          <View accessibilityRole="progressbar" accessibilityValue={{ text: `已完成 ${counts.completed} 个，已启动 ${counts.started} 个 Agent` }} style={{ height: 4, backgroundColor: colors.fillStrong, borderRadius: 2, overflow: "hidden" }}>
            <View style={{ height: 4, width: `${Math.min(100, counts.completed / counts.started * 100)}%`, backgroundColor: workflow.state === "completed" ? colors.ok : colors.accent }} />
          </View>
        ) : null}
      </View>
      <Text style={[type.caption, { color: colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}>
        {[
          workflow.tokens !== undefined ? `${compactNumber(workflow.tokens)} tokens` : undefined,
          elapsed >= 1000 ? duration(elapsed) : undefined,
          workflow.state === "stopped" && counts.running + counts.paused > 0 ? `${counts.running + counts.paused} 个 Agent 尚未结束` : undefined,
        ].filter(Boolean).join(" · ") || "等待运行信息"}
      </Text>
    </View>
  );
}

export const WorkflowAgentRow = memo(function WorkflowAgentRow({ agent, sessionId, compact = false }: { agent: WorkflowAgent; sessionId?: string; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const canOpen = !!sessionId && !!agent.toolCallId;
  const hasResult = !!agent.result;
  const state = workflowStateText[agent.state];
  const onPress = () => {
    haptics.selection();
    if (canOpen) router.push({ pathname: "/session/[id]/workflow-agent/[call]", params: { id: sessionId!, call: agent.toolCallId! } });
    else setExpanded((value) => !value);
  };
  return (
    <View>
      <Pressable
        disabled={!canOpen && !hasResult}
        onPress={onPress}
        accessibilityRole={canOpen || hasResult ? "button" : undefined}
        accessibilityLabel={`${agent.title}，${state}`}
        accessibilityHint={canOpen ? "查看 Agent 的完整过程" : hasResult ? "展开结果" : undefined}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, paddingVertical: compact ? 8 : 12, paddingHorizontal: compact ? 0 : 14, backgroundColor: pressed ? colors.fill : undefined, borderRadius: 10 })}
      >
        <View style={{ width: 20, alignItems: "center" }}><WorkflowMark state={agent.state} /></View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text numberOfLines={2} style={[type.subhead, { color: colors.label, fontWeight: "500" }]}>{agent.title}</Text>
          <Text numberOfLines={1} style={[type.caption, { color: agent.state === "failed" ? colors.danger : colors.secondaryLabel, fontVariant: ["tabular-nums"] }]}>
            {[state, agent.model, agent.toolCalls !== undefined ? `${agent.toolCalls} 次工具调用` : undefined,
              agent.tokens !== undefined ? `${compactNumber(agent.tokens)} tokens` : undefined,
              agent.durationMs !== undefined ? duration(agent.durationMs) : undefined].filter(Boolean).join(" · ")}
          </Text>
        </View>
        {canOpen || hasResult ? <Icon sf={expanded ? "chevron.down" : "chevron.right"} md={expanded ? "expand_more" : "chevron_right"} size={12} color={colors.tertiaryLabel} /> : null}
      </Pressable>
      {expanded && !canOpen && agent.result ? <Text selectable style={[type.footnote, { color: colors.secondaryLabel, paddingLeft: compact ? 30 : 44, paddingRight: 14, paddingBottom: 12 }]}>{agent.result}</Text> : null}
    </View>
  );
});

export function WorkflowPhaseSection({ group, sessionId }: { group: WorkflowGroup; sessionId: string }) {
  const completed = group.agents.filter((agent) => agent.state === "completed").length;
  const running = group.agents.filter((agent) => agent.state === "running").length;
  const failed = group.agents.filter((agent) => agent.state === "failed").length;
  const [open, setOpen] = useState(() => completed !== group.agents.length || group.agents.length === 0);
  const [visibleCount, setVisibleCount] = useState(12);
  return (
    <View style={{ gap: 3 }}>
      <Pressable
        onPress={() => { haptics.selection(); setOpen((value) => !value); }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${group.title}，${group.agents.length} 个 Agent`}
        style={{ flexDirection: "row", alignItems: "center", minHeight: 52, paddingHorizontal: 4, gap: 10 }}
      >
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[type.headline, { color: colors.label }]}>{group.title}</Text>
          <Text style={[type.caption, { color: failed ? colors.danger : colors.secondaryLabel }]}>
            {[`${completed} / ${group.agents.length} 已完成`, running ? `${running} 运行中` : undefined, failed ? `${failed} 失败` : undefined].filter(Boolean).join(" · ")}
          </Text>
        </View>
        <Icon sf={open ? "chevron.down" : "chevron.right"} md={open ? "expand_more" : "chevron_right"} size={13} color={colors.secondaryLabel} />
      </Pressable>
      {open ? (
        <View style={{ borderRadius: 16, borderCurve: "continuous", backgroundColor: colors.card, overflow: "hidden" }}>
          {group.agents.length ? group.agents.slice(0, visibleCount).map((agent, index) => (
            <View key={agent.id}>
              {index > 0 ? <View style={{ height: 0.5, marginLeft: 44, backgroundColor: colors.separator }} /> : null}
              <WorkflowAgentRow agent={agent} sessionId={sessionId} />
            </View>
          )) : <Text style={[type.footnote, { padding: 16, color: colors.tertiaryLabel }]}>暂无 Agent</Text>}
          {group.agents.length > visibleCount ? (
            <Pressable onPress={() => setVisibleCount((count) => count + 12)} accessibilityRole="button" style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 14 }}>
              <Text style={[type.footnote, { color: colors.accent }]}>显示更多（还有 {group.agents.length - visibleCount} 个）</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A bounded preview; the run's complete roster lives on its own screen. */
export function WorkflowPreview({ workflow, sessionId }: { workflow: Workflow; sessionId?: string }) {
  const groups = workflowGroups(workflow);
  const priority: Record<WorkflowAgentState, number> = { running: 0, failed: 1, paused: 2, pending: 3, unknown: 4, stopped: 5, completed: 6 };
  const shown = new Set([...(workflow.agents ?? [])].sort((a, b) => priority[a.state] - priority[b.state]).slice(0, 3).map((agent) => agent.id));
  return groups.map((group) => {
    const agents = group.agents.filter((agent) => shown.has(agent.id));
    return agents.length ? <View key={group.id}>
      {group.id !== "ungrouped" ? <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel, fontWeight: "600", paddingTop: 6 }]}>{group.title}</Text> : null}
      {agents.map((agent) => <WorkflowAgentRow key={agent.id} agent={agent} sessionId={sessionId} compact />)}
    </View> : null;
  });
}

export const WorkflowCard = memo(function WorkflowCard({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const sessionId = useTimelineSession();
  const saved = useClient((state) => sessionId ? state.workflows[sessionId]?.[item.id] : undefined);
  const record = useMemo(() => saved ?? workflowFromTool(item), [saved, item]);
  const counts = workflowCounts(record.workflow);
  const state = record.workflow.state;
  return (
    <PressableScale
      disabled={!sessionId}
      onPress={() => openWorkflow(sessionId!, record.toolCallId)}
      accessibilityRole="button"
      accessibilityLabel={`查看工作流：${record.workflow.name ?? record.task}，${state ? workflowStateText[state] : "正在启动"}，${counts.completed} / ${counts.started} 个 Agent 已完成${counts.failed ? `，${counts.failed} 个失败` : ""}`}
      accessibilityHint="查看完整流程和各个 Agent 的过程"
      style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 14, backgroundColor: colors.inset }}
    >
      <WorkflowMark state={state} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>{record.workflow.name ?? record.task}</Text>
        <Text numberOfLines={1} style={[type.caption, { color: counts.failed || state === "failed" ? colors.danger : colors.secondaryLabel }]}>
          {[state ? workflowStateText[state] : "正在启动", `${counts.completed} / ${counts.started} 个 Agent 已完成`, counts.running ? `${counts.running} 个运行中` : undefined].filter(Boolean).join(" · ")}
        </Text>
      </View>
      {counts.failed > 0 ? <Text style={[type.caption, { color: colors.danger }]}>{counts.failed} 个失败</Text> : null}
      <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.tertiaryLabel} />
    </PressableScale>
  );
});

export function WorkflowCardContent({ record, sessionId }: { record: WorkflowRecord; sessionId?: string }) {
  return (
    <View style={{ backgroundColor: colors.inset, borderRadius: 18, borderCurve: "continuous", padding: 14, gap: 9 }}>
      <Pressable disabled={!sessionId} onPress={() => openWorkflow(sessionId!, record.toolCallId)} accessibilityRole="button" accessibilityLabel={`查看工作流：${record.workflow.name ?? record.task}`}>
        <WorkflowSummary record={record} compact />
      </Pressable>
      <WorkflowPreview workflow={record.workflow} sessionId={sessionId} />
      <Pressable disabled={!sessionId} onPress={() => openWorkflow(sessionId!, record.toolCallId)} accessibilityRole="button" style={{ minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 0.5, borderTopColor: colors.separator }}>
        <Text style={[type.footnote, { color: colors.accent, fontWeight: "600" }]}>查看完整流程</Text>
        <Icon sf="arrow.right" md="arrow_forward" size={14} color={colors.accent} />
      </Pressable>
    </View>
  );
}

export function LiveWorkflowsBar({ sessionId }: { sessionId: string }) {
  const records = useClient((state) => state.workflows[sessionId]);
  const live = useMemo(() => Object.values(records ?? {}).filter((record) => workflowIsLive(record.workflow)), [records]);
  if (!live.length) return null;
  const first = live[0]!;
  const counts = workflowCounts(first.workflow);
  const phase = workflowCurrentPhase(first.workflow);
  const activeCounts = live.reduce((sum, record) => {
    const next = workflowCounts(record.workflow);
    return { running: sum.running + next.running, paused: sum.paused + next.paused };
  }, { running: 0, paused: 0 });
  const activity = [activeCounts.running ? `${activeCounts.running} 个 Agent 运行中` : undefined, activeCounts.paused ? `${activeCounts.paused} 个已暂停` : undefined].filter(Boolean).join(" · ") || "等待 Agent 启动";
  return (
    <PressableScale
      pressedScale={0.99}
      accessibilityRole="button"
      accessibilityLabel={live.length > 1 ? `查看 ${live.length} 个进行中的工作流` : `查看工作流：${first.workflow.name ?? first.task}`}
      onPress={() => live.length === 1 ? openWorkflow(sessionId, first.toolCallId) : router.push({ pathname: "/session/[id]/workflows", params: { id: sessionId } })}
      outerStyle={{ marginHorizontal: 12, marginBottom: 2 }}
      style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14, backgroundColor: colors.inset, flexDirection: "row", alignItems: "center", gap: 10 }}
    >
      <WorkflowMark state={first.workflow.state} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={[type.footnote, { color: colors.label, fontWeight: "600" }]}>
          {live.length > 1 ? `${live.length} 个工作流进行中` : first.workflow.name ?? first.task}
        </Text>
        <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel }]}>
          {live.length > 1 ? activity
            : first.workflow.state === "stopped" ? `已停止 · ${counts.running + counts.paused} 个 Agent 尚未结束`
            : [phase, first.workflow.state === "paused" ? "已暂停" : activity, `${counts.completed} 个已完成`].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <Icon sf="chevron.right" md="chevron_right" size={13} color={colors.tertiaryLabel} />
    </PressableScale>
  );
}
