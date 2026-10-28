import type { TimelineItem } from "@linkshell/client-core";
import type { LegendListRef } from "@legendapp/list/react-native";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { useHeaderHeight } from "expo-router/react-navigation";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Text } from "@/components/fixed-text";
import type { SharedValue } from "react-native-reanimated";
import { buildRows, visible, type Row } from "@/lib/timeline-rows";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "../icon";
import { AgentMessage, DriverChange, ErrorCard, Notice, PermissionResult, PlanCard, Thought, TimeSeparator, TurnEnd, UserMessage } from "./items";
import { StepsSummary } from "./steps";
import { GLYPH, ToolCall } from "./tool-call";
import { FloatingComputerUse } from "../computer-use-preview";
import { computerUseTopInset } from "@/lib/computer-use";
import type { TurnActivityState } from "@/lib/turn-activity";
import { TurnActivity } from "./turn-activity";

/** How near the top (in screens) the page of history before it is asked for. */
const EARLIER_SCREENS = 2;

/** History before what's shown, loaded a page at a time. */
export interface EarlierHistory {
  loading: boolean;
  /** Adds one page above; false when it couldn't. */
  load: () => Promise<boolean>;
}

/**
 * The top of what's loaded. Scrolling near it loads the page above; the row
 * itself does the same on a tap, so a load that didn't start or failed never
 * leaves the user stuck. One height in both states, so the rows below stay put.
 */
function EarlierRow({ loading, onPress }: { loading: boolean; onPress: () => void }) {
  return (
    <Pressable
      disabled={loading}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={loading ? "正在加载更早的消息" : "加载更早的消息"}
      style={{ height: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 }}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.tertiaryLabel} style={{ transform: [{ scale: 0.75 }], width: 13, height: 13 }} />
      ) : (
        <Icon sf="arrow.up" md="arrow_upward" size={12} color={colors.secondaryLabel} weight="medium" />
      )}
      <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{loading ? "正在加载更早的消息…" : "加载更早的消息"}</Text>
    </Pressable>
  );
}

export interface TimelineProps {
  items: TimelineItem[];
  computerPreview?: boolean;
  previewHeaderConsumed?: boolean;
  planId?: string;
  turnActive: boolean;
  activity?: TurnActivityState;
  composerInset: SharedValue<number>;
  keyboardOffset: number;
  onFailedMessage: (item: Extract<TimelineItem, { kind: "user" }>) => void;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  header?: React.ReactElement | null;
  /** Set while the session has history before `items` that isn't loaded. */
  earlier?: EarlierHistory;
  /** Start at, and stick to, the newest row (chat). Off for lists read from the top. */
  anchorEnd?: boolean;
  /** Push rows shorter than the screen down to the bottom, against a composer. Defaults to `anchorEnd`. */
  alignEnd?: boolean;
}

