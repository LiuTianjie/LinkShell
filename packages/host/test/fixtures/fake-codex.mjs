#!/usr/bin/env node
// A small stand-in for `codex app-server --listen unix://…` that follows the
// real protocol closely enough to exercise LinkShell's Codex driver end to end:
// shared threads across connections, thread/started broadcasts, streaming
// deltas, approvals answered by whichever client is first, interrupt and steer.
//
// Prompt keywords: "SLOW" streams 40 chunks at 40ms; "RUN" asks for command
// approval first ("RUN LONG": the command takes a while); "BACKGROUND" leaves
// a command running after the turn. FAKE_CODEX_SEED=1 preloads one finished
// thread on disk.
//
// FAKE_CODEX_DISK=<dir> is the disk several Codex processes share: threads are
// saved there as they are written, and a thread loaded in one process is
// locked against the others (thread/resume: "already has an active writer"),
// which can still read what is on disk — where a turn that is running
// elsewhere reads as interrupted, with no end time. The disk also holds each
// thread's queue (thread/queue/add from any process): the process that has
// the thread loaded starts what is queued when the thread is idle.
//
// FAKE_CODEX_MODELS=1 answers model/list (otherwise it is unknown, as the other
// tests expect). FAKE_CODEX_CONFIG_MODEL answers config/read with that model
// ("" for none), or with FAKE_CODEX_PROJECT_MODELS' (JSON, cwd → model) for a
// cwd listed there; unset, config/read is unknown, as to older Codex builds.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fake\n");
  process.exit(0);
}
if (args[0] === "features" && args[1] === "list") {
  // FAKE_CODEX_FEATURES: what this "version" lists (default: the question feature, in development).
  process.stdout.write(process.env.FAKE_CODEX_FEATURES ?? "apps                                     stable             true\ndefault_mode_request_user_input          under development  false\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stderr.write(process.env.FAKE_CODEX_LOGGED_OUT === "1" ? "Not logged in\n" : "Logged in using ChatGPT\n");
  process.exit(process.env.FAKE_CODEX_LOGGED_OUT === "1" ? 1 : 0);
}
// Like Codex: features can be switched on before --listen, and one it doesn't know is an error.
const listenAt = args.indexOf("--listen");
for (let index = 1; index < listenAt; index += 2) {
  if (args[index] !== "--enable" || args[index + 1] !== "default_mode_request_user_input") {
    process.stderr.write(`Error: Unknown feature flag: ${args[index + 1]}\n`);
    process.exit(1);
  }
}
if (args[0] !== "app-server" || listenAt < 1 || !args[listenAt + 1]?.startsWith("unix://")) {
  process.stderr.write(`fake-codex: unsupported args ${args.join(" ")}\n`);
  process.exit(2);
}
const socketPath = args[listenAt + 1].slice("unix://".length);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowSeconds = () => Math.floor(Date.now() / 1000);
const threads = new Map();
const connections = new Set();

const DISK = process.env.FAKE_CODEX_DISK;
if (DISK) mkdirSync(DISK, { recursive: true });
const filePath = (id) => join(DISK, `${id}.json`);
const lockPath = (id) => join(DISK, `${id}.lock`);

function save(thread) {
  if (!DISK || thread.turns.length === 0 || thread.meta.ephemeral) return;
  writeFileSync(filePath(thread.meta.id), JSON.stringify({ meta: thread.meta, archived: thread.archived === true, turns: thread.turns }));
}
function onDisk(id) {
  if (!DISK || !existsSync(filePath(id))) return undefined;
  return JSON.parse(readFileSync(filePath(id), "utf8"));
}
/** The process that has the thread loaded, if it is still alive. */
function writer(id) {
  if (!DISK || !existsSync(lockPath(id))) return undefined;
  const pid = Number(readFileSync(lockPath(id), "utf8"));
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}
function lock(id) {
  if (!DISK) return;
  const pid = writer(id);
  if (pid !== undefined && pid !== process.pid) throw { code: -32600, message: `thread ${id} already has an active writer` };
  writeFileSync(lockPath(id), String(process.pid));
}
/** Like Codex: a thread nobody is subscribed to, and that isn't working, is unloaded and free for another process. */
function unloadIfUnused(thread) {
  if (thread.subscribers.size > 0 || thread.active) return;
  thread.loaded = false;
  if (!DISK) return;
  if (writer(thread.meta.id) === process.pid) rmSync(lockPath(thread.meta.id), { force: true });
  if (thread.turns.length > 0) threads.delete(thread.meta.id);
}
const queuePath = (id) => join(DISK, `${id}.queue.json`);
const queued = (id) => (DISK && existsSync(queuePath(id)) ? JSON.parse(readFileSync(queuePath(id), "utf8")) : []);
const setQueued = (id, entries) => writeFileSync(queuePath(id), JSON.stringify(entries));

/** As a process that doesn't run the thread reads it: a turn still running has stopped without an end. */
function diskView(stored, withTurns) {
  const turns = stored.turns.map((turn) => (turn.status === "inProgress" ? { ...turn, status: "interrupted", completedAt: null } : turn));
  return { ...stored.meta, status: { type: "notLoaded" }, path: filePath(stored.meta.id), turns: withTurns ? turns : [] };
}
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
  lock(thread.meta.id);
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
  return { ...thread.meta, status, path: DISK ? filePath(thread.meta.id) : null, turns: withTurns ? thread.turns : [] };
}
/**
 * What thread/resume returns. Like Codex, a turn that is running is given
 * from memory: its messages numbered item-1, item-2… rather than under their
 * ids, and with the command that is still running.
 */
