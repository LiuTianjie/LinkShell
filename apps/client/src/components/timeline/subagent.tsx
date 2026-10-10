import type { TimelineItem } from "@linkshell/client-core";
import { router } from "expo-router";
import { memo } from "react";
import { ActivityIndicator, View } from "react-native";
import { Text } from "@/components/fixed-text";
import { useClient } from "@/lib/client";
import { describeTool } from "@/lib/describe";
import { compactNumber, duration } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useNow } from "@/lib/use-now";
import { findWorkflowAgent } from "@/lib/workflows";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "../icon";
import { PressableScale } from "../pressable-scale";
import { useTimelineSession } from "./context";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

export function plainTail(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/[#*_`>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** What the sub-agent is doing right now, from the newest item of its own timeline. */
export function currentActivity(children: TimelineItem[]): string | undefined {
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i]!;
    if (child.kind === "tool") {
      const described = describeTool(child);
      return [described.verb, described.subject].filter(Boolean).join(" ");
    }
    if (child.kind === "thought" && child.streaming) return "思考中…";
    if (child.kind === "agent") return child.streaming ? "正在写回复…" : plainTail(child.text);
  }
  return undefined;
}

/** The sub-agent's final report: its last message. */
export function finalReport(children: TimelineItem[]): Extract<TimelineItem, { kind: "agent" }> | undefined {
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i]!;
    if (child.kind === "agent" && child.text.trim()) return child;
  }
  return undefined;
}

/** Running state, step count and elapsed time of a sub-agent call. */
export function useSubagentProgress(item: ToolItem) {
  const sessionId = useTimelineSession();
  // The computer's own record of it, once listed: it knows a background
  // sub-agent is still at work after its call returned, and one that was killed.
  const record = useClient((state) => (sessionId ? state.subagents[sessionId]?.find((entry) => entry.toolCallId === item.id) : undefined));
  const worker = useClient((state) => sessionId ? findWorkflowAgent(state.workflows[sessionId], item.id) : undefined);
  const children = item.sub?.items ?? [];
  const detail = item.detail?.type === "subagent" ? item.detail : undefined;
  const workflow = detail?.workflow;
  const outcome = workflow?.state ?? worker?.state ?? detail?.state ?? record?.state;
  const running = outcome ? outcome === "running" || outcome === "paused" || outcome === "pending" : record ? record.running : item.status === "in_progress" || item.status === "pending" || item.sub?.turnActive === true;
  const failed = outcome ? outcome === "failed" : record ? record.failed === true : item.status === "failed";
  const now = useNow(running ? 1000 : null);
  const steps = worker?.toolCalls ?? children.filter((child) => child.kind === "tool").length;
  // Background sub-agents' calls return at launch; the work ends with their last event.
  const lastChild = children.reduce((latest, child) => Math.max(latest, child.kind === "tool" ? (child.endedTs ?? child.ts) : child.ts), 0);
  const elapsed = worker?.durationMs ?? (running ? now : (worker?.endedAt ?? record?.endedAt ?? Math.max(item.endedTs ?? item.ts, lastChild))) - (worker?.startedAt ?? record?.startedAt ?? item.ts);
  const paused = outcome === "paused";
  const stopped = outcome === "stopped";
  const unknown = outcome === "unknown";
  const workflowSummary = workflow ? [
    workflow.started !== undefined ? `已完成 ${workflow.completed ?? 0} / 已启动 ${workflow.started} 个 Agent` : "正在启动…",
    workflow.tokens !== undefined ? `${compactNumber(workflow.tokens)} tokens` : null,
    paused ? "已暂停" : stopped ? "已停止" : null,
  ].filter(Boolean).join(" · ") : undefined;
  return {
    children,
    running,
    failed,
    steps,
    elapsed,
    paused,
    stopped,
    unknown,
    workflow: !!workflow,
    name: detail?.name ?? record?.name ?? detail?.agentType ?? "子 Agent",
    model: worker?.model ?? detail?.model,
    task: detail?.task ?? item.title.replace(/^[^:：]*[:：]\s*/, ""),
    summary:
      [workflowSummary ?? (steps ? `${steps} 步` : null), elapsed >= 1000 ? `${running ? "已运行" : "用时"} ${duration(workflow?.durationMs ?? elapsed)}` : null, paused && !workflow ? "已暂停" : stopped ? "已停止" : unknown ? "结果待确认" : failed ? "失败" : null]
        .filter(Boolean)
        .join(" · ") || (running ? "正在启动…" : "已完成"),
  };
}

