import { cleanToolTitle, tidyCommand, type ToolCallContent } from "@linkshell/wire";
import type { TimelineItem } from "./timeline.js";

/**
 * How a tool call reads in the conversation, worded as the Claude desktop app words it (our model
 * for every agent): "已读取 foo.ts" when done, "正在读取 foo.ts" while it runs, "…（失败）" when
 * it failed. Built from the shared tool fields (`toolKind`, `detail`, `rawInput`, `title`,
 * `content`), so Claude, Codex and the ACP agents read alike; an agent's own tool name only
 * decides where the shared fields can't tell (Grep from Glob, Write from Edit).
 */

export type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

/** What a call did, finely enough to word it. */
export type ToolAction =
  | "read" | "list" | "create" | "edit" | "delete" | "move" | "memory"
  | "command" | "search" | "find" | "web_search" | "fetch"
  | "agent" | "workflow" | "agent_message" | "agent_wait" | "agent_stop" | "agent_resume" | "agent_list"
  | "skill" | "mcp" | "todo" | "plan" | "question" | "send_file" | "image" | "review" | "mode"
  | "start_session" | "session_message" | "wrap_up" | "chapter" | "update_plan" | "compaction"
  | "other";

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

export function fileName(path: string): string {
  const parts = path.replace(/^file:\/\//, "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The tool's own name: the agent's (`name`), or a Claude title that is just the name (calls of a
 * tool LinkShell has no wording for are titled with it).
 */
export function toolName(item: Pick<ToolItem, "name" | "title">): string | undefined {
  return item.name ?? (/^[A-Z][A-Za-z]+$/.test(item.title) ? item.title : undefined);
}

// Tool names agents share for the same things (Gemini, Antigravity and others call their file
// tools this way), for calls whose kind says only "other".
const READ_NAMES = /^(read_file|read_many_files|view_file|readfile|read)$/i;
const LIST_NAMES = /^(ls|list_dir|list_directory|listdir)$/i;
const FIND_NAMES = /^(glob|find_by_name|find_files|file_search)$/i;
const SEARCH_NAMES = /^(grep|grep_search|search_file_content|codebase_search)$/i;
const CREATE_NAMES = /^(write|write_file|write_to_file|create_file)$/i;
const EDIT_NAMES = /^(edit|multiedit|notebookedit|edit_file|replace|replace_file_content|multi_replace_file_content|str_replace|apply_patch)$/i;
const COMMAND_NAMES = /^(bash|shell|run_command|run_shell_command|exec_command)$/i;
const FETCH_NAMES = /^(webfetch|web_fetch|fetch|read_url_content)$/i;
const WEB_SEARCH_NAMES = /^(websearch|web_search|google_web_search|search_web)$/i;

/** Agents' own memory files (Claude's auto-memory, Codex's memories): saving one is remembering. */
const MEMORY_PATH = /\/\.(claude|codex)\/(.+\/)?memor(y|ies)\/[^/]+\.md$/;

/** The text a call returned (its output, else the text of its content, else a raw output's). */
export function toolOutput(item: ToolItem): string {
  if (item.output) return item.output;
  const said = item.content
    .map((entry) => (entry.type === "content" && entry.content.type === "text" ? entry.content.text : ""))
    .filter(Boolean)
    .join("\n");
  if (said) return said;
  const raw = item.rawOutput;
  if (typeof raw === "string") return raw;
  const fields = record(raw);
  for (const key of ["output", "stdout", "aggregatedOutput", "aggregated_output", "formatted_output", "content"]) {
    if (typeof fields[key] === "string" && fields[key]) return fields[key] as string;
  }
  return "";
}

/** The command a call ran, without the shell wrapper and environment prefixes. */
export function toolCommand(item: Pick<ToolItem, "rawInput">): string | undefined {
  const input = record(item.rawInput);
  const command = input.command ?? input.cmd ?? input.CommandLine;
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === "string");
    // ["bash", "-lc", "npm test"] → "npm test"
    if (parts.length === 3 && /(^|\/)(ba|z|)sh$/.test(parts[0]!) && parts[1]!.startsWith("-")) return tidyCommand(parts[2]!);
    return parts.length ? tidyCommand(parts.join(" ")) : undefined;
  }
  return typeof command === "string" && command.trim() ? tidyCommand(command) : undefined;
}

