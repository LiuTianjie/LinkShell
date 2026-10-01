#!/usr/bin/env node
// A small stand-in for `codex app-server --listen unix://…` that follows the
// real protocol closely enough to exercise LinkShell's Codex driver end to end:
// shared threads across connections, thread/started broadcasts, streaming
// deltas, approvals answered by whichever client is first, interrupt and steer.
//
// Prompt keywords: "SLOW" streams 40 chunks at 40ms; "RUN" asks for command
// approval first. FAKE_CODEX_SEED=1 preloads one finished thread on disk.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { WebSocketServer } from "ws";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fake\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stderr.write(process.env.FAKE_CODEX_LOGGED_OUT === "1" ? "Not logged in\n" : "Logged in using ChatGPT\n");
  process.exit(process.env.FAKE_CODEX_LOGGED_OUT === "1" ? 1 : 0);
}
if (args[0] !== "app-server" || args[1] !== "--listen" || !args[2]?.startsWith("unix://")) {
  process.stderr.write(`fake-codex: unsupported args ${args.join(" ")}\n`);
  process.exit(2);
}
const socketPath = args[2].slice("unix://".length);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowSeconds = () => Math.floor(Date.now() / 1000);
const threads = new Map();
const connections = new Set();
const pendingServerRequests = new Map();
let nextServerRequestId = 1000;

function newThread(cwd, extra = {}) {
  const thread = {
    meta: { id: randomUUID(), cwd, name: null, preview: "", model: "fake-model", createdAt: nowSeconds(), updatedAt: nowSeconds(), ...extra },
    turns: [],
    subscribers: new Set(),
    loaded: true,
    active: undefined,
    pendingApproval: undefined,
  };
  threads.set(thread.meta.id, thread);
  return thread;
}

if (process.env.FAKE_CODEX_SEED === "1") {
  const seeded = newThread("/seed/project", { name: "Seeded thread", preview: "what is 2+2" });
  seeded.loaded = false;
  seeded.turns.push({
    id: randomUUID(),
    status: "completed",
    items: [
      { type: "userMessage", id: "seed-user", clientId: null, content: [{ type: "text", text: "what is 2+2", text_elements: [] }] },
      { type: "agentMessage", id: "seed-agent", text: "4" },
    ],
  });
}

function view(thread, withTurns) {
  const status = thread.active
    ? { type: "active", activeFlags: thread.pendingApproval ? ["waitingOnApproval"] : [] }
    : thread.loaded
      ? { type: "idle" }
      : { type: "notLoaded" };
  return { ...thread.meta, status, turns: withTurns ? thread.turns : [] };
}

function send(conn, message) {
  if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(message));
}
function notifyThread(thread, method, params) {
  for (const conn of thread.subscribers) send(conn, { jsonrpc: "2.0", method, params });
}
function broadcast(method, params) {
  for (const conn of connections) send(conn, { jsonrpc: "2.0", method, params });
}
function emitItem(thread, turn, item) {
  const threadId = thread.meta.id;
  notifyThread(thread, "item/started", { threadId, turnId: turn.id, item, startedAtMs: Date.now() });
  turn.items.push(item);
  notifyThread(thread, "item/completed", { threadId, turnId: turn.id, item, completedAtMs: Date.now() });
}
function setStatus(thread) {
  notifyThread(thread, "thread/status/changed", { threadId: thread.meta.id, status: view(thread, false).status });
}

function requestApproval(thread, turn, item) {
  const id = nextServerRequestId++;
  return new Promise((resolve) => {
    const settle = (decision) => {
      if (!pendingServerRequests.has(id)) return;
      pendingServerRequests.delete(id);
      thread.pendingApproval = undefined;
      notifyThread(thread, "serverRequest/resolved", { threadId: thread.meta.id, requestId: id });
      setStatus(thread);
      resolve(decision);
    };
    pendingServerRequests.set(id, settle);
    thread.pendingApproval = settle;
    setStatus(thread);
    for (const conn of thread.subscribers) {
      send(conn, {
        jsonrpc: "2.0",
        id,
        method: "item/commandExecution/requestApproval",
        params: { threadId: thread.meta.id, turnId: turn.id, itemId: item.id, command: item.command, cwd: item.cwd, startedAtMs: Date.now() },
      });
    }
  });
}

function finishTurn(thread, turn, status) {
  turn.status = status;
  thread.active = undefined;
  thread.meta.updatedAt = nowSeconds();
  notifyThread(thread, "turn/completed", { threadId: thread.meta.id, turn: { id: turn.id, items: [], status, error: null } });
  setStatus(thread);
}

