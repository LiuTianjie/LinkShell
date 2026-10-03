import type { TimelineItem } from "@linkshell/client-core";
import type { LegendListRef } from "@legendapp/list/react-native";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { clockTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { colors } from "@/theme/colors";
import { type } from "@/theme/type";
import { Icon } from "../icon";
import { AgentMessage, DriverChange, ErrorCard, Notice, PermissionResult, PlanCard, Thought, TimeSeparator, TurnEnd, UserMessage } from "./items";
import { StepsSummary, type Step } from "./steps";
import { ToolCall } from "./tool-call";

type Row =
  | { type: "item"; key: string; item: TimelineItem; gap: number; /** The agent's reply that ends its turn. */ last?: boolean }
  | { type: "steps"; key: string; steps: Step[]; open: boolean; gap: number }
  | { type: "time"; key: string; label: string };

/** Fewest finished steps in a row that fold into one summary line. */
const MIN_FOLD = 3;

const TIME_GAP = 15 * 60_000;

/** How near the top (in screens) the page of history before it is asked for. */
const EARLIER_SCREENS = 2;

function visible(item: TimelineItem): boolean {
  if (item.kind === "agent") return item.text.trim().length > 0 || !!item.attachments?.length;
  // Codex often reports reasoning without a summary: nothing to show.
  if (item.kind === "thought") return item.streaming || item.text.trim().length > 0;
  if (item.kind === "turn-end") return item.stopReason !== "end_turn";
  return true;
}

type Rhythm = TimelineItem["kind"] | "card";

/** Sub-agent cards space like cards, not like one-line tool rows. */
function rhythmOf(item: TimelineItem): Rhythm {
  return item.kind === "tool" && item.detail?.type === "subagent" && item.detail.action === "spawn" ? "card" : item.kind;
}

/** Vertical rhythm: tool lines stack tightly, a new user turn gets air. */
function gapBetween(previous: Rhythm | undefined, next: Rhythm): number {
  if (!previous) return 8;
  if (next === "user") return 22;
  if (next === "card" || previous === "card") return 12;
  if (previous === "user") return 16;
  if (next === "tool" && previous === "tool") return 2;
  if (next === "tool" || previous === "tool") return 10;
  if (next === "permission-result" || previous === "permission-result") return 6;
  return 12;
}

/** Finished tool calls and thoughts: the agent's working steps between messages. */
function isStep(item: TimelineItem): item is Step {
  if (item.kind === "thought") return !item.streaming;
  if (item.kind !== "tool") return false;
  if (item.detail?.type === "subagent" && item.detail.action === "spawn") return false;
  // Screenshots and generated images are results worth seeing, not plumbing.
  if (item.content.some((entry) => entry.type === "content" && entry.content.type === "image")) return false;
  return item.status === "completed" || item.status === "failed";
}

/**
 * `seams`: items that were first in the list when a page of history went in
 * above them. Rows don't reach across one (a folded run of steps would take a
 * new key, a time label would go), so the rows the user is looking at there
 * stay the same rows and the list can hold them in place.
 */
/**
 * The end of a call whose beginning is in an earlier page, with nothing to it
 * but that it ended (a background task finishing long after it was started):
 * there is nothing to show until the page with the call is loaded.
 */
function bareEnd(item: TimelineItem): boolean {
  return item.kind === "tool" && item.title === "Tool" && !item.detail && item.content.length === 0 && !item.output && !item.sub && item.status !== "in_progress";
}

function buildRows(all: TimelineItem[], now: number, open: ReadonlySet<string>, seams: ReadonlySet<string>, turnActive: boolean): Row[] {
  const items = all.some(bareEnd) ? all.filter((item) => !bareEnd(item)) : all;
  const rows: Row[] = [];
  // The latest reply of the turn being read: it gets the reply actions when the turn ends.
  let reply: Extract<Row, { type: "item" }> | undefined;
  const endTurn = () => {
    if (reply) reply.last = true;
    reply = undefined;
  };
  let previousKind: Rhythm | undefined;
  let previousTs = 0;
  let run: Step[] = [];

  const push = (item: TimelineItem) => {
    const rhythm = rhythmOf(item);
    const row: Extract<Row, { type: "item" }> = { type: "item", key: item.id, item, gap: gapBetween(previousKind, rhythm) };
    rows.push(row);
    if (item.kind === "user") endTurn();
    else if (item.kind === "agent") reply = row;
    previousKind = rhythm;
    previousTs = item.ts;
  };
  const flush = () => {
    if (run.length >= MIN_FOLD) {
      const key = `steps-${run[0]!.id}`;
      const expanded = open.has(key);
      rows.push({ type: "steps", key, steps: run, open: expanded, gap: gapBetween(previousKind, "tool") });
      previousKind = "tool";
      previousTs = run[run.length - 1]!.ts;
      if (expanded) for (const step of run) push(step);
    } else {
      for (const step of run) push(step);
    }
    run = [];
  };

  for (const item of items) {
    if (!visible(item)) continue;
    const seam = seams.has(item.id);
    if (seam) flush();
    if (isStep(item)) {
      run.push(item);
      continue;
    }
    flush();
    if (item.kind === "user" && (seam || item.ts - previousTs > TIME_GAP)) {
      rows.push({ type: "time", key: `time-${item.id}`, label: clockTime(item.ts, now) });
      previousKind = undefined;
    }
    push(item);
  }
  flush();
  if (!turnActive) endTurn();
  return rows;
}

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
  planId?: string;
  turnActive: boolean;
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
  { items, planId, turnActive, composerInset, keyboardOffset, onFailedMessage, onScroll, header, earlier, anchorEnd = true, alignEnd = anchorEnd },
  ref,
) {
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
  const held = useRef<{ key: string; at: number; steady: boolean }[] | null>(null);
  const added = items.length > 0 && shown.current.length > 0 && items[0]!.id !== shown.current[0]!.id;
  const state = added ? list.current?.getState() : undefined;
  const coasting = momentum.current && !!state && reported.current.y < state.scrollLength;
  if (!added || !coasting || overdue.current) {
    const first = added ? shown.current.find(visible) : undefined;
    if (first) seams.current.add(first.id);
    held.current = null;
    if (state && !dragging.current && !momentum.current && !pinned.current) {
      held.current = [];
      for (let index = state.start; index <= state.end; index++) {
        const row = state.data[index] as Row | undefined;
        if (!row) continue;
        // Messages are never folded away or merged: the surest rows to go by.
        const steady = row.type === "item" && (row.item.kind === "user" || row.item.kind === "agent");
        held.current.push({ key: row.key, at: state.positionAtIndex(index) - state.scroll, steady });
      }
    }
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

  // The rows just above the screen are measured once they are drawn, and what
  // they turn out to measure moves the rows below: for some frames after such
  // a page, keep the row exactly where it was.
  const settling = useRef(0);
  useEffect(() => {
    const candidates = held.current;
    held.current = null;
    const state = list.current?.getState();
    if (!candidates || !state) return;
    const present = candidates.filter((row) => state.indexByKey(row.key) !== undefined);
    const row = present.find((candidate) => candidate.steady) ?? present[0];
    if (!row) return;
    let frames = 30;
    cancelAnimationFrame(settling.current);
    settling.current = requestAnimationFrame(function settle() {
      const now = list.current?.getState();
      const index = now?.indexByKey(row.key);
      if (!now || index === undefined || dragging.current || momentum.current) return;
      const drift = now.positionAtIndex(index) - now.scroll - row.at;
      if (Math.abs(drift) > 1) {
        pinned.current = false;
        void list.current?.scrollToOffset({ offset: now.scroll + drift, animated: false });
      }
      if (--frames > 0) settling.current = requestAnimationFrame(settle);
    });
  }, [rows]);
  useEffect(() => () => cancelAnimationFrame(settling.current), []);

  const toEnd = useCallback(() => {
    if (anchorEnd && pinned.current && !dragging.current) void list.current?.scrollToEnd({ animated: false });
  }, [anchorEnd]);
  // Until that first settling is over, where the list is says nothing about where the user is.
  const settled = useRef(false);
  useEffect(() => {
    const timers = [60, 180, 400, 800, 1400].map((ms) => setTimeout(toEnd, ms));
    timers.push(setTimeout(() => (settled.current = true), 1500));
    return () => timers.forEach(clearTimeout);
  }, [toEnd]);
  useEffect(() => {
    const frame = requestAnimationFrame(toEnd);
    return () => cancelAnimationFrame(frame);
  }, [rows, toEnd]);

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
  // The list moves the scroll view to hold its rows in place. A system
  // animation in flight (a tap on the status bar) can undo that move without
  // the list hearing of it, leaving its rows drawn where the view isn't.
  // Once at rest, put the view where the list has it.
  const hold = useCallback(() => {
    const state = list.current?.getState();
    if (!state || dragging.current || momentum.current || Date.now() - reported.current.at < 150) return;
    if (Math.abs(state.scroll - reported.current.y) > 2) void list.current?.scrollToOffset({ offset: state.scroll, animated: false });
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
          hold();
          if (landed && nearStart(EARLIER_SCREENS)) loadEarlier();
        };
        setTimeout(after, 400);
        setTimeout(hold, 1200);
      });
    },
    [hold, nearStart],
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
      else if (dragging.current) pinned.current = false;
      // Brought to the top without a drag (a tap on the status bar): not following the end any more.
      else if (settled.current && contentOffset.y < layoutMeasurement.height && fromEnd > layoutMeasurement.height) pinned.current = false;
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
          content = <Notice item={item} />;
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
      return <View style={{ paddingHorizontal: 16, paddingTop: row.gap }}>{content}</View>;
    },
    [onFailedMessage, planId, turnActive, toggle],
  );

  return (
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
  );
});