/** The words the agent described a command with, when it did (Claude's Bash; Antigravity titles it so). */
export function commandDescription(item: ToolItem): string | undefined {
  const described = text(record(item.rawInput).description);
  if (described) return described;
  const command = toolCommand(item);
  const title = cleanToolTitle(item.title);
  if (!command || !title || title === "Run command") return undefined;
  // A title that is (or quotes) the command says nothing more than it.
  const first = command.split("\n")[0]!.trim();
  return title.includes(first) || first.includes(title) || tidyCommand(title) === command ? undefined : title;
}

/** The file a call is about: the first changed, else the one its input or location names. */
export function toolPath(item: ToolItem): string | undefined {
  for (const entry of item.content) {
    if (entry.type === "diff") return entry.path;
    if (entry.type === "patch") return entry.movePath ?? entry.path;
  }
  const input = record(item.rawInput);
  return (
    text(input.file_path) ?? text(input.notebook_path) ?? text(input.absolute_path) ?? text(input.path) ?? text(input.Path) ??
    text(input.TargetFile) ?? text(input.AbsolutePath) ?? item.locations?.[0]?.path
  );
}

function changes(item: ToolItem): Extract<ToolCallContent, { type: "diff" | "patch" }>[] {
  return item.content.filter((entry): entry is Extract<ToolCallContent, { type: "diff" | "patch" }> => entry.type === "diff" || entry.type === "patch");
}

/** Every file a call changed (a patch can touch several). */
export function changedPaths(item: ToolItem): string[] {
  return [...new Set(changes(item).map((entry) => (entry.type === "patch" ? entry.movePath ?? entry.path : entry.path)))];
}

/** A plan the agent proposed (Claude's ExitPlanMode), as Markdown. */
export function proposedPlan(item: ToolItem): string | undefined {
  return text(record(item.rawInput).plan);
}

function fileAction(item: ToolItem, name: string | undefined): ToolAction {
  const path = toolPath(item);
  if (path && MEMORY_PATH.test(path)) return "memory";
  if (item.toolKind === "delete") return "delete";
  if (item.toolKind === "move") return "move";
  const changed = changes(item);
  if (changed.length && changed.every((entry) => (entry.type === "patch" ? entry.change === "delete" : false))) return "delete";
  const added = changed.length > 0 && changed.every((entry) => (entry.type === "diff" ? entry.oldText == null : entry.change === "add"));
  // Claude's Write carries no old text even when it replaces a file; its result says which it was.
  if (added || (!changed.length && name && CREATE_NAMES.test(name))) return /has been (updated|overwritten)/i.test(toolOutput(item)) ? "edit" : "create";
  return "edit";
}

function listing(item: ToolItem, name: string | undefined): boolean {
  return (!!name && LIST_NAMES.test(name)) || /^List\b/.test(item.title);
}

function finding(item: ToolItem, name: string | undefined): boolean {
  return (!!name && FIND_NAMES.test(name)) || /^(Find|Glob)\b/.test(item.title);
}

const SUBAGENT_ACTIONS: Record<string, ToolAction> = {
  spawn: "agent",
  message: "agent_message",
  wait: "agent_wait",
  stop: "agent_stop",
  resume: "agent_resume",
  list: "agent_list",
};

// Items are immutable (an update makes a new object), so what is read from one is read once.
const actions = new WeakMap<ToolItem, ToolAction>();
const labels = new WeakMap<ToolItem, ToolLabel>();

/** What a call did. */
export function toolAction(item: ToolItem): ToolAction {
  let action = actions.get(item);
  if (action === undefined) {
    action = readAction(item);
    actions.set(item, action);
  }
  return action;
}

