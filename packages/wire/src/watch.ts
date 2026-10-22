import { z } from "zod";
import {
  classifySessionPhase,
  isLiveActivityActionCurrent,
  liveActivityActionSchema,
  liveActivityActions,
  liveActivityDetailLink,
  liveActivitySessionTask,
  needsAttention,
  needsUserInput,
  phasePriority,
  plainPreview,
  sessionTitle,
  terminalState,
  tidyCommand,
  cleanToolTitle,
  type AttentionPhase,
  type LiveActivityAction,
} from "./live-activity.js";
import type { PendingPermissionSummary, SessionSummary, TerminalInfo } from "./model.js";

export const watchComputerSchema = z.object({
  key: z.string().min(1).max(512),
  name: z.string().min(1).max(80),
  online: z.boolean(),
  selected: z.boolean(),
  platform: z.enum(["darwin", "win32", "linux", "unknown"]).optional(),
});
export type WatchComputer = z.infer<typeof watchComputerSchema>;

export const watchWorkspaceSchema = z.object({
  path: z.string().min(1).max(240),
  name: z.string().min(1).max(80),
});
export type WatchWorkspace = z.infer<typeof watchWorkspaceSchema>;

export const watchConfigOptionValueSchema = z.object({
  value: z.string().min(1).max(120),
  name: z.string().min(1).max(80),
  description: z.string().max(140).optional(),
});
export type WatchConfigOptionValue = z.infer<typeof watchConfigOptionValueSchema>;

export const watchConfigOptionSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  category: z.enum(["model", "model_config", "mode", "effort", "other"]).default("other"),
  current: z.string().max(120),
  currentLabel: z.string().max(80).optional(),
  values: z.array(watchConfigOptionValueSchema).max(12),
});
export type WatchConfigOption = z.infer<typeof watchConfigOptionSchema>;

export const watchActionSchema = liveActivityActionSchema;
export type WatchAction = LiveActivityAction;

export const watchPlanProgressSchema = z.object({
  completed: z.number().int().min(0),
  total: z.number().int().min(1),
  currentStep: z.string().max(120).optional(),
});
export type WatchPlanProgress = z.infer<typeof watchPlanProgressSchema>;

export const watchTimelineItemSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum([
    "user",
    "assistant",
    "thought",
    "tool",
    "diff",
    "subagent",
    "image",
    "plan",
    "permission",
    "question",
    "error",
  ]),
  title: z.string().max(120).optional(),
  // The session the watch has open carries several KB per item (see watchSnapshotContent).
  text: z.string().max(8000),
  detail: z.string().max(4000).optional(),
  status: z.enum(["running", "completed", "failed", "waiting"]).optional(),
  filePath: z.string().max(200).optional(),
  diffAdded: z.number().int().min(0).optional(),
  diffRemoved: z.number().int().min(0).optional(),
  subagentType: z.string().max(64).optional(),
  subagentName: z.string().max(64).optional(),
  subagentModel: z.string().max(80).optional(),
  imageBase64: z.string().max(16_384).optional(),
  imageMimeType: z.string().max(64).optional(),
});
export type WatchTimelineItem = z.infer<typeof watchTimelineItemSchema>;

export const watchSessionSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(120),
  subtitle: z.string().max(240),
  project: z.string().max(80),
  cwd: z.string().max(240).optional(),
  branch: z.string().max(80).optional(),
  agent: z.string().min(1).max(80),
  model: z.string().max(80).optional(),
  mode: z.string().max(80).optional(),
  subagents: z
    .object({
      total: z.number().int().min(0),
      running: z.number().int().min(0),
    })
    .optional(),
  configOptions: z.array(watchConfigOptionSchema).max(6).optional(),
  phase: z.enum([
    "waiting_for_approval",
    "waiting_for_input",
    "failed",
    "running",
    "starting",
    "completed",
    "stale",
  ]),
  updatedAt: z.number(),
  pinned: z.boolean().optional(),
  promptTitle: z.string().max(200).optional(),
  commandPreview: z.string().max(200).optional(),
  detailPreview: z.string().max(240).optional(),
  goal: z.string().max(160).optional(),
  planProgress: watchPlanProgressSchema.optional(),
  actions: z.array(watchActionSchema).max(3).optional(),
  hasMoreActions: z.boolean().optional(),
  hasEarlier: z.boolean().optional(),
  items: z.array(watchTimelineItemSchema).max(60).optional(),
  canCancel: z.boolean(),
  canSend: z.boolean(),
  handoff: z.enum(["none", "can_takeover", "can_release"]),
  deepLink: z.string().max(2048),
});
export type WatchSession = z.infer<typeof watchSessionSchema>;

export const watchTerminalSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(120),
  subtitle: z.string().max(160),
  project: z.string().max(80),
  cwd: z.string().max(240).optional(),
  command: z.string().max(160).optional(),
  outputPreview: z.string().max(2400).optional(),
  phase: z.enum(["running", "failed", "completed", "stale"]),
  activeAt: z.number(),
  exitCode: z.number().int().optional(),
  deepLink: z.string().max(2048),
});
export type WatchTerminal = z.infer<typeof watchTerminalSchema>;