function resumeView(thread) {
  const turns = thread.turns.map((turn) =>
    turn !== thread.active
      ? turn
      : {
          ...turn,
          items: [
            ...turn.items.map((item, index) => (item.type === "userMessage" || item.type === "agentMessage" ? { ...item, id: `item-${index + 1}` } : item)),
            ...(turn.running ? [turn.running] : []),
          ],
        },
  );
  return { ...view(thread, false), turns };
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
  save(thread);
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
  status = turn.finishStatus ?? status;
  turn.status = status;
  turn.completedAt = nowSeconds();
  thread.active = undefined;
  thread.meta.updatedAt = nowSeconds();
  save(thread);
  notifyThread(thread, "turn/completed", { threadId: thread.meta.id, turn: { id: turn.id, items: [], status, error: null } });
  setStatus(thread);
  unloadIfUnused(thread);
}

async function runTurn(thread, turn, text) {
  const threadId = thread.meta.id;
  notifyThread(thread, "turn/started", { threadId, turn: { id: turn.id, items: [], status: "inProgress" } });
  setStatus(thread);
  if (text.includes("MCP_CONFIRM")) {
    const result = await new Promise((resolve) => {
      const id = nextServerRequestId++;
      thread.pendingMcp = true;
      pendingServerRequests.set(id, (_decision, result) => {
        if (!pendingServerRequests.delete(id)) return;
        thread.pendingMcp = false;
        notifyThread(thread, "serverRequest/resolved", { threadId, requestId: id });
        resolve(result);
      });
      for (const conn of thread.subscribers) send(conn, {
        jsonrpc: "2.0", id, method: "mcpServer/elicitation/request",
        params: {
          threadId, turnId: turn.id, serverName: "cua_repl", mode: "form",
          message: 'Allow Computer Use to use "Device Hub"?',
          _meta: { callId: "computer-tool" }, requestedSchema: { type: "object", properties: {} },
        },
      });
    });
    if (result.action === "cancel") return finishTurn(thread, turn, "interrupted");
    text = `mcp ${JSON.stringify(result)}`;
  }
  if (text.includes("RUN")) {
    const command = { type: "commandExecution", id: randomUUID(), command: "echo hi", cwd: thread.meta.cwd, status: "inProgress" };
    const decision = await requestApproval(thread, turn, command);
    if (decision === "accept" || decision === "acceptForSession") {
      turn.running = command;
      notifyThread(thread, "item/started", { threadId, turnId: turn.id, item: command, startedAtMs: Date.now() });
      notifyThread(thread, "item/commandExecution/outputDelta", { threadId, turnId: turn.id, itemId: command.id, delta: "hi\n" });
      // "LONG": the command takes a while, so a client can join while it runs.
      if (text.includes("LONG")) await sleep(400);
      const done = { ...command, status: "completed", exitCode: 0, aggregatedOutput: "hi\n", durationMs: 3 };
      turn.running = undefined;
      turn.items.push(done);
      save(thread);
      notifyThread(thread, "item/completed", { threadId, turnId: turn.id, item: done, completedAtMs: Date.now() });
    } else {
      emitItem(thread, turn, { ...command, status: "declined" });
    }
    if (decision === "cancel" || decision === "interrupted") return finishTurn(thread, turn, "interrupted");
  }
  if (text.includes("ASKME")) {
    // request_user_input: one question with options and an own answer, one to type.
    const answers = await new Promise((resolve) => {
      const id = nextServerRequestId++;
      pendingServerRequests.set(id, (_decision, result) => {
        if (!pendingServerRequests.delete(id)) return;
        notifyThread(thread, "serverRequest/resolved", { threadId, requestId: id });
        resolve(result);
      });
      for (const conn of thread.subscribers) {
        send(conn, {
          jsonrpc: "2.0",
          id,
          method: "item/tool/requestUserInput",
          params: {
            threadId,
            turnId: turn.id,
            itemId: "call_ask",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              { id: "db", header: "Database", question: "Which database should it use?", isOther: true, isSecret: false, options: [{ label: "Postgres", description: "Good default" }, { label: "SQLite", description: "One file" }] },
              { id: "token", header: "Token", question: "Paste the deploy token", isOther: false, isSecret: true, options: null },
            ],
          },
        });
      }
    });
    text = `answers ${JSON.stringify(answers)}`;
  }
  const slow = text.includes("SLOW");
  const prefix = thread.side ? `side[${thread.side.sandbox}/${thread.side.approvalPolicy}/${thread.side.injected.length}/${thread.turns.length}]: ` : "echo: ";
  const chunks = slow ? Array.from({ length: 40 }, (_, i) => `w${i} `) : [prefix, ...text.split(/(\s+)/).filter(Boolean)];
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
  // "BACKGROUND": the turn leaves a command running after it ends, like a dev server.
  if (text.includes("BACKGROUND")) {
    thread.background = [1, 2].map((n) => ({ itemId: randomUUID(), processId: String(n), command: "npm run dev", cwd: thread.meta.cwd, osPid: null, cpuPercent: null, rssKb: null }));
    for (const task of thread.background) {
      notifyThread(thread, "item/started", { threadId, turnId: turn.id, item: { type: "commandExecution", id: task.itemId, command: task.command, status: "inProgress" } });
      notifyThread(thread, "item/commandExecution/outputDelta", { threadId, turnId: turn.id, itemId: task.itemId, delta: "started\n" });
    }
    if (text.includes("BACKGROUND_FAIL")) {
      const task = thread.background[0];
      setTimeout(() => {
        thread.background = thread.background.filter((entry) => entry !== task);
        notifyThread(thread, "item/commandExecution/outputDelta", { threadId, turnId: turn.id, itemId: task.itemId, delta: "after turn\n" });
        notifyThread(thread, "item/completed", { threadId, turnId: turn.id, item: { type: "commandExecution", id: task.itemId, command: task.command, status: "failed", exitCode: 3, aggregatedOutput: "initial output\nstarted\nafter turn\n" } });
      }, 300);
    }
  }
  const message = { type: "agentMessage", id: messageId, text: accumulated };
  turn.items.push(message);
  save(thread);
  notifyThread(thread, "item/completed", { threadId, turnId: turn.id, item: message, completedAtMs: Date.now() });
  finishTurn(thread, turn, turn.interrupted ? "interrupted" : "completed");
}