function readAction(item: ToolItem): ToolAction {
  const detail = item.detail;
  if (detail) {
    switch (detail.type) {
      case "compaction":
        return "compaction";
      case "web_search":
        return "web_search";
      case "skill":
        return "skill";
      case "image_generation":
        return "image";
      case "review":
        return "review";
      case "question":
        return "question";
      case "subagent":
        return detail.workflow ? "workflow" : SUBAGENT_ACTIONS[detail.action] ?? "agent";
      case "mcp": {
        // The Claude desktop app's own tools (servers `ccd_…`): its session, turn and plan controls.
        if (detail.tool === "update_plan") return "update_plan";
        if (/^ccd_/.test(detail.server)) {
          if (detail.tool === "start_session") return "start_session";
          if (detail.tool === "wrap_up") return "wrap_up";
          if (detail.tool === "mark_chapter") return "chapter";
          if (detail.tool === "send_message") return "session_message";
        }
        return "mcp";
      }
    }
  }
  const name = toolName(item);
  switch (name) {
    case "TodoWrite":
      return "todo";
    case "ExitPlanMode":
      return "plan";
    case "SendUserFile":
      return "send_file";
    case "AskUserQuestion":
      return "question";
  }
  switch (item.toolKind) {
    case "execute":
      return "command";
    case "read":
      return listing(item, name) ? "list" : "read";
    case "search":
      return finding(item, name) ? "find" : "search";
    case "fetch":
      return name && WEB_SEARCH_NAMES.test(name) ? "web_search" : "fetch";
    case "edit":
    case "delete":
    case "move":
      return fileAction(item, name);
    case "switch_mode":
      return proposedPlan(item) ? "plan" : "mode";
    default:
      break;
  }
  if (name) {
    if (READ_NAMES.test(name)) return "read";
    if (LIST_NAMES.test(name)) return "list";
    if (FIND_NAMES.test(name)) return "find";
    if (SEARCH_NAMES.test(name)) return "search";
    if (CREATE_NAMES.test(name) || EDIT_NAMES.test(name)) return fileAction(item, name);
    if (COMMAND_NAMES.test(name)) return "command";
    if (WEB_SEARCH_NAMES.test(name)) return "web_search";
    if (FETCH_NAMES.test(name)) return "fetch";
  }
  return "other";
}

/** Calls with no row of their own: the plan card already shows what they changed. */
export function isHiddenTool(item: TimelineItem): boolean {
  return item.kind === "tool" && toolAction(item) === "update_plan";
}

/** "search_issues" / "searchIssues" → "Search issues". */
export function humanizeName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** An MCP call's server and tool as people read them: "Figma：Get design context". */
export function mcpName(server: string, tool: string): { server: string; tool: string } {
  // Codex connectors are one server (`codex_apps`) whose tools carry the app: "figma.get_metadata".
  const dotted = /^([^.]+)\.(.+)$/.exec(tool);
  if (dotted && /^codex_apps?$/.test(server)) return { server: humanizeName(dotted[1]!), tool: humanizeName(dotted[2]!) };
  // The Claude desktop app's own servers.
  if (/^ccd_/.test(server)) return { server: "Claude", tool: humanizeName(tool) };
  return { server: server.replace(/[_-]+/g, " ").replace(/^./, (first) => first.toUpperCase()), tool: humanizeName(tool) };
}

/** Durations as the conversation says them: "28 秒", "3 分 5 秒", "1 小时 2 分". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
}

/** How long a call took, when that is known. */
export function toolDuration(item: ToolItem): number | undefined {
  const reported = record(item.rawOutput).durationMs;
  if (typeof reported === "number" && reported >= 0) return reported;
  return item.endedTs !== undefined && item.endedTs >= item.ts ? item.endedTs - item.ts : undefined;
}

/** A command's exit code: reported (Codex, ACP), or in the words of its output (Claude, Antigravity). */
export function exitCodeOf(item: ToolItem): number | undefined {
  const raw = record(item.rawOutput);
  for (const key of ["exitCode", "exit_code"]) if (typeof raw[key] === "number") return raw[key] as number;
  const output = toolOutput(item);
  const said = /^Exit code (\d+)/.exec(output) ?? /\bexited with code (\d+)/.exec(output);
  return said ? Number(said[1]) : undefined;
}

