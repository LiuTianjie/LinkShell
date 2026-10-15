import { needsAttention } from "@/lib/describe";
import { LegendList } from "@legendapp/list/react-native";
import type { SessionSummary, TerminalInfo } from "@linkshell/wire";
import { router, Stack } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/fixed-text";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";
import { Icon } from "@/components/icon";
import { AttentionIsland } from "@/components/attention-island";
import { ConnectionBanner } from "@/components/connection-banner";
import { NeedCard } from "@/components/need-card";
import { SectionHeader } from "@/components/section-header";
import { SessionRow, positionOf, type RowPosition } from "@/components/session-row";
import { TerminalRow } from "@/components/terminal-row";
import { searchWords, sessionMatches, terminalMatches } from "@/lib/search";
import { terminalState, useTerminals } from "@/lib/terminals";
import { EmptyState, LoadingState, unreachable, WaitingForComputer } from "@/components/state-views";
import { useActions, useClient, useConnection, useHasComputer } from "@/lib/client";
import { Welcome } from "@/components/welcome";
import { haptics } from "@/lib/haptics";
import {
  buildLiveActivityPayload,
  isSessionSnoozed,
  mergeLiveViewsIntoSessions,
  useIOSAttentionSync,
  usePinnedSessionIds,
  useSnoozedSessions,
  type HomeFilterMode,
} from "@/lib/session-attention";
import { useNow } from "@/lib/use-now";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { useFloatingTabInset } from "@/components/floating-tabs";
import { NEW_SESSION } from "@/components/new-session-action";
import { PageSearch } from "@/components/page-header";
import { SessionContent } from "./session-screen";
import { MountedMotionPane, type PaneFrame } from "@/components/mounted-motion-pane";
import { useLayoutGeometry } from "@/lib/use-layout-geometry";
import { workspaceLayout } from "@/lib/workspace-layout";
import { homeNavigationLayout, homeUsesInlineControls } from "@/lib/home-layout";
import { SessionFoldLayoutContext } from "@/lib/session-fold-layout";
import { sessionTitle } from "@/lib/describe";
import { baseName } from "@/lib/format";
import { SessionAvatar } from "@/components/session-row";
import { Glass } from "@/components/glass";
import { LayoutProbe } from "../../modules/link-layout";
import { AdaptivePage, usePageInsets } from "@/components/adaptive-page";
import { HeaderActions, type HeaderAction } from "@/components/header-actions";
import { SessionTools } from "@/components/session-workspace";

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

/** "今天 / 昨天 / 近 7 天 / 更早": recent sessions read as a diary, not a wall. */
function dayBucket(ts: number, now: number): string {
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= start) return "今天";
  if (ts >= start - DAY) return "昨天";
  if (ts >= start - 6 * DAY) return "近 7 天";
  return "更早";
}

