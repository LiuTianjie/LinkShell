import { describeFailures, describeSteps, tallySteps } from "@linkshell/client-core";
import type { Step } from "@/lib/timeline-rows";
import { memo } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/components/fixed-text";
import Animated, { cubicBezier } from "react-native-reanimated";
import { duration } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { DiffStat } from "@/components/diff-stat";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "../icon";
import { GLYPH } from "./tool-call";

/**
 * A run of finished working steps folded into one line. The steps stay one
 * tap away, and open in place as ordinary rows.
 */
export const StepsSummary = memo(function StepsSummary({ steps, open, onToggle }: { steps: Step[]; open: boolean; onToggle: () => void }) {
  const t = tallySteps(steps);
  const label = describeSteps(t);
  const failures = describeFailures(t);
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
      accessibilityLabel={`${label}${failures ?? ""}`}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 }}
    >
      <View style={{ width: GLYPH, alignItems: "center" }}>
        <Icon sf="square.stack.3d.up" md="stacks" size={14} color={colors.secondaryLabel} weight="medium" />
      </View>
      <Text numberOfLines={1} style={[type.subhead, { flex: 1, color: colors.secondaryLabel }]}>
        {label}
        {failures ? <Text style={{ color: colors.danger }}>{failures}</Text> : null}
      </Text>
      {t.added || t.removed ? (
        <Text style={[type.footnote, { fontVariant: ["tabular-nums"], fontWeight: "600" }]}>
          <DiffStat added={t.added} removed={t.removed} />
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
}, (before, after) =>
  // The rows are built again on every streamed chunk, with new arrays of the same steps (and a new
  // toggle for the same run: the same steps are the same run).
  before.open === after.open && before.steps.length === after.steps.length && before.steps.every((step, index) => step === after.steps[index]));
