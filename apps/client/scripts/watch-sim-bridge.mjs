#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildWatchSnapshot,
  cleanToolTitle,
  plainPreview,
  RpcPeer,
  tidyCommand,
  watchCommandSchema,
} from "../../../packages/wire/dist/index.js";

const home = process.env.LINKSHELL_HOME || join(homedir(), ".linkshell");
const socketPath = join(home, "run", "host.sock");
const devTcpPort = Number(process.env.LINKSHELL_DEV_PORT || 7878);
const bridgeHttpPort = Number(process.env.LINKSHELL_WATCH_BRIDGE_PORT || 7879);
const sharedSimSnapshotPath = "/tmp/linkshell-watch-snapshot.json";

function stripTerminalAnsi(raw) {
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
    .map((line) => line.replace(/\s+/g, " ").trimEnd())
    .filter((line) => line !== "%")
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0));
  return lines.slice(-30).join("\n").slice(-1600);
}

function cleanUserMessageText(raw) {
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

function fileBaseName(filePath) {
  const parts = String(filePath || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath || "文件修改";
}

function summarizeDiffFromContent(contentList) {
  if (!Array.isArray(contentList)) return null;
  for (const entry of contentList) {
    if (entry?.type === "patch" && typeof entry.diff === "string") {
      const lines = entry.diff.split("\n");
      let added = 0;
      let removed = 0;
      const bodyLines = [];
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
        filePath: entry.path || "文件修改",
        added,
        removed,
        preview: bodyLines.join("\n").slice(0, 320),
      };
    }
    if (entry?.type === "diff") {
      const oldLines = String(entry.oldText ?? "").split("\n").filter(Boolean);
      const newLines = String(entry.newText ?? "").split("\n").filter(Boolean);
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
        filePath: entry.path || "文件修改",
        added: addedLines.length,
        removed: removedLines.length,
        preview,
      };
    }
  }
  return null;
}