function buildItems(
  sessions: SessionSummary[],
  terminals: TerminalInfo[],
  now: number,
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
      items.push({ type: "header", key: "h-need", title: "需要你", count: waiting.length, warn: true });
      for (const session of waiting) items.push({ type: "need", key: `n-${session.id}`, session });
    }
    if (failed.length) {
      items.push({ type: "header", key: "h-fail", title: "出错", count: failed.length, warn: true });
      failed.forEach((session, index) => items.push({ type: "row", key: `err-${session.id}`, session, position: positionOf(index, failed.length) }));
    }
  } else if (filter === "running") {
    if (running.length) {
      items.push({ type: "header", key: "h-run", title: "进行中", count: running.length });
      running.forEach((entry, index) => items.push(rowOf(entry, positionOf(index, running.length), "r")));
    }
  } else if (filter === "pinned") {
    const allPinned = liveAll.filter((s) => pinnedSet.has(s.id)).sort(newest);
    if (allPinned.length) {
      items.push({ type: "header", key: "h-pin", title: "已置顶", count: allPinned.length });
      allPinned.forEach((session, index) => items.push({ type: "row", key: `pin-${session.id}`, session, position: positionOf(index, allPinned.length) }));
    }
  } else if (filter === "terminals") {
    const sortedTerminals = [...terminals].sort((a, b) => b.activeAt - a.activeAt);
    if (sortedTerminals.length) {
      items.push({ type: "header", key: "h-term", title: "终端", count: sortedTerminals.length });
      sortedTerminals.forEach((terminal, index) =>
        items.push({ type: "terminal", key: `term-${terminal.id}`, terminal, position: positionOf(index, sortedTerminals.length) }),
      );
    }
  } else if (filter === "snoozed") {
    if (snoozedSessions.length) {
      items.push({ type: "header", key: "h-snooze", title: "稍后处理", count: snoozedSessions.length });
      snoozedSessions.forEach((session, index) =>
        items.push({ type: "row", key: `snz-${session.id}`, session, position: positionOf(index, snoozedSessions.length) }),
      );
    }
  } else {
    // Default "all" view: Attention-first hierarchy (Waiting > Failed > Running > Pinned > Day buckets)
    if (waiting.length) {
      items.push({ type: "header", key: "h-need", title: "需要你", count: waiting.length, warn: true });
      for (const session of waiting) items.push({ type: "need", key: `n-${session.id}`, session });
    }
    if (failed.length) {
      items.push({ type: "header", key: "h-fail", title: "出错", count: failed.length, warn: true });
      failed.forEach((session, index) =>
        items.push({ type: "row", key: `err-${session.id}`, session, position: positionOf(index, failed.length) }),
      );
    }
    if (running.length) {
      items.push({ type: "header", key: "h-run", title: "进行中", count: running.length });
      running.forEach((entry, index) => items.push(rowOf(entry, positionOf(index, running.length), "r")));
    }
    if (pinned.length) {
      items.push({ type: "header", key: "h-pin", title: "已置顶", count: pinned.length });
      pinned.forEach((session, index) =>
        items.push({ type: "row", key: `pin-${session.id}`, session, position: positionOf(index, pinned.length) }),
      );
    }
    const buckets = new Map<string, Entry[]>();
    for (const entry of recent) {
      const bucket = dayBucket(entry.at, now);
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

/**
 * What a search finds, newest first, as one plain list: no "needs you" cards or days, since the question
 * was "where is it". Archived sessions are found too, under their own heading.
 */
function searchItems(sessions: SessionSummary[], terminals: TerminalInfo[], words: string[]): Item[] {
  const matching = sessions.filter((session) => sessionMatches(session, words));
  const current: Entry[] = [
    ...matching.filter((session) => !session.archived).map((session): Entry => ({ kind: "session", session, at: session.updatedAt })),
    ...terminals.filter((terminal) => terminalMatches(terminal, words)).map((terminal): Entry => ({ kind: "terminal", terminal, at: terminal.activeAt })),
  ].sort((a, b) => b.at - a.at);
  const archived = matching.filter((session) => session.archived).sort(newest);
  const items: Item[] = [];
  if (current.length) {
    items.push({ type: "header", key: "h-found", title: "找到", count: current.length });
    current.forEach((entry, index) => items.push(rowOf(entry, positionOf(index, current.length), "f")));
  }
  if (archived.length) {
    items.push({ type: "header", key: "h-found-archived", title: "已归档", count: archived.length });
    archived.forEach((session, index) => items.push({ type: "row", key: `fa-${session.id}`, session, position: positionOf(index, archived.length) }));
  }
  return items;
}

/** Which computer (tap to switch), and only the one thing worth saying: what's waiting on you. */
function Summary({ waiting, small = false }: { waiting: number; small?: boolean }) {
  const machine = useClient((state) => state.machine);
  const online = useClient((state) => state.status === "online");
  return (
    <Pressable
      onPress={() => {
        haptics.selection();
        router.push("/computers");
      }}
      accessibilityRole="button"
      accessibilityLabel={`当前电脑：${machine ? machine.hostname.replace(/\.local$/, "") : "电脑"}，点击切换设备`}
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
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: online ? colors.ok : colors.tertiaryLabel }} />
      <Text numberOfLines={1} style={[small ? type.footnote : type.subhead, { color: colors.secondaryLabel, flexShrink: 1 }]}>
        {machine ? machine.hostname.replace(/\.local$/, "") : "电脑"}
      </Text>
      <Icon sf="chevron.up.chevron.down" md="unfold_more" size={11} color={colors.tertiaryLabel} />
      {waiting ? <Text style={[small ? type.footnote : type.subhead, { color: colors.waiting, fontWeight: "600" }]}>· {waiting} 项需要你</Text> : null}
    </Pressable>
  );
}

