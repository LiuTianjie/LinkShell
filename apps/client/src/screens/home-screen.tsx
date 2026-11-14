import { needsAttention, sessionTitle } from "@/lib/describe";
import { LegendList } from "@legendapp/list/react-native";
import type { ClientState, Locale } from "@linkshell/client-core";
import type { SessionSummary, TerminalInfo } from "@linkshell/wire";
import { router, Stack } from "expo-router";
import { useHeaderHeight, useIsFocused } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { Icon } from "@/components/icon";
import { AttentionIsland } from "@/components/attention-island";
import { isHostLowBattery } from "@/components/computer-metrics";
import { ConnectionBanner } from "@/components/connection-banner";
import { NeedCard } from "@/components/need-card";
import { SectionHeader } from "@/components/section-header";
import { SessionAvatar, SessionRow, positionOf, type RowPosition } from "@/components/session-row";
import { TerminalRow } from "@/components/terminal-row";
import { searchWords, sessionMatches, terminalMatches } from "@/lib/search";
import { terminalState, useTerminals } from "@/lib/terminals";
import { EmptyState, LoadingState, LockedComputer, unreachable, WaitingForComputer } from "@/components/state-views";
import { LinkDot } from "@/components/status";
import { useActions, useClient, useConnection, useConnectionStatus, useHasComputer } from "@/lib/client";
import { computerDisplayName, useComputerNames } from "@/lib/computer-names";
import { Welcome } from "@/components/welcome";
import { haptics } from "@/lib/haptics";
import { useLocale } from "@/lib/locale";
import { useMachineMetrics } from "@/lib/machine-metrics";
import { toggleArchived } from "@/lib/session-actions";
import {
  buildLiveActivityPayload,
  isSessionSnoozed,
  mergeLiveViewsIntoSessions,
  toggleSessionPinned,
  usePinnedSessionIds,
  useSnoozedSessions,
  type HomeFilterMode,
} from "@/lib/session-attention";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";
import { radius, type } from "@/theme/type";
import { IOS_TAB_BAR_HEIGHT, useFloatingTabInset } from "@/components/floating-tabs";
import { NEW_SESSION } from "@/components/new-session-action";
import { PageSearch } from "@/components/page-header";
import { SessionContent } from "./session-screen";
import { MountedMotionPane, type PaneFrame } from "@/components/mounted-motion-pane";
import { useLayoutGeometry } from "@/lib/use-layout-geometry";
import { workspaceLayout } from "@/lib/workspace-layout";
import { homeNavigationLayout, homeUsesInlineControls } from "@/lib/home-layout";
import { SessionFoldLayoutContext } from "@/lib/session-fold-layout";
import { baseName } from "@/lib/format";
import { Glass } from "@/components/glass";
import { LayoutProbe } from "../../modules/link-layout";
import { AdaptivePage, usePageInsets } from "@/components/adaptive-page";
import { HeaderActions, type HeaderAction } from "@/components/header-actions";
import { SessionTools, type Panel } from "@/components/session-workspace";

type Item =
  | {
      type: "header";
      key: string;
      title: string;
      count?: number;
      warn?: boolean;
    }
  | { type: "need"; key: string; session: SessionSummary }
  | {
      type: "row";
      key: string;
      session: SessionSummary;
      position: RowPosition;
    }
  | { type: "terminal"; key: string; terminal: TerminalInfo; position: RowPosition };

type Entry = { kind: "session"; session: SessionSummary; at: number } | { kind: "terminal"; terminal: TerminalInfo; at: number };

function rowOf(entry: Entry, position: RowPosition, prefix: string): Item {
  return entry.kind === "session"
    ? { type: "row", key: `${prefix}-${entry.session.id}`, session: entry.session, position }
    : { type: "terminal", key: `${prefix}-t-${entry.terminal.id}`, terminal: entry.terminal, position };
}

const newest = (a: SessionSummary, b: SessionSummary) => b.updatedAt - a.updatedAt;

const DAY = 86_400_000;

function dayBucket(ts: number, now: number, locale: Locale): string {
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= start) return locale === "zh" ? "今天" : locale === "ja" ? "今日" : "Today";
  if (ts >= start - DAY) return locale === "zh" ? "昨天" : locale === "ja" ? "昨日" : "Yesterday";
  if (ts >= start - 6 * DAY) return locale === "zh" ? "近 7 天" : locale === "ja" ? "直近 7 日間" : "Last 7 Days";
  return locale === "zh" ? "更早" : locale === "ja" ? "それ以前" : "Earlier";
}

function sectionWords(locale: Locale) {
  if (locale === "ja") {
    return {
      need: "確認待ち",
      fail: "エラー",
      run: "実行中",
      pin: "ピン留め",
      term: "ターミナル",
      snooze: "あとで",
      found: "検索結果",
      archived: "アーカイブ済み",
    };
  }
  if (locale === "en") {
    return {
      need: "Needs Attention",
      fail: "Errors",
      run: "Running",
      pin: "Pinned",
      term: "Terminals",
      snooze: "Snoozed",
      found: "Found",
      archived: "Archived",
    };
  }
  return {
    need: "等你处理",
    fail: "出错",
    run: "运行中",
    pin: "已置顶",
    term: "终端",
    snooze: "稍后处理",
    found: "找到",
    archived: "已归档",
  };
}