export const Timeline = forwardRef<LegendListRef, TimelineProps>(function Timeline(
  { items, computerPreview = false, previewHeaderConsumed = false, planId, turnActive, activity, composerInset, keyboardOffset, onFailedMessage, onScroll, header, earlier, anchorEnd = true, alignEnd = anchorEnd },
  ref,
) {
  const headerHeight = useHeaderHeight();
  const [previewInset, setPreviewInset] = useState<number | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  // Stick to the newest row. Row heights are estimated until drawn, so the
  // first jump to the end can land short on a long session; keep settling
  // there until the user scrolls away, and follow new rows while pinned.
  const list = useRef<LegendListRef>(null);
  useImperativeHandle(ref, () => list.current as LegendListRef, []);
  const pinned = useRef(anchorEnd);
  const dragging = useRef(false);
  const momentum = useRef(false);
  /** The last offset the scroll view reported, and when. */
  const reported = useRef({ y: 0, at: 0 });
  const restored = useRef(0);

  // A page of earlier history goes in above the rows on screen, which must
  // stay where they are. The list does that by itself while the page lands
  // well above the screen. Near the top it can't be left to it: after a fling
  // the list rubber-bands there (and the bounce ends at the top, now the new
  // page's), and the rows at the seam change (a tool call that began in the
  // earlier page moves up into it, runs of steps fold differently). So a
  // page that arrives while the list still coasts near its top waits for it to
  // stop, and a page that goes in while the list is still is held in place
  // here, by a row that is on screen before and after.
  const shown = useRef(items);
  const seams = useRef(new Set<string>());
  const overdue = useRef(false);
  const [, redraw] = useState(0);
  const added = items.length > 0 && shown.current.length > 0 && items[0]!.id !== shown.current[0]!.id;
  const state = added ? list.current?.getState() : undefined;
  const coasting = momentum.current && !!state && reported.current.y < state.scrollLength;
  if (!added || !coasting || overdue.current) {
    const first = added ? shown.current.find(visible) : undefined;
    if (first) seams.current.add(first.id);
    shown.current = items;
    overdue.current = false;
  }
  const waiting = shown.current !== items;
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      overdue.current = true;
      redraw((count) => count + 1);
    }, 1500);
    return () => clearTimeout(timer);
  }, [waiting]);
  const visibleItems = shown.current;
  const rows = useMemo(() => buildRows(visibleItems, Date.now(), open, seams.current, turnActive), [visibleItems, open, turnActive]);

  const toEnd = useCallback(() => {
    if (anchorEnd && pinned.current && !dragging.current && !momentum.current) {
      void list.current?.scrollToEnd({ animated: false });
    }
  }, [anchorEnd]);
  // Until that first settling is over, where the list is says nothing about where the user is.
  const settled = useRef(false);
  useEffect(() => {
    const timers = [60, 180, 400, 800, 1400].map((ms) => setTimeout(toEnd, ms));
    timers.push(setTimeout(() => (settled.current = true), 1500));
    return () => timers.forEach(clearTimeout);
  }, [toEnd]);

  // Only auto-scroll to end when the tail item changes or a turn starts — never
  // when toggling a StepsSummary ("运行 X 条命令") or prepending earlier history.
  const tailItem = visibleItems[visibleItems.length - 1];
  const lastId = tailItem?.id;
  const tailSignature = useMemo(() => {
    if (!tailItem) return "";
    if (tailItem.kind === "agent" || tailItem.kind === "thought") {
      return `${tailItem.id}:${tailItem.text.length}:${tailItem.streaming ? 1 : 0}`;
    }
    if (tailItem.kind === "tool") {
      return `${tailItem.id}:${tailItem.status}:${tailItem.output?.length ?? 0}`;
    }
    return `${tailItem.id}:${tailItem.kind}`;
  }, [tailItem]);
  const prevTailSignature = useRef(tailSignature);
  const prevTurnActive = useRef(turnActive);
  useEffect(() => {
    const tailChanged = tailSignature !== prevTailSignature.current;
    const turnStarted = turnActive && !prevTurnActive.current;
    prevTailSignature.current = tailSignature;
    prevTurnActive.current = turnActive;
    if (!tailChanged && !turnStarted) return;
    const frame = requestAnimationFrame(toEnd);
    return () => cancelAnimationFrame(frame);
  }, [tailSignature, turnActive, toEnd]);

  // Earlier history loads a page at a time as the user nears the top: early
  // enough that a page is usually in before they get there, and the next one
  // only once this one has landed and the top is still that close.
  const earlierRef = useRef(earlier);
  earlierRef.current = earlier;
  const fetching = useRef(false);
  // A page that didn't come: leave it to the row (or to scrolling away and back), not to a retry loop.
  const stalled = useRef(false);
  const nearStart = useCallback((screens: number) => {
    const state = list.current?.getState();
    return !!state && state.scroll < state.scrollLength * screens;
  }, []);
  const loadEarlier = useCallback(
    (asked = false) => {
      const current = earlierRef.current;
      if (!current || current.loading || fetching.current || !settled.current || (stalled.current && !asked)) return;
      fetching.current = true;
      void current.load().then((landed) => {
        stalled.current = !landed;
        const after = () => {
          // Still waiting out a bounce: look again once it's in.
          if (waitingRef.current) {
            setTimeout(after, 300);
            return;
          }
          fetching.current = false;
          if (landed && nearStart(EARLIER_SCREENS)) loadEarlier();
        };
        setTimeout(after, 400);
      });
    },
    [nearStart],
  );
  // What the session opens with can be shorter than the screen (a run of tool
  // calls folds into one line): once it has settled at the end, look once.
  const hasEarlier = !!earlier;
  useEffect(() => {
    if (!hasEarlier) return;
    const timer = setTimeout(() => {
      if (nearStart(1)) loadEarlier();
    }, 1600);
    return () => clearTimeout(timer);
  }, [hasEarlier, loadEarlier, nearStart]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement, contentInset } = event.nativeEvent;
      // Use the list's resolved inset: embedded conversations don't have a native header to clear.
      if (contentInset) setPreviewInset(Math.max(0, contentInset.top));
      const fromEnd = contentSize.height + (contentInset?.bottom ?? 0) - (contentOffset.y + layoutMeasurement.height);
      // Android: opening a menu (a Modal over the screen) throws the list to its
      // top, as it did before there was earlier history to load. Nobody scrolled:
      // put it back where it was.
      const before = reported.current;
      if (
        Platform.OS === "android" &&
        settled.current &&
        !dragging.current &&
        !momentum.current &&
        contentOffset.y <= 0 &&
        before.y > 40 &&
        Date.now() - restored.current > 500
      ) {
        restored.current = Date.now();
        void list.current?.scrollToOffset({ offset: before.y, animated: false });
        return;
      }
      reported.current = { y: contentOffset.y, at: Date.now() };
      if (fromEnd < 48) pinned.current = true;
      else if (dragging.current || momentum.current || settled.current) pinned.current = false;
      // Only as the user scrolls there: a page can't be held in place while the system animates to the top.
      if (contentOffset.y >= layoutMeasurement.height * EARLIER_SCREENS) stalled.current = false;
      else if (dragging.current || momentum.current) loadEarlier();
      onScroll?.(event);
    },
    [onScroll, loadEarlier],
  );
  // The user's scroll has come to rest: bring in a page that waited, and look whether the top is near.
  const onRest = useCallback(() => {
    if (waitingRef.current) redraw((count) => count + 1);
    if (nearStart(EARLIER_SCREENS)) loadEarlier();
  }, [loadEarlier, nearStart]);

  const renderItem = useCallback(
    ({ item: row }: { item: Row }) => {
      if (row.type === "time") {
        return (
          <View style={{ paddingTop: 22, paddingBottom: 2 }}>
            <TimeSeparator label={row.label} />
          </View>
        );
      }
      if (row.type === "steps") {
        return (
          <View style={{ paddingHorizontal: 16, paddingTop: row.gap }}>
            <StepsSummary steps={row.steps} open={row.open} onToggle={() => toggle(row.key)} />
          </View>
        );
      }
      const item = row.item;
      let content: React.ReactNode;
      switch (item.kind) {
        case "user":
          content = <UserMessage item={item} onFailedPress={onFailedMessage} />;
          break;
        case "agent":
          content = <AgentMessage item={item} last={row.last} />;
          break;
        case "thought":
          content = <Thought item={item} />;
          break;
        case "tool":
          content = <ToolCall item={item} />;
          break;
        case "plan":
          content = <PlanCard item={item} active={turnActive && item.id === planId} />;
          break;
        case "notice":
          content = <Notice item={item} live={turnActive && item.id === lastId} />;
          break;
        case "error":
          content = <ErrorCard item={item} />;
          break;
        case "turn-end":
          content = <TurnEnd item={item} />;
          break;
        case "driver":
          content = <DriverChange item={item} />;
          break;
        case "permission-result":
          content = <PermissionResult item={item} />;
          break;
      }
      // An opened fold's steps hang off it: indented under its glyph, along a rule, so it's clear where the run ends.
      if (row.nested) {
        return (
          <View style={{ paddingHorizontal: 16 }}>
            <View style={{ marginLeft: GLYPH / 2, paddingLeft: GLYPH / 2 + 4, paddingTop: row.gap, borderLeftWidth: 1.5, borderLeftColor: colors.separator }}>{content}</View>
          </View>
        );
      }
      return <View style={{ paddingHorizontal: 16, paddingTop: row.gap }}>{content}</View>;
    },
    [onFailedMessage, planId, turnActive, toggle, lastId],
  );

  return (
    <View style={{ flex: 1 }}>
    <KeyboardAwareLegendList
      ref={list}
      data={rows}
      keyExtractor={(row) => row.key}
      getItemType={(row) => (row.type === "item" ? row.item.kind : row.type)}
      renderItem={renderItem}
      extraData={turnActive}
      estimatedItemSize={56}
      alignItemsAtEnd={alignEnd}
      initialScrollAtEnd={anchorEnd}
      maintainScrollAtEnd={anchorEnd}
      maintainScrollAtEndThreshold={0.15}
      maintainVisibleContentPosition
      keyboardLiftBehavior="whenAtEnd"
      keyboardOffset={keyboardOffset}
      contentInsetEndAdjustment={composerInset}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 12 }}
      ListFooterComponent={activity ? <TurnActivity activity={activity} onLayout={toEnd} /> : null}
      ListHeaderComponent={
        earlier ? (
          <>
            {header}
            <EarlierRow
              loading={earlier.loading}
              onPress={() => {
                haptics.selection();
                loadEarlier(true);
              }}
            />
          </>
        ) : (
          header
        )
      }
      onScroll={handleScroll}
      onScrollBeginDrag={() => {
        dragging.current = true;
        momentum.current = false;
      }}
      onScrollEndDrag={() => {
        dragging.current = false;
        onRest();
      }}
      onMomentumScrollBegin={() => {
        momentum.current = true;
      }}
      onMomentumScrollEnd={() => {
        dragging.current = false;
        momentum.current = false;
        onRest();
      }}
      // iOS, after a tap on the status bar has brought the list to its top.
      onScrollToTop={() => loadEarlier()}
      scrollEventThrottle={32}
      style={{ flex: 1 }}
    />
    {computerPreview ? <FloatingComputerUse top={computerUseTopInset(Platform.OS, headerHeight, previewInset, previewHeaderConsumed)} /> : null}
    </View>
  );
});
