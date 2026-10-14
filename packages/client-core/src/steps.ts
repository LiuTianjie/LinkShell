import type { ToolCallContent } from "@linkshell/wire";
import type { TimelineItem } from "./timeline.js";
import { workflowIsLive } from "./workflows.js";

/**
 * Folding the agent's working steps.
 *
 * Claude's and Codex's desktop clients don't show every tool call as its own
 * block: a run of finished steps between two messages collapses to one summary
 * line ("运行 5 条命令 · 读取 3 个文件 · 修改 2 个文件"), one click from the
 * detail. Messages, in-progress calls, images and sub-agent cards break the run
 * and render in full. This module is the platform-agnostic half of that — the
 * mobile and web timelines share these rules; each renders the rows its own way.
 */

/** A finished tool call or thought: the agent's work between messages. */
export type Step = Extract<TimelineItem, { kind: "tool" | "thought" }>;

/** Fewest finished steps in a row that fold into one summary line. */
export const MIN_FOLD = 3;

export interface StepTally {
  commands: number;
  reads: number;
  files: Set<string>;
  searches: number;
  web: number;
  tools: number;
  thoughts: number;
  agents: number;
  workflows: number;
  failed: number;
  added: number;
  removed: number;
}

/** File-change counts from tool content — just the tallies the summary needs. */
function countChanges(content: ToolCallContent[]): { path: string; added: number; removed: number }[] {
  const changes: { path: string; added: number; removed: number }[] = [];
  for (const entry of content) {
    if (entry.type === "diff") {
      // Line-level counts are enough for a summary; a word diff isn't needed.
      const oldLines = entry.oldText ? entry.oldText.split("\n").length : 0;
      const newLines = entry.newText ? entry.newText.split("\n").length : 0;
      changes.push({
        path: entry.path,
        added: entry.oldText == null ? newLines : Math.max(0, newLines - oldLines),
        removed: entry.oldText == null ? 0 : Math.max(0, oldLines - newLines),
      });
    } else if (entry.type === "patch") {
      const lines = entry.diff.split("\n");
      changes.push({
        path: entry.movePath ?? entry.path,
        added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
        removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
      });
    }
  }
  return changes;
}

export function tallySteps(steps: Step[]): StepTally {
  const t: StepTally = { commands: 0, reads: 0, files: new Set(), searches: 0, web: 0, tools: 0, thoughts: 0, agents: 0, workflows: 0, failed: 0, added: 0, removed: 0 };
  for (const step of steps) {
    if (step.kind === "thought") {
      t.thoughts += 1;
      continue;
    }
    if (step.detail?.type === "subagent" && step.detail.action === "spawn") {
      if (step.detail.workflow) t.workflows += 1;
      else t.agents += 1;
      if ((step.detail.workflow?.state ?? step.detail.state) === "failed" || step.status === "failed" || step.detail.workflow?.agents?.some((agent) => agent.state === "failed")) t.failed += 1;
      continue;
    }
    if (step.status === "failed") t.failed += 1;
    const changes = countChanges(step.content);
    for (const change of changes) {
      t.files.add(change.path);
      t.added += change.added;
      t.removed += change.removed;
    }
    if (step.detail?.type === "web_search") t.web += 1;
    else if (step.detail) t.tools += 1;
    else if (step.toolKind === "execute") t.commands += 1;
    else if (step.toolKind === "read") t.reads += 1;
    else if (step.toolKind === "search") t.searches += 1;
    else if (step.toolKind === "fetch") t.web += 1;
    else if (step.toolKind === "think") t.thoughts += 1;
    else if (step.toolKind === "edit" || step.toolKind === "delete" || step.toolKind === "move") {
      // An edit that reported no diff still touched a file.
      if (changes.length === 0) t.files.add(step.id);
    } else t.tools += 1;
  }
  return t;
}

/** "修改 2 个文件 · 运行 5 条命令 · 读取 3 个文件", most telling first, up to three. */
export function describeSteps(t: StepTally): string {
  const parts: string[] = [];
  if (t.workflows) parts.push(`${t.workflows} 个工作流`);
  if (t.agents) parts.push(`${t.agents} 个子 Agent`);
  if (t.files.size) parts.push(`修改 ${t.files.size} 个文件`);
  if (t.commands) parts.push(`运行 ${t.commands} 条命令`);
  if (t.reads) parts.push(`读取 ${t.reads} 个文件`);
  if (t.searches) parts.push(`搜索 ${t.searches} 次`);
  if (t.web) parts.push(`查看 ${t.web} 个网页`);
  if (t.tools) parts.push(`调用 ${t.tools} 个工具`);
  // Thinking is the least telling; name it only when it's all there was.
  if (t.thoughts && parts.length === 0) parts.push(`思考 ${t.thoughts} 次`);
  return parts.slice(0, 3).join(" · ");
}

/** Finished tool calls and thoughts that fold; messages and live work don't. */
export function isStep(item: TimelineItem): item is Step {
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
    return false;
  }
  return item.status === "completed" || item.status === "failed";
}

export type StepRow =
  | { type: "item"; item: TimelineItem }
  | { type: "steps"; key: string; steps: Step[] };

/**
 * Fold runs of ≥ MIN_FOLD consecutive finished steps into one `steps` row;
 * everything else, and shorter runs, stay as `item` rows in order. A run that
 * is still open (its summary key is in `open`) is emitted as the summary plus
 * its individual steps, so the detail shows in place.
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