export function HomeScreen() {
  const { computer } = useConnection();
  return <AdaptivePage><HomeWorkspace key={computer.key} /></AdaptivePage>;
}

function HomeWorkspace() {
  const insets = usePageInsets();
  const systemInsets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const window = useWindowDimensions();
  const geometry = useLayoutGeometry();
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
  useEffect(() => { if (!laptop) setLaptopListOpen(false); }, [laptop]);
  const [motionAction, setMotionAction] = useState(0);
  const [detailVisited, setDetailVisited] = useState(false);
  const [tool, setTool] = useState<"changes" | "preview" | null>(null);
  const first = useMemo(() => Object.values(sessions).filter((session) => !session.archived).sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || b.updatedAt - a.updatedAt)[0], [sessions]);
  const selected = selectedId && sessions[selectedId] && !sessions[selectedId].archived ? sessions[selectedId] : first;
  const select = useCallback((id: string) => {
    if (!split) {
      router.push({ pathname: "/session/[id]", params: { id } });
      return;
    }
    setMotionAction((value) => value + 1);
    setSelectedId(id);
    setDetailOpened(true);
    setLaptopListOpen(false);
  }, [split]);
  // Closing the phone continues the conversation the user was just reading.
  useEffect(() => {
    if (split && selected) {
      setSelectedId(selected.id);
      setDetailOpened(true);
    }
  }, [split, selected]);
  const showDetail = !!selected && (split || detailOpened);
  const inlineControls = homeUsesInlineControls(systemInsets, split, showDetail);
  const navigationLayout = homeNavigationLayout(insets, systemInsets, headerHeight, !inlineControls);
  useEffect(() => { if (showDetail) setDetailVisited(true); }, [showDetail]);
  const showTools = !!selected && tool !== null;
  const showSidebar = laptop ? (!selected || laptopListOpen) && !showTools : split ? !sidebarCollapsed && !showTools : !showDetail && !showTools;
  const sidebarWidth = folded ? layout.before : Math.min(350, Math.max(290, width * 0.36));
  const gap = split ? folded ? layout.gap : 12 : 0;
  const navigationTop = Platform.OS === "ios" ? navigationLayout.contentTop : 0;
  const paneTop = split ? Math.max(8, navigationTop, insets.top) : navigationTop;
  const bottom = laptop ? Math.max(12, insets.bottom) : split ? 12 : 0;
  const foldLayout = useMemo(() => laptop ? { bottomReserved: bottom } : null, [laptop, bottom]);
  const motionGeometry = [geometry.revision, width, height, split, axis, folded, layout.before, layout.after, layout.gap, insets.top, insets.bottom, navigationTop, window.fontScale].join(":");
  const sidebarTop = Platform.OS === "ios" ? navigationTop : split ? insets.top : 0;
  const sidebar: PaneFrame = axis === "column"
    ? { left: 0, top: sidebarTop, width, height: showSidebar ? Math.max(0, layout.before - sidebarTop) : 0 }
    : { left: 0, top: sidebarTop, width: showSidebar ? split ? sidebarWidth : width : 0, height: Math.max(0, height - sidebarTop) };
  const detailVisible = showDetail && (split || !showTools);
  const detailLeft = folded && axis === "row" && !showSidebar && !showTools ? layout.before + layout.gap : showSidebar && split && axis === "row" ? sidebarWidth + gap : 0;
  const toolWidth = Math.max(0, split ? layout.after - 12 : width);
  const detail: PaneFrame = laptop
    ? { left: 0, top: paneTop, width, height: Math.max(0, height - paneTop - bottom) }
    : { left: detailLeft, top: paneTop, width: detailVisible ? Math.max(0, width - detailLeft - (showTools && split ? toolWidth + gap + 12 : split ? 12 : 0)) : 0, height: Math.max(0, height - paneTop - bottom) };
  const tools: PaneFrame = split && axis === "column"
    ? { left: 0, top: paneTop, width, height: showTools ? Math.max(0, layout.before - paneTop) : 0 }
    : { left: showTools ? split ? width - toolWidth - 12 : 0 : width, top: split ? paneTop : Math.max(navigationTop, insets.top), width: showTools ? toolWidth : 0, height: Math.max(0, height - (split ? paneTop : Math.max(navigationTop, insets.top)) - bottom) };
  const toggleSidebar = () => {
    setMotionAction((value) => value + 1);
    if (laptop) { setLaptopListOpen((value) => !value); setTool(null); }
    else if (!split) { setDetailOpened(false); setTool(null); }
    else if (showTools) { setTool(null); setSidebarCollapsed(false); }
    else setSidebarCollapsed((value) => !value);
  };
  const openTool = (panel: "changes" | "preview") => { setMotionAction((value) => value + 1); setLaptopListOpen(false); setTool(panel); };
  const toggleTool = (panel: "changes" | "preview") => { setMotionAction((value) => value + 1); setLaptopListOpen(false); setTool((current) => current === panel ? null : panel); };
  const closeTool = () => { setMotionAction((value) => value + 1); setTool(null); };
  const sessionTools: HeaderAction[] = [{ ...NEW_SESSION, kind: "button" }, ...(["changes", "preview"] as const).map((panel): HeaderAction => ({
    kind: "button", key: panel,
    icon: panel === "changes" ? { sf: "plus.forwardslash.minus", md: "difference" } : { sf: "globe", md: "language" },
    label: panel === "changes" ? "改动" : "预览",
    onPress: () => toggleTool(panel),
  }))];
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {Platform.OS === "ios" ? <>
        <Stack.Screen options={{ title: "", headerTitle: undefined, headerShown: !inlineControls, headerLargeTitleEnabled: false, headerTransparent: navigationLayout.headerTransparent, headerShadowVisible: false, headerStyle: { backgroundColor: colors.background as string } }} />
        {showDetail ? <Stack.Toolbar placement="left"><Stack.Toolbar.Button icon={split ? "sidebar.left" : "chevron.left"} accessibilityLabel={split ? showSidebar ? "收起会话列表" : "展开会话列表" : "返回会话列表"} onPress={toggleSidebar}>{split ? "会话列表" : "返回会话列表"}</Stack.Toolbar.Button></Stack.Toolbar> : null}
        {!showDetail && !inlineControls ? <HeaderActions actions={[{ ...NEW_SESSION, kind: "button" }]} /> : null}
      </> : null}
      <View onLayout={geometry.onLayout} style={{ flex: 1, overflow: "hidden" }}>
        <LayoutProbe onMetrics={geometry.onMetrics} revision={geometry.revision} />
        <MountedMotionPane frame={sidebar} visible={showSidebar} action={motionAction} geometry={motionGeometry} fixedWidth={split && axis === "row" ? sidebarWidth : width} style={{ zIndex: laptop ? 1 : 0 }}>
          <HomeList onSelect={select} selectedId={showDetail ? selected?.id : undefined} compact={split} inlineControls={inlineControls} />
        </MountedMotionPane>
          <MountedMotionPane frame={detail} visible={detailVisible} action={motionAction} geometry={motionGeometry} style={{ borderRadius: split ? 28 : 0, borderCurve: "continuous", backgroundColor: colors.plain }}>
            <SessionFoldLayoutContext value={foldLayout}>
            {selected && (showDetail || detailVisited) ? <>
              {Platform.OS !== "ios" ? <View style={{ paddingTop: split ? Math.max(18, insets.top + 4) : insets.top + 12, paddingBottom: 14, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 0.5, borderBottomColor: colors.separator }}>
                {!split ? <Pressable onPress={toggleSidebar} accessibilityRole="button" accessibilityLabel="返回会话列表" hitSlop={8} style={{ width: 32, height: 40, alignItems: "center", justifyContent: "center" }}><Icon sf="chevron.left" md="arrow_back" size={20} color={colors.accent} /></Pressable> : null}
                {split ? <Pressable onPress={toggleSidebar} accessibilityRole="button" accessibilityLabel={!showSidebar ? "展开会话列表" : "收起会话列表"} accessibilityState={{ expanded: showSidebar }} hitSlop={6} style={{ width: 36, height: 40, alignItems: "center", justifyContent: "center" }}><Icon sf="sidebar.left" md="view_sidebar" size={20} color={colors.secondaryLabel} /></Pressable> : null}
                <SessionAvatar session={selected} size={34} />
                <View style={{ flex: 1, gap: 3 }}>
                  <Text numberOfLines={1} style={[type.headline, { color: colors.label }]}>{sessionTitle(selected)}</Text>
                  <Text numberOfLines={1} style={[type.caption, { color: colors.secondaryLabel }]}>{baseName(selected.cwd)}</Text>
                </View>
                {(["changes", "preview"] as const).map((panel) => (
                  <Pressable key={panel} onPress={() => toggleTool(panel)} accessibilityRole="button" accessibilityState={{ selected: tool === panel }} accessibilityLabel={panel === "changes" ? "查看改动" : "网页预览"} hitSlop={4}>
                    <Glass interactive style={{ minHeight: 40, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 14, alignItems: "center", justifyContent: "center" }}>
                      <Text style={[type.caption, { color: colors.accent, fontWeight: "600" }]}>{panel === "changes" ? "改动" : "预览"}</Text>
                    </Glass>
                  </Pressable>
                ))}
              </View> : null}
              <SessionContent key={selected.id} sessionId={selected.id} embedded consumedBottomInset={bottom} navigation={Platform.OS === "ios" && showDetail} navigationTitle={split ? "" : undefined} toolbarActions={split ? sessionTools : []} onOpenPanel={openTool} />
            </> : null}
            </SessionFoldLayoutContext>
          </MountedMotionPane>
          <MountedMotionPane frame={tools} visible={showTools} action={motionAction} geometry={motionGeometry} fixedWidth={split && axis === "column" ? width : toolWidth} style={{ zIndex: laptop ? 2 : 0, borderRadius: split ? 28 : 0, borderCurve: "continuous", backgroundColor: colors.plain }}>
            {selected ? <SessionTools key={selected.id} sessionId={selected.id} panel={tool ?? "changes"} onPanel={openTool} onClose={closeTool} active={showTools} motionAction={motionAction} motionGeometry={motionGeometry} /> : null}
          </MountedMotionPane>
      </View>
    </View>
  );
}

