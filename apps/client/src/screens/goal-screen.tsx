import { useEffect, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import type { GoalChange } from "@linkshell/wire";
import { Text, TextInput } from "@/components/fixed-text";
import { SheetHeader } from "@/components/sheet-header";
import { Button } from "@/components/button";
import { goalStatus } from "@/components/goal-card";
import { useActions, useClient, useConnection, useSessionSubscription } from "@/lib/client";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";

export function GoalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useSessionSubscription(id);
  const session = useClient((state) => state.sessions[id]);
  const driver = useClient((state) => state.views[id]?.driver ?? state.sessions[id]?.driver);
  const goal = useClient((state) => state.views[id]?.goal);
  const offered = useClient((state) => state.views[id]?.commands.some((command) => command.name === "goal"));
  const online = useClient((state) => state.status === "online");
  const { link } = useConnection();
  const actions = useActions();
  const codex = session?.agent === "codex";
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [budget, setBudget] = useState(goal?.tokenBudget?.toString() ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!editing) { setObjective(goal?.objective ?? ""); setBudget(goal?.tokenBudget?.toString() ?? ""); }
  }, [goal?.objective, goal?.tokenBudget, editing]);
  useEffect(() => {
    if (!codex || !online) return;
    let active = true;
    void link.call("sessions.goal", { sessionId: id, change: { action: "get" } }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [codex, online, link, id]);

  const change = async (change: GoalChange) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (codex) await link.call("sessions.goal", { sessionId: id, change });
      else {
        const text = change.action === "set" ? `/goal ${change.objective}` : change.action === "clear" ? "/goal clear" : "/goal";
        const delivery = await actions.send(id, [{ type: "text", text }], { now: true });
        if (delivery === "failed") throw new Error("目标命令未发送成功，请在会话中重试");
        setNotice(delivery === "queued" ? "目标命令已排队，等待 Claude 执行" : "已发送目标命令，执行结果会显示在会话中");
      }
      setEditing(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const save = () => {
    const tokenBudget = budget.trim() ? Number(budget) : undefined;
    if (!objective.trim() || (codex && objective.trim().length > 4000)) { setError("请输入目标，Codex 目标最多 4000 字符"); return; }
    if (!codex && ["clear", "stop", "off", "reset", "none", "cancel"].includes(objective.trim())) { setError("这是 Claude 的清除指令，请输入具体的完成条件"); return; }
    if (codex && tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) { setError("Token 预算必须为正整数"); return; }
    void change({ action: "set", objective: objective.trim(), ...(codex && tokenBudget !== undefined ? { tokenBudget } : {}) });
  };
  const readOnly = codex && driver === "desktop";
  const disabled = busy || !online || !offered || readOnly;
  return <KeyboardAwareScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 16 }} keyboardShouldPersistTaps="handled" bottomOffset={24}>
    <SheetHeader title="持续目标" />
    <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{codex ? "设定完成条件，让 Codex 持续推进；可以暂停、继续或清除目标。" : "设定完成条件，让 Claude 持续推进；达到条件后自动清除，也可以提前清除。"}</Text>
    {goal ? <View style={{ gap: 6 }}>
      <Text style={[type.headline, { color: colors.accent }]}>{goalStatus[goal.status]}</Text>
      <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{goal.tokensUsed !== undefined ? `已用 ${goal.tokensUsed.toLocaleString()} tokens` : goal.iterations !== undefined ? `已检查 ${goal.iterations} 轮` : "目标已设置"}</Text>
      {goal.lastReason ? <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{goal.lastReason}</Text> : null}
    </View> : <Text style={[type.subhead, { color: colors.secondaryLabel }]}>{goal === null ? "当前没有活动目标" : "尚未收到目标状态"}</Text>}
    <TextInput accessibilityLabel="目标内容" value={objective} onChangeText={(value) => { setEditing(true); setObjective(value); }} multiline maxLength={codex ? 4000 : undefined} placeholder="希望完成什么？如何判断完成？" placeholderTextColor={colors.placeholder as string} style={[type.body, { minHeight: 130, padding: 14, borderRadius: 16, backgroundColor: colors.sheetCard, color: colors.label, textAlignVertical: "top" }]} />
    {codex ? <View style={{ gap: 6 }}><Text style={[type.footnote, { color: colors.secondaryLabel }]}>Token 预算（可选）</Text><TextInput accessibilityLabel="Token 预算" value={budget} onChangeText={(value) => { setEditing(true); setBudget(value); }} keyboardType="number-pad" placeholder={goal?.tokenBudget ? "留空保留现有预算" : "不设置预算"} placeholderTextColor={colors.placeholder as string} style={[type.body, { padding: 14, borderRadius: 14, backgroundColor: colors.sheetCard, color: colors.label }]} /></View> : null}
    <Button variant="primary" title={goal ? "更新目标" : "开始目标"} onPress={save} disabled={disabled || !objective.trim()} />
    {codex && goal ? <Button title={goal.status === "active" ? "暂停目标" : "继续目标"} onPress={() => void change({ action: goal.status === "active" ? "pause" : "resume" })} disabled={disabled || goal.status === "complete" || goal.status === "budgetLimited"} /> : null}
    {goal ? <Button variant="destructive" title="清除目标" onPress={() => void change({ action: "clear" })} disabled={disabled} /> : null}
    {!codex ? <Button title="查询当前目标" onPress={() => void change({ action: "get" })} disabled={disabled} /> : null}
    {!offered ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>当前 Agent 尚未提供 Goal 命令。请连接或接管会话，并确认电脑上的 Agent 版本支持此功能。</Text> : null}
    {readOnly ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>会话正由电脑上的独立 Codex 客户端控制，这里可以查看目标；请在电脑端暂停或修改。</Text> : null}
    {busy || notice ? <Text accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.secondaryLabel }]}>{busy ? "正在处理…" : notice}</Text> : null}
    {error ? <Text accessibilityLiveRegion="polite" style={[type.footnote, { color: colors.danger }]}>{error}</Text> : null}
  </KeyboardAwareScrollView>;
}
