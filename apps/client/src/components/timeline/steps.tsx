import type { TimelineItem } from "@linkshell/client-core";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { cubicBezier } from "react-native-reanimated";
import { fileChanges } from "@/lib/describe";
import { duration } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "../icon";
import { GLYPH } from "./tool-call";

export type Step = Extract<TimelineItem, { kind: "tool" | "thought" }>;

interface Tally {
  commands: number;
  reads: number;
  files: Set<string>;
  searches: number;
  web: number;
  tools: number;
  thoughts: number;
  failed: number;
  added: number;
  removed: number;
}

function tally(steps: Step[]): Tally {
  const t: Tally = { commands: 0, reads: 0, files: new Set(), searches: 0, web: 0, tools: 0, thoughts: 0, failed: 0, added: 0, removed: 0 };
  for (const step of steps) {
    if (step.kind === "thought") {
      t.thoughts += 1;
      continue;
    }
    if (step.status === "failed") t.failed += 1;
    const changes = fileChanges(step.content);
    for (const change of changes) {
      t.files.add(change.path);
      t.added += change.added;
      t.removed += change.removed;
    }
    if (step.detail?.type === "web_search") t.web += 1;
    else if (step.detail) t.tools += 1;
    else if (step.toolKind === "execute") t.commands += 1;
    else if (step.toolKind === "read") t.reads += 1;
    else if (step.toolKind === "search") t.searches += 1;
    else if (step.toolKind === "fetch") t.web += 1;
    else if (step.toolKind === "think") t.thoughts += 1;
    else if (step.toolKind === "edit" || step.toolKind === "delete" || step.toolKind === "move") {
      // An edit that reported no diff still touched a file.
      if (changes.length === 0) t.files.add(step.id);
    } else t.tools += 1;
  }
  return t;
}

/** "运行 5 条命令 · 读取 3 个文件 · 修改 2 个文件", most telling first. */
function describe(t: Tally): string {
  const parts: string[] = [];
  if (t.files.size) parts.push(`修改 ${t.files.size} 个文件`);
  if (t.commands) parts.push(`运行 ${t.commands} 条命令`);
  if (t.reads) parts.push(`读取 ${t.reads} 个文件`);
  if (t.searches) parts.push(`搜索 ${t.searches} 次`);
  if (t.web) parts.push(`查看 ${t.web} 个网页`);
  if (t.tools) parts.push(`调用 ${t.tools} 个工具`);
  // Thinking is the least telling; name it only when it's all there was.
  if (t.thoughts && parts.length === 0) parts.push(`思考 ${t.thoughts} 次`);
  return parts.slice(0, 3).join(" · ");
}

/**
 * A run of finished working steps folded into one line. The steps stay one
 * tap away, and open in place as ordinary rows.
 */
export const StepsSummary = memo(function StepsSummary({ steps, open, onToggle }: { steps: Step[]; open: boolean; onToggle: () => void }) {
  const t = tally(steps);
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  const end = last.endedTs ?? last.ts;
  const elapsed = end - first.ts;
  return (
    <Pressable
      onPress={() => {
        haptics.selection();
        onToggle();
      }}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`${steps.length} 个步骤：${describe(t)}`}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 }}
    >
      <View style={{ width: GLYPH, alignItems: "center" }}>
        <Icon sf="square.stack.3d.up" md="stacks" size={14} color={colors.secondaryLabel} weight="medium" />
      </View>
      <Text numberOfLines={1} style={[type.subhead, { flex: 1, color: colors.secondaryLabel }]}>
        {describe(t) || `${steps.length} 个步骤`}
      </Text>
      {t.failed ? <Text style={[type.footnote, { color: colors.danger, fontWeight: "600" }]}>{t.failed} 个失败</Text> : null}
      {t.added || t.removed ? (
        <Text style={[type.footnote, { fontVariant: ["tabular-nums"], fontWeight: "600" }]}>
          <Text style={{ color: colors.diffAddText }}>+{t.added}</Text> <Text style={{ color: colors.diffDelText }}>−{t.removed}</Text>
        </Text>
      ) : elapsed >= 2000 ? (
        <Text style={[type.footnote, { color: colors.tertiaryLabel }]}>{duration(elapsed)}</Text>
      ) : null}
      <Animated.View
        style={{
          transform: [{ rotate: open ? "90deg" : "0deg" }],
          transitionProperty: "transform",
          transitionDuration: "180ms",
          transitionTimingFunction: cubicBezier(0.23, 1, 0.32, 1),
        }}
      >
        <Icon sf="chevron.right" md="chevron_right" size={11} color={colors.tertiaryLabel} weight="semibold" />
      </Animated.View>
    </Pressable>
  );
});
