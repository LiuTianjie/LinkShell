import { useState } from "react";
import { router } from "expo-router";
import { Platform, View } from "react-native";
import type { BackgroundTask } from "@linkshell/wire";
import { Text } from "./fixed-text";
import { PressableScale } from "./pressable-scale";
import { Icon } from "./icon";
import { LiveDot } from "./status";
import { Button } from "./button";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { duration } from "@/lib/format";
import { useNow } from "@/lib/use-now";

export const taskStatus: Record<BackgroundTask["state"], string> = { running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止", unknown: "状态待确认" };
export function TaskList({ sessionId, tasks }: { sessionId: string; tasks: BackgroundTask[] }) {
  const [open, setOpen] = useState(false);
  const now = useNow(tasks.some((task) => task.state === "running") ? 1000 : 30_000);
  const live = tasks.filter((task) => task.state === "running");
  const ended = tasks.filter((task) => task.state !== "running");
  // Finished tasks fold away only behind running ones, and only when there are several.
  const foldable = live.length > 0 && ended.length > 1;
  const expanded = !foldable || open;
  return <View style={{ gap: 10, marginBottom: 18 }}>
    <Text style={[type.headline, { color: colors.label, paddingHorizontal: 4, paddingTop: Platform.OS === "android" ? 16 : 0 }]}>后台任务</Text>
    {[...live, ...(expanded ? ended : [])].map((task) => <PressableScale key={task.id} accessibilityRole="button" accessibilityLabel={`${task.title}，${taskStatus[task.state]}`} onPress={() => router.push({ pathname: "/session/[id]/task/[task]", params: { id: sessionId, task: task.id } })} style={{ padding: 14, borderRadius: 18, backgroundColor: colors.sheetCard, flexDirection: "row", gap: 12, alignItems: "center" }}>
      <Icon sf="terminal" md="terminal" size={22} color={colors.secondaryLabel} />
      <View style={{ flex: 1, gap: 5 }}>
        <Text numberOfLines={2} style={[type.subhead, { color: colors.label, fontWeight: "600" }]}>{task.title}</Text>
        <View style={{ flexDirection: "row", gap: 5, alignItems: "center" }}>{task.state === "running" ? <LiveDot size={6} /> : null}<Text style={[type.footnote, { color: task.state === "failed" ? colors.danger : colors.secondaryLabel }]}>{task.kind === "monitor" ? "Monitor" : "Shell"} · {taskStatus[task.state]} · {duration(Math.max(0, (task.endedAt ?? now) - task.startedAt))}</Text></View>
        {task.summary ? <Text numberOfLines={2} style={[type.caption, { color: colors.secondaryLabel }]}>{task.summary}</Text> : null}
      </View>
      <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.tertiaryLabel} />
    </PressableScale>)}
    {foldable ? <Button title={`${open ? "收起" : "查看"}其他 ${ended.length} 个任务`} variant="plain" onPress={() => setOpen(!open)} /> : null}
  </View>;
}
