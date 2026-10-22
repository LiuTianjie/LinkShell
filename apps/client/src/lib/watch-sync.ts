import type { ClientActions, HostLink, PromptProgress, SessionView, TimelineItem } from "@linkshell/client-core";
import {
  buildWatchSnapshot,
  cleanToolTitle,
  cutWatchBytes,
  isWatchCommandCurrent,
  plainPreview,
  sortWatchTerminals,
  tidyCommand,
  WATCH_FOCUSED_ITEMS,
  WATCH_MAX_ITEMS,
  WATCH_TERMINAL_LIMIT,
  watchPlainText,
  watchTimelineText,
  type AgentInfo,
  type ContentBlock,
  type ProjectSummary,
  type SessionSummary,
  type TerminalInfo,
  type ToolCallContent,
  type WatchCommand,
  type WatchComputer,
  type WatchConfigOption,
  type WatchSnapshot,
  type WatchTimelineItem,
  type WatchWorkspace,
} from "@linkshell/wire";
import { useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import {
  completeNativeWatchCommand,
  consumeNativeWatchCommand,
  getNativeWatchStatus,
  pendingNativeWatchCommandId,
  subscribeNativeWatchCommands,
  subscribeNativeWatchStatus,
  syncNativeWatchSnapshot,
  WatchCommandRejected,
  type NativeWatchStatus,
} from "../../modules/link-layout";
import { mergeLiveViewsIntoSessions, usePinnedSessionIds } from "./session-attention";
import { holdTerminal } from "./terminal-attach";

/* eslint-disable no-control-regex -- Terminal output contains ANSI escapes and backspace control bytes. */
export function stripTerminalAnsi(raw: string): string {
  if (!raw) return "";
  let cleaned = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[=>@-_]/g, "")
    .replace(/[\uE000-\uF8FF]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  while (/[^\n\x08]\x08/.test(cleaned)) {
    cleaned = cleaned.replace(/[^\n\x08]\x08/g, "");
  }
  cleaned = cleaned.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const lines = cleaned
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "%")
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1]!.length > 0));
  return lines.slice(-30).join("\n").slice(-1600);
}
/* eslint-enable no-control-regex */

function cleanBase64Image(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^data:[^;]+;base64,/i, "");
  if (!trimmed || trimmed.length > 12_000) return undefined;
  return trimmed;
}

function fileBaseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

function summarizeDiffContent(content: ToolCallContent[]): {
  filePath: string;
  added: number;
  removed: number;
  preview: string;
} | null {
  for (const entry of content) {
    if (entry.type === "patch") {
      const lines = entry.diff.split("\n");
      let added = 0;
      let removed = 0;
      const bodyLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
        if (line.startsWith("+")) {
          added += 1;
          if (bodyLines.length < 8) bodyLines.push(line.slice(0, 80));
        } else if (line.startsWith("-")) {
          removed += 1;
          if (bodyLines.length < 8) bodyLines.push(line.slice(0, 80));
        }
      }
      return {
        filePath: entry.path,
        added,
        removed,
        preview: bodyLines.join("\n").slice(0, 320),
      };
    }
    if (entry.type === "diff") {
      const oldLines = (entry.oldText ?? "").split("\n").filter(Boolean);
      const newLines = (entry.newText ?? "").split("\n").filter(Boolean);
      const oldSet = new Set(oldLines);
      const newSet = new Set(newLines);
      const removedLines = oldLines.filter((l) => !newSet.has(l));
      const addedLines = newLines.filter((l) => !oldSet.has(l));
      const preview = [
        ...removedLines.slice(0, 4).map((l) => `- ${l.trim().slice(0, 72)}`),
        ...addedLines.slice(0, 4).map((l) => `+ ${l.trim().slice(0, 72)}`),
      ]
        .join("\n")
        .slice(0, 320);
      return {
        filePath: entry.path,
        added: addedLines.length,
        removed: removedLines.length,
        preview,
      };
    }
  }
  return null;
}

function extractImageBlocks(blocks: ContentBlock[] | undefined): {
  base64?: string;
  mimeType?: string;
  count: number;
} {
  if (!blocks?.length) return { count: 0 };
  const images = blocks.filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image");
  if (!images.length) return { count: 0 };
  const firstWithData = images.find((img) => cleanBase64Image(img.data));
  return {
    base64: cleanBase64Image(firstWithData?.data),
    mimeType: (firstWithData ?? images[0])?.mimeType,
    count: images.length,
  };
}

/**
 * Whole messages, line breaks and code included; the snapshot's byte budget decides how
 * much of each reaches the watch (several KB for the open conversation, a line for others).
 */
function messageText(raw: string): string {
  return cutWatchBytes(watchTimelineText(raw), 8_000);
}

export function cleanUserMessageText(raw: string): string {
  if (!raw) return "";
  let cleaned = raw.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, "").trim();
  const userReq = cleaned.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (userReq?.[1]) {
    cleaned = userReq[1].trim();
  }
  const origTask = cleaned.match(/<original_task>([\s\S]*?)<\/original_task>/i);
  if (origTask?.[1]) {
    cleaned = origTask[1].trim();
  }
  const replyMatch = cleaned.match(/<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/i);
  if (replyMatch?.[1]) {
    try {
      const parsed = JSON.parse(replyMatch[1].trim());
      if (Array.isArray(parsed)) {
        const parts = parsed
          .map((entry) => {
            const ans = Array.isArray(entry?.answers) ? entry.answers.join(" / ") : "";
            const q = typeof entry?.question === "string" ? entry.question : "";
            return ans ? (q ? `${q} → ${ans}` : ans) : "";
          })
          .filter(Boolean);
        if (parts.length > 0) return parts.join("\n");
      }
    } catch {
      // Ignore JSON parse error
    }
  }
  return cleaned.trim();
}

