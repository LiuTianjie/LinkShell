import type { ClientActions, HostLink, PromptProgress, SessionView, TimelineItem } from "@linkshell/client-core";
import {
  buildWatchSnapshot,
  cleanToolTitle,
  isWatchCommandCurrent,
  plainPreview,
  tidyCommand,
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
  type NativeWatchStatus,
} from "../../modules/link-layout";
import { mergeLiveViewsIntoSessions, usePinnedSessionIds } from "./session-attention";

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
        text: (text || `发送了 ${img.count} 张图片`).slice(0, 360),
        ...(img.base64 ? { imageBase64: img.base64, imageMimeType: img.mimeType } : {}),
        status: item.failed ? "failed" : item.pending ? "running" : "completed",
      });
    } else if (item.kind === "agent") {
      const text = (plainPreview(item.text) || item.text).trim();
      const img = extractImageBlocks(item.attachments);
      if (text || img.count > 0) {
        result.push({
          id: item.id,
          kind: img.count > 0 && !text ? "image" : "assistant",
          title: img.count > 0 ? `Agent · 附图(${img.count})` : "Agent",
          text: (text || `生成了 ${img.count} 张图片`).slice(0, 420),
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
      const text = plainPreview(item.text).trim();
      if (!text) continue;
      result.push({
        id: item.id,
        kind: "thought",
        title: "思考",
        text: text.slice(0, 240),
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
          ...(subOutput ? { detail: subOutput.slice(-240) } : {}),
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
        ...(out ? { detail: out.slice(-220) } : {}),
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
    const limit = input.itemLimits?.[id] ?? 14;
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
    availableAgents: availableAgents.length > 0 ? availableAgents : undefined,
    workspaces,
    agentTiers,
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
  onExpandTimeline?: (sessionId: string) => number;
  createTerminal?: (input: { cwd?: string; command?: string }) => Promise<TerminalInfo>;
  openTerminal?: (terminalId: string) => Promise<void>;
  terminalInput?: (terminalId: string, data: string) => Promise<void>;
  closeTerminal?: (terminalId: string) => Promise<void>;
};

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

    if (command.kind === "refresh") {
      if (ctx.online) await ctx.actions.refresh();
      return { ok: true, message: ctx.online ? "已同步最新状态" : "正在重连电脑" };
    }

    if (!ctx.online) {
      return { ok: false, message: "电脑当前不在线，请稍后重试" };
    }

    if (command.kind === "open-session") {
      if (!isWatchCommandCurrent(command, ctx.computerKey, ctx.sessions[command.sessionId])) {
        return { ok: false, message: "无法打开该会话" };
      }
      ctx.actions.openSession?.(command.sessionId);
      return { ok: true, message: "已加载会话详情" };
    }

    if (command.kind === "load-earlier") {
      if (!isWatchCommandCurrent(command, ctx.computerKey, ctx.sessions[command.sessionId])) {
        return { ok: false, message: "无法加载更早消息" };
      }
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
      ctx.actions.openSession?.(created.id);
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
          { now: command.now },
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

export function useIOSWatchSync(
  input: Omit<BuildClientWatchSnapshotInput, "pinnedSessionIds">,
  ctx: WatchActionContext,
  enabled = true,
  link?: HostLink,
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
  const watchInstalled = watchStatus.paired && watchStatus.installed;
  const terminalGenerationRef = useRef(0);
  const [terminalOutputs, setTerminalOutputs] = useState<Record<string, string>>({});
  const [itemLimits, setItemLimits] = useState<Record<string, number>>({});
  const itemLimitsRef = useRef<Record<string, number>>({});
  const rawTerminalBuffersRef = useRef<Record<string, string>>({});
  const attachedTerminalsRef = useRef<Set<string>>(new Set());
  const openedSessionsRef = useRef<Set<string>>(new Set());
  const ctxRef = useRef(ctx);
  ctxRef.current = {
    ...ctx,
    onExpandTimeline: (sessionId: string) => {
      const next = Math.min(50, (itemLimitsRef.current[sessionId] ?? 14) + 15);
      itemLimitsRef.current = { ...itemLimitsRef.current, [sessionId]: next };
      setItemLimits(itemLimitsRef.current);
      return next;
    },
  };

  useEffect(() => {
    openedSessionsRef.current.clear();
    attachedTerminalsRef.current.clear();
    rawTerminalBuffersRef.current = {};
    setTerminalOutputs({});
    terminalGenerationRef.current += 1;
    if (Platform.OS !== "ios" || !online || !enabled || !watchInstalled || !link) return;
    const offOutput = link.on("terminal.output", ({ terminalId, data }) => {
      if (!data || !attachedTerminalsRef.current.has(terminalId)) return;
      const nextRaw = ((rawTerminalBuffersRef.current[terminalId] ?? "") + data).slice(-8192);
      rawTerminalBuffersRef.current[terminalId] = nextRaw;
      const cleaned = stripTerminalAnsi(nextRaw);
      setTerminalOutputs((prev) => (prev[terminalId] === cleaned ? prev : { ...prev, [terminalId]: cleaned }));
    });
    return () => {
      terminalGenerationRef.current += 1;
      offOutput();
    };
  }, [online, enabled, watchInstalled, link]);

  // Automatically open top recent sessions so their timelines are available on Apple Watch
  useEffect(() => {
    if (Platform.OS !== "ios" || !online || !enabled || !watchInstalled || !ctx.actions.openSession) return;
    const live = sessions
      .filter((s) => !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6);
    for (const s of live) {
      if (!views?.[s.id] && !openedSessionsRef.current.has(s.id)) {
        openedSessionsRef.current.add(s.id);
        ctx.actions.openSession(s.id);
      }
    }
  }, [online, enabled, watchInstalled, sessions, views, ctx.actions]);

  // Attach to active terminals and keep clean output previews for Apple Watch
  useEffect(() => {
    if (Platform.OS !== "ios" || !online || !enabled || !watchInstalled || !link) return;
    const generation = terminalGenerationRef.current;
    const topTerminals = [...terminals]
      .sort((a, b) => b.activeAt - a.activeAt)
      .slice(0, 4);

    for (const term of topTerminals) {
      if (attachedTerminalsRef.current.has(term.id)) continue;
      attachedTerminalsRef.current.add(term.id);
      void link
        .call("terminals.attach", { terminalId: term.id })
        .then((res) => {
          if (generation !== terminalGenerationRef.current || !res.replay) return;
          rawTerminalBuffersRef.current[term.id] = res.replay.slice(-8192);
          const cleaned = stripTerminalAnsi(rawTerminalBuffersRef.current[term.id]!);
          if (cleaned) {
            setTerminalOutputs((prev) => (prev[term.id] === cleaned ? prev : { ...prev, [term.id]: cleaned }));
          }
        })
        .catch(() => {
          if (generation === terminalGenerationRef.current) attachedTerminalsRef.current.delete(term.id);
        });
    }
  }, [online, enabled, watchInstalled, terminals, link]);

  useEffect(() => {
    if (Platform.OS !== "ios" || !enabled) return;
    const sync = () => {
      const snapshot = buildClientWatchSnapshot({
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
        now,
        pinnedSessionIds: pinned,
      });
      void syncNativeWatchSnapshot(snapshot);
    };
    sync();
    const heartbeat = setInterval(() => {
      if (online) sync();
    }, 30_000);
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "inactive" || nextState === "background" || nextState === "active") {
        sync();
      }
    });
    return () => {
      clearInterval(heartbeat);
      sub.remove();
    };
  }, [
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
    now,
    pinned,
    enabled,
  ]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let disposed = false;
    const handled = new Set<string>();

    const handleCommand = async ({ id }: { id: string }) => {
      if (disposed || !id || handled.has(id)) return;
      handled.add(id);
      try {
        const command = await consumeNativeWatchCommand(id);
        if (!command) return;
        const result = await executeWatchCommand(command, ctxRef.current);
        await completeNativeWatchCommand(id, result.ok, result.message);
      } catch {
        await completeNativeWatchCommand(id, false, "处理手表指令时出错");
      }
    };

    let draining = false;
    const checkPending = async () => {
      if (draining || disposed) return;
      draining = true;
      try {
        while (!disposed) {
          const id = await pendingNativeWatchCommandId();
          if (!id || handled.has(id)) break;
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
