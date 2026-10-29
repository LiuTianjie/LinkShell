import { z } from "zod";
import type { PendingPermissionSummary, PermissionOption, SessionActivity, SessionSummary, TerminalInfo, ToolKind } from "./model.js";
import { unwrapShellCommand } from "./shell.js";

export type AttentionPhase = "waiting_for_approval" | "waiting_for_input" | "failed" | "running" | "starting" | "completed" | "stale";

export const liveActivityActionSchema = z.object({
  id: z.string().max(560), label: z.string().min(1).max(64),
  role: z.enum(["allow", "reject", "always", "stop", "choice"]),
  kind: z.enum(["permission", "answer", "async-answer"]),
  computerKey: z.string().min(1).max(512), sessionId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(256), optionId: z.string().max(160), questionId: z.string().max(128).optional(),
});
export type LiveActivityAction = z.infer<typeof liveActivityActionSchema>;

export const liveActivityTaskSchema = z.object({
  id: z.string().min(1).max(128), kind: z.enum(["session", "terminal"]),
  phase: z.enum(["waiting_for_approval", "waiting_for_input", "failed", "running", "starting", "completed", "stale"]),
  title: z.string().max(160), subtitle: z.string().max(360), project: z.string().max(160), agent: z.string().max(80),
});
export type LiveActivityTask = z.infer<typeof liveActivityTaskSchema>;

/** A transition, rather than a heartbeat: the receiver can alert exactly once. */
export const liveActivityNoticeSchema = z.object({
  id: z.string().min(1).max(128), createdAt: z.number().int().positive(),
  task: liveActivityTaskSchema,
});
export type LiveActivityNotice = z.infer<typeof liveActivityNoticeSchema>;

export const liveActivityContentSchema = z.object({
  phase: z.enum(["waiting_for_approval", "waiting_for_input", "failed", "running", "starting", "completed", "stale"]),
  title: z.string().max(160), subtitle: z.string().max(360), project: z.string().max(160),
  agent: z.string().max(80), agents: z.array(z.string().max(80)).max(12).optional(),
  actions: z.array(liveActivityActionSchema).max(3).optional(), hasMoreActions: z.boolean().optional(),
  tasks: z.array(liveActivityTaskSchema).max(6).optional(), noticeId: z.string().max(128).optional(),
  waitingCount: z.number().int().min(0), runningCount: z.number().int().min(0), failedCount: z.number().int().min(0),
  deepLink: z.string().max(2048).refine((url) => url.startsWith("linkshell:///")),
});
export type LiveActivityContentState = z.infer<typeof liveActivityContentSchema>;
export interface LiveActivityPayload extends Partial<LiveActivityContentState> { active: boolean; computerName: string; computerKey?: string }

export const liveActivityIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9-]+$/);
export const liveActivitySubscriptionSchema = z.object({
  activityId: liveActivityIdSchema,
  serviceUrl: z.url().max(256),
  grant: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
  computerKey: z.string().min(1).max(512),
});
export type LiveActivitySubscription = z.infer<typeof liveActivitySubscriptionSchema>;

// ActivityKit accepts at most 4 KB. Preserve request identifiers exactly; drop
// whole buttons when necessary, so a truncated choice can never be submitted.
export function liveActivityContent(payload: LiveActivityPayload): LiveActivityContentState {
  const cut = (value: string | undefined, max: number) => [...(value ?? "")].slice(0, max).join("");
  const actions = (payload.actions ?? []).filter((action) => liveActivityActionSchema.safeParse(action).success);
  const state: LiveActivityContentState = {
    phase: payload.phase ?? "completed", title: cut(payload.title, 80), subtitle: cut(payload.subtitle, 180),
    project: cut(payload.project, 80), agent: cut(payload.agent, 40),
    agents: payload.agents?.filter((id) => id.length <= 80).slice(0, 12),
    actions, hasMoreActions: payload.hasMoreActions || actions.length !== (payload.actions ?? []).length,
    tasks: payload.tasks?.map((task) => ({
      ...task, title: cut(task.title, 48), subtitle: cut(task.subtitle, 80), project: cut(task.project, 32), agent: cut(task.agent, 40),
    })).filter((task) => liveActivityTaskSchema.safeParse(task).success).slice(0, 6),
    noticeId: payload.noticeId,
    waitingCount: payload.waitingCount ?? 0, runningCount: payload.runningCount ?? 0, failedCount: payload.failedCount ?? 0,
    deepLink: payload.deepLink && payload.deepLink.length <= 2048 ? payload.deepLink : "linkshell:///",
  };
  const size = () => new TextEncoder().encode(JSON.stringify(state)).length;
  // Leave room for an ActivityKit alert as well as Apple's envelope. Keep a
  // second task when possible so the compact snapshot still supports browsing.
  while (size() > 3300 && (state.tasks?.length ?? 0) > 2) state.tasks!.pop();
  while (size() > 3300 && state.actions!.length) { state.actions!.pop(); state.hasMoreActions = true; }
  if (size() > 3300) { state.subtitle = cut(state.subtitle, 60); state.project = ""; state.agents = state.agents?.slice(0, 3); }
  while (size() > 3300 && state.tasks?.length) state.tasks.pop();
  if (size() > 3300) state.deepLink = "linkshell:///";
  return state;
}

