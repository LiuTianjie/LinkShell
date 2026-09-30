import type { SessionSummary } from "@linkshell/wire";
import { router } from "expo-router";
import { memo } from "react";
import { StyleSheet, Text, View, type ColorValue } from "react-native";
import { activityText, plainPreview, sessionTitle } from "@/lib/describe";
import { baseName, relativeTime } from "@/lib/format";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { mono, type } from "@/theme/type";
import { AgentTile } from "./agent-tile";
import { Icon } from "./icon";
import { PressableScale } from "./pressable-scale";
import { LiveDot, stateColor } from "./status";

/** The agent tile beside a row's title. */
const ICON = 20;

export type RowPosition = "first" | "middle" | "last" | "only";

export function positionOf(index: number, count: number): RowPosition {
  if (count === 1) return "only";
  if (index === 0) return "first";
  return index === count - 1 ? "last" : "middle";
}

export function openSession(sessionId: string) {
  router.push({ pathname: "/session/[id]", params: { id: sessionId } });
}

/** Agent tile with a status badge in its corner. */
export function SessionAvatar({ session, size = 36 }: { session: SessionSummary; size?: number }) {
  const showBadge = session.state !== "idle";
  const dot = Math.max(6, Math.round(size * 0.22));
  return (
    <View style={{ width: size, height: size }}>
      <AgentTile agent={session.agent} size={size} dimmed={session.state === "offline"} />
      {showBadge ? (
        <View
          style={{
            position: "absolute",
            right: size < 28 ? -4 : -3,
            bottom: size < 28 ? -4 : -3,
            padding: size < 28 ? 1.5 : 2,
            borderRadius: dot,
            backgroundColor: colors.card,
          }}
        >
          <LiveDot color={stateColor(session.state)} size={dot} live={session.state === "running"} />
        </View>
      ) : null}
    </View>
  );
}

/** A handoff session's current driver, as a small glyph beside the time. */
function DriverGlyph({ session }: { session: SessionSummary }) {
  if (session.driver !== "desktop" && session.driver !== "remote") return null;
  const phone = session.driver === "remote";
  return (
    <Icon
      sf={phone ? "iphone" : "laptopcomputer"}
      md={phone ? "smartphone" : "laptop_mac"}
      size={12}
      color={phone ? colors.accent : colors.tertiaryLabel}
    />
  );
}

/**
 * A session in a grouped list, in two lines: what it is and when, then where
 * it lives and what it last said (or is doing now). The tile says which agent.
 */
/** One row of a grouped list: icon and title, time, then project and detail. Shared by sessions and terminals. */
export function ListRow({
  leading,
  title,
  titleMono = false,
  time,
  accessory,
  project,
  detail,
  detailColor = colors.secondaryLabel,
  warn = false,
  position,
  onPress,
  accessibilityLabel,
}: {
  leading: React.ReactNode;
  title: string;
  titleMono?: boolean;
  time: string;
  accessory?: React.ReactNode;
  project?: string;
  detail?: string;
  detailColor?: ColorValue;
  warn?: boolean;
  position: RowPosition;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const top = position === "first" || position === "only";
  const bottom = position === "last" || position === "only";
  return (
    <PressableScale onPress={onPress} pressedScale={0.985} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      <View
        style={{
          backgroundColor: colors.card,
          borderTopLeftRadius: top ? 20 : 0,
          borderTopRightRadius: top ? 20 : 0,
          borderBottomLeftRadius: bottom ? 20 : 0,
          borderBottomRightRadius: bottom ? 20 : 0,
          borderCurve: "continuous",
          paddingLeft: 14,
        }}
      >
        <View style={{ paddingVertical: 11, paddingRight: 14, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {leading}
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                fontSize: titleMono ? 14.5 : 16,
                lineHeight: 21,
                fontWeight: titleMono ? "400" : "600",
                color: colors.label,
                fontFamily: titleMono ? mono : undefined,
              }}
            >
              {title}
            </Text>
            {accessory}
            <Text style={[type.footnote, { color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }]}>{time}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: ICON + 8 }}>
            {warn ? <Icon sf="exclamationmark.triangle.fill" md="warning" size={12} color={colors.danger} /> : null}
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, lineHeight: 19, color: detailColor }}>
              {project ? <Text style={{ color: colors.secondaryLabel, fontWeight: "500" }}>{project}</Text> : null}
              {project && detail ? <Text style={{ color: colors.tertiaryLabel }}>{" · "}</Text> : null}
              {detail}
            </Text>
          </View>
        </View>
        {bottom ? null : (
          // Rows rarely end on a whole pixel; the card runs a pixel under the next row so
          // two anti-aliased edges never leave a seam of page showing between them.
          <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: -1, height: 2, backgroundColor: colors.card }} />
        )}
        {bottom ? null : (
          <View
            style={{ position: "absolute", left: 14 + ICON + 8, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }}
          />
        )}
      </View>
    </PressableScale>
  );
}

export const SessionRow = memo(function SessionRow({
  session,
  position = "only",
  showProject = true,
  now,
}: {
  session: SessionSummary;
  position?: RowPosition;
  showProject?: boolean;
  now: number;
}) {
  const look = agentLook(session.agent);
  const running = session.state === "running";
  const failed = session.state === "error";
  const project = showProject ? baseName(session.cwd) : undefined;
  const title = sessionTitle(session);
  const detail = running
    ? activityText(session.activity)
    : failed
      ? session.preview
        ? plainPreview(session.preview)
        : "上一轮出错了"
      : session.preview
        ? plainPreview(session.preview)
        : undefined;
  return (
    <ListRow
      leading={<SessionAvatar session={session} size={ICON} />}
      title={title}
      time={relativeTime(session.updatedAt, now)}
      accessory={<DriverGlyph session={session} />}
      project={project}
      detail={detail ?? (project ? undefined : look.name)}
      detailColor={running ? colors.running : failed ? colors.danger : colors.secondaryLabel}
      warn={failed}
      position={position}
      onPress={() => openSession(session.id)}
      accessibilityLabel={[title, project, look.name, detail].filter(Boolean).join("，")}
    />
  );
});
