import type { TimelineItem } from "./timeline.js";
import { changeStat } from "./line-diff.js";
import { changedPaths, fileName, isHiddenTool, toolAction, toolOutcome, toolPath, type ToolAction } from "./tool-labels.js";
import { workflowIsLive } from "./workflows.js";

/**
 * Folding the agent's working steps.
 *
 * The Claude desktop app (our model for every agent) doesn't show every tool call as its own
 * block: the calls between two messages collapse to one sentence ("已编辑 2 个文件，已运行 11 个
 * 命令，已读取 3 个文件，以及另外 3 项操作"), one click from the detail. Messages, calls still
 * running, pictures, cards and dividers break the run and render in full. This module is the
 * platform-agnostic half of that: the mobile and web timelines share these rules; each renders
 * the rows its own way.
 */

/** A finished tool call or thought: the agent's work between messages. */
export type Step = Extract<TimelineItem, { kind: "tool" | "thought" }>;

/** Fewest finished steps in a row that fold into one summary line: one alone stays a plain row. */
export const MIN_FOLD = 2;

/** Parts of the summary sentence, one per kind of work. */
type PartKind =
  | "read" | "create" | "edit" | "command" | "search" | "find" | "web_search" | "fetch"
  | "agent" | "todo" | "plan" | "memory" | "session" | "message" | "tool";

const PART_OF: Partial<Record<ToolAction, PartKind>> = {
  read: "read",
  list: "find",
  create: "create",
  edit: "edit",
  delete: "edit",
  move: "edit",
  memory: "memory",
  command: "command",
  search: "search",
  find: "find",
  web_search: "web_search",
  fetch: "fetch",
  agent: "agent",
  workflow: "agent",
  todo: "todo",
  update_plan: "todo",
  plan: "plan",
  start_session: "session",
  session_message: "message",
};

/** Kinds that are about files: when they all touched one file, the sentence names it. */
const FILE_PARTS: PartKind[] = ["read", "create", "edit"];
const FILE_VERBS: Partial<Record<PartKind, string>> = { read: "读取", create: "创建", edit: "编辑" };

interface Part {
  kind: PartKind;
  /** What it counts, deduplicated (a file read twice is one file). */
  keys: Set<string>;
  /** The steps it covers. */
  steps: number;
  /** Where in the run it first appeared. */
  first: number;
}

export interface StepTally {
  parts: Part[];
  thoughts: number;
  steps: number;
  failed: number;
  /** Interrupted or declined. */
  stopped: number;
  added: number;
  removed: number;
  /** The one file every file step touched, when there was exactly one. */
  file?: string;
}

function keyOf(step: Extract<Step, { kind: "tool" }>, kind: PartKind): string[] {
  switch (kind) {
    case "read":
    case "create":
    case "edit":
    case "memory": {
      const paths = changedPaths(step);
      if (paths.length) return paths;
      const path = toolPath(step);
      return [path ?? step.id];
    }
    case "fetch": {
      const url = (step.rawInput as { url?: unknown } | undefined)?.url;
      return [typeof url === "string" ? url : step.id];
    }
    case "message": {
      const to = (step.rawInput as { session_id?: unknown } | undefined)?.session_id;
      return [typeof to === "string" ? to : step.id];
    }
    default:
      return [step.id];
  }
}