export const toolVerb: Record<ToolKind, string> = {
  read: "读取",
  edit: "编辑",
  delete: "删除",
  move: "移动",
  search: "搜索",
  execute: "运行",
  think: "思考",
  fetch: "获取",
  switch_mode: "切换模式",
  other: "",
};


const ENGLISH_VERB = /^(read|reading|edit|editing|write|writing|update|create|delete|search|searching|list|run|running|fetch|grep|glob|find|view|open)\b[:\s]+/i;

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
    // ACP option IDs are agent-local: Gemini's sole `cancel` is a rejection,
    // while Codex offers it alongside a separate decline/skip action.
    const soleReject = option.optionId === "cancel" && option.kind === "reject_once" && kinds.get("reject_once") === 1;
    const known = soleReject ? undefined : choiceById[option.optionId];
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

/** Async questions need attention even while the agent keeps working. */
export function needsUserInput(session: SessionSummary): boolean {
  return !!session.permission?.questions?.length || !!session.asyncQuestions?.length;
}

export function needsAttention(session: SessionSummary): boolean {
  return session.state === "waiting" || needsUserInput(session);
}

const SHELLS = /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|nu|pwsh|powershell)\b/;

/**
 * A start command as a one-line title. The UI font has no Nerd Font glyphs
 * (private-use code points), which would show as boxes; the terminal itself
 * draws them with its symbol font.
 */
export function commandTitle(command: string): string {
  return command.replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, "").replace(/\s+/g, " ").trim();
}

