import type { SessionState } from "@linkshell/wire";
import { ActivityIndicator, View, type ColorValue } from "react-native";
import { colors } from "@/theme/colors";

/** A session's or a link's state as a plain 8 pt dot; the colour says it all, so it never pulses. */
export function StatusDot({ color = colors.running }: { color?: ColorValue }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

export type LinkHealth = "online" | "connecting" | "error" | "offline";

/**
 * A computer's or a service's connection, a scale of its own beside session
 * states: online is the one good news a green dot carries; connecting is a
 * spinner (next to `secondaryLabel` text), never a coloured dot.
 */
export function LinkDot({ health }: { health: LinkHealth }) {
  if (health === "connecting") {
    return <ActivityIndicator size="small" color={colors.secondaryLabel} style={{ width: 12, height: 12, transform: [{ scale: 0.6 }] }} />;
  }
  return <StatusDot color={health === "online" ? colors.ok : health === "error" ? colors.danger : colors.tertiaryLabel} />;
}

/** Idle and done are the normal resting state: grey, never green. */
export function stateColor(state: SessionState): ColorValue {
  switch (state) {
    case "running":
      return colors.running;
    case "waiting":
      return colors.waiting;
    case "error":
      return colors.danger;
    default:
      return colors.tertiaryLabel;
  }
}

/** `waiting` covers both approvals and questions; callers that know which say 等你确认 / 等你回答. */
export function stateLabel(state: SessionState): string {
  switch (state) {
    case "running":
      return "运行中";
    case "waiting":
      return "等你处理";
    case "error":
      return "出错";
    case "offline":
      return "离线";
    case "unknown":
      return "状态未确认";
    default:
      return "空闲";
  }
}
