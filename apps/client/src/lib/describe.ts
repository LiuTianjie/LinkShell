import { unwrapShellCommand } from "@linkshell/wire";
import type { PermissionOption, SessionActivity, SessionSummary, ToolCallContent, ToolDetail, ToolKind } from "@linkshell/wire";
import type { TimelineItem } from "@linkshell/client-core";
import type { IconProps } from "@/components/icon";
import { baseName } from "./format";

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
type Glyph = Pick<IconProps, "sf" | "md">;

export const toolVerb: Record<ToolKind, string> = {
  read: "读取",
  edit: "编辑",
  delete: "删除",
  move: "移动",
  search: "搜索",
  execute: "运行",
  think: "思考",
  fetch: "获取",
  other: "",
};

export const toolGlyph: Record<ToolKind, Glyph> = {
  read: { sf: "doc.text", md: "description" },
  edit: { sf: "pencil", md: "edit" },
  delete: { sf: "trash", md: "delete" },
  move: { sf: "arrow.right.doc.on.clipboard", md: "drive_file_move" },
  search: { sf: "magnifyingglass", md: "search" },
  execute: { sf: "terminal", md: "terminal" },
  think: { sf: "brain", md: "psychology" },
  fetch: { sf: "globe", md: "language" },
  other: { sf: "wrench.and.screwdriver", md: "build" },
};

const ENGLISH_VERB = /^(read|reading|edit|editing|write|writing|update|create|delete|search|searching|list|run|running|fetch|grep|glob|find|view|open)\b[:\s]+/i;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Drops the agent's own English verb and wrapping backticks from a tool title. */
export function cleanToolTitle(title: string): string {
  return title.replace(ENGLISH_VERB, "").replace(/^`(.+)`$/s, "$1").trim();
}

/** Drops the shell wrapper and environment prefixes agents put around a command. */
export function tidyCommand(command: string): string {
  let text = unwrapShellCommand(command).trim();
  // "export TZ=…;", "TZ=… cmd", "cd dir &&" are noise on a phone.
  for (;;) {
    const next = text
      .replace(/^export\s+\w+=(?:'[^']*'|"[^"]*"|\S*)\s*(?:;|&&|\n)\s*/, "")
      .replace(/^\w+=(?:'[^']*'|"[^"]*"|\S+)\s+(?=\S)/, "");
    if (next === text) break;
    text = next;
  }
  return text || command;
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
  if (item.detail) return describeDetail(item.detail, changes);
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

function describeDetail(detail: ToolDetail, changes: FileChange[]): ToolDescription {
  switch (detail.type) {
    case "mcp":
      return { verb: detail.server.replace(/[_-]/g, " "), subject: detail.tool.replace(/_/g, " "), code: false, glyph: { sf: "puzzlepiece.extension", md: "extension" }, changes };
    case "subagent":
      return { verb: subagentVerb[detail.action], subject: detail.task ?? "", code: false, glyph: { sf: "square.stack.3d.up", md: "layers" }, changes };
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

export function activityText(activity: SessionActivity | undefined): string {
  if (!activity) return "正在运行…";
  if (activity.kind === "thinking") return "思考中…";
  if (activity.kind === "responding") return "正在回复…";
  const verb = activity.toolKind ? toolVerb[activity.toolKind] : "";
  const subject = activity.title ? (activity.toolKind === "execute" ? tidyCommand(cleanToolTitle(activity.title)) : cleanToolTitle(activity.title)) : "";
  return [verb, subject].filter(Boolean).join(" ") || "正在使用工具…";
}

export interface PermissionChoice {
  option: PermissionOption;
  label: string;
  role: "allow" | "always" | "reject" | "stop";
}

const choiceById: Record<string, { label: string; role: PermissionChoice["role"] }> = {
  accept: { label: "允许", role: "allow" },
  acceptForSession: { label: "本会话都允许", role: "always" },
  decline: { label: "拒绝", role: "reject" },
  cancel: { label: "拒绝并停止", role: "stop" },
  turn: { label: "本轮允许", role: "allow" },
  session: { label: "本会话都允许", role: "always" },
};

const choiceByKind: Record<PermissionOption["kind"], { label: string; role: PermissionChoice["role"] }> = {
  allow_once: { label: "允许", role: "allow" },
  allow_always: { label: "总是允许", role: "always" },
  reject_once: { label: "拒绝", role: "reject" },
  reject_always: { label: "总是拒绝", role: "stop" },
};

/** Localized permission choices, in the order: reject, allow, then the rest. */
export function permissionChoices(options: PermissionOption[]): PermissionChoice[] {
  const kinds = new Map<string, number>();
  for (const option of options) kinds.set(option.kind, (kinds.get(option.kind) ?? 0) + 1);
  const choices = options.map((option): PermissionChoice => {
    const known = choiceById[option.optionId];
    if (known) return { option, ...known };
    const byKind = choiceByKind[option.kind];
    // Two options of one kind: the agent's own names tell them apart.
    return { option, label: (kinds.get(option.kind) ?? 0) > 1 ? option.name : byKind.label, role: byKind.role };
  });
  const order: PermissionChoice["role"][] = ["reject", "allow", "always", "stop"];
  return choices.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
}

export function sessionTitle(session: Pick<SessionSummary, "title">): string {
  return session.title?.trim() || "新会话";
}

/** Markdown flattened to one line of plain text, for list previews. */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    // Previews arrive flattened: list bullets end up mid-line ("包括： - 一 - 二").
    .replace(/([：:。；;，,])\s*[-*•]\s+/g, "$1")
    .replace(/\s[-*•]\s+(?=\S)/g, " · ")
    .trim();
}