function buildItems(
  sessions: SessionSummary[],
  terminals: TerminalInfo[],
  now: number,
  locale: Locale,
  options: {
    pinnedIds?: string[];
    snoozedMap?: Record<string, number>;
    filter?: HomeFilterMode;
  } = {},
): {
  items: Item[];
  waiting: number;
  running: number;
  failed: number;
  pinnedCount: number;
  snoozedCount: number;
} {
  const copy = sectionWords(locale);
  const pinnedSet = new Set(options.pinnedIds ?? []);
  const snoozedMap = options.snoozedMap ?? {};
  const filter = options.filter ?? "all";

  const liveAll = sessions.filter((s) => !s.archived);
  const snoozedSessions = liveAll.filter((s) => isSessionSnoozed(s, now, snoozedMap)).sort(newest);
  const live = liveAll.filter((s) => !isSessionSnoozed(s, now, snoozedMap));

  const waiting = live.filter((s) => needsAttention(s)).sort(newest);
  const failed = live.filter((s) => !needsAttention(s) && s.state === "error").sort(newest);
  const busyTerminals = terminals.filter((t) => terminalState(t).busy);
  const running: Entry[] = [
    ...live
      .filter((s) => s.state === "running" && !needsAttention(s))
      .map((session): Entry => ({ kind: "session", session, at: session.updatedAt })),
    ...busyTerminals.map((terminal): Entry => ({ kind: "terminal", terminal, at: terminal.activeAt })),
  ].sort((a, b) => b.at - a.at);

  const pinned = live
    .filter((s) => !needsAttention(s) && s.state !== "running" && s.state !== "error" && pinnedSet.has(s.id))
    .sort(newest);

  const recent: Entry[] = [
    ...live
      .filter((s) => !needsAttention(s) && s.state !== "running" && s.state !== "error" && !pinnedSet.has(s.id))
      .map((session): Entry => ({ kind: "session", session, at: session.updatedAt })),
    ...terminals.filter((t) => !busyTerminals.includes(t)).map((terminal): Entry => ({ kind: "terminal", terminal, at: terminal.activeAt })),
  ].sort((a, b) => b.at - a.at);

  const items: Item[] = [];

  if (filter === "attention") {
    if (waiting.length) {
      items.push({ type: "header", key: "h-need", title: copy.need });
      for (const session of waiting) items.push({ type: "need", key: `n-${session.id}`, session });
    }
    if (failed.length) {
      items.push({ type: "header", key: "h-fail", title: copy.fail, count: failed.length, warn: true });
      failed.forEach((session, index) => items.push({ type: "row", key: `err-${session.id}`, session, position: positionOf(index, failed.length) }));
    }
  } else if (filter === "running") {
    if (running.length) {
      items.push({ type: "header", key: "h-run", title: copy.run, count: running.length });
      running.forEach((entry, index) => items.push(rowOf(entry, positionOf(index, running.length), "r")));
    }
  } else if (filter === "pinned") {
    const allPinned = liveAll.filter((s) => pinnedSet.has(s.id)).sort(newest);
    if (allPinned.length) {
      items.push({ type: "header", key: "h-pin", title: copy.pin, count: allPinned.length });
      allPinned.forEach((session, index) => items.push({ type: "row", key: `pin-${session.id}`, session, position: positionOf(index, allPinned.length) }));
    }
  } else if (filter === "terminals") {
    const sortedTerminals = [...terminals].sort((a, b) => b.activeAt - a.activeAt);
    if (sortedTerminals.length) {
      items.push({ type: "header", key: "h-term", title: copy.term, count: sortedTerminals.length });
      sortedTerminals.forEach((terminal, index) =>
        items.push({ type: "terminal", key: `term-${terminal.id}`, terminal, position: positionOf(index, sortedTerminals.length) }),
      );
    }
  } else if (filter === "snoozed") {
    if (snoozedSessions.length) {
      items.push({ type: "header", key: "h-snooze", title: copy.snooze, count: snoozedSessions.length });
      snoozedSessions.forEach((session, index) =>
        items.push({ type: "row", key: `snz-${session.id}`, session, position: positionOf(index, snoozedSessions.length) }),
      );
    }
  } else {
    if (waiting.length) {
      items.push({ type: "header", key: "h-need", title: copy.need });
      for (const session of waiting) items.push({ type: "need", key: `n-${session.id}`, session });
    }
    if (failed.length) {
      items.push({ type: "header", key: "h-fail", title: copy.fail, count: failed.length, warn: true });
      failed.forEach((session, index) =>
        items.push({ type: "row", key: `err-${session.id}`, session, position: positionOf(index, failed.length) }),
      );
    }
    if (running.length) {
      items.push({ type: "header", key: "h-run", title: copy.run, count: running.length });
      running.forEach((entry, index) => items.push(rowOf(entry, positionOf(index, running.length), "r")));
    }
    if (pinned.length) {
      items.push({ type: "header", key: "h-pin", title: copy.pin, count: pinned.length });
      pinned.forEach((session, index) =>
        items.push({ type: "row", key: `pin-${session.id}`, session, position: positionOf(index, pinned.length) }),
      );
    }
    const buckets = new Map<string, Entry[]>();
    for (const entry of recent) {
      const bucket = dayBucket(entry.at, now, locale);
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), entry]);
    }
    for (const [title, group] of buckets) {
      items.push({ type: "header", key: `h-${title}`, title });
      group.forEach((entry, index) => items.push(rowOf(entry, positionOf(index, group.length), "c")));
    }
  }

  return {
    items,
    waiting: waiting.length,
    running: running.length,
    failed: failed.length,
    pinnedCount: liveAll.filter((s) => pinnedSet.has(s.id)).length,
    snoozedCount: snoozedSessions.length,
  };
}