function defaultWatchConfigOptions(agent = "", currentModel, currentMode) {
  const lower = String(agent).toLowerCase();
  if (lower.includes("codex")) {
    const mode = currentMode || "workspace-write";
    const model = currentModel || "gpt-5.4";
    return [
      {
        id: "mode",
        name: "沙盒与权限",
        category: "mode",
        current: mode,
        currentLabel: mode === "read-only" ? "只读沙盒" : mode === "full-access" ? "完全访问" : "工作区沙盒",
        values: [
          { value: "workspace-write", name: "工作区沙盒", description: "允许修改当前项目文件" },
          { value: "read-only", name: "只读沙盒", description: "仅分析代码，写操作需确认" },
          { value: "full-access", name: "完全访问", description: "无沙盒限制执行命令" },
        ],
      },
      {
        id: "model",
        name: "模型",
        category: "model",
        current: model,
        currentLabel: model,
        values: [
          { value: "gpt-5.4", name: "GPT-5.4" },
          { value: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
          { value: "o4-mini", name: "o4-mini" },
        ],
      },
    ];
  }
  if (lower.includes("claude")) {
    const mode = currentMode || "default";
    const model = currentModel || "claude-sonnet-4-6";
    return [
      {
        id: "mode",
        name: "权限模式",
        category: "mode",
        current: mode,
        currentLabel:
          mode === "acceptEdits"
            ? "自动改文件"
            : mode === "plan"
              ? "仅规划 (Plan)"
              : mode === "bypassPermissions"
                ? "全自动 (Bypass)"
                : "标准确认",
        values: [
          { value: "default", name: "标准确认", description: "敏感命令在手表确认" },
          { value: "acceptEdits", name: "自动改文件", description: "自动允许修改文件" },
          { value: "plan", name: "仅规划 (Plan)", description: "先出方案不改代码" },
          { value: "bypassPermissions", name: "全自动 (Bypass)", description: "跳过权限弹窗" },
        ],
      },
      {
        id: "model",
        name: "模型",
        category: "model",
        current: model,
        currentLabel: model,
        values: [
          { value: "claude-sonnet-4-6", name: "Sonnet 4.6" },
          { value: "claude-opus-4-6", name: "Opus 4.6" },
          { value: "claude-haiku-4-5", name: "Haiku 4.5" },
        ],
      },
    ];
  }
  return [
    {
      id: "mode",
      name: "沙盒模式",
      category: "mode",
      current: currentMode || "default",
      currentLabel: currentMode || "标准沙盒",
      values: [
        { value: "default", name: "标准沙盒" },
        { value: "auto", name: "自动批准修改" },
      ],
    },
  ];
}

function sliceWatchTimelineWithUserContext(items, maxItems = 14) {
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

// 1. Raw TCP -> Unix socket proxy on 127.0.0.1:7878 so both iPhone Simulator and this bridge can use standard ws://127.0.0.1:7878
const tcpProxy = net.createServer((clientSocket) => {
  const hostSocket = net.connect(socketPath);
  clientSocket.pipe(hostSocket).pipe(clientSocket);
  clientSocket.on("error", () => hostSocket.destroy());
  hostSocket.on("error", () => clientSocket.destroy());
});
tcpProxy.on("error", () => {
  // Port 7878 already in use; ignore
});

let machine = null;
let online = false;
const sessionsById = new Map();
const sessionEventsById = new Map();
const sessionStartSeqById = new Map();
const sessionItemLimits = new Map();
const sessionConfigsById = new Map();
const subscribedSessions = new Set();
let projects = [];
let terminals = [];
const rawTerminalBuffers = {};
const terminalOutputs = {};
const attachedTerminals = new Set();

let ws = null;
let peer = null;

function convertEventsToWatchTimeline(events, session, maxItems = 14, startSeq = 0) {
  const items = [];
  const byId = new Map();
  let latestPlan = undefined;
  let latestConfig = undefined;

  const upsert = (entry) => {
    if (byId.has(entry.id)) {
      const idx = byId.get(entry.id);
      items[idx] = { ...items[idx], ...entry };
    } else {
      byId.set(entry.id, items.length);
      items.push(entry);
    }
  };

  for (const evt of events || []) {
    const u = evt.update;
    if (!u) continue;
    if (u.sessionUpdate === "ls_config" && Array.isArray(u.configOptions)) {
      latestConfig = u.configOptions;
      continue;
    }
    if (u.parentToolCallId) continue;

    if (u.sessionUpdate === "user_message_chunk") {
      const msgId = `user:${u.messageId || `seq-${evt.seq}`}`;
      const existing = byId.has(msgId) ? items[byId.get(msgId)] : null;
      if (u.content?.type === "text" && u.content.text) {
        const combinedRaw = (existing?._rawText || "") + u.content.text;
        const cleaned = cleanUserMessageText(combinedRaw);
        if (!cleaned && !existing?.imageBase64) continue;
        upsert({
          id: msgId,
          kind: "user",
          title: existing?.title || "你",
          text: (cleaned || existing?.text || "发送了图片").slice(0, 360),
          _rawText: combinedRaw,
          status: "completed",
        });
      } else if (u.content?.type === "image") {
        const b64 =
          typeof u.content.data === "string" && u.content.data.length <= 12000
            ? u.content.data.replace(/^data:[^;]+;base64,/i, "")
            : undefined;
        upsert({
          id: msgId,
          kind: "user",
          title: "你 · 附图",
          text: existing?.text || "📷 附带屏幕截图",
          ...(b64 ? { imageBase64: b64, imageMimeType: u.content.mimeType || "image/png" } : {}),
          status: "completed",
        });
      }
    } else if (u.sessionUpdate === "ls_message") {
      const rawText = (u.content || [])
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      const text = u.role === "user" ? cleanUserMessageText(rawText) : rawText;
      if (!text) continue;
      if (u.role === "user") {
        upsert({
          id: `user:${u.messageId || `msg-${evt.seq}`}`,
          kind: "user",
          title: "你",
          text: text.slice(0, 360),
          status: "completed",
        });
      } else {
        upsert({
          id: `assistant:${u.messageId || `msg-${evt.seq}`}`,
          kind: "assistant",
          title: "Agent",
          text: (plainPreview(text) || text).slice(0, 420),
          status: "completed",
        });
      }
    } else if (u.sessionUpdate === "agent_message_chunk") {
      if (u.content?.type === "text" && u.content.text) {
        const msgId = `assistant:${u.messageId || `stream-${evt.seq}`}`;
        const existing = byId.has(msgId) ? items[byId.get(msgId)] : items[items.length - 1];
        if (existing && existing.kind === "assistant" && (existing.id === msgId || existing.id.startsWith("assistant:stream-"))) {
          const rawCombined = (existing._rawText || existing.text || "") + u.content.text;
          existing._rawText = rawCombined;
          existing.text = (plainPreview(rawCombined) || rawCombined).slice(-420);
        } else {
          upsert({
            id: msgId,
            kind: "assistant",
            title: "Agent",
            _rawText: u.content.text,
            text: (plainPreview(u.content.text) || u.content.text).slice(0, 420),
            status: "running",
          });
        }
      }
    } else if (u.sessionUpdate === "ls_message_done" && u.role === "agent" && u.messageId) {
      const msgId = `assistant:${u.messageId}`;
      if (byId.has(msgId)) {
        items[byId.get(msgId)].status = "completed";
      }
    } else if (u.sessionUpdate === "agent_thought_chunk") {
      if (u.content?.type === "text" && u.content.text) {
        const msgId = `thought:${u.messageId || `seq-${evt.seq}`}`;
        const existing = byId.has(msgId) ? items[byId.get(msgId)] : null;
        const rawCombined = (existing?._rawText || "") + u.content.text;
        const cleanThought = plainPreview(rawCombined).trim();
        if (cleanThought) {
          upsert({
            id: msgId,
            kind: "thought",
            title: "思考",
            _rawText: rawCombined,
            text: cleanThought.slice(0, 240),
            status: "completed",
          });
        }
      }
    } else if (u.sessionUpdate === "ls_thought") {
      const text = plainPreview(u.text || "").trim();
      if (!text) continue;
      upsert({
        id: u.thoughtId || `thought-${evt.seq}`,
        kind: "thought",
        title: "思考",
        text: text.slice(0, 240),
        status: "completed",
      });
    } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      const toolId = u.toolCallId || `tool-${evt.seq}`;
      const existing = byId.has(toolId) ? items[byId.get(toolId)] : null;
      const rawTitle = cleanToolTitle(u.title || "") || existing?.text || u.name || "工具调用";
      const toolStatus =
        u.status === "failed"
          ? "failed"
          : u.status === "completed"
            ? "completed"
            : u.status === "in_progress" || u.status === "pending"
              ? "running"
              : existing?.status || "completed";

      // Check if subagent
      const metaTool = u._meta?.claudeCode?.toolName || u.name || "";
      const isSubagent =
        metaTool === "Task" ||
        metaTool === "spawn_agent" ||
        metaTool === "send_message" ||
        Boolean(u.rawInput?.subagent_type) ||
        /subagent|deepcoder|worker/i.test(rawTitle) ||
        existing?.kind === "subagent";

      let out = "";
      if (Array.isArray(u.content)) {
        for (const c of u.content) {
          if (c.type === "content" && c.content?.type === "text") out += c.content.text + "\n";
          if (c.type === "terminal" && c.output) out += c.output + "\n";
        }
      }
      const cleanOut = stripTerminalAnsi(out);

      if (isSubagent) {
        const subType = u.rawInput?.subagent_type || existing?.subagentType || "Worker";
        const subName = u.rawInput?.name || existing?.subagentName || (rawTitle.includes("DeepCoder") ? "DeepCoder" : undefined);
        upsert({
          id: toolId,
          kind: "subagent",
          title: subName ? `子代理 · ${subName}` : `子代理 · ${subType}`,
          text: rawTitle.slice(0, 240),
          ...((cleanOut || existing?.detail) ? { detail: (cleanOut || existing?.detail).slice(-240) } : {}),
          subagentType: String(subType).slice(0, 48),
          ...(subName ? { subagentName: String(subName).slice(0, 48) } : {}),
          status: toolStatus,
        });
        continue;
      }

      // Check if file edit / diff
      const diffInfo = summarizeDiffFromContent(u.content);
      if (diffInfo || u.kind === "edit" || existing?.kind === "diff") {
        const pathStr =
          diffInfo?.filePath ||
          u.locations?.[0]?.path ||
          existing?.filePath ||
          cleanToolTitle(u.title || "") ||
          "文件修改";
        const shortFile = fileBaseName(pathStr);
        const detailText = diffInfo?.preview || cleanOut || existing?.detail;
        upsert({
          id: toolId,
          kind: "diff",
          title: "文件修改",
          text: shortFile.slice(0, 120),
          filePath: String(pathStr).slice(0, 180),
          ...(diffInfo
            ? { diffAdded: diffInfo.added, diffRemoved: diffInfo.removed }
            : existing?.diffAdded !== undefined
              ? { diffAdded: existing.diffAdded, diffRemoved: existing.diffRemoved }
              : {}),
          ...(detailText ? { detail: detailText.slice(0, 320) } : {}),
          status: toolStatus,
        });
        continue;
      }

      const cmdText = u.kind === "execute" ? tidyCommand(rawTitle) : rawTitle;
      upsert({
        id: toolId,
        kind: "tool",
        title:
          u.kind === "execute"
            ? "执行命令"
            : u.kind === "search"
              ? "搜索代码"
              : u.kind === "read"
                ? "读取文件"
                : existing?.title || "工具调用",
        text: (u.title ? cmdText : existing?.text || cmdText).slice(0, 200),
        ...((cleanOut || existing?.detail) ? { detail: (cleanOut || existing?.detail).slice(-220) } : {}),
        status: toolStatus,
      });
    } else if (u.sessionUpdate === "plan" && Array.isArray(u.entries) && u.entries.length > 0) {
      const completed = u.entries.filter((e) => e.status === "completed").length;
      const active =
        u.entries.find((e) => e.status === "in_progress") ?? u.entries.find((e) => e.status === "pending");
      latestPlan = {
        completed,
        total: u.entries.length,
        ...(active?.content ? { currentStep: active.content } : {}),
      };
      const text = u.entries
        .slice(0, 8)
        .map((e) => `${e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"} ${e.content}`)
        .join("\n");
      upsert({
        id: `plan-${evt.sessionId}`,
        kind: "plan",
        title: u.title || "执行计划",
        text: text.slice(0, 360),
        status: completed === u.entries.length ? "completed" : "running",
      });
    } else if (u.sessionUpdate === "ls_async_questions" && Array.isArray(u.questions)) {
      for (const q of u.questions.slice(0, 2)) {
        upsert({
          id: `q-${q.id}`,
          kind: "question",
          title: q.header || "Agent 提问",
          text: String(q.question || "").slice(0, 280),
          ...(Array.isArray(q.options) && q.options.length > 0
            ? { detail: q.options.map((o) => `• ${o.label}`).join("\n").slice(0, 220) }
            : {}),
          status: "waiting",
        });
      }
    } else if (u.sessionUpdate === "ls_error") {
      upsert({
        id: `err-${evt.seq}`,
        kind: "error",
        title: "错误",
        text: (u.message || "执行出错").slice(0, 280),
        status: "failed",
      });
    }
  }

  const cleanedItems = items
    .map(({ _rawText, ...rest }) => rest)
    .filter((i) => i.text && i.text.trim().length > 0);

  if (
    !cleanedItems.some((i) => i.kind === "user") &&
    session?.title &&
    session.title.trim().length > 0
  ) {
    cleanedItems.unshift({
      id: `seed-user-${session.id}`,
      kind: "user",
      title: "你",
      text: session.title.trim().slice(0, 360),
      status: "completed",
    });
  }

  const sliced =
    maxItems > 14
      ? cleanedItems.slice(-maxItems)
      : sliceWatchTimelineWithUserContext(cleanedItems, maxItems);
  const hasEarlier = cleanedItems.length > sliced.length || startSeq > 0;

  return {
    items: sliced,
    totalCount: cleanedItems.length,
    hasEarlier,
    planProgress: latestPlan,
    configOptions: latestConfig,
  };
}

async function subscribeSession(sessionId) {
  if (!peer || !sessionId) return;
  subscribedSessions.add(sessionId);
  try {
    const res = await peer.request("sessions.subscribe", { sessionId, fromSeq: 0, lazyImages: true });
    if (res.session) sessionsById.set(res.session.id, res.session);
    if (typeof res.startSeq === "number") {
      sessionStartSeqById.set(sessionId, res.startSeq);
    }
  } catch {
    // Ignore
  }
}

async function attachTerminal(terminalId) {
  if (!peer || !terminalId) return;
  attachedTerminals.add(terminalId);
  try {
    const res = await peer.request("terminals.attach", { terminalId });
    if (res.replay) {
      rawTerminalBuffers[terminalId] = res.replay.slice(-8192);
      terminalOutputs[terminalId] = stripTerminalAnsi(rawTerminalBuffers[terminalId]);
    }
  } catch {
    // Ignore
  }
}

async function syncAllFromHost() {
  if (!peer) return;
  try {
    const [mInfo, sList, pList, tList] = await Promise.all([
      peer.request("machine.info", {}),
      peer.request("sessions.list", { limit: 25 }),
      peer.request("sessions.projects", {}).catch(() => ({ projects: [] })),
      peer.request("terminals.list", {}).catch(() => ({ terminals: [] })),
    ]);
    machine = mInfo;
    online = true;
    projects = pList.projects || [];
    terminals = tList.terminals || [];

    sessionsById.clear();
    for (const s of sList.sessions || []) {
      sessionsById.set(s.id, s);
    }

    const topSessions = [...sessionsById.values()]
      .filter((s) => !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8);
    for (const s of topSessions) {
      if (!subscribedSessions.has(s.id)) {
        await subscribeSession(s.id);
      }
    }

    const topTerms = [...terminals].sort((a, b) => b.activeAt - a.activeAt).slice(0, 4);
    await Promise.all(topTerms.map((t) => attachTerminal(t.id)));
  } catch (err) {
    console.error("[watch-sim-bridge] syncAllFromHost error:", err);
  }
}

function connectToHost() {
  ws = new WebSocket(`ws://127.0.0.1:${devTcpPort}`);
  peer = new RpcPeer({
    send: (text) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    onNotification: (method, params) => {
      if (method === "session.summary" && params?.summary) {
        sessionsById.set(params.summary.id, params.summary);
        if (!subscribedSessions.has(params.summary.id)) {
          void subscribeSession(params.summary.id);
        }
      } else if (method === "session.window" && params?.sessionId && typeof params.startSeq === "number") {
        sessionStartSeqById.set(params.sessionId, params.startSeq);
      } else if (method === "session.event" && params?.sessionId) {
        const list = sessionEventsById.get(params.sessionId) || [];
        if (!list.some((e) => e.seq === params.seq)) {
          list.push(params);
          list.sort((a, b) => a.seq - b.seq);
          if (list.length > 600) {
            const preserved = list.filter(
              (e) =>
                e.update?.sessionUpdate === "user_message_chunk" ||
                e.update?.sessionUpdate === "ls_config" ||
                e.update?.sessionUpdate === "ls_goal",
            );
            const recent = list.slice(-480);
            const recentSeqs = new Set(recent.map((e) => e.seq));
            const mergedList = [...preserved.filter((e) => !recentSeqs.has(e.seq)), ...recent].sort(
              (a, b) => a.seq - b.seq,
            );
            sessionEventsById.set(params.sessionId, mergedList);
          } else {
            sessionEventsById.set(params.sessionId, list);
          }
        }
      } else if (method === "terminal.changed" && params?.terminal) {
        const rest = terminals.filter((t) => t.id !== params.terminal.id);
        terminals = params.closed
          ? rest
          : [params.terminal, ...rest].sort((a, b) => b.createdAt - a.createdAt);
        if (!params.closed && !attachedTerminals.has(params.terminal.id)) {
          void attachTerminal(params.terminal.id);
        }
      } else if (method === "terminal.output" && params?.terminalId && params?.data) {
        const next = ((rawTerminalBuffers[params.terminalId] ?? "") + params.data).slice(-8192);
        rawTerminalBuffers[params.terminalId] = next;
        terminalOutputs[params.terminalId] = stripTerminalAnsi(next);
      }
    },
    requestTimeoutMs: 30_000,
  });

  ws.onopen = () => {
    online = true;
    void syncAllFromHost();
  };
  ws.onmessage = (evt) => {
    peer.receive(typeof evt.data === "string" ? evt.data : Buffer.from(evt.data).toString("utf8"));
  };
  ws.onclose = () => {
    online = false;
    subscribedSessions.clear();
    attachedTerminals.clear();
    peer.close();
    setTimeout(connectToHost, 1500);
  };
  ws.onerror = () => {};
}

function buildCurrentSnapshot() {
  const rawHost = machine?.hostname || "MacBook Pro";
  const computerName = rawHost.replace(/\.local$/i, "");
  const computerKey = machine?.machineId ? `local:${machine.machineId}` : "local:host";
  const allSessions = [...sessionsById.values()];
  const realSessions = allSessions.filter(
    (s) =>
      !String(s.cwd || "").includes("/tmp/linkshell-") &&
      !String(s.title || "").startsWith("This is an isolated LinkShell acceptance test"),
  );
  const sessions = realSessions.length > 0 ? realSessions : allSessions;

  const timelines = {};
  const hasEarlier = {};
  const itemLimits = {};
  const plans = {};
  const modes = {};
  const configs = {};

  for (const session of sessions) {
    const events = sessionEventsById.get(session.id) || [];
    const maxItems = sessionItemLimits.get(session.id) || 14;
    const startSeq = sessionStartSeqById.get(session.id) || 0;
    itemLimits[session.id] = maxItems;
    const converted = convertEventsToWatchTimeline(events, session, maxItems, startSeq);
    if (converted.items.length > 0) timelines[session.id] = converted.items;
    if (converted.hasEarlier) hasEarlier[session.id] = true;
    if (converted.planProgress) plans[session.id] = converted.planProgress;

    const customCfg = sessionConfigsById.get(session.id) || converted.configOptions;
    const cfgList =
      Array.isArray(customCfg) && customCfg.length > 0
        ? customCfg.slice(0, 4).map((opt) => {
            const curVal = (opt.values || []).find((v) => v.value === opt.current);
            return {
              id: opt.id,
              name: opt.name,
              category: opt.category,
              current: opt.current,
              ...(curVal?.name ? { currentLabel: curVal.name } : {}),
              values: (opt.values || []).slice(0, 8).map((v) => ({
                value: v.value,
                name: v.name,
                ...(v.description ? { description: v.description } : {}),
              })),
            };
          })
        : defaultWatchConfigOptions(session.agent, session.model, undefined);

    configs[session.id] = cfgList;
    const modeOpt = cfgList.find((c) => c.category === "mode" || c.id === "mode" || c.id === "sandbox");
    if (modeOpt) modes[session.id] = modeOpt.currentLabel || modeOpt.current;
  }

  const availableAgents = (machine?.agents ?? [])
    .filter((a) => a.installed !== false && a.tier !== "terminal")
    .map((a) => a.id);
  const agentTiers = Object.fromEntries((machine?.agents ?? []).map((a) => [a.id, a.tier]));

  const workspaces = [{ path: "/Users/turning4th/claude-remote", name: "claude-remote" }];
  for (const proj of projects) {
    if (proj.cwd) {
      const parts = proj.cwd.split(/[\\/]/).filter(Boolean);
      workspaces.push({ path: proj.cwd, name: parts[parts.length - 1] ?? proj.cwd });
    }
  }

  const snap = buildWatchSnapshot(computerName, sessions, terminals, online, {
    computerKey,
    computers: [{ key: computerKey, name: computerName, online, selected: true, platform: "darwin" }],
    plans,
    timelines,
    hasEarlier,
    itemLimits,
    modes,
    configs,
    terminalOutputs,
    availableAgents: availableAgents.length > 0 ? availableAgents : ["claude", "codex", "gemini", "cursor"],
    workspaces,
    agentTiers,
  });

  try {
    writeFileSync(sharedSimSnapshotPath, JSON.stringify(snap), "utf8");
  } catch {
    // Ignore file write errors
  }

  return snap;
}

async function handleWatchCommand(rawCmd) {
  const parsed = watchCommandSchema.safeParse(rawCmd);
  if (!parsed.success || !peer) {
    return { ok: false, message: "指令格式无效" };
  }
  const command = parsed.data;
  try {
    if (command.kind === "refresh") {
      await syncAllFromHost();
      return { ok: true, message: "已同步最新状态" };
    }
    if (command.kind === "select-computer") {
      await syncAllFromHost();
      return { ok: true, message: `已连接到 ${(machine?.hostname || "Mac").replace(/\.local$/i, "")}` };
    }
    if (command.kind === "open-session") {
      if (!subscribedSessions.has(command.sessionId)) {
        await subscribeSession(command.sessionId);
        await new Promise((r) => setTimeout(r, 250));
      }
      return { ok: true, message: "" };
    }
    if (command.kind === "load-earlier") {
      if (!subscribedSessions.has(command.sessionId)) {
        await subscribeSession(command.sessionId);
      }
      const prevLimit = sessionItemLimits.get(command.sessionId) || 14;
      const nextLimit = Math.min(50, prevLimit + 15);
      sessionItemLimits.set(command.sessionId, nextLimit);

      const currentEvents = sessionEventsById.get(command.sessionId) || [];
      const currentStartSeq = sessionStartSeqById.get(command.sessionId) || 0;
      const convertedNow = convertEventsToWatchTimeline(
        currentEvents,
        sessionsById.get(command.sessionId),
        nextLimit,
        currentStartSeq,
      );
      if (convertedNow.totalCount < nextLimit && currentStartSeq > 0) {
        try {
          const page = await peer.request("sessions.history", {
            sessionId: command.sessionId,
            beforeSeq: currentStartSeq + 1,
            lazyImages: true,
          });
          if (typeof page.startSeq === "number") {
            sessionStartSeqById.set(command.sessionId, page.startSeq);
          }
          if (Array.isArray(page.events) && page.events.length > 0) {
            const list = sessionEventsById.get(command.sessionId) || [];
            const seenSeqs = new Set(list.map((e) => e.seq));
            for (const evt of page.events) {
              if (!seenSeqs.has(evt.seq)) {
                list.push({ ...evt, sessionId: command.sessionId });
                seenSeqs.add(evt.seq);
              }
            }
            list.sort((a, b) => a.seq - b.seq);
            sessionEventsById.set(command.sessionId, list);
          }
        } catch {
          // Ignore history fetch errors
        }
      }
      return { ok: true, message: "已加载更早消息" };
    }
    if (command.kind === "create-session") {
      const promptText = command.prompt?.trim();
      const cwd =
        !command.cwd || command.cwd === "~"
          ? "/Users/turning4th/claude-remote"
          : command.cwd;
      const res = await peer.request("sessions.create", {
        agent: command.agent,
        cwd,
        ...(promptText ? { prompt: [{ type: "text", text: promptText }] } : {}),
      });
      if (res.session) {
        sessionsById.set(res.session.id, res.session);
        await subscribeSession(res.session.id);
      }
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, message: `已启动 ${command.agent} 会话` };
    }
    if (command.kind === "create-terminal") {
      const cwd =
        !command.cwd || command.cwd === "~"
          ? "/Users/turning4th/claude-remote"
          : command.cwd;
      const res = await peer.request("terminals.create", {
        cwd,
        ...(command.command?.trim() ? { command: command.command.trim() } : {}),
        cols: 80,
        rows: 24,
      });
      if (res.terminal) {
        terminals = [res.terminal, ...terminals.filter((t) => t.id !== res.terminal.id)];
        await attachTerminal(res.terminal.id);
      }
      await new Promise((r) => setTimeout(r, 450));
      return { ok: true, message: "已新建终端" };
    }
    if (command.kind === "open-terminal") {
      await attachTerminal(command.terminalId);
      return { ok: true, message: "" };
    }
    if (command.kind === "terminal-input") {
      await attachTerminal(command.terminalId);
      await peer.request("terminals.input", {
        terminalId: command.terminalId,
        data: command.data,
      });
      await new Promise((r) => setTimeout(r, 500));
      return { ok: true, message: command.data === "\u0003" ? "已发送 Ctrl+C" : "已发送命令" };
    }
    if (command.kind === "close-terminal") {
      await peer.request("terminals.close", { terminalId: command.terminalId });
      terminals = terminals.filter((t) => t.id !== command.terminalId);
      return { ok: true, message: "已关闭终端" };
    }

    const sessionId = command.kind === "action" ? command.action.sessionId : command.sessionId;
    switch (command.kind) {
      case "action": {
        const { action } = command;
        if (action.kind === "permission") {
          await peer.request("sessions.permission", {
            sessionId,
            requestId: action.requestId,
            optionId: action.optionId,
          });
          await new Promise((r) => setTimeout(r, 300));
          return { ok: true, message: `已处理：${action.label}` };
        }
        if (action.kind === "answer") {
          await peer.request("sessions.answer", {
            sessionId,
            requestId: action.requestId,
            answers: [{ id: action.questionId, values: [action.optionId] }],
          });
          await new Promise((r) => setTimeout(r, 300));
          return { ok: true, message: `已回答：${action.label}` };
        }
        break;
      }
      case "prompt": {
        if (!subscribedSessions.has(sessionId)) {
          await subscribeSession(sessionId);
        }
        await peer.request("sessions.prompt", {
          sessionId,
          clientMessageId: `watch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          content: [{ type: "text", text: command.text.trim() }],
        });
        await new Promise((r) => setTimeout(r, 400));
        return { ok: true, message: "已发送给 Agent" };
      }
      case "set-config": {
        const session = sessionsById.get(sessionId);
        const existingCfg =
          sessionConfigsById.get(sessionId) ||
          defaultWatchConfigOptions(session?.agent, session?.model, undefined);
        const updatedCfg = existingCfg.map((opt) => {
          if (opt.id !== command.optionId) return opt;
          const matchedVal = (opt.values || []).find((v) => v.value === command.value);
          return {
            ...opt,
            current: command.value,
            currentLabel: matchedVal?.name || command.value,
          };
        });
        sessionConfigsById.set(sessionId, updatedCfg);
        if (session && command.optionId === "model") {
          sessionsById.set(sessionId, { ...session, model: command.value });
        }
        await peer
          .request("sessions.setConfig", {
            sessionId,
            configId: command.optionId,
            value: command.value,
          })
          .catch(() => {});
        return { ok: true, message: `已切换为 ${command.value}` };
      }
      case "cancel": {
        await peer.request("sessions.cancel", { sessionId });
        await new Promise((r) => setTimeout(r, 300));
        return { ok: true, message: "已停止当前轮次" };
      }
      case "takeover": {
        await peer.request("sessions.takeover", { sessionId });
        await subscribeSession(sessionId);
        await new Promise((r) => setTimeout(r, 350));
        return { ok: true, message: "已在腕表接管会话" };
      }
      case "release": {
        await peer.request("sessions.release", { sessionId });
        await new Promise((r) => setTimeout(r, 300));
        return { ok: true, message: "已交还电脑终端" };
      }
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "操作失败" };
  }
  return { ok: false, message: "操作未完成" };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
  });
}

tcpProxy.listen(devTcpPort, "127.0.0.1", () => {
  console.log(`[watch-sim-bridge] Proxying ws://127.0.0.1:${devTcpPort} -> ${socketPath}`);
  connectToHost();
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${bridgeHttpPort}`);

  if (req.method === "GET" && url.pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ supported: true, activated: true, paired: true, installed: true, reachable: true }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/snapshot") {
    const snap = buildCurrentSnapshot();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(snap));
    return;
  }

  if (req.method === "POST" && url.pathname === "/snapshot") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/commands/enqueue") {
    const body = await readJsonBody(req);
    const result = await handleWatchCommand(body);
    const snap = buildCurrentSnapshot();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: result.ok,
        message: result.message,
        snapshotJSON: JSON.stringify(snap),
      }),
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/commands/pending") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: null }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(bridgeHttpPort, "127.0.0.1", () => {
  console.log(`[watch-sim-bridge] Watch Simulator Bridge listening on http://127.0.0.1:${bridgeHttpPort}`);
});
