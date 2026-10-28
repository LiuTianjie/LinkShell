export { toolVerb, cleanToolTitle, tidyCommand, activityText, permissionChoices, sessionTitle, plainPreview, needsUserInput, needsAttention, type PermissionChoice } from "@linkshell/wire";
import type { ToolCallContent, ToolKind } from "@linkshell/wire";
import { changeStat, toolCommand, toolLabel, toolLabelParts, type TimelineItem, type ToolAction } from "@linkshell/client-core";
import type { IconProps } from "@/components/icon";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
type Glyph = Pick<IconProps, "sf" | "md">;

export const toolGlyph: Record<ToolKind, Glyph> = {
  read: { sf: "doc.text", md: "description" },
  edit: { sf: "pencil", md: "edit" },
  delete: { sf: "trash", md: "delete" },
  move: { sf: "arrow.right.doc.on.clipboard", md: "drive_file_move" },
  search: { sf: "magnifyingglass", md: "search" },
  execute: { sf: "terminal", md: "terminal" },
  think: { sf: "brain", md: "psychology" },
  fetch: { sf: "globe", md: "language" },
  switch_mode: { sf: "slider.horizontal.3", md: "tune" },
  other: { sf: "wrench.and.screwdriver", md: "build" },
};

export function commandOf(item: Pick<ToolItem, "rawInput" | "title">): string | undefined {
  return toolCommand(item);
}

export interface FileChange {
  path: string;
  kind: "add" | "delete" | "update";
  added: number;
  removed: number;
  /** Unified diff lines, without file headers. */
  lines: string[];
}

function lineDiff(oldText: string, newText: string): string[] {
  // Small, dependency-free line diff (LCS) — good for the edits agents make.
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length * b.length > 250_000) return [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)];
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`-${a[i++]}`);
    } else {
      out.push(`+${b[j++]}`);
    }
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return trimContext(out);
}

/** Keeps three lines of context around changes, like `diff -U3`. */
function trimContext(lines: string[]): string[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line[0] === "+" || line[0] === "-") {
      for (let k = Math.max(0, index - 3); k <= Math.min(lines.length - 1, index + 3); k++) keep[k] = true;
    }
  });
  const out: string[] = [];
  let skipped = false;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped && out.length) out.push("@@");
      skipped = false;
      out.push(line);
    } else {
      skipped = true;
    }
  });
  return out;
}

export function fileChanges(content: ToolCallContent[]): FileChange[] {
  const changes: FileChange[] = [];
  for (const entry of content) {
    if (entry.type === "diff") {
      const lines = lineDiff(entry.oldText ?? "", entry.newText);
      // Counted by the shared diff, so the numbers are the ones the computer shows.
      const stat = changeStat(entry);
      changes.push({ path: entry.path, kind: entry.oldText == null ? "add" : "update", added: stat.added, removed: stat.removed, lines });
    } else if (entry.type === "patch") {
      const lines = entry.diff
        .split("\n")
        .filter((line) => !line.startsWith("---") && !line.startsWith("+++") && !line.startsWith("diff --git") && !line.startsWith("index "))
        .map((line) => (line.startsWith("@@") ? "@@" : line));
      const stat = changeStat(entry);
      changes.push({
        path: entry.movePath ?? entry.path,
        kind: entry.change,
        added: stat.added,
        removed: stat.removed,
        lines: lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines,
      });
    }
  }
  return changes;
}

export interface ToolDescription {
  /** The verb with what follows it ("已读取 ", "已搜索网页："), as the computer words it. */
  verb: string;
  /** The object of the verb: a file name, command or query. */
  subject: string;
  /** "（失败）", "（已停止）": how it ended, when not well. */
  suffix?: string;
  /** Show `subject` in the monospace face. */
  code: boolean;
  glyph: Glyph;
  changes: FileChange[];
  /** Said after the row: "12 处匹配", "用时 3 秒". */
  note?: string;
}

const actionGlyph: Partial<Record<ToolAction, Glyph>> = {
  list: { sf: "folder", md: "folder" },
  find: { sf: "doc.text.magnifyingglass", md: "find_in_page" },
  create: { sf: "doc.badge.plus", md: "note_add" },
  memory: { sf: "brain", md: "psychology" },
  web_search: { sf: "globe", md: "travel_explore" },
  agent: { sf: "square.stack.3d.up", md: "layers" },
  workflow: { sf: "square.stack.3d.up", md: "layers" },
  agent_message: { sf: "square.stack.3d.up", md: "layers" },
  agent_wait: { sf: "square.stack.3d.up", md: "layers" },
  agent_stop: { sf: "square.stack.3d.up", md: "layers" },
  agent_resume: { sf: "square.stack.3d.up", md: "layers" },
  agent_list: { sf: "square.stack.3d.up", md: "layers" },
  skill: { sf: "wand.and.stars", md: "auto_fix_high" },
  mcp: { sf: "puzzlepiece.extension", md: "extension" },
  todo: { sf: "checklist", md: "checklist" },
  plan: { sf: "list.bullet.rectangle", md: "assignment" },
  question: { sf: "questionmark.bubble", md: "help" },
  send_file: { sf: "paperplane", md: "send" },
  image: { sf: "photo", md: "image" },
  review: { sf: "eye", md: "rate_review" },
  start_session: { sf: "plus.bubble", md: "add_comment" },
  session_message: { sf: "bubble.left.and.bubble.right", md: "forum" },
  compaction: { sf: "arrow.down.right.and.arrow.up.left", md: "compress" },
};

/** A call's row as the computer words it (`toolLabel`, shared by every client). */
export function describeTool(item: ToolItem): ToolDescription {
  const label = toolLabel(item);
  const parts = toolLabelParts(label);
  const automation = item.detail?.type === "mcp" && (item.detail.server === "codex_app" || item.detail.server === "codex_apps") && item.detail.tool === "automation_update";
  return {
    verb: parts.verb,
    subject: parts.subject ?? "",
    suffix: parts.suffix,
    code: label.style === "code",
    glyph: automation ? { sf: "clock.arrow.circlepath", md: "schedule" } : actionGlyph[label.action] ?? toolGlyph[item.toolKind],
    changes: fileChanges(item.content),
    note: label.note,
  };
}