export function sliceWatchTimelineWithUserContext(
  items: WatchTimelineItem[],
  maxItems = 14,
): WatchTimelineItem[] {
  if (items.length <= maxItems) return items;
  const tail = items.slice(-maxItems);
  if (tail.some((item) => item.kind === "user")) {
    return tail;
  }
  const earlierUsers = items
    .slice(0, items.length - maxItems)
    .filter((item) => item.kind === "user")
    .slice(-2);
  if (earlierUsers.length === 0) return tail;
  return [...earlierUsers, ...tail.slice(earlierUsers.length)];
}

export function extractAllWatchTimelineItems(view: SessionView | undefined): WatchTimelineItem[] {
  if (!view?.items?.length) return [];
  const result: WatchTimelineItem[] = [];
  for (const item of view.items as TimelineItem[]) {
    if (item.kind === "user") {
      const rawText = item.blocks
        .map((block) => (block.type === "text" ? block.text : block.type === "resource_link" ? block.name || block.uri : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      const text = cleanUserMessageText(rawText);
      const img = extractImageBlocks(item.blocks);
      if (!text && img.count === 0) continue;
      result.push({
        id: item.id,
        kind: img.count > 0 && !text ? "image" : "user",
        title: img.count > 0 ? `你 · 附图(${img.count})` : "你",
        text: messageText(text) || `发送了 ${img.count} 张图片`,
        ...(img.base64 ? { imageBase64: img.base64, imageMimeType: img.mimeType } : {}),
        status: item.failed ? "failed" : item.pending ? "running" : "completed",
      });
    } else if (item.kind === "agent") {
      const text = messageText(item.text);
      const img = extractImageBlocks(item.attachments);
      if (text || img.count > 0) {
        result.push({
          id: item.id,
          kind: img.count > 0 && !text ? "image" : "assistant",
          title: img.count > 0 ? `Agent · 附图(${img.count})` : "Agent",
          text: text || `生成了 ${img.count} 张图片`,
          ...(img.base64 ? { imageBase64: img.base64, imageMimeType: img.mimeType } : {}),
          status: item.streaming ? "running" : "completed",
        });
      }
      if (item.questions?.length) {
        for (const q of item.questions.slice(0, 2)) {
          result.push({
            id: `${item.id}:q:${q.id}`,
            kind: "question",
            title: "Agent 提问",
            text: q.title.slice(0, 280),
            ...(q.options?.length
              ? { detail: q.options.map((opt) => `• ${opt}`).join("\n").slice(0, 220) }
              : {}),
            status: "waiting",
          });
        }
      }
    } else if (item.kind === "thought") {
      // Thoughts show as plain Text on the watch; answers are rendered as markdown.
      const text = cutWatchBytes(watchPlainText(item.text), 2_000);
      if (!text) continue;
      result.push({
        id: item.id,
        kind: "thought",
        title: "思考",
        text,
        status: item.streaming ? "running" : "completed",
      });
    } else if (item.kind === "tool") {
      const toolStatus =
        item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : "running";

      // 1. Subagent call
      if (item.detail?.type === "subagent" || item.sub) {
        const subDetail = item.detail?.type === "subagent" ? item.detail : undefined;
        const subType = subDetail?.agentType || "Subagent";
        const subName = subDetail?.name;
        const subModel = subDetail?.model;
        const taskText =
          subDetail?.task?.trim() || cleanToolTitle(item.title) || item.name || "执行子代理任务";
        let subOutput = stripTerminalAnsi(item.output);
        if (!subOutput && item.sub?.items?.length) {
          for (let i = item.sub.items.length - 1; i >= 0; i -= 1) {
            const subItem = item.sub.items[i]!;
            if (subItem.kind === "agent" && subItem.text.trim()) {
              subOutput = plainPreview(subItem.text).trim();
              break;
            }
            if (subItem.kind === "tool" && subItem.title) {
              subOutput = `正在执行: ${cleanToolTitle(subItem.title)}`;
              break;
            }
          }
        }
        result.push({
          id: item.id,
          kind: "subagent",
          title: subName ? `子代理 · ${subName}` : `子代理 · ${subType}`,
          text: taskText.slice(0, 240),
          ...(subOutput ? { detail: subOutput.slice(-800) } : {}),
          subagentType: subType.slice(0, 48),
          ...(subName ? { subagentName: subName.slice(0, 48) } : {}),
          ...(subModel ? { subagentModel: subModel.slice(0, 64) } : {}),
          status: subDetail?.state === "running" ? "running" : toolStatus,
        });
        continue;
      }

      // 2. File Edit / Diff
      const diffInfo = summarizeDiffContent(item.content);
      if (diffInfo || item.toolKind === "edit") {
        const pathStr = diffInfo?.filePath || item.locations?.[0]?.path || cleanToolTitle(item.title) || "文件修改";
        const shortFile = fileBaseName(pathStr);
        const detailText = diffInfo?.preview || stripTerminalAnsi(item.output);
        result.push({
          id: item.id,
          kind: "diff",
          title: "文件修改",
          text: shortFile.slice(0, 120),
          filePath: pathStr.slice(0, 180),
          ...(diffInfo ? { diffAdded: diffInfo.added, diffRemoved: diffInfo.removed } : {}),
          ...(detailText ? { detail: detailText.slice(0, 320) } : {}),
          status: toolStatus,
        });
        continue;
      }

      // 3. Regular Tool Call (command execution, search, read, MCP, etc.)
      const rawTitle = cleanToolTitle(item.title) || item.name || "工具调用";
      const cmdText = item.toolKind === "execute" ? tidyCommand(rawTitle) : rawTitle;
      const out = stripTerminalAnsi(item.output);
      const toolImages = extractImageBlocks(
        item.content.flatMap((c) => (c.type === "content" ? [c.content] : [])),
      );
      result.push({
        id: item.id,
        kind: "tool",
        title:
          item.detail?.type === "mcp"
            ? `MCP · ${item.detail.server}`
            : item.toolKind === "execute"
              ? "执行命令"
              : item.toolKind === "search"
                ? "搜索代码"
                : item.toolKind === "read"
                  ? "读取文件"
                  : "工具调用",
        text: cmdText.slice(0, 200),
        ...(out ? { detail: out.slice(-1_200) } : {}),
        ...(toolImages.base64
          ? { imageBase64: toolImages.base64, imageMimeType: toolImages.mimeType }
          : {}),
        status: toolStatus,
      });
    } else if (item.kind === "plan" && item.entries.length > 0) {
      const text = item.entries
        .slice(0, 8)
        .map((e) => `${e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"} ${e.content}`)
        .join("\n");
      result.push({
        id: item.id,
        kind: "plan",
        title: item.title || "执行计划",
        text: text.slice(0, 360),
        status: item.entries.every((e) => e.status === "completed") ? "completed" : "running",
      });
    } else if (item.kind === "permission-result") {
      if (item.asked && item.answers?.length) {
        result.push({
          id: item.id,
          kind: "question",
          title: item.title.slice(0, 80) || "已回答问题",
          text: item.answers.map((a) => `${a.question}: ${a.answer}`).join("\n").slice(0, 280),
          status: "completed",
        });
      } else {
        result.push({
          id: item.id,
          kind: "permission",
          title: item.title.slice(0, 80),
          text: item.optionName ? `已选择：${item.optionName}` : item.allowed === false ? "已拒绝" : "已允许",
          status: item.allowed === false ? "failed" : "completed",
        });
      }
    } else if (item.kind === "error") {
      result.push({
        id: item.id,
        kind: "error",
        title: "错误",
        text: item.message.slice(0, 280),
        ...(item.hint ? { detail: item.hint.slice(0, 160) } : {}),
        status: "failed",
      });
    }
  }
  return result;
}

export function extractWatchTimelineItems(
  view: SessionView | undefined,
  maxItems = 14,
): WatchTimelineItem[] {
  const all = extractAllWatchTimelineItems(view);
  return maxItems > 14 ? all.slice(-maxItems) : sliceWatchTimelineWithUserContext(all, maxItems);
}

export interface BuildClientWatchSnapshotInput {
  computerKey: string;
  computerName: string;
  sessions: SessionSummary[];
  terminals: TerminalInfo[];
  online: boolean;
  views?: Record<string, SessionView>;
  promptProgress?: Record<string, PromptProgress>;
  computers?: WatchComputer[];
  pinnedSessionIds?: string[];
  agents?: AgentInfo[];
  projects?: ProjectSummary[];
  homeDir?: string;
  terminalOutputs?: Record<string, string>;
  itemLimits?: Record<string, number>;
  /** The session the watch last opened. */
  focusedSessionId?: string;
  now?: number;
}

export function buildClientWatchSnapshot(input: BuildClientWatchSnapshotInput): WatchSnapshot {
  const merged = mergeLiveViewsIntoSessions(input.sessions, input.views, input.promptProgress);
  const goals = Object.fromEntries(
    Object.entries(input.views ?? {}).flatMap(([id, view]) =>
      view.goal ? [[id, { status: view.goal.status, objective: view.goal.objective }]] : [],
    ),
  );
  const plans = Object.fromEntries(
    Object.entries(input.views ?? {}).flatMap(([id, view]) => {
      let entries: { content: string; status: "pending" | "in_progress" | "completed" }[] | undefined;
      if (view.planId !== undefined && view.index[view.planId] !== undefined) {
        const indexed = view.items[view.index[view.planId]!];
        if (indexed?.kind === "plan" && indexed.entries.length > 0) {
          entries = indexed.entries;
        }
      }
      if (!entries) {
        for (let i = view.items.length - 1; i >= 0; i -= 1) {
          const item = view.items[i];
          if (item?.kind === "plan" && item.entries.length > 0) {
            entries = item.entries;
            break;
          }
        }
      }
      if (!entries || entries.length === 0) return [];
      const completed = entries.filter((e) => e.status === "completed").length;
      const active = entries.find((e) => e.status === "in_progress") ?? entries.find((e) => e.status === "pending");
      return [
        [
          id,
          {
            completed,
            total: entries.length,
            ...(active?.content ? { currentStep: active.content } : {}),
          },
        ],
      ];
    }),
  );
  const timelines: Record<string, WatchTimelineItem[]> = {};
  const hasEarlier: Record<string, boolean> = {};
  for (const [id, view] of Object.entries(input.views ?? {})) {
    const allItems = extractAllWatchTimelineItems(view);
    const limit =
      id === input.focusedSessionId
        ? Math.min(WATCH_MAX_ITEMS, Math.max(WATCH_FOCUSED_ITEMS, input.itemLimits?.[id] ?? 0))
        : (input.itemLimits?.[id] ?? 14);
    const sliced = limit > 14 ? allItems.slice(-limit) : sliceWatchTimelineWithUserContext(allItems, limit);
    if (sliced.length > 0) {
      timelines[id] = sliced;
    }
    if (allItems.length > sliced.length || (view.startSeq ?? 0) > 0) {
      hasEarlier[id] = true;
    }
  }
  const modes: Record<string, string> = {};
  const configs: Record<string, WatchConfigOption[]> = {};
  for (const session of merged) {
    const view = input.views?.[session.id];
    if (view?.config?.length) {
      const mapped: WatchConfigOption[] = view.config.slice(0, 4).map((opt) => {
        const curVal = opt.values.find((v) => v.value === opt.current);
        return {
          id: opt.id,
          name: opt.name,
          category: opt.category,
          current: opt.current,
          ...(curVal?.name ? { currentLabel: curVal.name } : {}),
          values: opt.values.slice(0, 8).map((v) => ({
            value: v.value,
            name: v.name,
            ...(v.description ? { description: v.description } : {}),
          })),
        };
      });
      configs[session.id] = mapped;
      const modeOpt = mapped.find((c) => c.category === "mode" || c.id === "mode" || c.id === "sandbox");
      if (modeOpt) modes[session.id] = modeOpt.currentLabel || modeOpt.current;
    }
    // Without the agent's own list the watch offers no settings: guessed models or modes would
    // be refused by the host, or show a mode the session isn't in.
  }

  const agentTiers = Object.fromEntries((input.agents ?? []).map((agent) => [agent.id, agent.tier]));
  const availableAgents = (input.agents ?? [])
    .filter((agent) => agent.installed !== false && agent.tier !== "terminal")
    .map((agent) => agent.id);

  const workspaces: WatchWorkspace[] = [];
  for (const proj of input.projects ?? []) {
    if (proj.cwd) {
      const parts = proj.cwd.split(/[\\/]/).filter(Boolean);
      workspaces.push({ path: proj.cwd, name: parts[parts.length - 1] ?? proj.cwd });
    }
  }
  if (input.homeDir) {
    const parts = input.homeDir.split(/[\\/]/).filter(Boolean);
    workspaces.push({ path: input.homeDir, name: parts[parts.length - 1] ?? input.homeDir });
  }

  return buildWatchSnapshot(input.computerName, merged, input.terminals, input.online, {
    computerKey: input.computerKey,
    computers: input.computers,
    pinnedSessionIds: input.pinnedSessionIds,
    goals,
    plans,
    timelines,
    hasEarlier,
    itemLimits: input.itemLimits,
    modes,
    configs,
    terminalOutputs: input.terminalOutputs,
    availableAgents,
    workspaces,
    agentTiers,
    focusedSessionId: input.focusedSessionId,
    now: input.now,
  });
}

export type WatchActionContext = {
  computerKey: string;
  online: boolean;
  sessions: Record<string, SessionSummary>;
  views?: Record<string, SessionView>;
  computers: WatchComputer[];
  selectComputer: (computerKey: string) => void;
  actions: Pick<
    ClientActions,
    | "respond"
    | "answer"
    | "answerAsync"
    | "send"
    | "cancel"
    | "takeover"
    | "release"
    | "refresh"
    | "openSession"
    | "createSession"
  > & {
    setConfig?: ClientActions["setConfig"];
    loadEarlier?: ClientActions["loadEarlier"];
  };
  /** The connection's refcounted subscribe; without it sessions are opened and never closed. */
  subscribeSession?: (sessionId: string) => () => void;
  /** Makes a session the watch's open one: subscribed, and given the largest share of the snapshot. */
  focusSession?: (sessionId: string) => void;
  /** Reconnects when offline; resolves whether the computer came back within the wait. */
  ensureOnline?: (timeoutMs: number) => Promise<boolean>;
  /** Reconnects the gateways too (the host link rides on one). */
  reconnect?: () => void;
  onExpandTimeline?: (sessionId: string) => number;
  createTerminal?: (input: { cwd?: string; command?: string }) => Promise<TerminalInfo>;
  openTerminal?: (terminalId: string) => Promise<void>;
  terminalInput?: (terminalId: string, data: string) => Promise<void>;
  closeTerminal?: (terminalId: string) => Promise<void>;
};

/** Short enough to answer inside the watch's 15 s command timeout. */
const WATCH_RECONNECT_WAIT_MS = 5_000;

export async function executeWatchCommand(
  command: WatchCommand,
  ctx: WatchActionContext,
): Promise<{ ok: boolean; message: string }> {
  try {
    if (command.kind === "select-computer") {
      const target = ctx.computers.find((item) => item.key === command.computerKey);
      if (!target) return { ok: false, message: "未找到这台电脑" };
      ctx.selectComputer(command.computerKey);
      return { ok: true, message: `已切换到 ${target.name}` };
    }

    // A watch command is often what wakes the phone, and the link's own retry timer
    // doesn't run while the app is suspended: reconnect now instead of waiting for it.
    let online = ctx.online;
    if (!online && ctx.ensureOnline) online = await ctx.ensureOnline(WATCH_RECONNECT_WAIT_MS);

    if (command.kind === "refresh") {
      if (!online) return { ok: false, message: "暂时连不上电脑，请确认电脑在线后重试" };
      await ctx.actions.refresh();
      return { ok: true, message: "已同步最新状态" };
    }

    if (!online) {
      return { ok: false, message: "电脑当前不在线，请稍后重试" };
    }

    if (command.kind === "open-session") {
      if (!isWatchCommandCurrent(command, ctx.computerKey, ctx.sessions[command.sessionId])) {
        return { ok: false, message: "无法打开该会话" };
      }
      if (ctx.focusSession) ctx.focusSession(command.sessionId);
      else ctx.actions.openSession?.(command.sessionId);
      return { ok: true, message: "已加载会话详情" };
    }

    if (command.kind === "load-earlier") {
      if (!isWatchCommandCurrent(command, ctx.computerKey, ctx.sessions[command.sessionId])) {
        return { ok: false, message: "无法加载更早消息" };
      }
      ctx.focusSession?.(command.sessionId);
      const nextLimit = ctx.onExpandTimeline ? ctx.onExpandTimeline(command.sessionId) : 28;
      const view = ctx.views?.[command.sessionId];
      const currentCount = view ? extractAllWatchTimelineItems(view).length : 0;
      if (ctx.actions.loadEarlier && (!view || (currentCount < nextLimit && (view.startSeq ?? 0) > 0))) {
        await ctx.actions.loadEarlier(command.sessionId);
      }
      return { ok: true, message: "已加载更早消息" };
    }

    if (command.kind === "create-session") {
      if (!isWatchCommandCurrent(command, ctx.computerKey, undefined)) {
        return { ok: false, message: "新建会话参数无效" };
      }
      if (!ctx.actions.createSession) {
        return { ok: false, message: "当前客户端不支持新建会话" };
      }
      const promptText = command.prompt?.trim();
      const created = await ctx.actions.createSession({
        agent: command.agent,
        cwd: command.cwd,
        ...(promptText ? { prompt: [{ type: "text", text: promptText }] } : {}),
      });
      if (ctx.focusSession) ctx.focusSession(created.id);
      else ctx.actions.openSession?.(created.id);
      return { ok: true, message: `已启动 ${command.agent} 会话` };
    }

    if (command.kind === "create-terminal") {
      if (!isWatchCommandCurrent(command, ctx.computerKey, undefined)) {
        return { ok: false, message: "新建终端参数无效" };
      }
      if (!ctx.createTerminal) {
        return { ok: false, message: "当前客户端不支持新建终端" };
      }
      const created = await ctx.createTerminal({
        cwd: command.cwd,
        command: command.command?.trim() || undefined,
      });
      await ctx.openTerminal?.(created.id);
      return { ok: true, message: "已新建终端" };
    }

    if (command.kind === "open-terminal") {
      if (!isWatchCommandCurrent(command, ctx.computerKey, undefined)) {
        return { ok: false, message: "无法打开该终端" };
      }
      await ctx.openTerminal?.(command.terminalId);
      return { ok: true, message: "已同步终端输出" };
    }

    if (command.kind === "terminal-input") {
      if (!isWatchCommandCurrent(command, ctx.computerKey, undefined)) {
        return { ok: false, message: "终端指令无效" };
      }
      if (!ctx.terminalInput) {
        return { ok: false, message: "当前客户端不支持终端输入" };
      }
      await ctx.terminalInput(command.terminalId, command.data);
      return { ok: true, message: command.data === "\u0003" ? "已发送中断 (Ctrl+C)" : "已发送终端命令" };
    }

    if (command.kind === "close-terminal") {
      if (!isWatchCommandCurrent(command, ctx.computerKey, undefined)) {
        return { ok: false, message: "无法关闭该终端" };
      }
      if (!ctx.closeTerminal) {
        return { ok: false, message: "当前客户端不支持关闭终端" };
      }
      await ctx.closeTerminal(command.terminalId);
      return { ok: true, message: "已关闭终端" };
    }

    const sessionId = command.kind === "action" ? command.action.sessionId : command.sessionId;
    const session = ctx.sessions[sessionId];
    const permissions = ctx.views?.[sessionId]?.permissions ?? [];

    if (!isWatchCommandCurrent(command, ctx.computerKey, session, permissions)) {
      return { ok: false, message: "任务状态或选项已变化，请刷新后重试" };
    }
    // Approvals also come from the overview; everything else is sent from the session's own page.
    if (command.kind !== "action") ctx.focusSession?.(sessionId);

    switch (command.kind) {
      case "action": {
        const { action } = command;
        if (action.kind === "permission") {
          await ctx.actions.respond(session!.id, action.requestId, action.optionId);
          return { ok: true, message: `已处理：${action.label}` };
        }
        if (action.kind === "answer") {
          await ctx.actions.answer(session!.id, action.requestId, [
            { id: action.questionId!, values: [action.optionId] },
          ]);
          return { ok: true, message: `已回答：${action.label}` };
        }
        const question = session!.asyncQuestions?.find((item) => item.id === action.requestId);
        if (!question) return { ok: false, message: "问题已处理或已过期" };
        await ctx.actions.answerAsync(session!.id, question, action.optionId);
        return { ok: true, message: `已回答：${action.label}` };
      }
      case "prompt": {
        const pendingQ = session!.permission?.questions?.[0];
        if (session!.state === "waiting" && session!.permission && pendingQ && pendingQ.kind === "text") {
          await ctx.actions.answer(session!.id, session!.permission.requestId, [
            { id: pendingQ.id, values: [command.text.trim()] },
          ]);
          return { ok: true, message: "已提交回答" };
        }
        const delivery = await ctx.actions.send(
          session!.id,
          [{ type: "text", text: command.text.trim() }],
          // The command's id is stable across the watch's retries: the host delivers it once.
          { now: command.now, clientMessageId: command.id },
        );
        if (delivery === "failed") return { ok: false, message: "发送失败，请稍后重试" };
        return {
          ok: true,
          message: delivery === "queued" ? "已加入会话队列" : "已发送给 Agent",
        };
      }
      case "set-config": {
        if (!ctx.actions.setConfig) {
          return { ok: false, message: "当前客户端不支持修改配置" };
        }
        await ctx.actions.setConfig(session!.id, command.optionId, command.value);
        return { ok: true, message: `已更新会话配置：${command.value}` };
      }
      case "cancel": {
        await ctx.actions.cancel(session!.id);
        return { ok: true, message: "已停止当前轮次" };
      }
      case "takeover": {
        await ctx.actions.takeover(session!.id);
        return { ok: true, message: "已在腕表接管会话" };
      }
      case "release": {
        await ctx.actions.release(session!.id);
        return { ok: true, message: "已交还电脑终端" };
      }
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "操作未能完成，请在手机上查看",
    };
  }
}

export function useWatchStatus(): {
  status: NativeWatchStatus;
  refreshStatus: () => Promise<NativeWatchStatus>;
} {
  const [status, setStatus] = useState<NativeWatchStatus>({
    supported: false,
    paired: false,
    installed: false,
    reachable: false,
  });

  const refreshStatus = async () => {
    if (Platform.OS !== "ios") return status;
    const next = await getNativeWatchStatus();
    setStatus(next);
    return next;
  };

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let active = true;
    void getNativeWatchStatus().then((next) => {
      if (active) setStatus(next);
    });
    const off = subscribeNativeWatchStatus((next) => {
      if (active) setStatus(next);
    });
    const appSub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void getNativeWatchStatus().then((next) => {
          if (active) setStatus(next);
        });
      }
    });
    return () => {
      active = false;
      off();
      appSub.remove();
    };
  }, []);

  return { status, refreshStatus };
}