export function tallySteps(steps: Step[]): StepTally {
  const parts = new Map<PartKind, Part>();
  const t: StepTally = { parts: [], thoughts: 0, steps: steps.length, failed: 0, stopped: 0, added: 0, removed: 0 };
  steps.forEach((step, index) => {
    if (step.kind === "thought") {
      t.thoughts += 1;
      return;
    }
    const outcome = toolOutcome(step);
    const subagent = step.detail?.type === "subagent" && step.detail.action === "spawn" ? step.detail : undefined;
    const failed = subagent
      ? (subagent.workflow?.state ?? subagent.state) === "failed" || step.status === "failed" || !!subagent.workflow?.agents?.some((agent) => agent.state === "failed")
      : outcome === "failed";
    if (failed) t.failed += 1;
    else if (outcome === "declined" || outcome === "stopped" || (subagent && (subagent.workflow?.state ?? subagent.state) === "stopped")) t.stopped += 1;
    const kind = PART_OF[toolAction(step)] ?? "tool";
    const part = parts.get(kind) ?? { kind, keys: new Set<string>(), steps: 0, first: index };
    for (const key of keyOf(step, kind)) part.keys.add(key);
    part.steps += 1;
    parts.set(kind, part);
    for (const entry of step.content) {
      if (entry.type !== "diff" && entry.type !== "patch") continue;
      const stat = changeStat(entry);
      t.added += stat.added;
      t.removed += stat.removed;
    }
  });
  // Unclassified work goes last; everything else in the order it first happened.
  t.parts = [...parts.values()].sort((a, b) => (a.kind === "tool" ? 1 : 0) - (b.kind === "tool" ? 1 : 0) || a.first - b.first);
  const files = new Set(t.parts.filter((part) => FILE_PARTS.includes(part.kind)).flatMap((part) => [...part.keys]));
  const fileSteps = steps.filter((step): step is Extract<Step, { kind: "tool" }> => step.kind === "tool" && FILE_PARTS.includes(PART_OF[toolAction(step)] ?? "tool"));
  // Only a file every step named for certain: a step without a path is keyed by its own id.
  if (files.size === 1 && fileSteps.every((step) => !!toolPath(step) || changedPaths(step).length > 0)) t.file = [...files][0];
  return t;
}

/** How much work a part stands for: what it counts, or its steps where it counts nothing. */
function amount(part: Part): number {
  return part.kind === "search" || part.kind === "find" || part.kind === "todo" || part.kind === "plan" ? part.steps : part.keys.size;
}

function phrase(part: Part): string {
  const n = amount(part);
  switch (part.kind) {
    case "read":
      return `已读取 ${n} 个文件`;
    case "create":
      return `已创建 ${n} 个文件`;
    case "edit":
      return `已编辑 ${n} 个文件`;
    case "command":
      return `已运行 ${n} 个命令`;
    case "search":
      return "已搜索代码";
    case "find":
      return "已搜索文件";
    case "web_search":
      return part.steps > 1 ? `已搜索网页 ${part.steps} 次` : "已搜索网页";
    case "fetch":
      return `已获取 ${n} 个页面`;
    case "agent":
      return `已运行 ${n} 个智能体`;
    case "todo":
      return "已更新待办事项";
    case "plan":
      return "提出了一个计划";
    case "memory":
      return `已保存 ${n} 条记忆`;
    case "session":
      return `已启动 ${n} 个会话`;
    case "message":
      return `发送消息给另外 ${n} 个会话`;
    case "tool":
      return `已使用 ${n} 个工具`;
  }
}

/** Most parts shown before the rest are counted as "以及另外 N 项操作". */
const SHOWN_PARTS = 3;

/**
 * "已编辑 2 个文件，已运行 11 个命令，已读取 3 个文件，以及另外 3 项操作": each kind of work in
 * the order it first happened, unclassified last. Five parts or more show the first three.
 */
export function describeSteps(t: StepTally): string {
  const sentence: { text: string; amount: number }[] = [];
  let merged = false;
  for (const part of t.parts) {
    if (t.file && FILE_PARTS.includes(part.kind)) {
      // Everything done to files was done to one: "已编辑并读取 foo.ts".
      if (merged) continue;
      merged = true;
      const verbs = t.parts.filter((other) => FILE_PARTS.includes(other.kind)).map((other) => FILE_VERBS[other.kind]!);
      sentence.push({ text: `已${verbs.join("并")} ${fileName(t.file)}`, amount: 1 });
      continue;
    }
    sentence.push({ text: phrase(part), amount: amount(part) });
  }
  if (sentence.length === 0) return t.thoughts ? `已思考 ${t.thoughts} 次` : `${t.steps} 个步骤`;
  if (sentence.length < SHOWN_PARTS + 2) return sentence.map((part) => part.text).join("，");
  const rest = sentence.slice(SHOWN_PARTS).reduce((sum, part) => sum + part.amount, 0);
  return [...sentence.slice(0, SHOWN_PARTS).map((part) => part.text), `以及另外 ${rest} 项操作`].join("，");
}

