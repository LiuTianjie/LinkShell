import type { SessionSummary } from "@linkshell/wire";
import { router } from "expo-router";
import { memo, useRef } from "react";
import { StyleSheet, View, type ColorValue } from "react-native";
import { Text } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { activityText, plainPreview, sessionTitle, needsUserInput } from "@/lib/describe";
import { baseName, relativeTime } from "@/lib/format";
import { BranchTag } from "./branch-tag";
import { agentLook } from "@/theme/agents";
import { colors } from "@/theme/colors";
import { mono, radius, type } from "@/theme/type";
import { AgentTile } from "./agent-tile";
import { Icon } from "./icon";
import { PressableFeedback, PressedWash } from "./pressable-feedback";
import { OwnedFloatingMenu, type FloatingMenuHandle } from "./app-menu";
import { haptics } from "@/lib/haptics";
import { useActions } from "@/lib/client";
import { confirmDelete, renameSession, toggleArchived } from "@/lib/session-actions";
import {
  clearSessionSnooze,
  isSessionSnoozed,
  snoozeSession,
  toggleSessionPinned,
  usePinnedSessionIds,
  useSnoozedSessions,
} from "@/lib/session-attention";
import { StatusDot, stateColor } from "./status";

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
  const showBadge = session.state !== "idle" || needsUserInput(session);
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
            borderRadius: 6,
            backgroundColor: colors.card,
          }}
        >
          {/* A question is waiting on the user even while the agent keeps running. */}
          <StatusDot color={needsUserInput(session) ? colors.waiting : stateColor(session.state)} />
        </View>
      ) : null}
    </View>
  );
}

