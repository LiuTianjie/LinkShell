import type { SessionView, TimelineItem } from "./timeline.js";
import { headingOf, isHiddenTool, runningText } from "./tool-labels.js";
import { isMarker } from "./steps.js";

/**
 * The live row under a running turn, as the Claude desktop app has it: what the agent is doing
 * right now (the call it runs, "思考中…", or that it waits for the person), and how long the turn
 * has taken so far.
 */
export interface LiveActivity {
  label: string;
  /** The agent waits for the person (a permission or a question). */
  waiting: boolean;
  /** When the turn started, when the view knows. */
  startedAt?: number;
}

/** Elapsed time is shown from this on: a turn that just began needs no clock. */
export const ELAPSED_FROM = 2000;

/** A thought's own title (Codex starts its reasoning summaries with one in bold). */
export function thoughtTitle(text: string): string | undefined {
  const title = headingOf(text);
  return title && title.length <= 80 ? title : undefined;
}

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

function running(item: TimelineItem): ToolItem | undefined {
  return item.kind === "tool" && (item.status === "in_progress" || item.status === "pending") && !isHiddenTool(item) && !isMarker(item) ? item : undefined;
}

export function liveActivity(view: Pick<SessionView, "items" | "permissions" | "turnStartedAt" | "turnBreaks">): LiveActivity {
  const startedAt = view.turnStartedAt;
  if (view.permissions.length) return { label: "需要您的输入", waiting: true, startedAt };
  const items = view.items;
  // The running turn's items: back to where the last one ended. A message sent while the agent
  // works is part of the turn, not its start.
  const ended = view.turnBreaks?.at(-1);
  const inTurn = (item: TimelineItem) => item.id !== ended;
  for (let at = items.length - 1; at >= 0 && inTurn(items[at]!); at--) {
    const item = items[at]!;
    if (item.kind === "user") continue;
    if (item.kind === "thought") {
      if (!item.streaming) break;
      return { label: thoughtTitle(item.text) ?? "思考中…", waiting: false, startedAt };
    }
    if (item.kind === "agent") {
      if (item.streaming) return { label: "正在回复", waiting: false, startedAt };
      break;
    }
    const call = running(item);
    if (call) return { label: runningText(call), waiting: false, startedAt };
    // Calls the agent made together finish one by one: one still running is what it waits for.
    if (item.kind === "tool") {
      for (let back = at - 1; back >= 0 && inTurn(items[back]!); back--) {
        const earlier = running(items[back]!);
        if (earlier) return { label: runningText(earlier), waiting: false, startedAt };
      }
      break;
    }
  }
  return { label: "思考中…", waiting: false, startedAt };
}