function searchItems(sessions: SessionSummary[], terminals: TerminalInfo[], words: string[], locale: Locale): Item[] {
  const copy = sectionWords(locale);
  const matching = sessions.filter((session) => sessionMatches(session, words));
  const current: Entry[] = [
    ...matching.filter((session) => !session.archived).map((session): Entry => ({ kind: "session", session, at: session.updatedAt })),
    ...terminals.filter((terminal) => terminalMatches(terminal, words)).map((terminal): Entry => ({ kind: "terminal", terminal, at: terminal.activeAt })),
  ].sort((a, b) => b.at - a.at);
  const archived = matching.filter((session) => session.archived).sort(newest);
  const items: Item[] = [];
  if (current.length) {
    items.push({ type: "header", key: "h-found", title: copy.found, count: current.length });
    current.forEach((entry, index) => items.push(rowOf(entry, positionOf(index, current.length), "f")));
  }
  if (archived.length) {
    items.push({ type: "header", key: "h-found-archived", title: copy.archived, count: archived.length });
    archived.forEach((session, index) => items.push({ type: "row", key: `fa-${session.id}`, session, position: positionOf(index, archived.length) }));
  }
  return items;
}

function Summary({ small = false, batteryPercent, lowBattery }: { small?: boolean; batteryPercent?: number | null; lowBattery?: boolean }) {
  const { computer } = useConnection();
  const names = useComputerNames((state) => state.names);
  const name = computerDisplayName(computer, names);
  const status = useConnectionStatus();
  const { t } = useLocale();
  return (
    <Pressable
      onPress={() => {
        haptics.selection();
        router.push("/computers");
      }}
      accessibilityRole="button"
      accessibilityLabel={`${name} · ${t("nav.computers")}`}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 6,
        paddingHorizontal: 4,
        paddingTop: 2,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <LinkDot health={status === "online" ? "online" : status === "connecting" ? "connecting" : "offline"} />
      <Text numberOfLines={1} style={[small ? type.footnote : type.subhead, { color: colors.secondaryLabel, flexShrink: 1 }]}>
        {name}
      </Text>
      {typeof batteryPercent === "number" ? (
        <Text style={[type.caption2, { color: lowBattery ? colors.danger : colors.tertiaryLabel, fontVariant: ["tabular-nums"], fontWeight: lowBattery ? "600" : "400" }]}>
          {Math.round(batteryPercent)}%
        </Text>
      ) : null}
      <Icon sf="chevron.up.chevron.down" md="unfold_more" size={11} color={colors.tertiaryLabel} />
    </Pressable>
  );
}

export function HomeScreen() {
  const { computer } = useConnection();
  return (
    <AdaptivePage>
      <HomeWorkspace key={computer.key} />
    </AdaptivePage>
  );
}

