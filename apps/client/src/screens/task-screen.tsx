import { useEffect, useRef, useState } from "react";
import { useIsFocused } from "expo-router/react-navigation";
import { useLocalSearchParams } from "expo-router";
import { Alert, ScrollView, View } from "react-native";
import type { MethodResult } from "@linkshell/wire";
import { Text } from "@/components/fixed-text";
import { SheetHeader } from "@/components/sheet-header";
import { Button } from "@/components/button";
import { taskStatus } from "@/components/background-tasks";
import { LiveDot } from "@/components/status";
import { useActions, useClient, useSessionSubscription } from "@/lib/client";
import { duration } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";

export function TaskScreen() {
  const { id, task: taskId } = useLocalSearchParams<{ id: string; task: string }>();
  useSessionSubscription(id);
  const focused = useIsFocused();
  const task = useClient((state) => state.tasks[id]?.[taskId]);
  const online = useClient((state) => state.status === "online");
  const { loadTasks, loadTaskOutput, stopTask } = useActions();
  const [output, setOutput] = useState<MethodResult<"sessions.taskOutput">>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [paging, setPaging] = useState(false);
  const readingEarlier = useRef(false);
  const generation = useRef(0);
  const now = useNow(task?.state === "running" ? 1000 : 30_000);
  useEffect(() => {
    readingEarlier.current = false; generation.current++; setOutput(undefined); setError("");
  }, [id, taskId]);
  useEffect(() => {
    if (!online || !focused) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const revision = generation.current;
      try {
        await loadTasks(id);
        if (!readingEarlier.current) {
          const result = await loadTaskOutput(id, taskId);
          if (active && revision === generation.current) { setOutput(result); setError(""); }
        }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }
      if (active && task?.state === "running") timer = setTimeout(() => void read(), 2000);
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [focused, online, id, taskId, task?.state, loadTasks, loadTaskOutput]);
  const earlier = async () => {
    if (!output?.start || paging) return;
    readingEarlier.current = true; generation.current++; setPaging(true);
    try {
      const page = await loadTaskOutput(id, taskId, output.start);
      setOutput((old) => old ? { text: page.text + old.text, start: page.start, size: page.size } : page);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPaging(false); }
  };
  const latest = async () => {
    if (paging) return;
    setPaging(true); generation.current++;
    try { setOutput(await loadTaskOutput(id, taskId)); readingEarlier.current = false; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPaging(false); }
  };
  const stop = () => Alert.alert("停止这个后台任务？", "这一轮对话和其他任务不受影响。", [
    { text: "取消", style: "cancel" },
    { text: "停止任务", style: "destructive", onPress: () => {
      setBusy(true); setError("");
      void stopTask(id, taskId).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false));
    } },
  ]);
  return <View style={{ flex: 1 }}><SheetHeader title="任务详情" /><View style={{ flex: 1, overflow: "hidden" }}><ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}>
    <Text selectable style={[type.title3, { color: colors.label }]}>{task?.title ?? "正在读取…"}</Text>
    {task ? <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>{task.state === "running" ? <LiveDot size={7} /> : null}<Text style={[type.subhead, { color: task.state === "failed" ? colors.danger : colors.secondaryLabel }]}>{taskStatus[task.state]} · {duration(Math.max(0, (task.endedAt ?? now) - task.startedAt))}{task.exitCode !== undefined ? ` · 退出码 ${task.exitCode}` : ""}</Text></View> : null}
    {task?.command ? <Text selectable style={[type.footnote, { fontFamily: mono, padding: 14, borderRadius: 14, backgroundColor: colors.inset, color: colors.label }]}>{task.command}</Text> : null}
    {task?.summary ? <Text selectable style={[type.subhead, { color: colors.secondaryLabel }]}>{task.summary}</Text> : null}
    {task?.state === "unknown" ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>电脑端已无法确认任务状态，未收到可靠的结束结果。</Text> : null}
    {task?.state === "running" && !task.canStop ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>此任务目前只能查看，请在电脑上的 Agent 中停止。</Text> : null}
    {task?.canStop && task.state === "running" ? <Button title="停止任务" variant="destructive" onPress={stop} busy={busy} disabled={!online} /> : null}
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}><Text style={[type.headline, { color: colors.label }]}>输出</Text><Button title="查看最新" variant="plain" size="small" onPress={() => void latest()} disabled={!online || paging} /></View>
    {output?.start ? <Button title="加载更早的输出" onPress={() => void earlier()} busy={paging} disabled={!online} /> : null}
    <Text selectable style={[type.footnote, { fontFamily: mono, color: colors.label, padding: 14, backgroundColor: colors.inset, borderRadius: 14 }]}>{output?.text || (output ? "没有可读的输出" : "正在读取输出…")}</Text>
    {error ? <Text accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.danger }]}>{error}</Text> : null}
  </ScrollView></View></View>;
}