/** How a terminal reads in a list: its title, what it's doing, and whether it has ended. */
export function terminalState(terminal: TerminalInfo) {
  const ended = terminal.exitCode !== undefined || terminal.interrupted === true;
  const foreground = ended || SHELLS.test(terminal.title) ? undefined : terminal.title;
  const failed = !terminal.interrupted && typeof terminal.exitCode === "number" && terminal.exitCode !== 0;
  const detail = terminal.interrupted
    ? "电脑重启时中断"
    : ended
      ? failed
        ? `已退出 · 代码 ${terminal.exitCode}`
        : "已结束"
      : foreground
        ? `正在运行 ${foreground}`
        : "空闲";
  return {
    title: (terminal.command && commandTitle(terminal.command)) || "终端",
    mono: Boolean(terminal.command),
    ended,
    busy: Boolean(foreground),
    failed,
    detail,
  };
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Classify a session into the 7-phase attention hierarchy (t3code model). */
export function classifySessionPhase(session: SessionSummary, online = true): AttentionPhase {
  if (!online || session.state === "offline") return "stale";
  if (needsUserInput(session)) return "waiting_for_input";
  if (session.state === "waiting" || needsAttention(session)) return "waiting_for_approval";
  if (session.state === "error") return "failed";
  if (session.state === "running") return "running";
  if (session.state === "unknown") return "starting";
  return "completed";
}

export function phasePriority(phase: AttentionPhase): number {
  switch (phase) {
    case "waiting_for_approval":
    case "waiting_for_input":
      return 0;
    case "failed":
      return 1;
    case "running":
    case "starting":
      return 2;
    case "completed":
      return 3;
    case "stale":
      return 4;
  }
}

export function liveActivityActions(session: SessionSummary, computerKey: string): {
  actions: LiveActivityAction[];
  hasMoreActions: boolean;
} {
  if (!computerKey) return { actions: [], hasMoreActions: false };
  const base = { computerKey, sessionId: session.id };
  const permission = session.permission;
  let choices: LiveActivityAction[];
  let hasMoreActions = false;
  if (permission) {
    if (permission.url) return { actions: [], hasMoreActions: true };
    const questions = permission.questions;
    if (questions?.length) {
      const question = questions[0]!;
      // A multi-select or form needs its own submit step; never submit a partial form.
      if (questions.length !== 1 || question.kind !== "choice" || question.secret) {
        return { actions: [], hasMoreActions: true };
      }
      choices = (question.options ?? []).map((option) => ({
        ...base, id: `${permission.requestId}:${question.id}:${option.value}`, label: option.label,
        role: "choice", kind: "answer", requestId: permission.requestId,
        questionId: question.id, optionId: option.value,
      }));
      hasMoreActions = Boolean(question.other) || choices.length === 0;
    } else {
      choices = permissionChoices(permission.options).map(({ option, label, role }) => ({
        ...base, id: `${permission.requestId}:${option.optionId}`, label, role,
        kind: "permission", requestId: permission.requestId, optionId: option.optionId,
      }));
    }
  } else {
    const question = session.asyncQuestions?.[0];
    if (!question) return { actions: [], hasMoreActions: false };
    choices = question.options.map((option, index) => ({
      ...base, id: `${question.id}:${index}`, label: option, role: "choice",
      kind: "async-answer", requestId: question.id, optionId: option,
    }));
    // Async questions always support a typed answer in the session.
    hasMoreActions = true;
  }
  // Keep whole labels and the ActivityKit payload bounded. The title opens every choice.
  const visible = choices.filter((choice) => [...choice.label].length <= 16 && choice.optionId.length <= 160).slice(0, 3);
  return { actions: visible, hasMoreActions: hasMoreActions || visible.length < choices.length };
}

/** Recheck against the connected host after waking the app, not the cached card. */
export function isLiveActivityActionCurrent(
  action: LiveActivityAction,
  computerKey: string,
  session: SessionSummary | undefined,
  permissions: PendingPermissionSummary[] = [],
): boolean {
  if (!session || session.archived || action.computerKey !== computerKey || action.sessionId !== session.id) return false;
  if (action.kind === "async-answer") {
    return Boolean(session.asyncQuestions?.some((question) => question.id === action.requestId && question.options.includes(action.optionId)));
  }
  const request = permissions.find((item) => item.requestId === action.requestId)
    ?? (session.permission?.requestId === action.requestId ? session.permission : undefined);
  if (!request || request.url) return false;
  if (action.kind === "permission") {
    return !request.questions?.length && request.options.some((option) => option.optionId === action.optionId);
  }
  if (action.kind !== "answer" || request.questions?.length !== 1) return false;
  const question = request.questions[0]!;
  return question.id === action.questionId && question.kind === "choice" && !question.secret
    && Boolean(question.options?.some((option) => option.value === action.optionId));
}

export function liveActivityDetailLink(computerKey: string, kind: "session" | "terminal", id: string): string {
  if (!computerKey) return `linkshell:///${kind}/${encodeURIComponent(id)}`;
  return `linkshell:///activity?computer=${encodeURIComponent(computerKey)}&${kind}=${encodeURIComponent(id)}`;
}

/** The card describes progress; the session retains the full command and output. */
function liveActivityProgress(activity: SessionActivity | undefined): string {
  if (activity?.kind !== "tool" || activity.toolKind !== "execute" || !activity.title) return activityText(activity);
  const command = tidyCommand(cleanToolTitle(activity.title));
  if (/^(?:rg|grep|find|fd|ls)\b/.test(command)) return "正在查找项目文件与代码";
  if (/^(?:cat|sed|head|tail)\b/.test(command)) return "正在阅读项目文件";
  if (/^git\s+(?:status|diff|log|show|branch)\b/.test(command)) return "正在检查分支与代码改动";
  if (/^(?:pnpm|npm|yarn|bun|npx)\b/.test(command)) {
    if (/\b(?:test|vitest|jest)\b/.test(command)) return "正在运行测试";
    if (/\b(?:typecheck|tsc)\b/.test(command)) return "正在检查类型";
    if (/\b(?:lint|eslint)\b/.test(command)) return "正在检查代码规范";
    if (/\bbuild\b/.test(command)) return "正在构建项目";
    if (/\b(?:install|add)\b/.test(command)) return "正在准备项目依赖";
  }
  if (/^xcodebuild\b/.test(command)) return "正在构建 iOS 应用";
  if (/^(?:python[\d.]*|node|ruby)\b/.test(command)) return "正在执行脚本";
  if (/^(?:curl|wget)\b/.test(command)) return "正在获取资料";
  return activityText(activity);
}

export function liveActivitySessionTask(session: SessionSummary, online = true): LiveActivityTask {
  const phase = classifySessionPhase(session, online);
  const subtitle = phase === "waiting_for_approval" || phase === "waiting_for_input"
    ? session.permission?.title ?? session.asyncQuestions?.[0]?.title ?? "需要你的确认"
    : phase === "completed" ? plainPreview(session.preview ?? "本轮任务已结束")
    : phase === "failed" ? plainPreview(session.preview ?? "执行出错，打开任务查看")
    : session.activity?.kind === "responding" && session.preview ? plainPreview(session.preview) : liveActivityProgress(session.activity);
  return { id: session.id, kind: "session", phase, title: sessionTitle(session), subtitle,
    project: baseName(session.worktree?.source ?? session.cwd), agent: session.agent };
}

export function liveActivityTerminalTask(terminal: TerminalInfo, online = true): LiveActivityTask {
  const state = terminalState(terminal);
  return { id: terminal.id, kind: "terminal", phase: !online ? "stale" : state.failed ? "failed" : state.busy ? "running" : "completed",
    title: state.title, subtitle: state.detail, project: baseName(terminal.cwd), agent: "terminal" };
}

/**
 * Builds the aggregated single-card iOS Live Activity / Dynamic Island payload
 * for a computer. New progress brings its task and agent to the front together.
 */
export function buildLiveActivitySnapshot(
  computerName: string,
  sessions: SessionSummary[],
  terminals: TerminalInfo[],
  online: boolean,
  computerKey = "",
  goals: Record<string, { status: string; objective: string }> = {},
): LiveActivityPayload {
  const live = sessions.filter((s) => !s.archived);
  const waiting = live.filter((s) => needsAttention(s));
  const failed = live.filter((s) => !needsAttention(s) && s.state === "error");
  const runningSessions = live.filter((s) => !needsAttention(s) && s.state === "running");
  const busyTerminals = terminals.filter((t) => terminalState(t).busy)
    .sort((a, b) => b.activeAt - a.activeAt || a.id.localeCompare(b.id));
  const runningCount = runningSessions.length + busyTerminals.length;

  const candidates = [...waiting, ...failed, ...runningSessions].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    const pa = phasePriority(classifySessionPhase(a, online));
    const pb = phasePriority(classifySessionPhase(b, online));
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });

  const hero = candidates[0];
  if (!hero && busyTerminals.length === 0) {
    return { active: false, computerName };
  }

  // Keep the featured task first; one icon represents every task using the same agent.
  const agents = [...new Set([
    ...candidates.map((session) => ({ agent: session.agent, at: session.updatedAt })),
    ...busyTerminals.map((terminal) => ({ agent: "terminal", at: terminal.activeAt })),
  ].sort((a, b) => b.at - a.at).map((item) => item.agent))];
  const tasks = [
    ...candidates.map((session) => ({ task: liveActivitySessionTask(session, online), at: session.createdAt })),
    ...busyTerminals.map((terminal) => ({ task: liveActivityTerminalTask(terminal, online), at: terminal.createdAt })),
  ].sort((a, b) => a.at - b.at || a.task.id.localeCompare(b.task.id)).map(({ task }) => task);

  if (hero && (!busyTerminals[0] || hero.updatedAt >= busyTerminals[0].activeAt)) {
    const phase = classifySessionPhase(hero, online);
    const heroGoal = goals[hero.id];
    const subtitle =
      phase === "waiting_for_approval" || phase === "waiting_for_input"
        ? hero.permission?.title ?? hero.asyncQuestions?.[0]?.title ?? "需要你的确认"
        : phase === "failed"
          ? hero.preview
            ? plainPreview(hero.preview)
            : "上一轮执行出错"
          : heroGoal?.status === "active" && !hero.activity
            ? `目标 · ${heroGoal.objective}`
            : hero.activity?.kind === "responding" && hero.preview
              ? plainPreview(hero.preview)
              : liveActivityProgress(hero.activity);

    return {
      active: true,
      computerName,
      phase,
      title: sessionTitle(hero),
      subtitle,
      project: baseName(hero.worktree?.source ?? hero.cwd),
      agent: hero.agent,
      agents,
      tasks,
      ...(online ? liveActivityActions(hero, computerKey) : { actions: [], hasMoreActions: false }),
      waitingCount: waiting.length,
      runningCount,
      failedCount: failed.length,
      deepLink: liveActivityDetailLink(computerKey, "session", hero.id),
    };
  }

  const busy = busyTerminals[0]!;
  const tState = terminalState(busy);
  return {
    active: true,
    computerName,
    phase: online ? "running" : "stale",
    title: tState.title || "终端运行中",
    subtitle: tState.detail || baseName(busy.cwd),
    project: baseName(busy.cwd),
    agent: "terminal",
    agents,
    tasks,
    waitingCount: waiting.length,
    runningCount,
    failedCount: failed.length,
    deepLink: liveActivityDetailLink(computerKey, "terminal", busy.id),
  };
}