/** How a call ended: the person declined it, it was interrupted, or the tool reported a failure. */
export type ToolOutcome = "running" | "done" | "failed" | "declined" | "stopped";

export function toolOutcome(item: ToolItem): ToolOutcome {
  if (item.status === "in_progress" || item.status === "pending") return "running";
  if (record(item.rawOutput).declined === true) return "declined";
  if (item.status !== "failed") return "done";
  // Only a call that failed is told so in words: one that worked may print them (a log, a test's text).
  const output = toolOutput(item);
  if (/doesn't want to (proceed|take this action)|tool use was rejected|user (rejected|denied|declined)/i.test(output)) return "declined";
  if (/^\[?Request interrupted by user|\binterrupted by (the )?user\b/i.test(output)) return "stopped";
  return "failed";
}

/** Matches a search reported, when its output says how many. */
export function matchCount(item: ToolItem): string | undefined {
  const output = toolOutput(item).trim();
  if (!output) return undefined;
  if (/^(No (files|matches|results) found|No results)\b/i.test(output)) return "无匹配";
  const found = /^Found (\d+) (?:total )?(files?|matches|occurrences|results?)/i.exec(output);
  if (!found) return undefined;
  return /^files?$/i.test(found[2]!) ? `${found[1]} 个文件` : `${found[1]} 处匹配`;
}

function firstLine(value: string, max = 120): string {
  const line = value.split("\n").find((part) => part.trim())?.trim() ?? value.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The first Markdown heading (or else first line) of a text: a plan's or a thought's title. */
export function headingOf(markdown: string): string | undefined {
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1] ?? /^\s*\*\*(.+?)\*\*\s*$/m.exec(markdown)?.[1];
  return heading?.trim() || undefined;
}

function questionsOf(item: ToolItem): { header?: string; question: string }[] {
  const raw = record(item.rawInput).questions;
  return (Array.isArray(raw) ? raw : []).flatMap((entry) => {
    const question = record(entry);
    const said = text(question.question) ?? text(question.text);
    return said ? [{ header: text(question.header), question: said }] : [];
  });
}

/** The questions a call asked (Claude's AskUserQuestion), with what each offered. */
export function askedQuestions(item: ToolItem): { header?: string; question: string; options: string[]; multiple: boolean }[] {
  const raw = record(item.rawInput).questions;
  return (Array.isArray(raw) ? raw : []).flatMap((entry) => {
    const question = record(entry);
    const said = text(question.question) ?? text(question.text);
    if (!said) return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((option) => text(record(option).label) ?? text(option) ?? []);
    return [{ header: text(question.header), question: said, options, multiple: question.multiSelect === true }];
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
}

/** What a search looked for: its pattern, or the quoted part of its title. */
function searchSubject(item: ToolItem): string | undefined {
  const input = record(item.rawInput);
  return text(input.pattern) ?? text(input.query) ?? text(input.Query) ?? text(input.regex) ?? /[“"]([^”"]+)[”"]/.exec(item.title)?.[1] ?? (cleanToolTitle(item.title) || undefined);
}

export interface ToolLabel {
  action: ToolAction;
  outcome: ToolOutcome;
  /** The verb phrase: "已读取", "正在运行", "已搜索网页：". */
  verb: string;
  /** What it acted on: a file name, a command, a pattern, a host. */
  subject?: string;
  /** How the subject reads: a file (opens it), code (the monospace face), or words. */
  style?: "file" | "code" | "text";
  /** The subject's full path, for a file. */
  path?: string;
  /** Said after the label: "12 处匹配", "用时 3 秒". */
  note?: string;
}

const VERBS: Record<ToolAction, [done: string, running: string]> = {
  read: ["已读取", "正在读取"],
  list: ["已列出", "正在列出"],
  create: ["已创建", "正在创建"],
  edit: ["已编辑", "编辑中"],
  delete: ["已删除", "正在删除"],
  move: ["已移动", "正在移动"],
  memory: ["已保存记忆", "正在保存记忆"],
  command: ["已运行", "正在运行"],
  search: ["已搜索", "正在搜索"],
  find: ["已搜索文件", "正在搜索文件"],
  web_search: ["已搜索网页：", "正在搜索网页："],
  fetch: ["已获取", "正在获取"],
  agent: ["已运行智能体：", "正在运行智能体："],
  workflow: ["已运行工作流：", "正在运行工作流："],
  agent_message: ["已发送消息给智能体", "正在发送消息给智能体"],
  agent_wait: ["已等待智能体", "正在等待智能体"],
  agent_stop: ["已停止智能体", "正在停止智能体"],
  agent_resume: ["已恢复智能体", "正在恢复智能体"],
  agent_list: ["已查看智能体", "正在查看智能体"],
  skill: ["已运行 Skill", "正在运行 Skill"],
  mcp: ["已使用", "正在使用"],
  todo: ["已更新待办事项", "正在更新待办事项"],
  plan: ["提出了计划：", "正在制定计划"],
  question: ["询问了：", "正在提问："],
  send_file: ["发送了文件", "正在发送文件"],
  image: ["已生成图片", "正在生成图片"],
  review: ["已完成代码审查", "正在审查代码"],
  mode: ["已切换模式", "正在切换模式"],
  start_session: ["已启动会话", "正在启动会话"],
  session_message: ["已发送消息给会话", "正在发送消息给会话"],
  wrap_up: ["已收尾", "正在收尾"],
  chapter: ["新章节", "新章节"],
  update_plan: ["已更新待办事项", "正在更新待办事项"],
  compaction: ["上下文已压缩", "正在压缩上下文"],
  other: ["已使用", "正在使用"],
};

/** A call's row: what it did, to what, and anything worth saying after. */
export function toolLabel(item: ToolItem): ToolLabel {
  let label = labels.get(item);
  if (!label) {
    label = readLabel(item);
    labels.set(item, label);
  }
  return label;
}

function readLabel(item: ToolItem): ToolLabel {
  const action = toolAction(item);
  const outcome = toolOutcome(item);
  const [done, running] = VERBS[action];
  const label: ToolLabel = { action, outcome, verb: outcome === "running" ? running : done };
  const detail = item.detail;
  const input = record(item.rawInput);
  const file = (path: string | undefined) => {
    if (!path) return;
    label.subject = fileName(path);
    label.style = "file";
    label.path = path.replace(/^file:\/\//, "");
  };
  switch (action) {
    case "read":
    case "memory":
      file(toolPath(item));
      if (!label.subject) label.subject = cleanToolTitle(item.title) || undefined;
      break;
    case "create":
    case "edit":
    case "delete":
    case "move": {
      const paths = changedPaths(item);
      if (paths.length > 1) label.subject = `${fileName(paths[0]!)} 等 ${paths.length} 个文件`;
      else file(toolPath(item));
      if (!label.subject) label.subject = cleanToolTitle(item.title) || undefined;
      break;
    }
    case "list": {
      const dir = text(input.path) ?? text(input.DirectoryPath) ?? text(input.dir_path) ?? /^List\s+(\S+)/.exec(item.title)?.[1];
      label.verb = outcome === "running" ? "正在列出" : "已列出";
      label.subject = dir && dir !== "files" ? `${dir} 中的文件` : "文件";
      break;
    }
    case "command": {
      const described = commandDescription(item);
      const command = toolCommand(item) ?? (cleanToolTitle(item.title) || undefined);
      label.subject = described ?? (command ? firstLine(command) : undefined);
      label.style = described ? "text" : "code";
      const took = outcome === "done" || outcome === "failed" ? toolDuration(item) : undefined;
      if (took !== undefined && took >= 1000) label.note = `用时 ${formatElapsed(took)}`;
      break;
    }
    case "search":
    case "find":
      label.subject = searchSubject(item);
      label.style = "code";
      if (outcome === "done") label.note = matchCount(item);
      break;
    case "web_search":
      label.subject = (detail?.type === "web_search" ? detail.query : undefined) ?? text(input.query) ?? (cleanToolTitle(item.title).replace(/^web:\s*/i, "") || undefined);
      break;
    case "fetch": {
      const url = text(input.url) ?? text(input.Url);
      label.subject = url ? hostOf(url) : cleanToolTitle(item.title) || undefined;
      break;
    }
    case "agent":
    case "workflow":
      if (detail?.type === "subagent") label.subject = firstLine(detail.task ?? detail.name ?? detail.agentType ?? "", 80) || undefined;
      break;
    case "skill":
      if (detail?.type === "skill") label.subject = `/${detail.name.replace(/^\//, "")}`;
      label.style = "code";
      break;
    case "mcp":
      if (detail?.type === "mcp" && /^codex_apps?$/.test(detail.server) && detail.tool === "automation_update") {
        // Codex's scheduled tasks: what was done to which.
        const mode = text(input.mode);
        const status = text(input.status);
        const verb = mode === "create" ? "创建" : mode === "delete" ? "删除" : mode === "view" ? "查看" : status === "PAUSED" ? "暂停" : status === "ACTIVE" ? "启用" : "更新";
        label.verb = `${outcome === "running" ? "正在" : "已"}${verb}定时任务`;
        label.subject = text(input.name) ?? text(input.id);
      } else if (detail?.type === "mcp") {
        const named = mcpName(detail.server, detail.tool);
        label.subject = `${named.server}：${named.tool}`;
      }
      break;
    case "start_session":
      label.subject = text(input.title);
      break;
    case "plan": {
      const plan = proposedPlan(item);
      label.subject = plan ? headingOf(plan) ?? firstLine(plan, 80) : undefined;
      if (!label.subject && outcome !== "running") label.verb = "提出了一个计划";
      break;
    }
    case "question": {
      const asked = questionsOf(item);
      const first = asked[0];
      label.subject = asked.length > 1 && !first?.header ? `${asked.length} 个问题` : first?.header ?? first?.question ?? (detail?.type === "question" ? detail.text : undefined);
      if (asked.length > 1 && first?.header) label.note = `共 ${asked.length} 个问题`;
      break;
    }
    case "send_file": {
      const files = (Array.isArray(input.files) ? input.files : []).flatMap((entry) => text(entry) ?? text(record(entry).path) ?? []);
      if (files.length === 1) file(files[0]);
      else if (files.length > 1) label.subject = `${files.length} 个文件`;
      break;
    }
    case "review":
      label.verb = detail?.type === "review" && detail.phase === "started" ? "已开始代码审查" : "已完成代码审查";
      break;
    case "chapter":
      label.subject = text(input.title);
      break;
    case "compaction":
      label.verb = compactionLabel(item);
      break;
    case "other": {
      const name = toolName(item);
      label.subject = name ? humanizeName(name) : cleanToolTitle(item.title) || undefined;
      break;
    }
    default:
      break;
  }
  if (label.subject === "") label.subject = undefined;
  return label;
}

/** The context being compacted, by the agent itself or because the person asked. */
export function compactionLabel(item: ToolItem): string {
  if (item.status === "in_progress" || item.status === "pending") return "正在压缩上下文";
  if (item.status === "failed") return "上下文压缩失败";
  const trigger = record(item.rawInput).trigger;
  return trigger === "auto" ? "上下文已自动压缩" : "上下文已压缩";
}

/** The row in its three pieces: the verb (with the space or colon that follows it), the subject, and what is said after. */
export function toolLabelParts(label: ToolLabel): { verb: string; subject?: string; suffix?: string } {
  const subject = label.subject;
  // "已搜索网页：" with nothing to say after it reads "已搜索网页".
  const verb = !subject ? label.verb.replace(/[：:]$/, "") : /[：:]$/.test(label.verb) ? label.verb : `${label.verb} `;
  if (label.outcome === "failed") return { verb, subject, suffix: "（失败）" };
  if (label.outcome === "declined") return subject ? { verb: "已拒绝 ", subject } : { verb, suffix: "（已拒绝）" };
  if (label.outcome === "stopped") return subject ? { verb: "已停止 ", subject } : { verb, suffix: "（已停止）" };
  return { verb, subject };
}

/** The row as one line of text: "已读取 foo.ts"、"已运行 npm test（失败）"。 */
export function toolLabelText(label: ToolLabel, options: { note?: boolean } = {}): string {
  const parts = toolLabelParts(label);
  const line = `${parts.verb}${parts.subject ?? ""}${parts.suffix ?? ""}`;
  return options.note && label.note ? `${line} · ${label.note}` : line;
}

/** What the conversation's live row says while this call runs: "正在运行 npm test". */
export function runningText(item: ToolItem): string {
  const label = toolLabel(item);
  return toolLabelText(label.outcome === "running" ? label : { ...label, outcome: "running", verb: VERBS[label.action][1] });
}

/** Rows whose output isn't worth opening: reading a file (the file is the result) and listing a directory. */
export function isQuietTool(item: ToolItem): boolean {
  const action = toolAction(item);
  if (action !== "read" && action !== "list") return false;
  // A failure's words are worth reading; so are pictures it read.
  return item.status !== "failed" && !item.content.some((entry) => entry.type === "content" && entry.content.type === "image");
}

/** A command's outcome under its output: "成功", "退出码 N" or "已停止". */
export function exitNote(item: ToolItem): string | undefined {
  const outcome = toolOutcome(item);
  if (outcome === "stopped" || outcome === "declined") return outcome === "declined" ? "已拒绝" : "已停止";
  const code = exitCodeOf(item);
  if (code === undefined) return undefined;
  return code === 0 ? "成功" : `退出码 ${code}`;
}

/** A session the Claude app's start_session started (or only proposed), as its card shows it. */
export function startedSession(item: ToolItem): { title: string; state: "starting" | "started" | "proposed" | "failed"; appId?: string } {
  const input = record(item.rawInput);
  const output = toolOutput(item);
  const title = text(input.title) ?? /(?:Started session|Proposed) "([^"]+)"/.exec(output)?.[1] ?? "正在启动会话";
  const appId = /session_id:\s*(local_[\w-]+)/.exec(output)?.[1];
  const state =
    item.status === "in_progress" || item.status === "pending"
      ? "starting"
      : item.status === "failed" || (!/Started session|Proposed /.test(output) && !!output && !appId)
        ? "failed"
        : /Proposed /.test(output) && !/Started session/.test(output)
          ? "proposed"
          : "started";
  return { title, state, ...(appId ? { appId } : {}) };
}

/** What the Claude app calls its own actions on an end-of-turn box's buttons. */
const APP_ACTIONS: Record<string, string> = {
  commit: "提交", create_pr: "创建 PR", merge: "合并", fix_ci: "修复 CI", address_comments: "处理评论",
  resolve_conflicts: "解决冲突", verify: "验证", archive: "归档", new_session: "新会话",
};

/**
 * One of an end-of-turn box's buttons: a reply sends `message` as the person's next message (its
 * label when it has none); an app action (commit, create a PR…) is the Claude app's own, done there.
 */
export type WrapUpAction = { label: string; message: string; app?: undefined } | { label: string; app: string; message?: undefined };

/** The Claude app's end-of-turn box (wrap_up): the recap, the question it leaves, the answers it offers. */
export function wrapUpOf(item: ToolItem): { recap?: string; ask?: string; actions: WrapUpAction[] } {
  const input = record(item.rawInput);
  const actions = (Array.isArray(input.actions) ? input.actions : []).flatMap((entry): WrapUpAction[] => {
    const button = record(entry);
    const app = text(button.action);
    if (app) return [{ label: APP_ACTIONS[app] ?? text(button.label) ?? app, app }];
    const label = text(button.label);
    return label ? [{ label, message: text(button.message) ?? label }] : [];
  });
  return { recap: text(input.recap), ask: text(input.ask), actions };
}
