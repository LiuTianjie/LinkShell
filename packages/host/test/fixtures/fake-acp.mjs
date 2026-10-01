#!/usr/bin/env node
// A stand-in ACP agent (newline-delimited JSON-RPC over stdio) that behaves
// like the real ones LinkShell talks to: sessions persist across restarts
// (FAKE_ACP_STORE), session/load replays history with message ids, prompts
// stream thought + message chunks, "RUN" asks for permission, "SLOW" streams
// slowly so it can be cancelled or steered.
//
//   FAKE_ACP_MESSAGE_IDS=0   omit messageId (like agents that don't send them)
//   FAKE_ACP_STEERING=1      advertise Claude-style prompt queueing (steer)
//   FAKE_ACP_FAIL_AUTH=1     every prompt fails with an auth error
//   FAKE_ACP_CLAUDE_DIR=dir  Claude mode: sessions are Claude Code transcripts
//                            under dir/projects, like claude-agent-acp
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-acp 1.2.3\n");
  process.exit(0);
}

const withIds = process.env.FAKE_ACP_MESSAGE_IDS !== "0";
const steering = process.env.FAKE_ACP_STEERING === "1";
const storePath = process.env.FAKE_ACP_STORE;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const claudeDir = process.env.FAKE_ACP_CLAUDE_DIR;

