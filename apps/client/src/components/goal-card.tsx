import type { SessionGoal } from "@linkshell/wire";
import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { Text } from "./fixed-text";
import { Icon } from "./icon";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { compactNumber } from "@/lib/format";

export const goalStatus: Record<SessionGoal["status"], string> = { active: "进行中", paused: "已暂停", blocked: "需要处理", usageLimited: "用量受限", budgetLimited: "预算已用完", complete: "已完成" };

export function GoalCard({ sessionId, goal }: { sessionId: string; goal: SessionGoal }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`目标：${goal.objective}，${goalStatus[goal.status]}`} onPress={() => router.push({ pathname: "/session/[id]/goal", params: { id: sessionId } })} style={{ borderRadius: 18, padding: 12, gap: 6, backgroundColor: colors.inset }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon sf="target" md="flag" size={16} color={colors.accent} />
      <Text style={[type.footnote, { flex: 1, color: colors.accent, fontWeight: "600" }]}>目标 · {goalStatus[goal.status]}</Text>
      <Icon sf="chevron.right" md="chevron_right" size={12} color={colors.secondaryLabel} />
    </View>
    <Text numberOfLines={2} style={[type.subhead, { color: colors.label }]}>{goal.objective}</Text>
    {goal.tokensUsed !== undefined ? <Text style={[type.caption, { color: colors.secondaryLabel }]}>{compactNumber(goal.tokensUsed)}{goal.tokenBudget ? ` / ${compactNumber(goal.tokenBudget)}` : ""} tokens{goal.timeUsedSeconds !== undefined ? ` · ${Math.floor(goal.timeUsedSeconds / 60)} 分钟` : ""}</Text> : null}
    {goal.iterations !== undefined ? <Text style={[type.caption, { color: colors.secondaryLabel }]}>已检查 {goal.iterations} 轮</Text> : null}
  </Pressable>;
}