function HomeList({ onSelect, selectedId, compact, inlineControls }: { onSelect: (id: string) => void; selectedId?: string; compact: boolean; inlineControls: boolean }) {
  const insets = usePageInsets();
  const tabInset = useFloatingTabInset();
  const sessionsById = useClient((state) => state.sessions);
  const machine = useClient((state) => state.machine);
  const online = useClient((state) => state.status === "online");
  const loaded = useClient((state) => state.sessionsLoaded);
  const error = useClient((state) => state.sessionsError);
  const offline = useClient((state) => unreachable(state.status));
  const hasComputer = useHasComputer();
  const { refresh } = useActions();
  const now = useNow();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HomeFilterMode>("all");
  const words = useMemo(() => searchWords(query), [query]);
  const searching = words.length > 0;

  const pinnedIds = usePinnedSessionIds();
  const snoozedMap = useSnoozedSessions();

  // Re-bucket when the day changes, not on every tick.
  const day = new Date(now).toDateString();
  const views = useClient((state) => state.views);
  const promptProgress = useClient((state) => state.promptProgress);
  const { terminals } = useTerminals();
  const allSessions = useMemo(
    () => mergeLiveViewsIntoSessions(Object.values(sessionsById), views, promptProgress),
    [sessionsById, views, promptProgress],
  );
  const computerName = machine ? machine.hostname.replace(/\.local$/, "") : "电脑";

  useIOSAttentionSync(computerName, allSessions, terminals, online, views, promptProgress);

  const liveActivityPayload = useMemo(
    () => buildLiveActivityPayload(computerName, allSessions, terminals, online, views, promptProgress),
    [computerName, allSessions, terminals, online, views, promptProgress],
  );

  const { items, waiting, running, failed, pinnedCount, snoozedCount } = useMemo(
    () =>
      buildItems(allSessions, terminals, Date.now(), {
        pinnedIds,
        snoozedMap,
        filter,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `day` is not read: it is what says the buckets are stale.
    [allSessions, terminals, day, pinnedIds, snoozedMap, filter],
  );
  const empty = loaded && Object.keys(sessionsById).length === 0 && terminals.length === 0;
  const results = useMemo(() => (searching ? searchItems(allSessions, terminals, words) : []), [searching, allSessions, terminals, words]);

  const filterChips = useMemo(() => {
    const chips: { key: HomeFilterMode; label: string; count?: number }[] = [{ key: "all", label: "全部" }];
    if (waiting + failed > 0) chips.push({ key: "attention", label: "需处理", count: waiting + failed });
    if (running > 0) chips.push({ key: "running", label: "进行中", count: running });
    if (pinnedCount > 0) chips.push({ key: "pinned", label: "已置顶", count: pinnedCount });
    if (terminals.length > 0) chips.push({ key: "terminals", label: "终端", count: terminals.length });
    if (snoozedCount > 0) chips.push({ key: "snoozed", label: "稍后", count: snoozedCount });
    return chips;
  }, [waiting, failed, running, pinnedCount, terminals.length, snoozedCount]);

  useEffect(() => {
    if (filter !== "all" && !filterChips.some((c) => c.key === filter)) {
      setFilter("all");
    }
  }, [filter, filterChips]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const renderItem = useCallback(
    ({ item }: { item: Item }) => {
      switch (item.type) {
        case "header":
          return <SectionHeader title={item.title} count={item.count} tone={item.warn ? colors.waiting : undefined} />;
        case "need":
          return (
            <View style={{ paddingBottom: 12 }}>
              <NeedCard session={item.session} now={now} onPress={() => onSelect(item.session.id)} />
            </View>
          );
        case "row":
          return <SessionRow session={item.session} position={compact ? "only" : item.position} now={now} onPress={() => onSelect(item.session.id)} selected={selectedId === item.session.id} />;
        case "terminal":
          return <TerminalRow terminal={item.terminal} position={item.position} now={now} />;
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

  return (
    <>
      <LegendList
        data={!loaded || empty ? [] : searching ? results : items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.type}
        renderItem={renderItem}
        extraData={`${selectedId ?? ""}:${now}:${filter}:${pinnedIds.join(",")}`}
        estimatedItemSize={64}
        recycleItems
        contentInsetAdjustmentBehavior="never"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: compact ? 12 : 16,
          paddingBottom: 32 + tabInset,
        }}
        style={{ flex: 1, backgroundColor: colors.background }}
        refreshing={refreshing}
        onRefresh={onRefresh}
        ListHeaderComponent={
          <View>
            <View style={{ paddingTop: (inlineControls ? 8 : 16) + (Platform.OS === "ios" ? 0 : insets.top), paddingBottom: 8, gap: inlineControls ? 8 : 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ flex: 1 }}><Summary waiting={waiting} small={inlineControls} /></View>
                {Platform.OS !== "ios" && !inlineControls ? <Pressable accessibilityRole="button" accessibilityLabel="新建会话" onPress={NEW_SESSION.onPress} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}><Icon sf="square.and.pencil" md="edit_square" size={22} color={colors.accent} /></Pressable> : null}
              </View>
              {inlineControls || (loaded && !empty) ? <PageSearch value={query} onChangeText={setQuery} placeholder="搜索会话" action={inlineControls ? NEW_SESSION : undefined} /> : null}
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
                        accessibilityLabel={`筛选：${chip.label}`}
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 5,
                          height: 32,
                          paddingHorizontal: 12,
                          borderRadius: 16,
                          borderCurve: "continuous",
                          borderWidth: StyleSheet.hairlineWidth,
                          borderColor: active ? colors.accent : colors.separator,
                          backgroundColor: active ? colors.accent : pressed ? colors.fillStrong : colors.card,
                        })}
                      >
                        <Text
                          style={[
                            type.caption,
                            {
                              color: active ? colors.onAccent : colors.label,
                              fontWeight: active ? "600" : "500",
                            },
                          ]}
                        >
                          {chip.label}
                        </Text>
                        {chip.count !== undefined ? (
                          <View
                            style={{
                              minWidth: 18,
                              height: 18,
                              paddingHorizontal: 5,
                              borderRadius: 9,
                              alignItems: "center",
                              justifyContent: "center",
                              backgroundColor: active ? "rgba(255,255,255,0.22)" : colors.fill,
                            }}
                          >
                            <Text
                              style={{
                                fontSize: 11,
                                color: active ? colors.onAccent : colors.secondaryLabel,
                                fontWeight: "600",
                                fontVariant: ["tabular-nums"],
                              }}
                            >
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
          </View>
        }
        ListFooterComponent={
          // (A search already looks through the archived ones.)
          loaded && !empty && !searching ? (
            <Pressable
              onPress={() => router.push("/archived")}
              accessibilityRole="button"
              hitSlop={8}
              style={{ alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 18 }}
            >
              <Icon sf="archivebox" md="archive" size={13} color={colors.tertiaryLabel} />
              <Text style={[type.footnote, { color: colors.tertiaryLabel }]}>已归档的会话</Text>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={
          !hasComputer ? (
            <Welcome />
          ) : !loaded ? (
            error ? (
              <EmptyState
                icon={{ sf: "exclamationmark.triangle", md: "warning" }}
                title="读取会话失败"
                message={error}
                action={{ title: "重试", onPress: () => void refresh() }}
              />
            ) : offline ? (
              <WaitingForComputer what="电脑上的会话" />
            ) : (
              <LoadingState label="正在读取会话…" />
            )
          ) : searching ? (
            <EmptyState icon={{ sf: "magnifyingglass", md: "search" }} title={`没有匹配“${query.trim()}”的会话`} message="可以搜标题、消息、项目、分支和 Agent。" />
          ) : (
            <EmptyState
              icon={{ sf: "bubble.left.and.text.bubble.right", md: "forum" }}
              title="还没有会话"
              message="在电脑终端里用 linkshell claude 或 linkshell codex 开始，或者直接在这里新建。"
              action={{ title: "新建会话", onPress: () => router.push("/new") }}
            />
          )
        }
      />
    </>
  );
}
