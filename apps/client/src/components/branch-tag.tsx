import { View, type ColorValue } from "react-native";
import { Text } from "@/components/fixed-text";
import { branchLabel } from "@/lib/worktree";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";
import { Icon } from "./icon";

/**
 * The git branch of a directory, the same everywhere it's shown: the branch
 * glyph and the name, its middle cut when long. Plain for the branch a
 * project is on; `own` (a grey tag) for a session that has a worktree, and so
 * a branch, of its own. Grey because it's a fact, not a state or an action.
 */
export function BranchTag({
  branch,
  font = type.caption,
  max = 22,
  own = false,
  color = colors.secondaryLabel,
}: {
  branch: string;
  /** The text style of the line it sits in; the glyph is a point smaller. */
  font?: (typeof type)[keyof typeof type];
  /** Characters kept of a long name. */
  max?: number;
  own?: boolean;
  color?: ColorValue;
}) {
  return (
    <View
      accessibilityLabel={own ? `独立的 worktree，分支 ${branch}` : `分支 ${branch}`}
      style={[
        { flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 1 },
        // As tall as the line it sits on, so the row keeps its height.
        own ? { paddingHorizontal: 5, borderRadius: radius.chip, borderCurve: "continuous", backgroundColor: colors.fill } : null,
      ]}
    >
      <Icon sf="arrow.triangle.branch" md="fork_right" size={font.fontSize - 1} color={own ? colors.secondaryLabel : colors.tertiaryLabel} />
      <Text numberOfLines={1} style={[font, { flexShrink: 1, fontWeight: "500", color: own ? colors.secondaryLabel : color }]}>
        {branchLabel(branch, max)}
      </Text>
    </View>
  );
}