export const watchSnapshotSchema = z.object({
  version: z.literal(1),
  generatedAt: z.number(),
  computerKey: z.string().max(512),
  computerName: z.string().max(80),
  online: z.boolean(),
  /** The session the watch last opened: it keeps the largest share of the byte budget. */
  focusedSessionId: z.string().min(1).max(128).optional(),
  statusLabel: z.string().max(80),
  waitingCount: z.number().int().min(0),
  runningCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  completedCount: z.number().int().min(0),
  availableAgents: z.array(z.string().min(1).max(48)).max(12).optional(),
  workspaces: z.array(watchWorkspaceSchema).max(10).optional(),
  computers: z.array(watchComputerSchema).max(12),
  sessions: z.array(watchSessionSchema).max(12),
  terminals: z.array(watchTerminalSchema).max(8),
});
export type WatchSnapshot = z.infer<typeof watchSnapshotSchema>;

export const WATCH_PROMPT_MAX = 8000;
/**
 * WCSession's applicationContext and sendMessage carry about 65 KB; the rest is
 * headroom for the envelope and for Swift's re-serialization of the JSON.
 */
export const WATCH_SNAPSHOT_BYTE_LIMIT = 56_000;
/** Snapshot sessions and terminals; the phone attaches exactly the terminals it sends. */
export const WATCH_SESSION_LIMIT = 10;
export const WATCH_TERMINAL_LIMIT = 6;
export const WATCH_FOCUSED_ITEMS = 40;
export const WATCH_MAX_ITEMS = 60;

export const watchCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("action"),
    action: watchActionSchema,
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("prompt"),
    computerKey: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(128),
    // Dictation runs long; the host's sessions.prompt has no limit of its own.
    text: z.string().min(1).max(WATCH_PROMPT_MAX),
    now: z.boolean().optional(),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("cancel"),
    computerKey: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(128),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("takeover"),
    computerKey: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(128),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("release"),
    computerKey: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(128),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("set-config"),
    computerKey: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(128),
    optionId: z.string().min(1).max(64),
    value: z.string().min(1).max(120),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("open-session"),
    computerKey: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(128),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("load-earlier"),
    computerKey: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(128),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("create-session"),
    computerKey: z.string().min(1).max(512),
    agent: z.string().min(1).max(48),
    cwd: z.string().min(1).max(240),
    prompt: z.string().max(WATCH_PROMPT_MAX).optional(),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("create-terminal"),
    computerKey: z.string().min(1).max(512),
    cwd: z.string().max(240).optional(),
    command: z.string().max(500).optional(),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("open-terminal"),
    computerKey: z.string().min(1).max(512),
    terminalId: z.string().min(1).max(128),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("terminal-input"),
    computerKey: z.string().min(1).max(512),
    terminalId: z.string().min(1).max(128),
    data: z.string().min(1).max(WATCH_PROMPT_MAX),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("close-terminal"),
    computerKey: z.string().min(1).max(512),
    terminalId: z.string().min(1).max(128),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("select-computer"),
    computerKey: z.string().min(1).max(512),
  }),
  z.object({
    id: z.string().min(1).max(128),
    kind: z.literal("refresh"),
    computerKey: z.string().max(512).optional(),
  }),
]);
export type WatchCommand = z.infer<typeof watchCommandSchema>;

export interface WatchQuickPrompt {
  id: string;
  label: string;
  icon: string;
  prompt: string;
}

export const DEFAULT_WATCH_QUICK_PROMPTS: readonly WatchQuickPrompt[] = [
  { id: "continue", label: "继续推进", icon: "play.fill", prompt: "请继续推进当前任务。" },
  { id: "test", label: "运行测试", icon: "checkmark.shield.fill", prompt: "请运行相关测试并汇报结果。" },
  { id: "summary", label: "总结进展", icon: "text.alignleft", prompt: "请简明总结目前的进展与下一步计划。" },
  { id: "fix", label: "排查修复", icon: "wrench.and.screwdriver.fill", prompt: "请分析当前报错原因并直接修复验证。" },
];

function cut(value: string | undefined, max: number): string {
  return [...(value ?? "")].slice(0, max).join("");
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Cuts to a UTF-8 byte budget: the WatchConnectivity limit is in bytes, and CJK text
 * takes three a character, so a character count would let it overflow threefold.
 */
export function cutWatchBytes(value: string | undefined, maxBytes: number): string {
  const text = value ?? "";
  // Every character is at most 4 bytes, so short strings need no counting.
  if (text.length * 4 <= maxBytes || utf8Length(text) <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - 3);
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (used + size > budget) break;
    used += size;
    end += ch.length;
  }
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * Message text for the watch's conversation view. Unlike plainPreview (one line, for
 * lists and Live Activities) it keeps line breaks and markdown: the watch renders
 * answers as markdown, code blocks included. Only whitespace noise is tidied.
 */
export function watchTimelineText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[ \u00a0]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Line-kept text for rows the watch shows as plain Text (thoughts): inline markup
 * outside code (emphasis, headings, links) is unwrapped; code lines stay as they are.
 */