/** Content identity of a snapshot: the same state rebuilt later differs only in generatedAt. */
export function watchSnapshotKey(snapshot: WatchSnapshot): string {
  const { generatedAt: _generatedAt, ...content } = snapshot;
  return JSON.stringify(content);
}

export interface WatchSnapshotScheduler {
  /** Takes the latest builder; sends after a quiet spell, or at once if nothing was sent yet. */
  schedule(build: () => WatchSnapshot): void;
  /** Sends now when the content changed (or the last send is getting old). */
  flush(): Promise<boolean>;
  /** Waits for the next schedule (React committing what a command changed), then flushes. */
  flushAfterUpdate(timeoutMs: number): Promise<boolean>;
  dispose(): void;
}

/**
 * Streaming agent output changes the views many times a second; each snapshot is a
 * full bounded rebuild and a WatchConnectivity transfer. Trailing debounce with a
 * maximum wait, and nothing sent when only the timestamp would change.
 */
export function createWatchSnapshotScheduler(
  send: (snapshot: WatchSnapshot) => Promise<unknown>,
  options: { delayMs?: number; maxWaitMs?: number; refreshMs?: number } = {},
): WatchSnapshotScheduler {
  const delayMs = options.delayMs ?? 400;
  const maxWaitMs = options.maxWaitMs ?? 1_500;
  // The watch calls a snapshot stale after 10 minutes; an unchanged one is resent well before.
  const refreshMs = options.refreshMs ?? 4 * 60_000;
  let build: (() => WatchSnapshot) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstPendingAt: number | undefined;
  let lastKey: string | undefined;
  let lastSentAt = 0;
  const waiters = new Set<() => void>();

  const flush = async (): Promise<boolean> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    firstPendingAt = undefined;
    if (!build) return false;
    const snapshot = build();
    const key = watchSnapshotKey(snapshot);
    if (key === lastKey && Date.now() - lastSentAt < refreshMs) return false;
    lastKey = key;
    lastSentAt = Date.now();
    try {
      await send(snapshot);
      return true;
    } catch {
      // Let the next change (or heartbeat) try again rather than deduping against a failed send.
      if (lastKey === key) lastKey = undefined;
      return false;
    }
  };

  return {
    schedule(next) {
      build = next;
      for (const wake of [...waiters]) wake();
      if (lastKey === undefined) {
        void flush();
        return;
      }
      const now = Date.now();
      firstPendingAt ??= now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), Math.max(0, Math.min(delayMs, firstPendingAt + maxWaitMs - now)));
    },
    flush,
    flushAfterUpdate(timeoutMs) {
      if (!build) return Promise.resolve(false);
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(wait);
          waiters.delete(done);
          resolve();
        };
        const wait = setTimeout(done, timeoutMs);
        waiters.add(done);
      }).then(flush);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      for (const wake of [...waiters]) wake();
      build = undefined;
    },
  };
}