async function runTurn(thread, turn, text) {
  const threadId = thread.meta.id;
  notifyThread(thread, "turn/started", { threadId, turn: { id: turn.id, items: [], status: "inProgress" } });
  setStatus(thread);
  if (text.includes("RUN")) {
    const command = { type: "commandExecution", id: randomUUID(), command: "echo hi", cwd: thread.meta.cwd, status: "inProgress" };
    const decision = await requestApproval(thread, turn, command);
    if (decision === "accept" || decision === "acceptForSession") {
      notifyThread(thread, "item/started", { threadId, turnId: turn.id, item: command, startedAtMs: Date.now() });
      notifyThread(thread, "item/commandExecution/outputDelta", { threadId, turnId: turn.id, itemId: command.id, delta: "hi\n" });
      const done = { ...command, status: "completed", exitCode: 0, aggregatedOutput: "hi\n", durationMs: 3 };
      turn.items.push(done);
      notifyThread(thread, "item/completed", { threadId, turnId: turn.id, item: done, completedAtMs: Date.now() });
    } else {
      emitItem(thread, turn, { ...command, status: "declined" });
    }
    if (decision === "cancel" || decision === "interrupted") return finishTurn(thread, turn, "interrupted");
  }
  const slow = text.includes("SLOW");
  const chunks = slow ? Array.from({ length: 40 }, (_, i) => `w${i} `) : ["echo: ", ...text.split(/(\s+)/).filter(Boolean)];
  const messageId = randomUUID();
  notifyThread(thread, "item/started", { threadId, turnId: turn.id, item: { type: "agentMessage", id: messageId, text: "" }, startedAtMs: Date.now() });
  let accumulated = "";
  for (const chunk of chunks) {
    if (turn.interrupted) break;
    await sleep(slow ? 40 : 2);
    if (turn.interrupted) break;
    accumulated += chunk;
    notifyThread(thread, "item/agentMessage/delta", { threadId, turnId: turn.id, itemId: messageId, delta: chunk });
  }
  const message = { type: "agentMessage", id: messageId, text: accumulated };
  turn.items.push(message);
  notifyThread(thread, "item/completed", { threadId, turnId: turn.id, item: message, completedAtMs: Date.now() });
  finishTurn(thread, turn, turn.interrupted ? "interrupted" : "completed");
}

function userItem(input, clientId) {
  const text = input.filter((part) => part.type === "text").map((part) => part.text).join(" ");
  return { item: { type: "userMessage", id: randomUUID(), clientId: clientId ?? null, content: input }, text };
}

