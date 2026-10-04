import { workflowIsLive, type TimelineItem } from "@linkshell/client-core";
import { clockTime } from "./format";

export type Step = Extract<TimelineItem, { kind: "tool" | "thought" }>;

export type Row =
  | { type: "item"; key: string; item: TimelineItem; gap: number; /** The agent's reply that ends its turn. */ last?: boolean }
  | { type: "steps"; key: string; steps: Step[]; open: boolean; gap: number }
  | { type: "time"; key: string; label: string };

/** Fewest finished steps in a row that fold into one summary line. */
const MIN_FOLD = 3;

const TIME_GAP = 15 * 60_000;

export function visible(item: TimelineItem): boolean {
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
  // Screenshots and generated images are results worth seeing, not plumbing.
  if (item.content.some((entry) => entry.type === "content" && entry.content.type === "image")) return false;
  if (item.detail?.type === "subagent" && item.detail.action === "spawn") {
    // A launch returning does not mean the background agent has finished.
    const workflow = item.detail.workflow;
    if (workflow) return !!workflow.state && !workflowIsLive(workflow);
    const state = item.detail.state;
    if (state) return state === "completed" || state === "failed" || state === "stopped";
    // Without an explicit outcome, keep the agent visible even if its launch returned.
    return false;
  }
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

export function buildRows(all: TimelineItem[], now: number, open: ReadonlySet<string>, seams: ReadonlySet<string>, turnActive: boolean): Row[] {
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