/** Resolves true once the link is online, false after `timeoutMs` or when it stops. */
export function waitForLinkOnline(link: Pick<HostLink, "status" | "onStatus">, timeoutMs: number): Promise<boolean> {
  if (link.status === "online") return Promise.resolve(true);
  return new Promise((resolve) => {
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, timeoutMs);
    off = link.onStatus((status) => {
      if (status !== "online" && status !== "stopped") return;
      clearTimeout(timer);
      off();
      resolve(status === "online");
    });
  });
}

/**
 * Results of commands already answered. The watch retries with the same id when a reply
 * is lost; a late retry gets the earlier answer instead of running the command again.
 * Module-wide, so it also survives a remount on computer switch.
 */
const completedWatchCommands = new Map<string, { ok: boolean; message: string; at: number }>();
const COMPLETED_TTL_MS = 10 * 60_000;
const COMPLETED_MAX = 200;

function completedWatchCommand(id: string): { ok: boolean; message: string } | undefined {
  const entry = completedWatchCommands.get(id);
  if (!entry) return undefined;
  if (Date.now() - entry.at > COMPLETED_TTL_MS) {
    completedWatchCommands.delete(id);
    return undefined;
  }
  return entry;
}

function rememberWatchCommand(id: string, result: { ok: boolean; message: string }): void {
  completedWatchCommands.delete(id);
  completedWatchCommands.set(id, { ...result, at: Date.now() });
  // Insertion order is age order: drop the oldest past the bound.
  for (const key of completedWatchCommands.keys()) {
    if (completedWatchCommands.size <= COMPLETED_MAX) break;
    completedWatchCommands.delete(key);
  }
}