function HomeWorkspace() {
  const insets = usePageInsets();
  const systemInsets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const window = useWindowDimensions();
  const geometry = useLayoutGeometry();
  const { t } = useLocale();
  const { width, height } = geometry.frame;
  const divisions = geometry.metrics?.divisions ?? [];
  const layout = workspaceLayout(width, window.fontScale, divisions, height);
  const { split, axis } = layout;
  const folded = layout.folded;
  const laptop = folded && axis === "column";
  const sessions = useClient((state) => state.sessions);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpened, setDetailOpened] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [laptopListOpen, setLaptopListOpen] = useState(false);
  useEffect(() => {
    if (!laptop) setLaptopListOpen(false);
  }, [laptop]);
  const [motionAction, setMotionAction] = useState(0);
  const [detailVisited, setDetailVisited] = useState(false);
  const [tool, setTool] = useState<Panel | null>(null);
  const first = useMemo(
    () =>
      Object.values(sessions)
        .filter((session) => !session.archived)
        .sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || b.updatedAt - a.updatedAt)[0],
    [sessions],
  );
  const selected = selectedId && sessions[selectedId] && !sessions[selectedId].archived ? sessions[selectedId] : first;
  const select = useCallback(
    (id: string) => {
      if (!split) {
        router.push({ pathname: "/session/[id]", params: { id } });
        return;
      }
      setMotionAction((value) => value + 1);
      setSelectedId(id);
      setDetailOpened(true);
      setLaptopListOpen(false);
    },
    [split],
  );
  useEffect(() => {
    if (split && selected) {
      setSelectedId(selected.id);
      setDetailOpened(true);
    }
  }, [split, selected]);
  const showDetail = !!selected && (split || detailOpened);
  const inlineControls = homeUsesInlineControls(systemInsets, showDetail);
  const navigationLayout = homeNavigationLayout(insets, systemInsets, headerHeight, !inlineControls);
  useEffect(() => {
    if (showDetail) setDetailVisited(true);
  }, [showDetail]);
  const showTools = !!selected && tool !== null;
  const showSidebar = laptop ? (!selected || laptopListOpen) && !showTools : split ? !sidebarCollapsed && !showTools : !showDetail && !showTools;
  const sidebarWidth = folded ? layout.before : Math.min(350, Math.max(290, width * 0.36));
  const gap = split ? (folded ? layout.gap : 12) : 0;
  const navigationTop = Platform.OS === "ios" ? navigationLayout.contentTop : 0;
  const paneTop = split ? Math.max(8, navigationTop, insets.top) : navigationTop;
  const bottom = laptop ? Math.max(12, insets.bottom) : split ? 12 : 0;
  const foldLayout = useMemo(() => (laptop ? { bottomReserved: bottom } : null), [laptop, bottom]);
  const motionGeometry = [
    geometry.revision,
    width,
    height,
    split,
    axis,
    folded,
    layout.before,
    layout.after,
    layout.gap,
    insets.top,
    insets.bottom,
    navigationTop,
    window.fontScale,
  ].join(":");
  const sidebarTop = Platform.OS === "ios" ? navigationTop : split ? insets.top : 0;
  const padEmpty = Platform.OS === "ios" && Platform.isPad && split && !folded && !showDetail;
  const activeSidebarWidth = padEmpty ? width : sidebarWidth;
  const sidebar: PaneFrame =
    axis === "column"
      ? { left: 0, top: sidebarTop, width, height: showSidebar ? Math.max(0, layout.before - sidebarTop) : 0 }
      : { left: 0, top: sidebarTop, width: showSidebar ? (split ? activeSidebarWidth : width) : 0, height: Math.max(0, height - sidebarTop) };
  const detailVisible = showDetail && (split || !showTools);
  const detailLeft =
    folded && axis === "row" && !showSidebar && !showTools
      ? layout.before + layout.gap
      : showSidebar && split && axis === "row"
        ? sidebarWidth + gap
        : 0;
  const toolWidth = Math.max(0, split ? layout.after - 12 : width);
  const detail: PaneFrame = laptop
    ? { left: 0, top: paneTop, width, height: Math.max(0, height - paneTop - bottom) }
    : {
        left: detailLeft,
        top: paneTop,
        width: detailVisible ? Math.max(0, width - detailLeft - (showTools && split ? toolWidth + gap + 12 : split ? 12 : 0)) : 0,
        height: Math.max(0, height - paneTop - bottom),
      };
  const tools: PaneFrame =
    split && axis === "column"
      ? { left: 0, top: paneTop, width, height: showTools ? Math.max(0, layout.before - paneTop) : 0 }
      : {
          left: showTools ? (split ? width - toolWidth - 12 : 0) : width,
          top: split ? paneTop : Math.max(navigationTop, insets.top),
          width: showTools ? toolWidth : 0,
          height: Math.max(0, height - (split ? paneTop : Math.max(navigationTop, insets.top)) - bottom),
        };
  const toggleSidebar = () => {
    setMotionAction((value) => value + 1);
    if (laptop) {
      setLaptopListOpen((value) => !value);
      setTool(null);
    } else if (!split) {
      setDetailOpened(false);
      setTool(null);
    } else if (showTools) {
      setTool(null);
      setSidebarCollapsed(false);
    } else setSidebarCollapsed((value) => !value);
  };
  const openTool = (panel: Panel) => {
    setMotionAction((value) => value + 1);
    setLaptopListOpen(false);
    setTool(panel);
  };
  const toggleTool = (panel: Panel) => {
    setMotionAction((value) => value + 1);
    setLaptopListOpen(false);
    setTool((current) => (current === panel ? null : panel));
  };
  const closeTool = () => {
    setMotionAction((value) => value + 1);
    setTool(null);
  };
  const sessionTools: HeaderAction[] = [
    { ...NEW_SESSION, kind: "button" },
    ...(["changes", "preview"] as const).map(
      (panel): HeaderAction => ({
        kind: "button",
        key: panel,
        icon: panel === "changes" ? { sf: "plus.forwardslash.minus", md: "difference" } : { sf: "globe", md: "language" },
        label: panel === "changes" ? t("nav.changes") : t("nav.ports"),
        onPress: () => toggleTool(panel),
      }),
    ),
  ];
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {Platform.OS === "ios" ? (
        <>
          <Stack.Screen
            options={{
              title: "",
              headerTitle: undefined,
              headerShown: !inlineControls,
              headerLargeTitleEnabled: false,
              headerTransparent: navigationLayout.headerTransparent,
              headerShadowVisible: false,
              headerStyle: { backgroundColor: colors.background as string },
            }}
          />
          {showDetail ? (
            <Stack.Toolbar placement="left">
              <Stack.Toolbar.Button icon={split ? "sidebar.left" : "chevron.left"} accessibilityLabel={t("nav.sessions")} onPress={toggleSidebar}>
                {t("nav.sessions")}
              </Stack.Toolbar.Button>
            </Stack.Toolbar>
          ) : null}
          {!showDetail && !inlineControls ? <HeaderActions actions={[{ ...NEW_SESSION, kind: "button" }]} /> : null}
        </>
      ) : null}
      <View onLayout={geometry.onLayout} style={{ flex: 1, overflow: "hidden" }}>
        <LayoutProbe onMetrics={geometry.onMetrics} revision={geometry.revision} />
        <MountedMotionPane
          frame={sidebar}
          visible={showSidebar}
          action={motionAction}
          geometry={motionGeometry}
          fixedWidth={split && axis === "row" ? activeSidebarWidth : width}
          style={{ zIndex: laptop ? 1 : 0 }}
        >
          <HomeList onSelect={select} selectedId={showDetail ? selected?.id : undefined} compact={split} inlineControls={inlineControls} />
        </MountedMotionPane>
        <MountedMotionPane
          frame={detail}
          visible={detailVisible}
          action={motionAction}
          geometry={motionGeometry}
          style={{ borderRadius: split ? radius.panel : 0, borderCurve: "continuous", backgroundColor: colors.plain }}
        >
          <SessionFoldLayoutContext value={foldLayout}>
            {selected && (showDetail || detailVisited) ? (
              <>
                {Platform.OS !== "ios" ? (
                  <View
                    style={{
                      paddingTop: split ? Math.max(18, insets.top + 4) : insets.top + 12,
                      paddingBottom: 14,
                      paddingHorizontal: 18,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      borderBottomWidth: 0.5,
                      borderBottomColor: colors.separator,
                    }}
                  >
                    {!split ? (
                      <Pressable
                        onPress={toggleSidebar}
                        accessibilityRole="button"
                        accessibilityLabel={t("nav.sessions")}
                        hitSlop={8}
                        style={{ width: 32, height: 40, alignItems: "center", justifyContent: "center" }}
                      >
                        <Icon sf="chevron.left" md="arrow_back" size={20} color={colors.accent} />
                      </Pressable>
                    ) : null}
                    {split ? (
                      <Pressable
                        onPress={toggleSidebar}
                        accessibilityRole="button"
                        accessibilityLabel={t("nav.sessions")}
                        accessibilityState={{ expanded: showSidebar }}
                        hitSlop={6}
                        style={{ width: 36, height: 40, alignItems: "center", justifyContent: "center" }}
                      >
                        <Icon sf="sidebar.left" md="view_sidebar" size={20} color={colors.secondaryLabel} />
                      </Pressable>
                    ) : null}
                    <SessionAvatar session={selected} size={34} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text numberOfLines={1} style={[type.headline, { color: colors.label }]}>
                        {sessionTitle(selected)}
                      </Text>
                      <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel }]}>
                        {baseName(selected.cwd)}
                      </Text>
                    </View>
                    {(["changes", "preview"] as const).map((panel) => (
                      <Pressable
                        key={panel}
                        onPress={() => toggleTool(panel)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: tool === panel }}
                        accessibilityLabel={panel === "changes" ? t("nav.changes") : t("nav.ports")}
                        hitSlop={4}
                      >
                        <Glass interactive style={{ minHeight: 40, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 20, alignItems: "center", justifyContent: "center" }}>
                          <Text style={[type.caption, { color: colors.accent, fontWeight: "600" }]}>
                            {panel === "changes" ? t("nav.changes") : t("ports.openPreview")}
                          </Text>
                        </Glass>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                <SessionContent
                  key={selected.id}
                  sessionId={selected.id}
                  embedded
                  consumedBottomInset={bottom}
                  navigation={Platform.OS === "ios" && showDetail}
                  navigationTitle={split ? "" : undefined}
                  toolbarActions={split ? sessionTools : []}
                  onOpenPanel={openTool}
                  panelsBeside={split}
                />
              </>
            ) : null}
          </SessionFoldLayoutContext>
        </MountedMotionPane>
        <MountedMotionPane
          frame={tools}
          visible={showTools}
          action={motionAction}
          geometry={motionGeometry}
          fixedWidth={split && axis === "column" ? width : toolWidth}
          style={{ zIndex: laptop ? 2 : 0, borderRadius: split ? radius.panel : 0, borderCurve: "continuous", backgroundColor: colors.plain }}
        >
          {selected ? (
            <SessionTools
              key={selected.id}
              sessionId={selected.id}
              panel={tool ?? "changes"}
              onPanel={openTool}
              onClose={closeTool}
              active={showTools}
              motionAction={motionAction}
              motionGeometry={motionGeometry}
            />
          ) : null}
        </MountedMotionPane>
      </View>
    </View>
  );
}