export function UserInputBadge() {
  return (
    <View style={{ backgroundColor: colors.waitingSoft, borderRadius: radius.chip, borderCurve: "continuous", paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={[type.caption, { color: colors.waiting, fontWeight: "600" }]}>等你回答</Text>
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
      color={colors.tertiaryLabel}
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
  titleTag,
  accessory,
  project,
  branch,
  detail,
  detailColor = colors.secondaryLabel,
  warn = false,
  position,
  onPress,
  accessibilityLabel,
  menu,
  selected = false,
}: {
  leading: React.ReactNode;
  title: string;
  titleMono?: boolean;
  time: string;
  /** Sits right after the title (a project's branch). */
  titleTag?: React.ReactNode;
  accessory?: React.ReactNode;
  project?: string;
  /** The worktree branch the session works in, after the project. */
  branch?: string;
  detail?: string;
  detailColor?: ColorValue;
  warn?: boolean;
  position: RowPosition;
  onPress: () => void;
  accessibilityLabel: string;
  /** Long-press actions. */
  menu?: RowMenuItem[];
  selected?: boolean;
}) {
  const { fontScale } = useWindowDimensions();
  const largeText = fontScale >= 1.3;
  const floating = useRef<FloatingMenuHandle>(null);
  // The app's own long-press menu everywhere. The system context menu on a
  // Link took the whole row out of the accessibility tree: VoiceOver skipped it.
  const floatingMenu = !!menu?.length;
  const top = position === "first" || position === "only";
  const bottom = position === "last" || position === "only";
  const corners = {
    borderTopLeftRadius: top ? radius.card : 0,
    borderTopRightRadius: top ? radius.card : 0,
    borderBottomLeftRadius: bottom ? radius.card : 0,
    borderBottomRightRadius: bottom ? radius.card : 0,
    borderCurve: "continuous",
  } as const;
  const row = (
    <PressableFeedback
      onPress={onPress}
      onLongPress={floatingMenu ? () => floating.current?.open() : undefined}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel}
    >
      {({ pressed }) => (
      <View style={{ backgroundColor: selected ? colors.accentSoft : colors.card, ...corners, paddingLeft: 14 }}>
        <PressedWash pressed={pressed} style={corners} />
        <View style={{ paddingVertical: 11, paddingRight: 14, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {leading}
            <Text
              numberOfLines={largeText ? 2 : 1}
              style={[
                titleMono ? { fontFamily: mono, fontSize: 14.5, lineHeight: 21 } : type.callout,
                { flex: 1, minWidth: 0, fontWeight: titleMono ? "400" : "600", color: colors.label },
              ]}
            >
              {title}
            </Text>
            {titleTag && !largeText ? <View style={{ flexShrink: 1, flexDirection: "row", minWidth: 0, maxWidth: "35%" }}>{titleTag}</View> : null}
            {accessory}
            {!largeText && time ? <Text numberOfLines={1} style={[type.footnote, { maxWidth: "30%", color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }]}>{time}</Text> : null}
          </View>
          {titleTag && largeText ? <View style={{ flexDirection: "row", paddingLeft: ICON + 8 }}>{titleTag}</View> : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: ICON + 8 }}>
            {warn ? <Icon sf="exclamationmark.triangle.fill" md="warning" size={12} color={colors.danger} /> : null}
            {branch ? (
              // Project, then the branch as a chip: on the line the project already has.
              <>
                {project ? <Text numberOfLines={1} style={[type.subhead, { flexShrink: 1, maxWidth: "35%", color: colors.secondaryLabel, fontWeight: "500" }]}>{project}</Text> : null}
                <BranchTag branch={branch} own />
                <Text numberOfLines={1} style={[type.subhead, { flex: 1, minWidth: 0, color: detailColor }]}>
                  {detail ? <Text style={{ color: colors.tertiaryLabel }}>{"· "}</Text> : null}
                  {detail}
                </Text>
              </>
            ) : (
              <Text numberOfLines={1} style={[type.subhead, { flex: 1, color: detailColor }]}>
                {project ? <Text style={{ color: colors.secondaryLabel, fontWeight: "500" }}>{project}</Text> : null}
                {project && detail ? <Text style={{ color: colors.tertiaryLabel }}>{" · "}</Text> : null}
                {detail}
              </Text>
            )}
          </View>
          {largeText && time ? <Text style={[type.footnote, { paddingLeft: ICON + 8, color: colors.tertiaryLabel, fontVariant: ["tabular-nums"] }]}>{time}</Text> : null}
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
      )}
    </PressableFeedback>
  );
  if (!floatingMenu) return row;
  return (
    <OwnedFloatingMenu
      handle={floating}
      onOpenMenu={() => haptics.medium()}
      actions={menu!.map((item, index) => ({ id: String(index), title: item.title, image: item.icon.sf, attributes: { destructive: item.destructive } }))}
      onPressAction={({ nativeEvent }) => menu![Number(nativeEvent.event)]?.onPress()}
    >
      {row}
    </OwnedFloatingMenu>
  );
}

export interface RowMenuItem {
  title: string;
  icon: { sf: import("./icon").IconProps["sf"]; md: import("./icon").IconProps["md"] };
  destructive?: boolean;
  onPress: () => void;
}

export const SessionRow = memo(function SessionRow({
  session,
  position = "only",
  showProject = true,
  now,
  onPress,
  selected = false,
}: {
  session: SessionSummary;
  position?: RowPosition;
  showProject?: boolean;
  now: number;
  onPress?: () => void;
  selected?: boolean;
}) {
  const look = agentLook(session.agent);
  const running = session.state === "running";
  const failed = session.state === "error";
  const pinnedIds = usePinnedSessionIds();
  const snoozedMap = useSnoozedSessions();
  const pinned = pinnedIds.includes(session.id);
  const snoozed = isSessionSnoozed(session, now, snoozedMap);
  // A session in a worktree belongs to the project the worktree was made from.
  const project = showProject ? baseName(session.worktree?.source ?? session.cwd) : undefined;
  const branch = session.worktree?.branch;
  const title = sessionTitle(session);
  const actions = useActions();
  const menu: RowMenuItem[] = [
    {
      title: pinned ? "取消置顶" : "置顶会话",
      icon: pinned ? { sf: "pin.slash", md: "push_pin" } : { sf: "pin.fill", md: "push_pin" },
      onPress: () => {
        haptics.selection();
        toggleSessionPinned(session.id);
      },
    },
    ...(!session.archived
      ? [
          snoozed
            ? {
                title: "取消稍后提醒",
                icon: { sf: "bell.fill", md: "notifications_active" } as const,
                onPress: () => {
                  haptics.selection();
                  clearSessionSnooze(session.id);
                },
              }
            : {
                title: "稍后处理（1 小时）",
                icon: { sf: "clock", md: "schedule" } as const,
                onPress: () => {
                  haptics.selection();
                  snoozeSession(session.id, 3600_000);
                },
              },
        ]
      : []),
    { title: "重命名", icon: { sf: "pencil", md: "edit" }, onPress: () => renameSession(session) },
    {
      title: session.archived ? "取消归档" : "归档",
      icon: session.archived ? { sf: "tray.and.arrow.up", md: "unarchive" } : { sf: "archivebox", md: "archive" },
      onPress: () => void toggleArchived(session, actions),
    },
    { title: "删除", icon: { sf: "trash", md: "delete" }, destructive: true, onPress: () => confirmDelete(session, actions) },
  ];
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
      selected={selected}
      leading={<SessionAvatar session={session} size={ICON} />}
      title={title}
      time={relativeTime(session.updatedAt, now)}
      accessory={
        needsUserInput(session) ? (
          <UserInputBadge />
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {pinned ? <Icon sf="pin.fill" md="push_pin" size={11} color={colors.accent} /> : null}
            {snoozed ? <Icon sf="clock.fill" md="schedule" size={11} color={colors.tertiaryLabel} /> : null}
            <DriverGlyph session={session} />
          </View>
        )
      }
      project={project}
      branch={branch}
      detail={detail ?? (project || branch ? undefined : look.name)}
      detailColor={running ? colors.running : failed ? colors.danger : colors.secondaryLabel}
      position={position}
      onPress={onPress ?? (() => openSession(session.id))}
      accessibilityLabel={[title, project, look.name, detail].filter(Boolean).join("，")}
      menu={menu}
    />
  );
});