/** Sessions kept subscribed for the watch besides the one it has open (each one streams). */
const WATCH_AUTO_OPEN = 4;

export function useIOSWatchSync(
  input: Omit<BuildClientWatchSnapshotInput, "pinnedSessionIds" | "focusedSessionId">,
  ctx: WatchActionContext,
  enabled = true,
  link?: HostLink,
  /** Overrides the native status (tests, the simulator bridge). */
  watchInstalledOverride?: boolean,
) {
  const {
    computerKey,
    computerName,
    sessions,
    terminals,
    online,
    views,
    promptProgress,
    computers,
    agents,
    projects,
    homeDir,
    now,
  } = input;
  const pinned = usePinnedSessionIds();
  const { status: watchStatus } = useWatchStatus();
  const watchInstalled = watchInstalledOverride ?? (watchStatus.paired && watchStatus.installed);
  const active = Platform.OS === "ios" && enabled && watchInstalled;
  const terminalGenerationRef = useRef(0);
  const [terminalOutputs, setTerminalOutputs] = useState<Record<string, string>>({});
  const [itemLimits, setItemLimits] = useState<Record<string, number>>({});
  const [focusedSessionId, setFocusedSessionId] = useState<string | undefined>(undefined);
  const focusedSessionRef = useRef<string | undefined>(undefined);
  const focusedTerminalRef = useRef<string | undefined>(undefined);
  const itemLimitsRef = useRef<Record<string, number>>({});
  const rawTerminalBuffersRef = useRef<Record<string, string>>({});
  const heldTerminalsRef = useRef<Map<string, () => void>>(new Map());
  const heldSessionsRef = useRef<Map<string, () => void>>(new Map());
  const schedulerRef = useRef<WatchSnapshotScheduler | null>(null);
  schedulerRef.current ??= createWatchSnapshotScheduler(syncNativeWatchSnapshot);
  const scheduler = schedulerRef.current;

  const attachForWatch = async (terminalId: string) => {
    if (!link) return;
    const generation = terminalGenerationRef.current;
    const res = await link.call("terminals.attach", { terminalId });
    if (generation !== terminalGenerationRef.current || !heldTerminalsRef.current.has(terminalId)) return;
    rawTerminalBuffersRef.current[terminalId] = (res.replay ?? "").slice(-8192);
    const cleaned = stripTerminalAnsi(rawTerminalBuffersRef.current[terminalId]!);
    setTerminalOutputs((prev) => (prev[terminalId] === cleaned ? prev : { ...prev, [terminalId]: cleaned }));
  };

  const ctxRef = useRef(ctx);
  ctxRef.current = {
    ...ctx,
    focusSession: (sessionId: string) => {
      if (focusedSessionRef.current === sessionId) return;
      focusedSessionRef.current = sessionId;
      setFocusedSessionId(sessionId);
    },
    ensureOnline: async (timeoutMs: number) => {
      if (!link) return ctx.online;
      if (link.status === "online") return true;
      if (link.status !== "connecting") {
        ctx.reconnect?.();
        link.reconnectNow();
      }
      return waitForLinkOnline(link, timeoutMs);
    },
    // The attach's replay is the terminal's current screen: it is what the watch opened it for.
    openTerminal: link
      ? async (terminalId: string) => {
          focusedTerminalRef.current = terminalId;
          if (!heldTerminalsRef.current.has(terminalId)) {
            heldTerminalsRef.current.set(terminalId, holdTerminal(link, terminalId));
          }
          await attachForWatch(terminalId);
        }
      : ctx.openTerminal,
    onExpandTimeline: (sessionId: string) => {
      const base = itemLimitsRef.current[sessionId] ?? (sessionId === focusedSessionRef.current ? WATCH_FOCUSED_ITEMS : 14);
      const next = Math.min(WATCH_MAX_ITEMS, base + 15);
      itemLimitsRef.current = { ...itemLimitsRef.current, [sessionId]: next };
      setItemLimits(itemLimitsRef.current);
      return next;
    },
  };

  // Terminal output for the terminals the watch shows; a new connection has no listeners
  // on the host, so they are attached again whenever the link comes back.
  useEffect(() => {
    if (!active || !link) return;
    const offOutput = link.on("terminal.output", ({ terminalId, data }) => {
      if (!data || !heldTerminalsRef.current.has(terminalId)) return;
      const nextRaw = ((rawTerminalBuffersRef.current[terminalId] ?? "") + data).slice(-8192);
      rawTerminalBuffersRef.current[terminalId] = nextRaw;
      const cleaned = stripTerminalAnsi(nextRaw);
      setTerminalOutputs((prev) => (prev[terminalId] === cleaned ? prev : { ...prev, [terminalId]: cleaned }));
    });
    const offOnline = link.onOnline(() => {
      for (const id of heldTerminalsRef.current.keys()) void attachForWatch(id).catch(() => {});
    });
    return () => {
      terminalGenerationRef.current += 1;
      offOutput();
      offOnline();
    };
    // attachForWatch only reads refs and the link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, link]);

  // Exactly the terminals the snapshot carries, held so the terminal screen's detach on
  // leaving doesn't end their stream (and released, detaching them, when they drop out).
  useEffect(() => {
    const held = heldTerminalsRef.current;
    const wanted = new Set<string>();
    if (active && link) {
      for (const terminal of sortWatchTerminals(terminals).slice(0, WATCH_TERMINAL_LIMIT)) wanted.add(terminal.id);
      const focused = focusedTerminalRef.current;
      if (focused && terminals.some((t) => t.id === focused)) wanted.add(focused);
    }
    for (const [id, release] of held) {
      if (wanted.has(id)) continue;
      release();
      held.delete(id);
      delete rawTerminalBuffersRef.current[id];
    }
    for (const id of wanted) {
      if (held.has(id) || !link) continue;
      held.set(id, holdTerminal(link, id));
      if (link.status === "online") void attachForWatch(id).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, link, terminals]);

  // Timelines come from subscribed sessions: the few most recent, and the one the watch
  // has open. Through the refcount, so a phone screen closing the same session doesn't
  // close it under the watch.
  useEffect(() => {
    const held = heldSessionsRef.current;
    const wanted = new Set<string>();
    if (active) {
      const live = sessions.filter((s) => !s.archived).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const s of live.slice(0, WATCH_AUTO_OPEN)) wanted.add(s.id);
      if (focusedSessionId && live.some((s) => s.id === focusedSessionId)) wanted.add(focusedSessionId);
    }
    for (const [id, release] of held) {
      if (wanted.has(id)) continue;
      release();
      held.delete(id);
    }
    const subscribe =
      ctx.subscribeSession ??
      ((id: string) => {
        ctx.actions.openSession(id);
        return () => {};
      });
    for (const id of wanted) if (!held.has(id)) held.set(id, subscribe(id));
  }, [active, sessions, focusedSessionId, ctx.subscribeSession, ctx.actions]);

  useEffect(
    () => () => {
      for (const release of heldSessionsRef.current.values()) release();
      heldSessionsRef.current.clear();
      for (const release of heldTerminalsRef.current.values()) release();
      heldTerminalsRef.current.clear();
      schedulerRef.current?.dispose();
    },
    [],
  );

  useEffect(() => {
    if (!active) return;
    scheduler.schedule(() =>
      buildClientWatchSnapshot({
        computerKey,
        computerName,
        sessions,
        terminals,
        online,
        views,
        promptProgress,
        computers,
        agents,
        projects,
        homeDir,
        terminalOutputs,
        itemLimits,
        focusedSessionId,
        now,
        pinnedSessionIds: pinned,
      }),
    );
  }, [
    active,
    scheduler,
    computerKey,
    computerName,
    sessions,
    terminals,
    online,
    views,
    promptProgress,
    computers,
    agents,
    projects,
    homeDir,
    terminalOutputs,
    itemLimits,
    focusedSessionId,
    now,
    pinned,
  ]);

  useEffect(() => {
    if (!active) return;
    const heartbeat = setInterval(() => {
      if (online) void scheduler.flush();
    }, 30_000);
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "inactive" || nextState === "background" || nextState === "active") {
        void scheduler.flush();
      }
    });
    return () => {
      clearInterval(heartbeat);
      sub.remove();
    };
  }, [active, online, scheduler]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let disposed = false;
    const inFlight = new Set<string>();

    const handleCommand = async ({ id }: { id: string }) => {
      if (disposed || !id || inFlight.has(id)) return;
      const earlier = completedWatchCommand(id);
      if (earlier) {
        // A retry of something already done: take it off the queue and answer as before.
        await consumeNativeWatchCommand(id).catch(() => null);
        await completeNativeWatchCommand(id, earlier.ok, earlier.message);
        return;
      }
      inFlight.add(id);
      try {
        const command = await consumeNativeWatchCommand(id);
        if (!command) {
          // Gone or expired on the native side; a reply that was already sent is not repeated.
          await completeNativeWatchCommand(id, false, "操作已过期，请在手表上重试");
          return;
        }
        const result = await executeWatchCommand(command, ctxRef.current);
        rememberWatchCommand(id, result);
        // Woken in the background, the phone may be suspended once the reply is out:
        // send the state the command produced first.
        await schedulerRef.current?.flushAfterUpdate(500);
        await completeNativeWatchCommand(id, result.ok, result.message);
      } catch (error) {
        const message = error instanceof WatchCommandRejected ? error.message : "处理手表指令时出错";
        if (error instanceof WatchCommandRejected) rememberWatchCommand(id, { ok: false, message });
        await completeNativeWatchCommand(id, false, message);
      } finally {
        inFlight.delete(id);
      }
    };

    let draining = false;
    const checkPending = async () => {
      if (draining || disposed) return;
      draining = true;
      try {
        const seen = new Set<string>();
        while (!disposed) {
          const id = await pendingNativeWatchCommandId();
          // A retry waiting behind its own running original is picked up once that finishes.
          if (!id || inFlight.has(id) || seen.has(id)) break;
          seen.add(id);
          await handleCommand({ id });
        }
      } catch {
        // Ignore transient bridge errors
      } finally {
        draining = false;
      }
    };

    const off = subscribeNativeWatchCommands((event) => {
      void handleCommand(event).then(() => checkPending());
    });
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void checkPending();
    });
    void checkPending();

    return () => {
      disposed = true;
      off();
      sub.remove();
    };
  }, []);
}
