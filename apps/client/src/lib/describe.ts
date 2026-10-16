import { toolVerb, cleanToolTitle, tidyCommand } from "@linkshell/wire";
export { toolVerb, cleanToolTitle, tidyCommand, activityText, permissionChoices, sessionTitle, plainPreview, needsUserInput, needsAttention, type PermissionChoice } from "@linkshell/wire";
import type { ToolCallContent, ToolDetail, ToolKind } from "@linkshell/wire";
import type { TimelineItem } from "@linkshell/client-core";
import type { IconProps } from "@/components/icon";
import { baseName } from "./format";

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

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function commandOf(item: Pick<ToolItem, "rawInput" | "title">): string | undefined {
  const input = record(item.rawInput);
  const command = input.command ?? input.cmd;
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === "string");
    // ["bash", "-lc", "npm test"] → "npm test"
    if (parts.length === 3 && /(^|\/)(ba|z|)sh$/.test(parts[0]!) && parts[1]!.startsWith("-")) return parts[2];
    return parts.join(" ");
  }
  return str(command);
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
      changes.push({
        path: entry.path,
        kind: entry.oldText == null ? "add" : "update",
        added: lines.filter((l) => l[0] === "+").length,
        removed: lines.filter((l) => l[0] === "-").length,
        lines,
      });
    } else if (entry.type === "patch") {
      const lines = entry.diff
        .split("\n")
        .filter((line) => !line.startsWith("---") && !line.startsWith("+++") && !line.startsWith("diff --git") && !line.startsWith("index "))
        .map((line) => (line.startsWith("@@") ? "@@" : line));
      changes.push({
        path: entry.movePath ?? entry.path,
        kind: entry.change,
        added: lines.filter((l) => l[0] === "+").length,
        removed: lines.filter((l) => l[0] === "-").length,
        lines: lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines,
      });
    }
  }
  return changes;
}

export interface ToolDescription {
  verb: string;
  /** The object of the verb: a file name, command or query. */
  subject: string;
  /** Show `subject` in the monospace face. */
  code: boolean;
  glyph: Glyph;
  changes: FileChange[];
}

export function describeTool(item: ToolItem): ToolDescription {
  const glyph = toolGlyph[item.toolKind];
  const changes = fileChanges(item.content);
  const input = record(item.rawInput);
  // Richer detail when the host knows it; the same for every agent.
  if (item.detail) return describeDetail(item.detail, changes, input);
  switch (item.toolKind) {
    case "execute": {
      const command = tidyCommand(commandOf(item) ?? cleanToolTitle(item.title));
      return { verb: "运行", subject: command, code: true, glyph, changes };
    }
    case "edit":
    case "delete":
    case "move": {
      const path = changes[0]?.path ?? str(input.file_path) ?? str(input.path) ?? item.locations?.[0]?.path;
      const verb = changes[0]?.kind === "add" ? "创建" : changes[0]?.kind === "delete" ? "删除" : toolVerb[item.toolKind];
      const subject = changes.length > 1 ? `${changes.length} 个文件` : path ? baseName(path) : cleanToolTitle(item.title);
      return { verb, subject, code: false, glyph, changes };
    }
    case "read": {
      const path = str(input.file_path) ?? str(input.path) ?? item.locations?.[0]?.path;
      return { verb: "读取", subject: path ? baseName(path) : cleanToolTitle(item.title), code: false, glyph, changes };
    }
    case "search": {
      const query = str(input.pattern) ?? str(input.query);
      return { verb: "搜索", subject: query ? `“${query}”` : cleanToolTitle(item.title), code: false, glyph, changes };
    }
    case "fetch": {
      const url = str(input.url);
      return { verb: "获取", subject: url ? url.replace(/^https?:\/\//, "") : cleanToolTitle(item.title), code: false, glyph, changes };
    }
    default:
      return { verb: item.toolKind === "think" ? "思考" : "", subject: item.title, code: false, glyph, changes };
  }
}

const subagentVerb: Record<Extract<ToolDetail, { type: "subagent" }>["action"], string> = {
  spawn: "子 Agent",
  message: "发给子 Agent",
  wait: "等待子 Agent",
  stop: "停止子 Agent",
  resume: "恢复子 Agent",
  list: "查看子 Agent",
};

function describeDetail(detail: ToolDetail, changes: FileChange[], input: Record<string, unknown> = {}): ToolDescription {
  switch (detail.type) {
    case "mcp": {
      if ((detail.server === "codex_app" || detail.server === "codex_apps") && detail.tool === "automation_update") {
        const mode = str(input.mode);
        const status = str(input.status);
        const verb =
          mode === "create"
            ? "创建定时任务"
            : mode === "delete"
              ? "删除定时任务"
              : mode === "view"
                ? "查看定时任务"
                : status === "PAUSED"
                  ? "暂停定时任务"
                  : status === "ACTIVE"
                    ? "启用定时任务"
                    : "更新定时任务";
        const subject = str(input.name) ?? str(input.id) ?? "";
        return { verb, subject, code: false, glyph: { sf: "clock.arrow.circlepath", md: "schedule" }, changes };
      }
      return { verb: detail.server.replace(/[_-]/g, " "), subject: detail.tool.replace(/_/g, " "), code: false, glyph: { sf: "puzzlepiece.extension", md: "extension" }, changes };
    }
    case "subagent":
      return { verb: detail.workflow ? "工作流" : subagentVerb[detail.action], subject: detail.task ?? "", code: false, glyph: { sf: "square.stack.3d.up", md: "layers" }, changes };
    case "skill":
      return { verb: "使用技能", subject: detail.name, code: false, glyph: { sf: "wand.and.stars", md: "auto_fix_high" }, changes };
    case "web_search":
      return { verb: "搜索网页", subject: detail.query ? `“${detail.query}”` : "", code: false, glyph: { sf: "globe", md: "travel_explore" }, changes };
    case "image_generation":
      return { verb: "生成图片", subject: detail.prompt ?? "", code: false, glyph: { sf: "photo", md: "image" }, changes };
    case "compaction":
      return { verb: "", subject: "压缩了上下文", code: false, glyph: { sf: "arrow.down.right.and.arrow.up.left", md: "compress" }, changes };
    case "question":
      return { verb: "提问", subject: detail.more ? `${detail.text}（还有 ${detail.more} 个）` : detail.text, code: false, glyph: { sf: "questionmark.bubble", md: "help" }, changes };
    case "review":
      return { verb: "", subject: detail.phase === "started" ? "开始代码审查" : "代码审查完成", code: false, glyph: { sf: "eye", md: "rate_review" }, changes };
  }
}
