import type { TimelineItem } from "@linkshell/client-core";
import type { LegendListRef } from "@legendapp/list/react-native";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { clockTime } from "@/lib/format";
import { AgentMessage, DriverChange, ErrorCard, Notice, PermissionResult, PlanCard, Thought, TimeSeparator, TurnEnd, UserMessage } from "./items";
import { StepsSummary, type Step } from "./steps";
import { ToolCall } from "./tool-call";

type Row =
  | { type: "item"; key: string; item: TimelineItem; gap: number }
  | { type: "steps"; key: string; steps: Step[]; open: boolean; gap: number }
  | { type: "time"; key: string; label: string };

/** Fewest finished steps in a row that fold into one summary line. */
const MIN_FOLD = 3;

const TIME_GAP = 15 * 60_000;

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

function buildRows(items: TimelineItem[], now: number, open: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  let previousKind: Rhythm | undefined;
  let previousTs = 0;
  let run: Step[] = [];

  const push = (item: TimelineItem) => {
    const rhythm = rhythmOf(item);
    rows.push({ type: "item", key: item.id, item, gap: gapBetween(previousKind, rhythm) });
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
    if (isStep(item)) {
      run.push(item);
      continue;
    }
    flush();
    if (item.kind === "user" && item.ts - previousTs > TIME_GAP) {
      rows.push({ type: "time", key: `time-${item.id}`, label: clockTime(item.ts, now) });
      previousKind = undefined;
    }
    push(item);
  }
  flush();
  return rows;
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
  /** Start at, and stick to, the newest row (chat). Off for lists read from the top. */
  anchorEnd?: boolean;
}

export const Timeline = forwardRef<LegendListRef, TimelineProps>(function Timeline(
  { items, planId, turnActive, composerInset, keyboardOffset, onFailedMessage, onScroll, header, anchorEnd = true },
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
  const rows = useMemo(() => buildRows(items, Date.now(), open), [items, open]);

  // Stick to the newest row. Row heights are estimated until drawn, so the
  // first jump to the end can land short on a long session; keep settling
  // there until the user scrolls away, and follow new rows while pinned.
  const list = useRef<LegendListRef>(null);
  useImperativeHandle(ref, () => list.current as LegendListRef, []);
  const pinned = useRef(anchorEnd);
  const dragging = useRef(false);
  const toEnd = useCallback(() => {
    if (anchorEnd && pinned.current && !dragging.current) void list.current?.scrollToEnd({ animated: false });
  }, [anchorEnd]);
  useEffect(() => {
    const timers = [60, 180, 400, 800, 1400].map((ms) => setTimeout(toEnd, ms));
    return () => timers.forEach(clearTimeout);
  }, [toEnd]);
  useEffect(() => {
    const frame = requestAnimationFrame(toEnd);
    return () => cancelAnimationFrame(frame);
  }, [rows, toEnd]);
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement, contentInset } = event.nativeEvent;
      const fromEnd = contentSize.height + (contentInset?.bottom ?? 0) - (contentOffset.y + layoutMeasurement.height);
      if (fromEnd < 48) pinned.current = true;
      else if (dragging.current) pinned.current = false;
      onScroll?.(event);
    },
    [onScroll],
  );

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
          content = <AgentMessage item={item} />;
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
      alignItemsAtEnd={anchorEnd}
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
      ListHeaderComponent={header}
      onScroll={handleScroll}
      onScrollBeginDrag={() => {
        dragging.current = true;
      }}
      onScrollEndDrag={() => {
        dragging.current = false;
      }}
      onMomentumScrollEnd={() => {
        dragging.current = false;
      }}
      scrollEventThrottle={32}
      style={{ flex: 1 }}
    />
  );
});
