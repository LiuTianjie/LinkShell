import type { TimelineItem } from "@linkshell/client-core";
import { router } from "expo-router";
import { memo } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { describeTool } from "@/lib/describe";
import { duration } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useNow } from "@/lib/use-now";
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
  const children = item.sub?.items ?? [];
  const running = item.status === "in_progress" || item.status === "pending" || item.sub?.turnActive === true;
  const failed = item.status === "failed";
  const now = useNow(running ? 1000 : null);
  const steps = children.filter((child) => child.kind === "tool").length;
  // Background sub-agents' calls return at launch; the work ends with their last event.
  const lastChild = children.reduce((latest, child) => Math.max(latest, child.kind === "tool" ? (child.endedTs ?? child.ts) : child.ts), 0);
  const elapsed = (running ? now : Math.max(item.endedTs ?? item.ts, lastChild)) - item.ts;
  const detail = item.detail?.type === "subagent" ? item.detail : undefined;
  return {
    children,
    running,
    failed,
    steps,
    elapsed,
    name: detail?.agentType ?? "子 Agent",
    model: detail?.model,
    task: detail?.task ?? item.title.replace(/^[^:：]*[:：]\s*/, ""),
    summary:
      [steps ? `${steps} 步` : null, elapsed >= 1000 ? `${running ? "已运行" : "用时"} ${duration(elapsed)}` : null, failed ? "失败" : null]
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
      accessibilityHint="查看这个子 Agent 的全部过程"
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
        <StatusMark running={running} failed={failed} />
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
      <Icon sf="person.2.fill" md="group" size={size * 0.47} color={failed ? colors.danger : colors.accent} />
    </View>
  );
}

export function StatusMark({ running, failed }: { running: boolean; failed: boolean }) {
  if (running) return <ActivityIndicator size="small" color={colors.accent} />;
  if (failed) return <Icon sf="xmark.circle.fill" md="cancel" size={16} color={colors.danger} />;
  return <Icon sf="checkmark.circle.fill" md="check_circle" size={16} color={colors.ok} />;
}