const handlers = {
  initialize: () => ({ userAgent: "fake-codex", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos" }),
  "thread/list": () => ({
    // Like Codex: a thread is only persisted (and listed) once it has a turn.
    data: [...threads.values()]
      .filter((t) => t.turns.length > 0 && !t.archived)
      .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
      .map((t) => view(t, false)),
    nextCursor: null,
    backwardsCursor: null,
  }),
  "thread/loaded/list": () => ({ data: [...threads.values()].filter((t) => t.loaded).map((t) => t.meta.id), nextCursor: null }),
  "thread/start": (params, conn) => {
    const thread = newThread(params.cwd ?? process.cwd());
    thread.subscribers.add(conn);
    broadcast("thread/started", { thread: view(thread, false) });
    return { thread: view(thread, false), model: "fake-model", modelProvider: "fake", cwd: thread.meta.cwd };
  },
  "thread/resume": (params, conn) => {
    const thread = threads.get(params.threadId);
    // Like Codex: resume needs the rollout on disk, which only exists after the first turn.
    if (!thread || thread.turns.length === 0) throw { code: -32600, message: `no rollout found for thread id ${params.threadId}` };
    thread.loaded = true;
    thread.subscribers.add(conn);
    return { thread: view(thread, true), model: "fake-model", modelProvider: "fake", cwd: thread.meta.cwd };
  },
  "thread/unsubscribe": (params, conn) => {
    threads.get(params.threadId)?.subscribers.delete(conn);
    return {};
  },
  "turn/start": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: "unknown thread" };
    if (thread.active) throw { code: -32600, message: "a turn is already running" };
    const turn = { id: randomUUID(), items: [], status: "inProgress" };
    thread.turns.push(turn);
    thread.active = turn;
    const { item, text } = userItem(params.input, params.clientUserMessageId);
    if (!thread.meta.preview) thread.meta.preview = text;
    setImmediate(() => {
      emitItem(thread, turn, item);
      void runTurn(thread, turn, text);
    });
    return { turn: { id: turn.id, items: [], status: "inProgress" } };
  },
  "turn/steer": (params) => {
    const thread = threads.get(params.threadId);
    const turn = thread?.active;
    if (!thread || !turn || turn.id !== params.expectedTurnId) throw { code: -32600, message: "no matching active turn" };
    emitItem(thread, turn, userItem(params.input, params.clientUserMessageId).item);
    return { turnId: turn.id };
  },
  "turn/interrupt": (params) => {
    const thread = threads.get(params.threadId);
    const turn = thread?.active;
    if (turn && turn.id === params.turnId) {
      turn.interrupted = true;
      thread.pendingApproval?.("interrupted");
    }
    return {};
  },
  "thread/archive": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: "unknown thread" };
    thread.archived = true;
    broadcast("thread/archived", { threadId: params.threadId });
    return {};
  },
  "thread/unarchive": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: "unknown thread" };
    thread.archived = false;
    return {};
  },
  "thread/name/set": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: "unknown thread" };
    thread.meta.name = params.name;
    broadcast("thread/name/updated", { threadId: params.threadId, threadName: params.name });
    return {};
  },
  "thread/delete": (params) => {
    if (!threads.delete(params.threadId)) throw { code: -32600, message: "unknown thread" };
    broadcast("thread/deleted", { threadId: params.threadId });
    return {};
  },
  "skills/list": (params) => ({
    data: [
      {
        cwd: params.cwds?.[0] ?? process.cwd(),
        skills: [
          { name: "tidy", description: "Tidy the project up", path: "/skills/tidy/SKILL.md", scope: "user", enabled: true },
          { name: "off", description: "Turned off", path: "/skills/off/SKILL.md", scope: "user", enabled: false },
        ],
        errors: [],
      },
    ],
  }),
  // Like Codex: both run as a turn of their own, without a user message.
  "thread/compact/start": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: "unknown thread" };
    if (thread.active) throw { code: -32600, message: "a turn is already running" };
    const turn = { id: randomUUID(), items: [], status: "inProgress" };
    thread.turns.push(turn);
    thread.active = turn;
    setImmediate(() => {
      notifyThread(thread, "turn/started", { threadId: thread.meta.id, turn: { id: turn.id, items: [], status: "inProgress" } });
      emitItem(thread, turn, { type: "contextCompaction", id: randomUUID() });
      finishTurn(thread, turn, "completed");
    });
    return {};
  },
  "review/start": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: "unknown thread" };
    if (thread.active) throw { code: -32600, message: "a turn is already running" };
    const turn = { id: randomUUID(), items: [], status: "inProgress" };
    thread.turns.push(turn);
    thread.active = turn;
    const review = params.target.type === "custom" ? params.target.instructions : "current changes";
    setImmediate(() => {
      notifyThread(thread, "turn/started", { threadId: thread.meta.id, turn: { id: turn.id, items: [], status: "inProgress" } });
      emitItem(thread, turn, { type: "enteredReviewMode", id: randomUUID(), review });
      emitItem(thread, turn, { type: "userMessage", id: randomUUID(), clientId: null, content: [{ type: "text", text: `Review ${review}.` }] });
      emitItem(thread, turn, { type: "exitedReviewMode", id: randomUUID(), review: "looks fine" });
      emitItem(thread, turn, { type: "agentMessage", id: randomUUID(), text: "looks fine" });
      finishTurn(thread, turn, "completed");
    });
    return { turn: { id: turn.id, items: [], status: "inProgress" }, reviewThreadId: thread.meta.id };
  },
  "fake/crash": () => {
    setImmediate(() => process.exit(1));
    return {};
  },
};

rmSync(socketPath, { force: true });
const server = createServer();
const wss = new WebSocketServer({ server, perMessageDeflate: false });
wss.on("connection", (ws) => {
  const conn = { ws };
  connections.add(conn);
  ws.on("close", () => {
    connections.delete(conn);
    for (const thread of threads.values()) thread.subscribers.delete(conn);
  });
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.method === undefined && message.id !== undefined) {
      pendingServerRequests.get(message.id)?.(message.result?.decision);
      return;
    }
    if (message.id === undefined) return;
    const handler = handlers[message.method];
    try {
      if (!handler) throw { code: -32601, message: `unknown method ${message.method}` };
      send(conn, { jsonrpc: "2.0", id: message.id, result: handler(message.params ?? {}, conn) });
    } catch (error) {
      send(conn, { jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message ?? String(error) } });
    }
  });
});
server.listen(socketPath);
const shutdown = () => {
  rmSync(socketPath, { force: true });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