function startTurn(thread, input, clientId) {
  const turn = { id: randomUUID(), items: [], status: "inProgress", startedAt: nowSeconds(), completedAt: null };
  thread.turns.push(turn);
  thread.active = turn;
  const { item, text } = userItem(input, clientId);
  if (!thread.meta.preview) thread.meta.preview = text;
  save(thread);
  setImmediate(() => {
    emitItem(thread, turn, item);
    void runTurn(thread, turn, text);
  });
  return turn;
}

// Like Codex: whoever queued it, the process that has the thread loaded starts it once the thread is idle.
if (DISK) {
  setInterval(() => {
    for (const thread of threads.values()) {
      if (!thread.loaded || thread.active) continue;
      const [next, ...rest] = queued(thread.meta.id);
      if (!next) continue;
      setQueued(thread.meta.id, rest);
      startTurn(thread, next.input, next.clientUserMessageId);
    }
  }, 25);
}

function userItem(input, clientId) {
  const text = input.filter((part) => part.type === "text").map((part) => part.text).join(" ");
  return { item: { type: "userMessage", id: randomUUID(), clientId: clientId ?? null, content: input }, text };
}

const goals = new Map();
let skillsChanged = false;
const handlers = {
  "account/read": (params) => {
    if (params.refreshToken !== false) throw { code: -32602, message: "status must not refresh credentials" };
    if (!process.env.FAKE_CODEX_ACCOUNT) throw { code: -32601, message: "account/read unavailable" };
    return JSON.parse(process.env.FAKE_CODEX_ACCOUNT);
  },
  "test/changeSkills": () => { skillsChanged = true; broadcast("skills/changed", {}); return {}; },
  "mcpServerStatus/list": (params) => ({ data: [{ name: params.cursor ? "second-server" : "first-server", tools: { check: {} }, authStatus: "notLoggedIn" }], nextCursor: params.cursor ? null : "next" }),
  "app/list": () => ({ data: [{ name: "Test connector", isEnabled: true }], nextCursor: null }),
  "thread/goal/get": (params) => ({ goal: goals.get(params.threadId) ?? null }),
  "thread/goal/set": (params) => {
    const previous = goals.get(params.threadId);
    if (!params.objective && !previous) throw { code: -32602, message: "no goal" };
    const goal = { threadId: params.threadId, objective: params.objective ?? previous.objective, status: params.status ?? "active", tokenBudget: params.tokenBudget ?? previous?.tokenBudget ?? null, tokensUsed: previous?.tokensUsed ?? 0, timeUsedSeconds: 0 };
    goals.set(params.threadId, goal);
    broadcast("thread/goal/updated", { threadId: params.threadId, goal });
    return { goal };
  },
  "thread/goal/clear": (params) => {
    const cleared = goals.delete(params.threadId);
    broadcast("thread/goal/cleared", { threadId: params.threadId });
    return { cleared };
  },
  initialize: () => ({ userAgent: "fake-codex", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos" }),
  "thread/list": () => ({
    // Like Codex: a thread is only persisted (and listed) once it has a turn.
    data: [
      ...[...threads.values()].filter((t) => t.turns.length > 0 && !t.archived).map((t) => view(t, false)),
      // What other processes have written.
      ...(DISK ? readdirSync(DISK) : [])
        .filter((name) => name.endsWith(".json") && !threads.has(name.slice(0, -5)))
        .map((name) => onDisk(name.slice(0, -5)))
        .filter((stored) => !stored.archived)
        .map((stored) => diskView(stored, false)),
    ].sort((a, b) => b.updatedAt - a.updatedAt),
    nextCursor: null,
    backwardsCursor: null,
  }),
  "thread/loaded/list": () => ({ data: [...threads.values()].filter((t) => t.loaded).map((t) => t.meta.id), nextCursor: null }),
  "thread/start": (params, conn) => {
    const thread = newThread(params.cwd ?? process.cwd(), typeof params.model === "string" ? { model: params.model } : {});
    thread.subscribers.add(conn);
    broadcast("thread/started", { thread: view(thread, false) });
    return { thread: view(thread, false), model: thread.meta.model, modelProvider: "fake", cwd: thread.meta.cwd };
  },
  "thread/read": (params) => {
    const thread = threads.get(params.threadId);
    if (thread) return { thread: view(thread, params.includeTurns === true) };
    const stored = onDisk(params.threadId);
    if (!stored) throw { code: -32600, message: "unknown thread" };
    return { thread: diskView(stored, params.includeTurns === true) };
  },
  "thread/fork": (params, conn) => {
    const source = threads.get(params.threadId);
    if (!source) throw { code: -32600, message: "unknown thread" };
    const end = params.lastTurnId ? source.turns.findIndex((turn) => turn.id === params.lastTurnId) : source.turns.length - 1;
    if (end < 0 && params.lastTurnId) throw { code: -32600, message: "unknown turn" };
    const thread = newThread(params.cwd ?? source.meta.cwd, { name: source.meta.name, preview: source.meta.preview, ...(params.ephemeral ? { ephemeral: true } : {}) });
    // What a side conversation is set up with, to say in its replies.
    if (params.ephemeral) thread.side = { instructions: params.developerInstructions ?? "", sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, injected: [] };
    // A fork is on disk with its own copies of the turns it was made through.
    thread.turns = source.turns.slice(0, end + 1).map((turn) => ({ ...turn, id: randomUUID(), items: turn.items.map((item) => ({ ...item })) }));
    save(thread);
    thread.subscribers.add(conn);
    broadcast("thread/started", { thread: view(thread, false) });
    return { thread: view(thread, params.excludeTurns !== true), model: "fake-model", modelProvider: "fake", cwd: thread.meta.cwd };
  },
  "thread/resume": (params, conn) => {
    let thread = threads.get(params.threadId);
    if (!thread) {
      // Not loaded here: from disk, unless another process has it.
      const stored = onDisk(params.threadId);
      if (stored) {
        lock(params.threadId);
        thread = { meta: stored.meta, archived: stored.archived, turns: stored.turns, subscribers: new Set(), loaded: false, active: undefined, pendingApproval: undefined };
        threads.set(params.threadId, thread);
      }
    }
    // Like Codex: resume needs the rollout on disk, which only exists after the first turn.
    if (!thread || thread.turns.length === 0) throw { code: -32600, message: `no rollout found for thread id ${params.threadId}` };
    lock(params.threadId);
    thread.loaded = true;
    thread.subscribers.add(conn);
    return { thread: params.excludeTurns === true ? view(thread, false) : resumeView(thread), model: "fake-model", modelProvider: "fake", cwd: thread.meta.cwd };
  },
  "thread/inject_items": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: "unknown thread" };
    thread.side?.injected.push(...params.items);
    return {};
  },
  "thread/unsubscribe": (params, conn) => {
    const thread = threads.get(params.threadId);
    if (!thread?.subscribers.delete(conn)) return { status: "notSubscribed" };
    unloadIfUnused(thread);
    return { status: "unsubscribed" };
  },
  "turn/start": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: "unknown thread" };
    if (thread.active) throw { code: -32600, message: "a turn is already running" };
    const turn = startTurn(thread, params.input, params.clientUserMessageId);
    turn.settings = { approvalPolicy: params.approvalPolicy, sandboxPolicy: params.sandboxPolicy };
    return { turn: { id: turn.id, items: [], status: "inProgress" } };
  },
  "thread/queue/add": (params) => {
    if (!DISK || (!threads.has(params.threadId) && !onDisk(params.threadId))) throw { code: -32600, message: "unknown thread" };
    const queuedSubmission = { id: randomUUID(), input: params.input, clientUserMessageId: params.clientUserMessageId };
    setQueued(params.threadId, [...queued(params.threadId), queuedSubmission]);
    return { queuedSubmission };
  },
  "thread/queue/list": (params) => ({ data: queued(params.threadId), nextCursor: null }),
  "thread/backgroundTerminals/list": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread?.loaded) throw { code: -32600, message: `thread not found: ${params.threadId}` };
    return { data: thread.background ?? [], nextCursor: null };
  },
  "thread/backgroundTerminals/terminate": (params) => {
    const thread = threads.get(params.threadId);
    const task = thread?.background?.find((entry) => entry.processId === params.processId);
    if (!task) return { terminated: false };
    thread.background = thread.background.filter((entry) => entry !== task);
    notifyThread(thread, "item/completed", { threadId: params.threadId, item: { type: "commandExecution", id: task.itemId, command: task.command, status: "failed", exitCode: 143, aggregatedOutput: "started\n" } });
    return { terminated: true };
  },
  "thread/backgroundTerminals/clean": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: "unknown thread" };
    thread.background = [];
    return {};
  },
  "thread/queue/delete": (params) => {
    const entries = queued(params.threadId);
    const kept = entries.filter((entry) => entry.id !== params.queuedSubmissionId);
    if (kept.length !== entries.length) setQueued(params.threadId, kept);
    return { deleted: kept.length !== entries.length };
  },
  "turn/steer": (params) => {
    const thread = threads.get(params.threadId);
    const turn = thread?.active;
    if (!thread || !turn || turn.id !== params.expectedTurnId) throw { code: -32600, message: "no matching active turn" };
    emitItem(thread, turn, userItem(params.input, params.clientUserMessageId).item);
    return { turnId: turn.id };
  },
  "turn/interrupt": async (params) => {
    const thread = threads.get(params.threadId);
    // The real server can hang on this ordering; fail fast so a regression
    // cannot pass merely because the fixture interrupts every pending tool.
    if (thread?.pendingMcp) throw { code: -32603, message: "MCP confirmation must be resolved before interrupt" };
    const turn = thread?.active;
    if (turn && turn.id === params.turnId) {
      if (turn.items.some((item) => item.type === "userMessage" && item.content.some((part) => part.text?.includes("APPROVAL_DURING_INTERRUPT")))) {
        // An already captured tool can ask after the permission change began,
        // before the old turn has acknowledged interruption.
        const pending = requestApproval(thread, turn, { id: randomUUID(), command: "echo late", cwd: thread.meta.cwd });
        await sleep(30);
        thread.pendingApproval?.("interrupted");
        turn.interruptApprovalDecision = await pending;
      }
      turn.interrupted = true;
      // A task can complete just before an interrupt reaches it.
      if (turn.items.some((item) => item.type === "userMessage" && item.content.some((part) => part.text?.includes("FINISH_ON_INTERRUPT")))) turn.finishStatus = "completed";
      thread.pendingApproval?.("interrupted");
    }
    return {};
  },
  "thread/archive": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: "unknown thread" };
    thread.archived = true;
    save(thread);
    broadcast("thread/archived", { threadId: params.threadId });
    return {};
  },
  "thread/unarchive": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: "unknown thread" };
    thread.archived = false;
    save(thread);
    return {};
  },
  "thread/name/set": (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: "unknown thread" };
    thread.meta.name = params.name;
    save(thread);
    broadcast("thread/name/updated", { threadId: params.threadId, threadName: params.name });
    return {};
  },
  "thread/delete": (params) => {
    if (!threads.delete(params.threadId)) throw { code: -32600, message: "unknown thread" };
    if (DISK) for (const path of [filePath(params.threadId), lockPath(params.threadId)]) rmSync(path, { force: true });
    broadcast("thread/deleted", { threadId: params.threadId });
    return {};
  },
  "skills/list": (params) => ({
    data: [
      {
        cwd: params.cwds?.[0] ?? process.cwd(),
        skills: [
          ...(skillsChanged ? [{ name: "new-skill", description: "Added while connected", path: "/skills/new/SKILL.md", enabled: true }] : []),
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

if (process.env.FAKE_CODEX_MODELS === "1") {
  const models = [
    { id: "gpt-big", model: "gpt-big", displayName: "GPT Big", description: "The large one", hidden: false, isDefault: true,
      defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] },
    { id: "gpt-mini", model: "gpt-mini", displayName: "GPT Mini", description: "", hidden: false, isDefault: false,
      defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
    { id: "gpt-old", model: "gpt-old", displayName: "GPT Old", description: "Retired", hidden: true, isDefault: false,
      defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
  ];
  handlers["model/list"] = (params) => ({ data: models.filter((m) => params.includeHidden || !m.hidden), nextCursor: null });
}
if (process.env.FAKE_CODEX_CONFIG_MODEL !== undefined) {
  const projects = JSON.parse(process.env.FAKE_CODEX_PROJECT_MODELS ?? "{}");
  handlers["config/read"] = (params) => ({
    config: { model: (params.cwd && projects[params.cwd]) || process.env.FAKE_CODEX_CONFIG_MODEL || null },
    origins: {},
    layers: null,
  });
}

// FAKE_CODEX_MCP (JSON: what mcpServerStatus/list lists, in one page) answers
// the MCP App methods from it instead of the paged two-server list above:
// plugin/installed names plugin "mirror@local" "Mirror"; resource/read and
// tool/call answer with what they were asked (a uri with "missing" in it is an
// unknown resource), and test/mcpCalls says which tool calls were made.
// test/setMcp replaces the list (a plugin installed since); test/mcpLists
// counts the reads. test/mcpToolCall plays one mcpToolCall item in a thread:
// item/started with `started`, then item/completed with `completed`.
if (process.env.FAKE_CODEX_MCP !== undefined) {
  let servers = JSON.parse(process.env.FAKE_CODEX_MCP);
  let lists = 0;
  const toolCalls = [];
  handlers["mcpServerStatus/list"] = () => {
    lists++;
    return { data: servers, nextCursor: null };
  };
  handlers["test/setMcp"] = (params) => {
    servers = params.data;
    return {};
  };
  handlers["test/mcpLists"] = () => ({ lists });
  handlers["plugin/installed"] = () => ({
    marketplaces: [{ name: "local", path: null, interface: null, plugins: [{ id: "mirror@local", name: "mirror", installed: true, enabled: true, interface: { displayName: "Mirror" } }] }],
    marketplaceLoadErrors: [],
  });
  handlers["mcpServer/resource/read"] = (params) => {
    if (params.uri.includes("missing")) throw { code: -32602, message: "Invalid params: Unknown screen resource" };
    return {
      contents: [{ uri: params.uri, mimeType: "text/html;profile=mcp-app", text: `<p>${params.server} ${params.threadId ?? "no thread"} ${params.connectorId ?? "no connector"}</p>`, _meta: { ui: { prefersBorder: false } } }],
      originCallId: null,
    };
  };
  handlers["mcpServer/tool/call"] = (params) => {
    toolCalls.push(params);
    return { content: [{ type: "text", text: `called ${params.tool}` }], structuredContent: { echo: params.arguments ?? null }, isError: false };
  };
  handlers["test/mcpCalls"] = () => ({ calls: toolCalls });
  handlers["test/mcpToolCall"] = (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw { code: -32600, message: `no thread ${params.threadId}` };
    const turnId = randomUUID();
    notifyThread(thread, "item/started", { threadId: params.threadId, turnId, item: params.started, startedAtMs: Date.now() });
    notifyThread(thread, "item/completed", { threadId: params.threadId, turnId, item: params.completed, completedAtMs: Date.now() });
    return {};
  };
}

rmSync(socketPath, { force: true });
const server = createServer();
const wss = new WebSocketServer({ server, perMessageDeflate: false });
wss.on("connection", (ws) => {
  const conn = { ws };
  connections.add(conn);
  ws.on("close", () => {
    connections.delete(conn);
    for (const thread of [...threads.values()]) if (thread.subscribers.delete(conn)) unloadIfUnused(thread);
  });
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.method === undefined && message.id !== undefined) {
      pendingServerRequests.get(message.id)?.(message.result?.decision, message.result);
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
  if (DISK) for (const id of threads.keys()) if (writer(id) === process.pid) rmSync(lockPath(id), { force: true });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