function SwipeableSessionRow({
  session,
  position,
  now,
  onPress,
  selected,
}: {
  session: SessionSummary;
  position: RowPosition;
  now: number;
  onPress: () => void;
  selected: boolean;
}) {
  const swipeRef = useRef<SwipeableMethods>(null);
  const actions = useActions();
  const pinnedIds = usePinnedSessionIds();
  const pinned = pinnedIds.includes(session.id);

  useEffect(() => {
    swipeRef.current?.close();
  }, [session.id]);

  const top = position === "first" || position === "only";
  const bottom = position === "last" || position === "only";
  const leftCorners = {
    borderTopLeftRadius: top ? radius.card : 0,
    borderBottomLeftRadius: bottom ? radius.card : 0,
    borderCurve: "continuous",
  } as const;
  const rightCorners = {
    borderTopRightRadius: top ? radius.card : 0,
    borderBottomRightRadius: bottom ? radius.card : 0,
    borderCurve: "continuous",
  } as const;

  const handlePin = () => {
    haptics.selection();
    toggleSessionPinned(session.id);
    swipeRef.current?.close();
  };

  const handleArchive = () => {
    swipeRef.current?.close();
    void toggleArchived(session, actions);
  };

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={2}
      leftThreshold={40}
      rightThreshold={40}
      overshootLeft={false}
      overshootRight={false}
      dragOffsetFromLeftEdge={16}
      dragOffsetFromRightEdge={16}
      renderLeftActions={() => (
        <Animated.View style={{ width: 84, backgroundColor: colors.accentFill, ...leftCorners }}>
          <Pressable
            onPress={handlePin}
            accessibilityRole="button"
            accessibilityLabel={pinned ? "取消置顶" : "置顶会话"}
            style={({ pressed }) => ({ flex: 1, alignItems: "center", justifyContent: "center", gap: 4, opacity: pressed ? 0.6 : 1 })}
          >
            <Icon sf={pinned ? "pin.slash" : "pin.fill"} md="push_pin" size={17} color="#fff" />
            <Text style={[type.caption, { color: "#fff", fontWeight: "600" }]}>{pinned ? "取消置顶" : "置顶"}</Text>
          </Pressable>
        </Animated.View>
      )}
      renderRightActions={() => (
        <Animated.View style={{ width: 84, backgroundColor: colors.fillStrong, ...rightCorners }}>
          <Pressable
            onPress={handleArchive}
            accessibilityRole="button"
            accessibilityLabel={session.archived ? "取消归档" : "归档"}
            style={({ pressed }) => ({ flex: 1, alignItems: "center", justifyContent: "center", gap: 4, opacity: pressed ? 0.6 : 1 })}
          >
            <Icon sf={session.archived ? "tray.and.arrow.up" : "archivebox"} md={session.archived ? "unarchive" : "archive"} size={17} color={colors.label} />
            <Text style={[type.caption, { color: colors.label, fontWeight: "600" }]}>{session.archived ? "取消归档" : "归档"}</Text>
          </Pressable>
        </Animated.View>
      )}
    >
      <SessionRow
        session={session}
        position={position}
        now={now}
        onPress={onPress}
        selected={selected}
      />
    </ReanimatedSwipeable>
  );
}