export function watchPlainText(text: string): string {
  let inFence = false;
  return watchTimelineText(text)
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line.trim();
      }
      if (inFence) return line;
      return line
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^(\s{0,3})#{1,6}\s+/, "$1")
        .replace(/^(\s*)[-*+]\s+/, "$1• ")
        .replace(/(\*\*|__|~~)(\S(?:.*?\S)?)\1/g, "$2")
        .replace(/`([^`\n]+)`/g, "$1");
    })
    .join("\n");
}

/**
 * Like cutWatchBytes, but keeps the end too: a long answer's conclusion is at the bottom.
 * Three quarters of the budget go to the beginning, the rest to the end.
 */
export function cutWatchBytesMiddle(value: string | undefined, maxBytes: number): string {
  const text = value ?? "";
  if (text.length * 4 <= maxBytes || utf8Length(text) <= maxBytes) return text;
  const chars = [...text];
  const take = (from: number, step: 1 | -1, budget: number) => {
    let used = 0;
    let count = 0;
    for (let i = from; i >= 0 && i < chars.length; i += step) {
      const size = utf8Length(chars[i]!);
      if (used + size > budget) break;
      used += size;
      count += 1;
    }
    return count;
  };
  const marker = (omitted: number) => `\n…（中间略去 ${omitted} 字）…\n`;
  const room = maxBytes - utf8Length(marker(chars.length));
  if (room < 200) return cutWatchBytes(text, maxBytes);
  const headCount = take(0, 1, Math.floor(room * 0.75));
  const tailCount = take(chars.length - 1, -1, room - utf8Length(chars.slice(0, headCount).join("")));
  return `${chars.slice(0, headCount).join("").trimEnd()}${marker(chars.length - headCount - tailCount)}${chars
    .slice(chars.length - tailCount)
    .join("")
    .trimStart()}`;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function extractCommandPreview(session: SessionSummary): string | undefined {
  const permTool = session.permission?.tool;
  if (permTool?.title) {
    const cleaned = cleanToolTitle(permTool.title);
    return cut(permTool.kind === "execute" ? tidyCommand(cleaned) : cleaned, 160) || undefined;
  }
  if (session.activity?.kind === "tool" && session.activity.title) {
    const cleaned = cleanToolTitle(session.activity.title);
    return cut(session.activity.toolKind === "execute" ? tidyCommand(cleaned) : cleaned, 160) || undefined;
  }
  return undefined;
}

function extractPromptTitle(session: SessionSummary): string | undefined {
  if (!needsAttention(session)) return undefined;
  const questionText = session.permission?.questions?.[0]?.text?.trim();
  if (questionText) return cut(questionText, 180);
  const permTitle = session.permission?.title?.trim();
  if (permTitle) return cut(permTitle, 180);
  const asyncTitle = session.asyncQuestions?.[0]?.title?.trim();
  if (asyncTitle) return cut(asyncTitle, 180);
  return needsUserInput(session) ? "Agent 正在等待你的回答" : "需要你的权限确认";
}

function fallbackTimelineItems(session: SessionSummary, commandPreview?: string, preview?: string): WatchTimelineItem[] {
  const items: WatchTimelineItem[] = [];
  if (session.title?.trim()) {
    items.push({
      id: `${session.id}:title`,
      kind: "user",
      title: "任务",
      text: cut(session.title.trim(), 240),
      status: "completed",
    });
  }
  if (commandPreview) {
    items.push({
      id: `${session.id}:cmd`,
      kind: "tool",
      title: session.permission ? "等待权限确认" : "执行命令",
      text: cut(commandPreview, 200),
      status: session.permission ? "waiting" : session.state === "running" ? "running" : "completed",
    });
  }
  if (preview && preview !== session.title?.trim()) {
    items.push({
      id: `${session.id}:preview`,
      kind: session.state === "error" ? "error" : "assistant",
      title: session.state === "error" ? "报错信息" : "最新回复",
      text: cut(preview, 360),
      status: session.state === "error" ? "failed" : session.state === "running" ? "running" : "completed",
    });
  }
  return items;
}

export function sliceTimelinePreservingUsers(
  items: WatchTimelineItem[],
  maxItems: number,
): WatchTimelineItem[] {
  if (items.length <= maxItems) return items;
  const tail = items.slice(-maxItems);
  if (tail.some((item) => item.kind === "user")) return tail;
  const keepUsers = maxItems >= 6 ? 2 : 1;
  const earlierUsers = items
    .slice(0, items.length - maxItems)
    .filter((item) => item.kind === "user")
    .slice(-keepUsers);
  if (earlierUsers.length === 0) return tail;
  return [...earlierUsers, ...tail.slice(earlierUsers.length)];
}

export function buildWatchSession(
  session: SessionSummary,
  online: boolean,
  computerKey = "",
  options: {
    pinned?: boolean;
    goal?: string;
    planProgress?: WatchPlanProgress;
    tier?: string;
    items?: WatchTimelineItem[];
    hasEarlier?: boolean;
    maxItems?: number;
    mode?: string;
    configOptions?: WatchConfigOption[];
    /** The session the watch has open: its whole recent conversation, not a glance. */
    focused?: boolean;
  } = {},
): WatchSession {
  const task = liveActivitySessionTask(session, online);
  const phase: AttentionPhase = task.phase;
  const handoff =
    session.driver === "desktop"
      ? "can_takeover"
      : session.driver === "remote" && (options.tier === "handoff" || session.agent === "claude")
        ? "can_release"
        : "none";
  const canSend = online && options.tier !== "terminal" && session.driver !== "desktop";
  const canCancel = online && (session.state === "running" || session.state === "waiting" || session.state === "unknown");
  const { actions, hasMoreActions } = online && session.driver !== "desktop"
    ? liveActivityActions(session, computerKey)
    : { actions: [], hasMoreActions: online && needsAttention(session) };
  const preview = session.preview ? cut(plainPreview(session.preview), 200) : undefined;
  const commandPreview = extractCommandPreview(session);
  const promptTitle = extractPromptTitle(session);
  const branch = session.worktree?.branch ? cut(session.worktree.branch.replace(/^refs\/heads\//, ""), 64) : undefined;
  const configOptions = options.configOptions?.slice(0, 6);
  const modelOpt = configOptions?.find((c) => c.category === "model" || c.id === "model");
  const modeOpt = configOptions?.find((c) => c.category === "mode" || c.id === "mode" || c.id === "sandbox");
  const model = cut(session.model || modelOpt?.currentLabel || modelOpt?.current, 64) || undefined;
  const mode = cut(options.mode || modeOpt?.currentLabel || modeOpt?.current, 64) || undefined;
  const subagents =
    session.subagents && session.subagents.total > 0
      ? {
          total: Math.max(0, session.subagents.total),
          running: Math.max(0, session.subagents.running),
        }
      : undefined;
  const planProgress =
    options.planProgress && options.planProgress.total > 0
      ? {
          completed: Math.max(0, Math.min(options.planProgress.completed, options.planProgress.total)),
          total: options.planProgress.total,
          ...(options.planProgress.currentStep ? { currentStep: cut(options.planProgress.currentStep, 100) } : {}),
        }
      : undefined;
  const maxItems = options.focused
    ? Math.max(WATCH_FOCUSED_ITEMS, Math.min(options.maxItems ?? 0, WATCH_MAX_ITEMS))
    : Math.max(4, Math.min(options.maxItems ?? 14, 56));
  const rawItems = options.items?.length ? options.items : fallbackTimelineItems(session, commandPreview, preview);
  const items =
    maxItems > 14
      ? rawItems.slice(-maxItems)
      : sliceTimelinePreservingUsers(rawItems, maxItems);
  const hasEarlier = Boolean(options.hasEarlier || rawItems.length > items.length);

  return {
    id: session.id,
    title: cut(sessionTitle(session), 96),
    subtitle: cut(
      session.driver === "desktop" && needsAttention(session)
        ? "在电脑终端等待确认 · 可接管后在腕表处理"
        : task.subtitle,
      200,
    ),
    project: cut(baseName(session.worktree?.source ?? session.cwd), 64),
    cwd: cut(session.worktree?.source ?? session.cwd, 200),
    ...(branch ? { branch } : {}),
    agent: cut(session.agent, 48),
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
    ...(subagents ? { subagents } : {}),
    ...(configOptions?.length ? { configOptions } : {}),
    phase,
    updatedAt: session.updatedAt,
    ...(options.pinned ? { pinned: true } : {}),
    ...(promptTitle ? { promptTitle } : {}),
    ...(commandPreview ? { commandPreview } : {}),
    ...(preview ? { detailPreview: preview } : {}),
    ...(options.goal ? { goal: cut(options.goal, 120) } : {}),
    ...(planProgress ? { planProgress } : {}),
    ...(actions.length ? { actions } : {}),
    ...(hasMoreActions ? { hasMoreActions: true } : {}),
    ...(hasEarlier ? { hasEarlier: true } : {}),
    ...(items.length ? { items } : {}),
    canCancel,
    canSend,
    handoff,
    deepLink: liveActivityDetailLink(computerKey, "session", session.id),
  };
}

export function buildWatchTerminal(
  terminal: TerminalInfo,
  online: boolean,
  computerKey = "",
  outputPreview?: string,
): WatchTerminal {
  const state = terminalState(terminal);
  const phase = !online ? "stale" : state.failed ? "failed" : state.busy ? "running" : "completed";
  return {
    id: terminal.id,
    title: cut(state.title || "终端", 96),
    subtitle: cut(state.detail || baseName(terminal.cwd), 120),
    project: cut(baseName(terminal.cwd), 64),
    cwd: cut(terminal.cwd, 200),
    ...(terminal.command ? { command: cut(terminal.command, 140) } : {}),
    ...(outputPreview?.trim() ? { outputPreview: cut(outputPreview.trim(), 1800) } : {}),
    phase,
    activeAt: terminal.activeAt,
    ...(typeof terminal.exitCode === "number" ? { exitCode: terminal.exitCode } : {}),
    deepLink: liveActivityDetailLink(computerKey, "terminal", terminal.id),
  };
}

export interface BuildWatchSnapshotOptions {
  computerKey?: string;
  computers?: WatchComputer[];
  pinnedSessionIds?: string[];
  goals?: Record<string, { status: string; objective: string }>;
  plans?: Record<string, WatchPlanProgress>;
  timelines?: Record<string, WatchTimelineItem[]>;
  hasEarlier?: Record<string, boolean>;
  itemLimits?: Record<string, number>;
  modes?: Record<string, string>;
  configs?: Record<string, WatchConfigOption[]>;
  terminalOutputs?: Record<string, string>;
  availableAgents?: string[];
  workspaces?: WatchWorkspace[];
  agentTiers?: Record<string, string>;
  /** The session the watch has open; it stays in the snapshot even outside the top ten. */
  focusedSessionId?: string;
  now?: number;
}

/** Failed, then busy, then most recently active: the order the watch lists terminals in. */
export function sortWatchTerminals(terminals: TerminalInfo[]): TerminalInfo[] {
  const rank = (s: ReturnType<typeof terminalState>) => (s.failed ? 0 : s.busy ? 1 : 2);
  return [...terminals].sort((a, b) => {
    const ra = rank(terminalState(a));
    const rb = rank(terminalState(b));
    if (ra !== rb) return ra - rb;
    if (a.activeAt !== b.activeAt) return b.activeAt - a.activeAt;
    return a.id.localeCompare(b.id);
  });
}

/** The first `max`, with the focused one swapped in for the last when it falls outside. */
function keepFocused<T extends { id: string }>(list: T[], max: number, focusedId: string | undefined): T[] {
  const head = list.slice(0, max);
  if (!focusedId || head.some((item) => item.id === focusedId)) return head;
  const focused = list.find((item) => item.id === focusedId);
  if (!focused) return head;
  return head.length < max ? [...head, focused] : [...head.slice(0, max - 1), focused];
}

/**
 * Builds the structured Apple Watch companion snapshot for the selected computer.
 * Prioritizes sessions needing approval/input, then errors, then running, then pinned/recent.
 */
export function buildWatchSnapshot(
  computerName: string,
  sessions: SessionSummary[],
  terminals: TerminalInfo[],
  online: boolean,
  options: BuildWatchSnapshotOptions = {},
): WatchSnapshot {
  const computerKey = options.computerKey ?? "";
  const pinnedSet = new Set(options.pinnedSessionIds ?? []);
  const goals = options.goals ?? {};
  const plans = options.plans ?? {};
  const timelines = options.timelines ?? {};
  const hasEarlierMap = options.hasEarlier ?? {};
  const itemLimits = options.itemLimits ?? {};
  const modes = options.modes ?? {};
  const configs = options.configs ?? {};
  const terminalOutputs = options.terminalOutputs ?? {};
  const tiers = options.agentTiers ?? {};
  const now = options.now ?? Date.now();

  const liveSessions = sessions.filter((s) => !s.archived);
  const waitingCount = liveSessions.filter((s) => needsAttention(s)).length;
  const busyTerminals = terminals.filter((t) => terminalState(t).busy);
  const failedTerminals = terminals.filter((t) => terminalState(t).failed);
  const runningSessions = liveSessions.filter((s) => !needsAttention(s) && s.state === "running");
  const failedSessions = liveSessions.filter((s) => !needsAttention(s) && s.state === "error");
  const completedSessions = liveSessions.filter((s) => !needsAttention(s) && s.state === "idle");

  const runningCount = runningSessions.length + busyTerminals.length;
  const failedCount = failedSessions.length + failedTerminals.length;
  const completedCount = completedSessions.length;

  const sortedSessions = [...liveSessions].sort((a, b) => {
    const pa = phasePriority(classifySessionPhase(a, online));
    const pb = phasePriority(classifySessionPhase(b, online));
    if (pa !== pb) return pa - pb;
    const pinA = Number(pinnedSet.has(a.id));
    const pinB = Number(pinnedSet.has(b.id));
    if (pinA !== pinB) return pinB - pinA;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id.localeCompare(b.id);
  });

  const sortedTerminals = sortWatchTerminals(terminals);
  const focusedId = options.focusedSessionId && liveSessions.some((s) => s.id === options.focusedSessionId)
    ? options.focusedSessionId
    : undefined;

  const statusLabel = !online
    ? "连接中断 · 正在重连"
    : waitingCount > 0
      ? `${waitingCount} 项等待你的确认`
      : failedCount > 0
        ? `${failedCount} 项执行出错`
        : runningCount > 0
          ? `${runningCount} 项任务正在运行`
          : liveSessions.length > 0
            ? "全部任务已就绪"
            : "暂无活跃任务";

  const watchComputers: WatchComputer[] = options.computers?.length
    ? options.computers.slice(0, 12).map((c) => ({
        key: cut(c.key, 512),
        name: cut(c.name, 64),
        online: c.online,
        selected: c.selected,
        ...(c.platform ? { platform: c.platform } : {}),
      }))
    : computerKey
      ? [{ key: cut(computerKey, 512), name: cut(computerName || "电脑", 64), online, selected: true }]
      : [];

  const seenPaths = new Set<string>();
  const workspaces: WatchWorkspace[] = [];
  const addWorkspace = (rawPath: string | undefined, rawName?: string) => {
    const path = rawPath?.trim();
    if (!path || seenPaths.has(path) || workspaces.length >= 8) return;
    seenPaths.add(path);
    workspaces.push({
      path: cut(path, 200),
      name: cut(rawName?.trim() || baseName(path) || path, 64),
    });
  };
  for (const ws of options.workspaces ?? []) addWorkspace(ws.path, ws.name);
  for (const s of sortedSessions) addWorkspace(s.worktree?.source ?? s.cwd);
  for (const t of sortedTerminals) addWorkspace(t.cwd);

  // Only what the computer reported: an invented agent would fail when the watch starts it.
  const availableAgents = (options.availableAgents ?? [])
    .map((id) => cut(id.trim(), 48))
    .filter(Boolean)
    .slice(0, 10);

  const snapshot: WatchSnapshot = {
    version: 1,
    generatedAt: now,
    computerKey: cut(computerKey, 512),
    computerName: cut(computerName || "电脑", 64),
    online,
    ...(focusedId ? { focusedSessionId: focusedId } : {}),
    statusLabel: cut(statusLabel, 80),
    waitingCount,
    runningCount,
    failedCount,
    completedCount,
    availableAgents,
    ...(workspaces.length ? { workspaces } : {}),
    computers: watchComputers,
    sessions: keepFocused(sortedSessions, WATCH_SESSION_LIMIT, focusedId).map((session) => {
      const goal = goals[session.id];
      return buildWatchSession(session, online, computerKey, {
        pinned: pinnedSet.has(session.id),
        goal: goal?.status === "active" ? goal.objective : undefined,
        planProgress: plans[session.id],
        tier: tiers[session.agent],
        items: timelines[session.id],
        hasEarlier: hasEarlierMap[session.id],
        maxItems: itemLimits[session.id],
        mode: modes[session.id],
        configOptions: configs[session.id],
        focused: session.id === focusedId,
      });
    }),
    terminals: sortedTerminals.slice(0, WATCH_TERMINAL_LIMIT).map((terminal) =>
      buildWatchTerminal(terminal, online, computerKey, terminalOutputs[terminal.id]),
    ),
  };

  return watchSnapshotContent(snapshot);
}

const ITEM_TEXT_BYTES = 600;
const ITEM_DETAIL_BYTES = 360;
const FOCUSED_TEXT_BYTES = 6_000;
const FOCUSED_DETAIL_BYTES = 2_400;
const IMAGE_MAX = 12_000;
/** What the open conversation may take before the other sessions are squeezed. */
const FOCUSED_SHARE = 0.65;

type SnapshotSession = WatchSnapshot["sessions"][number];

function jsonBytes(value: unknown): number {
  return utf8Length(JSON.stringify(value));
}

function boundItem(item: WatchTimelineItem, focused: boolean): WatchTimelineItem {
  const { imageBase64, imageMimeType, ...rest } = item;
  // A cut base64 string is a broken picture, so an oversized one is left out whole.
  const image = imageBase64 && imageBase64.length <= IMAGE_MAX ? imageBase64 : undefined;
  return {
    ...rest,
    id: cut(item.id, 120),
    ...(item.title ? { title: cut(item.title, 80) } : {}),
    text: focused ? cutWatchBytesMiddle(item.text, FOCUSED_TEXT_BYTES) : cutWatchBytes(item.text, ITEM_TEXT_BYTES),
    ...(item.detail ? { detail: cutWatchBytes(item.detail, focused ? FOCUSED_DETAIL_BYTES : ITEM_DETAIL_BYTES) } : {}),
    ...(item.filePath ? { filePath: cut(item.filePath, 160) } : {}),
    ...(item.subagentType ? { subagentType: cut(item.subagentType, 48) } : {}),
    ...(item.subagentName ? { subagentName: cut(item.subagentName, 48) } : {}),
    ...(item.subagentModel ? { subagentModel: cut(item.subagentModel, 64) } : {}),
    ...(image ? { imageBase64: image, ...(imageMimeType ? { imageMimeType: cut(imageMimeType, 48) } : {}) } : {}),
  };
}

function withoutImage(item: WatchTimelineItem): WatchTimelineItem {
  if (!item.imageBase64) return item;
  const { imageBase64: _image, imageMimeType: _mime, ...rest } = item;
  return rest;
}

/**
 * The newest items that fit in `budget` bytes. The newest message is the one being
 * read, so it is cut rather than dropped; only the newest picture is kept; and the
 * latest question from the user stays when the tail has none, so the answer has context.
 */
function fitItems(items: WatchTimelineItem[], budget: number): WatchTimelineItem[] {
  const kept: WatchTimelineItem[] = [];
  let used = 2;
  let imageKept = false;
  let index = items.length - 1;
  for (; index >= 0; index -= 1) {
    let item = items[index]!;
    if (imageKept) item = withoutImage(item);
    let size = jsonBytes(item) + 1;
    if (used + size > budget && item.imageBase64) {
      item = withoutImage(item);
      size = jsonBytes(item) + 1;
    }
    if (used + size > budget) {
      if (kept.length > 0) break;
      let room = budget - used - jsonBytes({ ...item, text: "" }) - 1;
      while (room >= 120 && used + size > budget) {
        item = { ...item, text: cutWatchBytes(item.text, room) };
        size = jsonBytes(item) + 1;
        room = Math.floor(room * 0.8);
      }
      if (used + size > budget) break;
    }
    if (item.imageBase64) imageKept = true;
    kept.push(item);
    used += size;
  }
  if (index >= 0 && !kept.some((item) => item.kind === "user")) {
    const earlier = items.slice(0, index + 1).reverse().find((item) => item.kind === "user");
    if (earlier) {
      const asked = withoutImage({ ...earlier, text: cutWatchBytes(earlier.text, ITEM_TEXT_BYTES) });
      const size = jsonBytes(asked) + 1;
      if (used + size <= budget) kept.push(asked);
      else if (kept.length > 1 && jsonBytes(kept[kept.length - 1]) + 1 + budget - used >= size) {
        kept[kept.length - 1] = asked;
      }
    }
  }
  return kept.reverse();
}

function squeezeSession(s: SnapshotSession, cap: number, textBytes: number): SnapshotSession {
  if (!s.items) return s;
  const items = sliceTimelinePreservingUsers(s.items, cap).map((item) => {
    const { detail: _detail, ...rest } = withoutImage(item);
    return { ...rest, text: cutWatchBytes(item.text, textBytes) };
  });
  return { ...s, items, hasEarlier: s.hasEarlier || items.length < s.items.length || undefined };
}

/**
 * Bounds a WatchSnapshot to WATCH_SNAPSHOT_BYTE_LIMIT UTF-8 bytes, never truncating
 * action IDs. The session the watch has open gets the largest share: pictures and the
 * other sessions' items go first, and whatever their trimming frees goes back to it.
 */
export function watchSnapshotContent(snapshot: WatchSnapshot, limit = WATCH_SNAPSHOT_BYTE_LIMIT): WatchSnapshot {
  const focusedId =
    snapshot.focusedSessionId && snapshot.sessions.some((s) => s.id === snapshot.focusedSessionId)
      ? snapshot.focusedSessionId
      : undefined;
  const isFocused = (s: { id: string }) => s.id === focusedId;
  const { focusedSessionId: _focused, ...base } = snapshot;
  const next: WatchSnapshot = {
    ...base,
    ...(focusedId ? { focusedSessionId: focusedId } : {}),
    computerName: cut(snapshot.computerName, 64),
    statusLabel: cut(snapshot.statusLabel, 80),
    ...(snapshot.availableAgents ? { availableAgents: snapshot.availableAgents.slice(0, 10).map((a) => cut(a, 48)) } : {}),
    ...(snapshot.workspaces?.length
      ? {
          workspaces: snapshot.workspaces.slice(0, 8).map((w) => ({
            path: cut(w.path, 200),
            name: cut(w.name, 64),
          })),
        }
      : {}),
    computers: snapshot.computers.slice(0, 12).map((c) => ({ ...c, name: cut(c.name, 64) })),
    sessions: keepFocused(snapshot.sessions, WATCH_SESSION_LIMIT, focusedId).map((s) => {
      const focused = isFocused(s);
      const validActions = (s.actions ?? []).filter((a) => watchActionSchema.safeParse(a).success).slice(0, 3);
      const rawValidItems = (s.items ?? []).filter((item) => Boolean(item.id && item.text?.trim()));
      const itemCap = focused
        ? WATCH_MAX_ITEMS
        : rawValidItems.length > 14
          ? Math.min(rawValidItems.length, 48)
          : 14;
      const validItems = (
        itemCap > 14 ? rawValidItems.slice(-itemCap) : sliceTimelinePreservingUsers(rawValidItems, itemCap)
      ).map((item) => boundItem(item, focused));
      const validConfigs = (s.configOptions ?? []).slice(0, 4).map((opt) => ({
        ...opt,
        id: cut(opt.id, 48),
        name: cut(opt.name, 48),
        current: cut(opt.current, 80),
        ...(opt.currentLabel ? { currentLabel: cut(opt.currentLabel, 64) } : {}),
        values: opt.values.slice(0, 8).map((v) => ({
          value: cut(v.value, 80),
          name: cut(v.name, 64),
          ...(v.description ? { description: cut(v.description, 100) } : {}),
        })),
      }));
      const hasEarlier = s.hasEarlier || validItems.length < rawValidItems.length || undefined;
      return {
        ...s,
        title: cut(s.title, 80),
        subtitle: cut(s.subtitle, 160),
        project: cut(s.project, 48),
        ...(s.cwd ? { cwd: cut(s.cwd, 200) } : {}),
        ...(s.branch ? { branch: cut(s.branch, 48) } : {}),
        ...(s.model ? { model: cut(s.model, 64) } : {}),
        ...(s.mode ? { mode: cut(s.mode, 64) } : {}),
        ...(validConfigs.length ? { configOptions: validConfigs } : {}),
        ...(s.promptTitle ? { promptTitle: cut(s.promptTitle, 140) } : {}),
        ...(s.commandPreview ? { commandPreview: cut(s.commandPreview, 140) } : {}),
        ...(s.detailPreview ? { detailPreview: cut(s.detailPreview, 160) } : {}),
        ...(s.goal ? { goal: cut(s.goal, 100) } : {}),
        ...(s.planProgress
          ? {
              planProgress: {
                completed: Math.max(0, Math.min(s.planProgress.completed, s.planProgress.total)),
                total: Math.max(1, s.planProgress.total),
                ...(s.planProgress.currentStep ? { currentStep: cut(s.planProgress.currentStep, 80) } : {}),
              },
            }
          : {}),
        ...(validActions.length ? { actions: validActions } : { actions: undefined }),
        hasMoreActions: s.hasMoreActions || validActions.length < (s.actions?.length ?? 0) || undefined,
        ...(hasEarlier ? { hasEarlier: true } : { hasEarlier: undefined }),
        ...(validItems.length ? { items: validItems } : { items: undefined }),
      };
    }),
    terminals: snapshot.terminals.slice(0, WATCH_TERMINAL_LIMIT).map((t) => ({
      ...t,
      title: cut(t.title, 80),
      subtitle: cut(t.subtitle, 120),
      project: cut(t.project, 48),
      ...(t.cwd ? { cwd: cut(t.cwd, 200) } : {}),
      ...(t.command ? { command: cut(t.command, 120) } : {}),
      ...(t.outputPreview ? { outputPreview: cut(t.outputPreview, 1400) } : {}),
    })),
  };

  const size = () => jsonBytes(next);
  const over = () => size() > limit;
  const others = (change: (s: SnapshotSession) => SnapshotSession) => {
    next.sessions = next.sessions.map((s) => (isFocused(s) ? s : change(s)));
  };
  const focusedItems = next.sessions.find(isFocused)?.items ?? [];
  // Everything but the open conversation, counted with an empty one in its place.
  const restBytes = () =>
    jsonBytes({ ...next, sessions: next.sessions.map((s) => (isFocused(s) ? { ...s, items: [], hasEarlier: true } : s)) });
  let focusedTrimmed = false;
  const fitFocused = (budget: number) => {
    if (!focusedItems.length) return;
    focusedTrimmed = true;
    const items = fitItems(focusedItems, budget);
    next.sessions = next.sessions.map((s) =>
      isFocused(s)
        ? {
            ...s,
            items: items.length ? items : undefined,
            hasEarlier: s.hasEarlier || items.length < focusedItems.length || undefined,
          }
        : s,
    );
  };

  if (over()) others((s) => (s.items ? { ...s, items: s.items.map(withoutImage) } : s));
  if (over()) fitFocused(Math.max(Math.floor(limit * FOCUSED_SHARE), limit - restBytes()));
  if (over()) others((s) => squeezeSession(s, 6, 300));
  if (over()) {
    next.terminals = next.terminals.map((t) => ({
      ...t,
      outputPreview: t.outputPreview ? cut(t.outputPreview, 800) : undefined,
    }));
  }
  if (over()) others((s) => ({ ...squeezeSession(s, 3, 160), configOptions: undefined }));
  while (over() && next.terminals.length > 2) next.terminals.pop();
  while (over() && next.sessions.filter((s) => !isFocused(s)).length > 3) {
    const lastOther = next.sessions.map(isFocused).lastIndexOf(false);
    next.sessions.splice(lastOther, 1);
  }
  if (over()) {
    others((s) => ({
      ...s,
      detailPreview: s.detailPreview ? cut(s.detailPreview, 60) : undefined,
      commandPreview: s.commandPreview ? cut(s.commandPreview, 60) : undefined,
      items: undefined,
      hasEarlier: s.items?.length ? true : s.hasEarlier,
    }));
  }
  // Whatever squeezing the others freed goes back to the open conversation.
  if (focusedTrimmed || over()) fitFocused(limit - restBytes());
  return next;
}

/**
 * Validates a command originating from Apple Watch against the connected computer
 * and live session state before executing any RPC on the host.
 */
export function isWatchCommandCurrent(
  command: WatchCommand,
  computerKey: string,
  session: SessionSummary | undefined,
  permissions: PendingPermissionSummary[] = [],
): boolean {
  if (command.kind === "select-computer") {
    return Boolean(command.computerKey.trim());
  }
  if (command.kind === "refresh") {
    return !command.computerKey || command.computerKey === computerKey;
  }
  if (command.kind === "open-session" || command.kind === "load-earlier") {
    return command.computerKey === computerKey && Boolean(command.sessionId.trim());
  }
  if (command.kind === "create-session") {
    return (
      command.computerKey === computerKey &&
      Boolean(command.agent.trim()) &&
      Boolean(command.cwd.trim())
    );
  }
  if (command.kind === "create-terminal") {
    return command.computerKey === computerKey;
  }
  if (command.kind === "open-terminal" || command.kind === "close-terminal") {
    return command.computerKey === computerKey && Boolean(command.terminalId.trim());
  }
  if (command.kind === "terminal-input") {
    return (
      command.computerKey === computerKey &&
      Boolean(command.terminalId.trim()) &&
      Boolean(command.data.length > 0)
    );
  }
  if (command.kind === "action") {
    if (session?.driver === "desktop") return false;
    return isLiveActivityActionCurrent(command.action, computerKey, session, permissions);
  }
  if (!session || session.archived || command.computerKey !== computerKey || command.sessionId !== session.id) {
    return false;
  }
  switch (command.kind) {
    case "prompt":
      return Boolean(command.text.trim()) && session.driver !== "desktop";
    case "set-config":
      return Boolean(command.optionId.trim()) && Boolean(command.value.trim()) && session.driver !== "desktop";
    case "cancel":
      return session.state === "running" || session.state === "waiting" || session.state === "unknown";
    case "takeover":
      return session.driver === "desktop";
    case "release":
      return session.driver === "remote";
  }
}