/** "（2 项失败）", "（1 项已停止）", both, or nothing. */
export function describeFailures(t: StepTally): string | undefined {
  const said = [t.failed ? `${t.failed} 项失败` : "", t.stopped ? `${t.stopped} 项已停止` : ""].filter(Boolean);
  return said.length ? `（${said.join("，")}）` : undefined;
}

/** A sub-agent's call is done when its agent is: the launch returning doesn't say so. */
function agentFinished(item: Extract<TimelineItem, { kind: "tool" }>): boolean {
  const detail = item.detail;
  if (detail?.type !== "subagent" || detail.action !== "spawn") return true;
  const workflow = detail.workflow;
  if (workflow) return !!workflow.state && !workflowIsLive(workflow);
  const state = detail.state;
  if (state) return state === "completed" || state === "failed" || state === "stopped";
  // Without a reported outcome the agent stays in view: a launch returning (Codex, a background
  // Claude agent) doesn't mean the agent is done.
  return false;
}

/**
 * Items the conversation doesn't draw. The agent's thinking: the Claude app shows it only when
 * asked to and Codex never does; while the agent thinks, the live row under the turn says so (and
 * gives the thought's title). And calls whose card already shows what they did (the plan's).
 */
export function isHiddenItem(item: TimelineItem): boolean {
  return item.kind === "thought" || isHiddenTool(item) || isBareEnd(item);
}

/**
 * The end of a call whose beginning is in a page not loaded yet (a background task finishing long
 * after it started): nothing to show until that page is, when the two become one call again.
 */
function isBareEnd(item: TimelineItem): boolean {
  return item.kind === "tool" && item.title === "Tool" && !item.detail && item.content.length === 0 && !item.output && !item.sub && item.status !== "in_progress";
}

/** Items that stand apart from the work: dividers and cards that close a turn. */
export function isMarker(item: TimelineItem): boolean {
  if (item.kind !== "tool") return false;
  const action = toolAction(item);
  return action === "compaction" || action === "chapter" || action === "wrap_up";
}

/** Finished tool calls and thoughts that fold; messages, live work, markers and pictures don't. */
export function isStep(item: TimelineItem): item is Step {
  if (item.kind === "thought") return !item.streaming;
  if (item.kind !== "tool") return false;
  if (isMarker(item)) return false;
  // Screenshots and generated images are results worth seeing, not plumbing.
  if (item.content.some((entry) => entry.type === "content" && entry.content.type === "image")) return false;
  if (item.detail?.type === "subagent" && item.detail.action === "spawn") return agentFinished(item);
  return item.status === "completed" || item.status === "failed";
}

export type StepRow =
  | { type: "item"; item: TimelineItem }
  | { type: "steps"; key: string; steps: Step[] };

/**
 * Fold runs of ≥ MIN_FOLD consecutive finished steps into one `steps` row;
 * everything else, and shorter runs, stay as `item` rows in order. A run that
 * is still open (its summary key is in `open`) is emitted as the summary plus
 * its individual steps, so the detail shows in place. Items with no row of
 * their own (`isHiddenItem`) are left out and don't break a run.
 */
export function foldStepRuns(items: TimelineItem[], open: ReadonlySet<string>): StepRow[] {
  const rows: StepRow[] = [];
  let run: Step[] = [];
  const flush = () => {
    if (run.length >= MIN_FOLD) {
      const key = `steps-${run[0]!.id}`;
      rows.push({ type: "steps", key, steps: run });
      if (open.has(key)) for (const step of run) rows.push({ type: "item", item: step });
    } else {
      for (const step of run) rows.push({ type: "item", item: step });
    }
    run = [];
  };
  for (const item of items) {
    if (isHiddenItem(item)) continue;
    if (isStep(item)) {
      run.push(item);
      continue;
    }
    flush();
    rows.push({ type: "item", item });
  }
  flush();
  return rows;
}