function HomeList({
  onSelect,
  selectedId,
  compact,
  inlineControls,
}: {
  onSelect: (id: string) => void;
  selectedId?: string;
  compact: boolean;
  inlineControls: boolean;
}) {
  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const insets = usePageInsets();
  const tabInset = useFloatingTabInset();
  const { locale, t, pick } = useLocale();
  const frozenSessionsRef = useRef<ClientState["sessions"] | null>(null);
  const frozenViewsRef = useRef<ClientState["views"] | null>(null);
  const frozenProgressRef = useRef<ClientState["promptProgress"] | null>(null);
  const sessionsById = useClient((state) => {
    if (focusedRef.current || frozenSessionsRef.current === null) {
      frozenSessionsRef.current = state.sessions;
    }
    return frozenSessionsRef.current;
  });
  const { computer, link } = useConnection();
  const names = useComputerNames((state) => state.names);
  const online = useClient((state) => state.status === "online");
  const loaded = useClient((state) => state.sessionsLoaded);
  const sessionsNextBefore = useClient((state) => state.sessionsNextBefore);
  const error = useClient((state) => state.sessionsError);
  const connectionStatus = useConnectionStatus();
  const offline = unreachable(connectionStatus);
  const hasComputer = useHasComputer();
  const { refresh, loadMoreSessions } = useActions();
  const { metrics } = useMachineMetrics();
  const power = metrics?.power;
  const lowBattery = isHostLowBattery(power);
  const now = useNow(focused ? 30_000 : null);
  const [refreshing, setRefreshing] = useState(false);
  const loadingMoreRef = useRef(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HomeFilterMode>("all");
  const words = useMemo(() => searchWords(query), [query]);
  const searching = words.length > 0;

  const pinnedIds = usePinnedSessionIds();
  const snoozedMap = useSnoozedSessions();

  const day = new Date(now).toDateString();
  const views = useClient((state) => {
    if (focusedRef.current || frozenViewsRef.current === null) {
      frozenViewsRef.current = state.views;
    }
    return frozenViewsRef.current;
  });
  const promptProgress = useClient((state) => {
    if (focusedRef.current || frozenProgressRef.current === null) {
      frozenProgressRef.current = state.promptProgress;
    }
    return frozenProgressRef.current;
  });
  const { terminals } = useTerminals();

  const frozenAllSessionsRef = useRef<SessionSummary[] | null>(null);
  const allSessions = useMemo(() => {
    if (!focused && frozenAllSessionsRef.current !== null) return frozenAllSessionsRef.current;
    const next = mergeLiveViewsIntoSessions(Object.values(sessionsById), views, promptProgress);
    frozenAllSessionsRef.current = next;
    return next;
  }, [focused, sessionsById, views, promptProgress]);
  const computerName = computerDisplayName(computer, names);

  const frozenLiveActivityRef = useRef<ReturnType<typeof buildLiveActivityPayload> | null>(null);
  const liveActivityPayload = useMemo(() => {
    if (!focused && frozenLiveActivityRef.current !== null) return frozenLiveActivityRef.current;
    const next = buildLiveActivityPayload(computerName, allSessions, terminals, online, views, promptProgress);
    frozenLiveActivityRef.current = next;
    return next;
  }, [focused, computerName, allSessions, terminals, online, views, promptProgress]);

  const frozenBuiltRef = useRef<ReturnType<typeof buildItems> | null>(null);
  // A snooze ends by the clock, not by anything the computer sends: while one runs, the list follows the clock.
  const snoozeNow = Object.keys(snoozedMap).length > 0 ? now : 0;
  const { items, waiting, running, failed, pinnedCount, snoozedCount } = useMemo(() => {
    if (!focused && frozenBuiltRef.current !== null) return frozenBuiltRef.current;
    const next = buildItems(allSessions, terminals, snoozeNow || Date.now(), locale, {
      pinnedIds,
      snoozedMap,
      filter,
    });
    frozenBuiltRef.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `day` invalidates date buckets on midnight rollover.
  }, [focused, allSessions, terminals, day, locale, pinnedIds, snoozedMap, filter, snoozeNow]);
  const empty = loaded && Object.keys(sessionsById).length === 0 && terminals.length === 0;
  const frozenResultsRef = useRef<Item[] | null>(null);
  const results = useMemo(() => {
    if (!focused && frozenResultsRef.current !== null) return frozenResultsRef.current;
    const next = searching ? searchItems(allSessions, terminals, words, locale) : [];
    frozenResultsRef.current = next;
    return next;
  }, [focused, searching, allSessions, terminals, words, locale]);

  const filterChips = useMemo(() => {
    const copy = sectionWords(locale);
    const chips: { key: HomeFilterMode; label: string; count?: number }[] = [
      { key: "all", label: t("session.outlineAll") },
    ];
    if (waiting + failed > 0) chips.push({ key: "attention", label: copy.need, count: waiting + failed });
    if (running > 0) chips.push({ key: "running", label: copy.run, count: running });
    if (pinnedCount > 0) chips.push({ key: "pinned", label: copy.pin, count: pinnedCount });
    if (terminals.length > 0) chips.push({ key: "terminals", label: copy.term, count: terminals.length });
    if (snoozedCount > 0) chips.push({ key: "snoozed", label: copy.snooze, count: snoozedCount });
    return chips;
  }, [locale, t, waiting, failed, running, pinnedCount, terminals.length, snoozedCount]);

  useEffect(() => {
    if (filter !== "all" && !filterChips.some((c) => c.key === filter)) {
      setFilter("all");
    }
  }, [filter, filterChips]);

  const onRefresh = useCallback(async () => {
    // Offline, the list call would wait half a minute for the link before failing: reconnect
    // instead (the banner says where that stands) and let go of the spinner.
    if (!online) {
      link.reconnectNow(true);
      return;
    }
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh, online, link]);

  const onEndReached = useCallback(() => {
    if (!online || !loaded || searching || sessionsNextBefore === undefined || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    void loadMoreSessions().catch(() => undefined).finally(() => {
      loadingMoreRef.current = false;
    });
  }, [online, loaded, searching, sessionsNextBefore, loadMoreSessions]);

  const renderItem = useCallback(
    ({ item }: { item: Item }) => {
      switch (item.type) {
        case "header":
          return <SectionHeader title={item.title} count={item.count} tone={item.warn ? colors.danger : undefined} />;
        case "need":
          return (
            <View style={{ paddingBottom: 12 }}>
              <NeedCard session={item.session} now={now} onPress={() => onSelect(item.session.id)} />
            </View>
          );
        case "row":
          return (
            <View style={compact && item.position !== "last" && item.position !== "only" ? { paddingBottom: 8 } : undefined}>
              <SwipeableSessionRow
                session={item.session}
                position={compact ? "only" : item.position}
                now={now}
                onPress={() => onSelect(item.session.id)}
                selected={selectedId === item.session.id}
              />
            </View>
          );
        case "terminal":
          return (
            <View style={compact && item.position !== "last" && item.position !== "only" ? { paddingBottom: 8 } : undefined}>
              <TerminalRow terminal={item.terminal} position={compact ? "only" : item.position} now={now} />
            </View>
          );
      }
    },
    [now, compact, onSelect, selectedId],
  );

  const openHeroFromIsland = useCallback(() => {
    const deep = liveActivityPayload.deepLink ?? "";
    const sessionMatch = /\/session\/([^/?#]+)/.exec(deep);
    if (sessionMatch?.[1]) {
      onSelect(sessionMatch[1]);
      return;
    }
    const termMatch = /\/terminal\/([^/?#]+)/.exec(deep);
    if (termMatch?.[1]) {
      router.push({ pathname: "/terminal/[id]", params: { id: termMatch[1] } });
    }
  }, [liveActivityPayload.deepLink, onSelect]);

  const padCenteredEmpty = Platform.OS === "ios" && Platform.isPad && compact && (!loaded || empty);

  return (
    <>
      <LegendList
        data={!loaded || empty ? [] : searching ? results : items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.type}
        renderItem={renderItem}
        extraData={`${selectedId ?? ""}:${now}:${filter}:${locale}:${pinnedIds.join(",")}`}
        estimatedItemSize={64}
        recycleItems
        contentInsetAdjustmentBehavior="never"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: compact ? 12 : 16,
          paddingBottom: 32 + (Platform.OS === "ios" ? insets.bottom + IOS_TAB_BAR_HEIGHT : tabInset),
          ...(padCenteredEmpty ? { maxWidth: 480, width: "100%", alignSelf: "center" } : {}),
        }}
        style={{ flex: 1, backgroundColor: colors.background }}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View>
            <View style={{ paddingTop: (inlineControls ? 8 : 16) + (Platform.OS === "ios" ? 0 : insets.top), paddingBottom: 8, gap: inlineControls ? 8 : 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Summary small={inlineControls} batteryPercent={power?.onBattery ? power.percent : null} lowBattery={lowBattery} />
                </View>
                {Platform.OS !== "ios" && !inlineControls ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("session.new")}
                    onPress={NEW_SESSION.onPress}
                    style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
                  >
                    <Icon sf="square.and.pencil" md="edit_square" size={22} color={colors.accent} />
                  </Pressable>
                ) : null}
              </View>
              {lowBattery && power?.percent !== null && power?.percent !== undefined ? (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: radius.control,
                    borderCurve: "continuous",
                    backgroundColor: colors.dangerSoft,
                  }}
                >
                  <Icon sf="battery.25" md="battery_alert" size={15} color={colors.danger} />
                  <Text style={[type.caption, { flex: 1, color: colors.danger, fontWeight: "600" }]}>
                    {t("power.lowBatteryWarning", { percent: Math.round(power.percent) })}
                  </Text>
                </View>
              ) : null}
              {inlineControls || (loaded && !empty) ? (
                <PageSearch value={query} onChangeText={setQuery} placeholder={`${t("common.search")}…`} action={inlineControls ? NEW_SESSION : undefined} />
              ) : null}
              {!searching && filterChips.length > 1 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ gap: 7, paddingHorizontal: 2 }}
                >
                  {filterChips.map((chip) => {
                    const active = filter === chip.key;
                    return (
                      <Pressable
                        key={chip.key}
                        onPress={() => {
                          haptics.selection();
                          setFilter(chip.key);
                        }}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={chip.label}
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 4,
                          height: 32,
                          paddingHorizontal: 12,
                          borderRadius: 16,
                          borderCurve: "continuous",
                          borderWidth: StyleSheet.hairlineWidth,
                          borderColor: "transparent",
                          backgroundColor: active ? colors.fillStrong : "transparent",
                          opacity: pressed ? 0.6 : 1,
                        })}
                      >
                        <Text
                          style={[
                            type.caption,
                            {
                              color: active ? colors.label : colors.secondaryLabel,
                              fontWeight: active ? "600" : "500",
                            },
                          ]}
                        >
                          {chip.label}
                        </Text>
                        {chip.count !== undefined ? (
                          <View style={{ height: 18, alignItems: "center", justifyContent: "center" }}>
                            <Text style={[type.caption2, { color: colors.secondaryLabel, fontWeight: "600", fontVariant: ["tabular-nums"] }]}>
                              {chip.count}
                            </Text>
                          </View>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              ) : null}
            </View>
            {!searching &&
            liveActivityPayload.active &&
            (liveActivityPayload.phase === "stale" ||
              filter === "pinned" ||
              filter === "terminals" ||
              filter === "snoozed") ? (
              <AttentionIsland payload={liveActivityPayload} onOpenHero={openHeroFromIsland} />
            ) : null}
            <ConnectionBanner />
            {loaded && error && online ? (
              // The list on screen is the last one that loaded; say that this refresh didn't.
              <Text style={[type.footnote, { color: colors.secondaryLabel, paddingHorizontal: 4, paddingTop: 8 }]}>
                {pick({ zh: "没能刷新会话列表，下拉可重试", en: "Couldn't refresh sessions. Pull down to retry.", ja: "セッションを更新できませんでした。引き下げて再試行してください。" })}
              </Text>
            ) : null}
          </View>
        }
        ListFooterComponent={
          loaded && !empty && !searching ? (
            <Pressable
              onPress={() => router.push("/archived")}
              accessibilityRole="button"
              hitSlop={8}
              style={({ pressed }) => ({ alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 18, opacity: pressed ? 0.6 : 1 })}
            >
              <Icon sf="archivebox" md="archive" size={13} color={colors.tertiaryLabel} />
              <Text style={[type.footnote, { color: colors.tertiaryLabel }]}>{t("nav.archived")}</Text>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={
          !hasComputer ? (
            <Welcome />
          ) : connectionStatus === "locked" ? (
            // Nothing loads until the password is given: a spinner here would never end.
            <LockedComputer />
          ) : !loaded ? (
            connectionStatus === "connecting" ? (
              <LoadingState label={t("connection.reconnecting")} />
            ) : error ? (
              <EmptyState
                icon={{ sf: "exclamationmark.triangle", md: "warning" }}
                title={pick({ zh: "读取会话失败", en: "Unable to load sessions", ja: "セッションの読み込みに失敗しました" })}
                message={error}
                action={{ title: t("common.retry"), onPress: () => void refresh() }}
              />
            ) : offline ? (
              <WaitingForComputer what={t("nav.sessions")} />
            ) : (
              <LoadingState label={t("common.loading")} />
            )
          ) : searching ? (
            <EmptyState
              icon={{ sf: "magnifyingglass", md: "search" }}
              title={t("session.noMatches")}
              message={pick({
                zh: "可以搜标题、消息、项目、分支和 Agent。",
                en: "Search by session title, prompt, project, branch, or agent.",
                ja: "タイトル、メッセージ、プロジェクト、ブランチ、Agent 名で検索できます。",
              })}
            />
          ) : (
            <EmptyState
              icon={{ sf: "bubble.left.and.text.bubble.right", md: "forum" }}
              title={pick({ zh: "还没有会话", en: "No sessions yet", ja: "セッションがまだありません" })}
              message={pick({
                zh: "在电脑终端里用 linkshell claude 或 linkshell codex 开始，或者直接在这里新建。",
                en: "Start `linkshell claude` or `linkshell codex` on your computer, or create a session right here.",
                ja: "PC ターミナルで linkshell claude / codex を起動するか、ここから新規作成できます。",
              })}
              action={{ title: t("session.new"), onPress: () => router.push("/new") }}
            />
          )
        }
      />
    </>
  );
}