/**
 * A sub-agent in the timeline: its task, a live line while it works and its
 * report when done. Its whole run opens in a sheet. Works for any agent whose
 * host driver nests the sub-agent's updates under the spawning call.
 */
export const SubagentCard = memo(function SubagentCard({ item }: { item: ToolItem }) {
  const sessionId = useTimelineSession();
  const progress = useSubagentProgress(item);
  const { children, running, failed } = progress;
  const activity = currentActivity(children);
  const report = running ? undefined : finalReport(children);

  return (
    <PressableScale
      pressedScale={0.985}
      disabled={!sessionId}
      onPress={() => {
        haptics.selection();
        router.push({ pathname: "/session/[id]/agent/[call]", params: { id: sessionId!, call: item.id } });
      }}
      accessibilityRole="button"
      accessibilityLabel={`${progress.name}：${progress.task}`}
      accessibilityHint={progress.workflow ? "查看工作流和各个 Agent 的过程" : "查看这个子 Agent 的全部过程"}
      style={{ backgroundColor: colors.inset, borderRadius: 18, borderCurve: "continuous", padding: 12, gap: 8 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <SubagentGlyph failed={failed} size={30} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text numberOfLines={1} style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>
            {progress.name}
          </Text>
          {progress.model ? (
            <Text numberOfLines={1} style={[type.caption, { color: colors.tertiaryLabel }]}>
              {progress.model}
            </Text>
          ) : null}
        </View>
        <StatusMark running={running && !progress.paused} failed={failed} paused={progress.paused} stopped={progress.stopped} unknown={progress.unknown} />
        <Icon sf="chevron.right" md="chevron_right" size={11} color={colors.tertiaryLabel} weight="semibold" />
      </View>

      {progress.task ? (
        <Text numberOfLines={2} style={[type.subhead, { color: colors.secondaryLabel }]}>
          {progress.task}
        </Text>
      ) : null}

      {running && activity ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
          <Text numberOfLines={1} style={[type.footnote, { flex: 1, color: colors.accent }]}>
            {activity}
          </Text>
        </View>
      ) : null}

      {report ? (
        <Text numberOfLines={3} style={[type.footnote, { color: colors.label }]}>
          {plainTail(report.text)}
        </Text>
      ) : null}

      <Text style={[type.caption, { color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }]}>{progress.summary}</Text>
    </PressableScale>
  );
});

export function SubagentGlyph({ failed, size }: { failed: boolean; size: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        borderCurve: "continuous",
        backgroundColor: failed ? colors.dangerSoft : colors.accentSoft,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon sf="square.stack.3d.up.fill" md="layers" size={size * 0.5} color={failed ? colors.danger : colors.accent} />
    </View>
  );
}

export function StatusMark({ running, failed, paused, stopped, unknown }: { running: boolean; failed: boolean; paused?: boolean; stopped?: boolean; unknown?: boolean }) {
  if (paused) return <Icon sf="pause.circle" md="pause_circle" size={16} color={colors.waiting} />;
  if (stopped) return <Icon sf="stop.circle" md="stop_circle" size={16} color={colors.secondaryLabel} />;
  if (unknown) return <Icon sf="questionmark.circle" md="help_outline" size={16} color={colors.secondaryLabel} />;
  if (running) return <ActivityIndicator size="small" color={colors.accent} />;
  if (failed) return <Icon sf="xmark.circle.fill" md="cancel" size={16} color={colors.danger} />;
  return <Icon sf="checkmark.circle.fill" md="check_circle" size={16} color={colors.ok} />;
}
