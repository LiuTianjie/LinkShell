import { Text, View, type ColorValue } from "react-native";
import { branchLabel } from "@/lib/worktree";
import { colors } from "@/theme/colors";
import { Icon } from "./icon";

/**
 * The git branch of a directory, the same everywhere it's shown: the branch
 * glyph and the name, its middle cut when long. Plain for the branch a
 * project is on; `own` (a tinted capsule) for a session that has a worktree,
 * and so a branch, of its own.
 */
export function BranchTag({
  branch,
  size = 12,
  max = 22,
  own = false,
  color = colors.secondaryLabel,
}: {
  branch: string;
  /** Font size; the glyph is a point smaller. */
  size?: number;
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
        own ? { paddingHorizontal: 5, borderRadius: 6, borderCurve: "continuous", backgroundColor: colors.accentSoft } : null,
      ]}
    >
      <Icon sf="arrow.triangle.branch" md="fork_right" size={size - 1} color={own ? colors.accent : colors.tertiaryLabel} />
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: size, lineHeight: Math.round(size * 1.3), fontWeight: "500", color: own ? colors.accent : color }}>
        {branchLabel(branch, max)}
      </Text>
    </View>
  );
}