// ── Claude mode: transcripts are the store ──
function transcriptPath(sessionId, cwd) {
  const projects = join(claudeDir, "projects");
  if (existsSync(projects)) {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  }
  // Claude keys projects by the canonical path, like the TUI's process.cwd().
  const canonical = cwd && existsSync(cwd) ? realpathSync(cwd) : cwd;
  return canonical ? join(projects, canonical.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`) : undefined;
}
function appendTranscript(sessionId, cwd, entry) {
  const path = transcriptPath(sessionId, cwd);
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, JSON.stringify({ isSidechain: false, sessionId, cwd, entrypoint: "sdk-ts", timestamp: new Date().toISOString(), ...entry }) + "\n");
}
function claudeSessions() {
  const projects = join(claudeDir, "projects");
  if (!existsSync(projects)) return [];
  const found = [];
  for (const dir of readdirSync(projects)) {
    for (const file of readdirSync(join(projects, dir))) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(projects, dir, file);
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const first = lines.find((l) => l.type === "user");
      const title = lines.findLast?.((l) => l.type === "ai-title")?.aiTitle ?? (typeof first?.message?.content === "string" ? first.message.content : null);
      found.push({ sessionId: file.replace(/\.jsonl$/, ""), cwd: first?.cwd ?? "/", title, updatedAt: new Date(statSync(path).mtimeMs).toISOString() });
    }
  }
  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** sessionId -> { cwd, title, updatedAt, mode, model, history: [{role, id, text, tool?}] } */
const sessions = storePath && existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : {};
const loaded = new Set();
const running = new Map(); // sessionId -> { cancelled, handedOff }
const pendingClientRequests = new Map();
let nextId = 1;
let messageCounter = Object.values(sessions).reduce((n, s) => n + s.history.length, 0);

function persist() {
  if (storePath) writeFileSync(storePath, JSON.stringify(sessions));
}
function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}
function update(sessionId, payload) {
  send({ method: "session/update", params: { sessionId, update: payload } });
}
function chunk(kind, messageId, text) {
  const payload = { sessionUpdate: kind, content: { type: "text", text } };
  if (withIds && messageId) payload.messageId = messageId;
  return payload;
}
function requestClient(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pendingClientRequests.set(id, resolve));
}
function config(session) {
  return {
    modes: {
      currentModeId: session.mode,
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
    },
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: session.model,
        options: [
          { value: "fast", name: "Fast" },
          { value: "smart", name: "Smart" },
        ],
      },
    ],
  };
}
function requireSession(params) {
  const session = sessions[params.sessionId];
  if (!session) throw { code: -32002, message: `session not found: ${params.sessionId}` };
  return session;
}
function requireOpenArgs(params) {
  if (!Array.isArray(params.mcpServers)) throw { code: -32602, message: "Invalid params: mcpServers is required" };
  if (typeof params.cwd !== "string") throw { code: -32602, message: "Invalid params: cwd is required" };
}

async function runPrompt(sessionId, text) {
  const session = sessions[sessionId];
  const turn = { cancelled: false, handedOff: false };
  running.set(sessionId, turn);
  session.history.push({ role: "user", id: randomUUID(), text });
  if (!session.title) session.title = text.slice(0, 40);
  if (claudeDir) appendTranscript(sessionId, session.cwd, { type: "user", uuid: randomUUID(), message: { role: "user", content: text } });
  if (process.env.FAKE_ACP_FAIL_AUTH === "1") {
    running.delete(sessionId);
    throw { code: -32000, message: "Authentication required: please run /login" };
  }
  if (text.includes("ASK")) {
    // Like Claude's adapter presents AskUserQuestion: a form, each question with a field for an answer of the user's own.
    const option = (label, description) => ({ const: label, title: label, ...(description ? { description } : {}) });
    const outcome = await requestClient("elicitation/create", {
      mode: "form",
      sessionId,
      toolCallId: "toolu_ask",
      message: "Please answer the following questions.",
      requestedSchema: {
        type: "object",
        properties: {
          question_0: { type: "string", title: "Database", description: "Which database should it use?", oneOf: [option("Postgres", "Good default"), option("SQLite")] },
          question_0_custom: { type: "string", title: "Other" },
          question_1: { type: "array", title: "Checks", description: "Which checks should run?", items: { anyOf: [option("lint"), option("tests"), option("types")] } },
          question_1_custom: { type: "string", title: "Other" },
        },
      },
    });
    const messageId = `msg_${++messageCounter}`;
    update(sessionId, chunk("agent_message_chunk", messageId, `asked: ${JSON.stringify(outcome)}`));
    session.history.push({ role: "agent", id: messageId, text: `asked: ${JSON.stringify(outcome)}` });
    if (outcome?.action === "cancel") {
      running.delete(sessionId);
      return "cancelled";
    }
    running.delete(sessionId);
    return "end_turn";
  }
  if (text.includes("RUN")) {
    const toolCallId = `toolu_${++messageCounter}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Run echo hi", kind: "execute", status: "pending", rawInput: { command: "echo hi" } });
    const answer = await requestClient("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: "Run echo hi", kind: "execute", rawInput: { command: "echo hi" } },
      options: [
        { optionId: "allow-once", name: "Yes", kind: "allow_once" },
        { optionId: "allow-always", name: "Yes, always", kind: "allow_always" },
        { optionId: "reject", name: "No", kind: "reject_once" },
      ],
    });
    const allowed = answer?.outcome?.outcome === "selected" && answer.outcome.optionId.startsWith("allow");
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: allowed ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: allowed ? "hi" : "denied" } }],
    });
    session.history.push({ role: "tool", id: toolCallId, text: allowed ? "hi" : "denied", ok: allowed });
    if (turn.cancelled) {
      running.delete(sessionId);
      return "cancelled";
    }
  }
  const messageId = claudeDir ? `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}` : `msg_${++messageCounter}`;
  update(sessionId, chunk("agent_thought_chunk", messageId, "thinking"));
  const slow = text.includes("SLOW");
  const parts = slow ? Array.from({ length: 30 }, (_, i) => `s${i} `) : ["echo: ", text];
  let said = "";
  for (const part of parts) {
    if (turn.cancelled || turn.handedOff) break;
    await sleep(slow ? 30 : 1);
    if (turn.cancelled || turn.handedOff) break;
    said += part;
    update(sessionId, chunk("agent_message_chunk", messageId, part));
  }
  session.history.push({ role: "agent", id: messageId, text: said });
  if (claudeDir) {
    appendTranscript(sessionId, session.cwd, { type: "assistant", uuid: randomUUID(), message: { id: messageId, role: "assistant", content: [{ type: "thinking", thinking: "thinking" }], stop_reason: null } });
    appendTranscript(sessionId, session.cwd, { type: "assistant", uuid: randomUUID(), message: { id: messageId, role: "assistant", content: [{ type: "text", text: said }], stop_reason: "end_turn" } });
  }
  session.updatedAt = new Date().toISOString();
  persist();
  if (running.get(sessionId) === turn) running.delete(sessionId);
  return turn.cancelled ? "cancelled" : "end_turn";
}

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, ...(process.env.FAKE_ACP_FORK === "1" ? { fork: {} } : {}) },
      _meta: steering ? { claudeCode: { promptQueueing: true } } : {},
    },
    agentInfo: { name: "fake-acp", version: "1.2.3" },
  }),
  "session/new": (params) => {
    requireOpenArgs(params);
    // Grok: no login, no session.
    if (process.env.FAKE_ACP_SIGNED_OUT === "1") throw { code: -32000, message: "Authentication required", data: "no auth method id provided" };
    const sessionId = randomUUID();
    sessions[sessionId] = { cwd: params.cwd, title: null, updatedAt: new Date().toISOString(), mode: "default", model: "fast", history: [] };
    loaded.add(sessionId);
    persist();
    return { sessionId, ...config(sessions[sessionId]) };
  },
  "session/fork": (params) => {
    const original = requireSession(params);
    const sessionId = randomUUID();
    sessions[sessionId] = { ...original, cwd: params.cwd, history: [...original.history], updatedAt: new Date().toISOString() };
    persist();
    return { sessionId, ...config(sessions[sessionId]) };
  },
  "session/list": () => claudeDir ? { sessions: claudeSessions(), nextCursor: null } : ({
    sessions: Object.entries(sessions)
      .filter(([, s]) => s.history.length > 0)
      .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
      .map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt })),
    nextCursor: null,
  }),
  "session/load": async (params) => {
    requireOpenArgs(params);
    const session = requireSession(params);
    for (const entry of session.history) {
      if (entry.role === "user") update(params.sessionId, { ...chunk("user_message_chunk", entry.id, entry.text) });
      else if (entry.role === "agent") update(params.sessionId, chunk("agent_message_chunk", entry.id, entry.text));
      else if (entry.role === "tool") {
        update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: entry.id, title: "Run echo hi", kind: "execute", status: entry.ok ? "completed" : "failed" });
      }
    }
    loaded.add(params.sessionId);
    return config(session);
  },
  "session/resume": (params) => {
    requireOpenArgs(params);
    if (claudeDir) {
      if (!existsSync(transcriptPath(params.sessionId, params.cwd) ?? "")) throw { code: -32002, message: `No conversation found with session ID: ${params.sessionId}` };
      sessions[params.sessionId] ??= { cwd: params.cwd, title: null, updatedAt: new Date().toISOString(), mode: "default", model: "fast", history: [] };
    }
    loaded.add(params.sessionId);
    return config(requireSession(params));
  },
  "session/delete": (params) => {
    requireSession(params);
    delete sessions[params.sessionId];
    loaded.delete(params.sessionId);
    persist();
    return {};
  },
  "session/close": (params) => {
    loaded.delete(params.sessionId);
    return {};
  },
  "session/prompt": async (params) => {
    requireSession(params);
    if (!loaded.has(params.sessionId)) throw { code: -32002, message: "session not loaded" };
    const text = params.prompt.filter((p) => p.type === "text").map((p) => p.text).join(" ");
    const current = running.get(params.sessionId);
    if (current) {
      if (!steering) throw { code: -32000, message: "a turn is already running" };
      current.handedOff = true;
    }
    return { stopReason: await runPrompt(params.sessionId, text) };
  },
  "session/set_mode": (params) => {
    requireSession(params).mode = params.modeId;
    persist();
    update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.modeId });
    return {};
  },
  "session/set_config_option": (params) => {
    const session = requireSession(params);
    if (params.configId === "model") session.model = params.value;
    persist();
    return { configOptions: config(session).configOptions };
  },
};

let buffer = "";
process.stdin.on("data", (data) => {
  buffer += data.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === undefined && message.id !== undefined) {
      pendingClientRequests.get(message.id)?.(message.result);
      pendingClientRequests.delete(message.id);
      continue;
    }
    if (message.method === "session/cancel") {
      const turn = running.get(message.params?.sessionId);
      if (turn) turn.cancelled = true;
      // Pending permission prompts resolve as cancelled on the client side.
      continue;
    }
    if (message.id === undefined) continue;
    const handler = handlers[message.method];
    Promise.resolve()
      .then(() => {
        if (!handler) throw { code: -32601, message: `Method not found: ${message.method}` };
        return handler(message.params ?? {});
      })
      .then(
        (result) => send({ id: message.id, result }),
        (error) => send({ id: message.id, error: { code: error.code ?? -32603, message: error.message ?? String(error) } }),
      );
  }
});
process.stdin.on("end", () => process.exit(0));
