import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const version = Number(process.env.ACP_TEST_VERSION ?? 1);
const sessions = new Map(), requests = new Map();
let sequence = 0, clientCapabilities;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const notify = (method, params) => send({ method, params });
const update = (sessionId, payload, record = true) => {
  if (record) sessions.get(sessionId)?.history.push(payload);
  notify("session/update", { sessionId, update: payload });
};
const ask = (method, params, id = `agent:${++sequence}`) => new Promise((resolve, reject) => {
  requests.set(id, { resolve, reject }); send({ id, method, params });
});
const text = (sessionId, messageId, value) => update(sessionId, version === 2
  ? { sessionUpdate: "agent_message", messageId, content: [{ type: "text", text: value }] }
  : { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: value } });
const config = () => [{ id: "enabled", name: "Enabled", type: "boolean", currentValue: false }, { id: "model", name: "Model", type: "select", category: "model", currentValue: "a", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }];
const state = (sessionId, value, stopReason) => update(sessionId, { sessionUpdate: "state_update", state: value, ...(stopReason ? { stopReason } : {}) });
const finish = (sessionId, stopReason = "end_turn") => { if (version === 2) state(sessionId, "idle", stopReason); };

async function run(sessionId, prompt) {
  const session = sessions.get(sessionId);
  if (prompt === "FORM") {
    const response = await ask("elicitation/create", { mode: "form", sessionId, message: "人数", requestedSchema: { type: "object", required: ["count"], properties: { count: { type: "integer", minimum: 1, maximum: 5, default: 2 } } } });
    text(sessionId, "answer", JSON.stringify(response));
  } else if (prompt === "CANCEL_PERMISSION") {
    const id = `agent:${++sequence}`;
    const response = ask("session/request_permission", { sessionId, toolCall: { toolCallId: "t", title: "Do work", kind: "execute" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }, id);
    setTimeout(() => notify("$/cancel_request", { requestId: id }), 40);
    text(sessionId, "answer", JSON.stringify(await response));
  } else if (prompt === "IO") {
    const path = join(session.cwd, "written.txt");
    await ask("fs/write_text_file", { sessionId, path, content: "第一行\n第二行\n" });
    const content = await ask("fs/read_text_file", { sessionId, path, line: 2, limit: 1 });
    const { terminalId } = await ask("terminal/create", { sessionId, command: process.execPath, args: ["-e", "process.stdout.write('终端中文')"], outputByteLimit: 128 });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "terminal-tool", title: "Terminal", kind: "execute", status: "in_progress", content: [{ type: "terminal", terminalId }] });
    const exit = await ask("terminal/wait_for_exit", { sessionId, terminalId });
    const output = await ask("terminal/output", { sessionId, terminalId });
    await ask("terminal/release", { sessionId, terminalId });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "terminal-tool", status: "completed" });
    text(sessionId, "answer", JSON.stringify({ content, output, exit }));
  } else if (prompt === "STREAM_IO") {
    const script = "let i=0;const timer=setInterval(()=>{process.stdout.write(String(i).padStart(4,'0')+'x'.repeat(1020));if(++i===100)clearInterval(timer)},2)";
    const { terminalId } = await ask("terminal/create", { sessionId, command: process.execPath, args: ["-e", script], outputByteLimit: 256 * 1024 });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "stream-output", title: "Terminal stream", kind: "execute", status: "in_progress", content: [{ type: "terminal", terminalId }] });
    await ask("terminal/wait_for_exit", { sessionId, terminalId });
    await ask("terminal/release", { sessionId, terminalId });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "stream-output", status: "completed" });
    text(sessionId, "stream-done", "done");
  } else if (prompt === "CHILD") {
    const child = "child-1";
    update(sessionId, { sessionUpdate: "subagent_update", sessionId: child, title: "审查", description: "审查更改", capabilities: { cancel: {} }, state: { state: "running" } });
    text(child, "answer", "子代理输出");
    const permission = ask("session/request_permission", { sessionId: child, toolCall: { toolCallId: "child-tool", title: "Read file" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });
    void permission.then(() => update(sessionId, { sessionUpdate: "subagent_update", sessionId: child, state: { state: "idle", stopReason: "end_turn" } }));
  } else if (prompt === "EVENTS") {
    update(sessionId, { sessionUpdate: "notice", severity: "warning", title: "临时提示" }, false);
    update(sessionId, { sessionUpdate: "compaction_update", compactionId: "c", status: "in_progress" });
    update(sessionId, { sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: { type: "text", text: "概要" } });
    update(sessionId, { sessionUpdate: "compaction_update", compactionId: "c", status: "completed" });
    update(sessionId, { sessionUpdate: "usage_update", used: 50, size: 1000, cost: { amount: 0.1, currency: "USD" } });
    text(sessionId, "answer", "done");
  } else if (prompt === "UTF8") {
    const message = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "中文" }, messageId: "utf8" } } }) + "\n");
    const index = message.indexOf(Buffer.from("中")) + 1;
    process.stdout.write(message.subarray(0, index)); await new Promise((resolve) => setTimeout(resolve, 10)); process.stdout.write(message.subarray(index));
  } else if (prompt === "CAPS") text(sessionId, "caps", JSON.stringify({ capabilities: clientCapabilities, setup: session.setup }));
  else {
    await new Promise((resolve) => setTimeout(resolve, 120));
    text(sessionId, `reply:${prompt}`, `answer ${prompt}`);
    if (version === 2) text(sessionId, `reply:${prompt}`, `replaced ${prompt}`);
  }
  finish(sessionId);
  return { stopReason: "end_turn", usage: { totalTokens: 20, inputTokens: 12, outputTokens: 8 } };
}

const providers = [{ providerId: "main", supported: ["anthropic"], required: true, current: { apiType: "anthropic", baseUrl: "https://example.com" } }, { providerId: "other", supported: ["openai"], required: false }];
async function request(method, params, id) {
  if (process.env.ACP_TEST_LOG) appendFileSync(process.env.ACP_TEST_LOG, JSON.stringify({ method, params }) + "\n");
  if (method === "initialize") {
    clientCapabilities = version === 2 ? params.capabilities : params.clientCapabilities;
    if (params.protocolVersion !== version) throw new Error("Wrong negotiated protocol");
    return version === 2
      ? { protocolVersion: 2, info: { name: "test" }, capabilities: { session: { prompt: { image: {}, audio: {}, embeddedContext: {} }, mcp: { stdio: {}, http: {}, acp: {} }, additionalDirectories: {}, delete: {} }, auth: {}, providers: {} }, authMethods: [{ type: "agent", methodId: "form", name: "表单登录" }, { type: "agent", methodId: "url", name: "网页登录" }] }
      : { protocolVersion: 1, agentInfo: { name: "test" }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true, acp: true }, sessionCapabilities: { list: {}, resume: {}, close: {}, additionalDirectories: {}, delete: {} }, auth: { logout: {} }, providers: {} }, authMethods: [{ id: "form", name: "表单登录" }, { id: "url", name: "网页登录" }, { id: "terminal", type: "terminal", name: "终端登录", args: ["--login"] }] };
  }
  if (method === "session/list") return { sessions: [...sessions].map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, updatedAt: new Date().toISOString() })) };
  if (method === "session/new") {
    const sessionId = randomUUID(); sessions.set(sessionId, { cwd: params.cwd, setup: params, history: [] });
    return { sessionId, configOptions: config(), availableCommands: [{ name: "check", description: "检查" }] };
  }
  if (method === "session/resume" || method === "session/load") {
    if (version === 2 && params.replayFrom?.type !== "start") throw new Error("Must request replay");
    for (const item of sessions.get(params.sessionId).history) update(params.sessionId, item, false);
    return { configOptions: config() };
  }
  if (method === "session/set_config_option") {
    if (params.configId === "enabled" && typeof params.value !== "boolean") throw new Error("Not a boolean");
    return { configOptions: params.configId === "model" && params.value === "b" ? [] : [{ ...config()[0], currentValue: params.value }] };
  }
  if (method === "session/prompt") {
    const prompt = params.prompt.map((block) => block.text ?? "").join("");
    if (version === 1) return run(params.sessionId, prompt);
    const messageId = `user:${++sequence}`;
    update(params.sessionId, { sessionUpdate: "user_message", messageId, content: params.prompt });
    state(params.sessionId, "running");
    if (prompt === "FAST") finish(params.sessionId);
    else void run(params.sessionId, prompt);
    return { messageId };
  }
  if (method === "authenticate" || method === "auth/login") {
    const response = await ask("elicitation/create", params.methodId === "url"
      ? { requestId: id, mode: "url", message: "请登录", url: "https://example.com/authorize", elicitationId: "login" }
      : { requestId: id, mode: "form", message: "验证码", requestedSchema: { type: "object", required: ["code"], properties: { code: { type: "string", minLength: 4, maxLength: 4 } } } });
    if (response.action !== "accept") throw new Error("Login cancelled");
    return {};
  }
  if (method === "providers/list") return { providers };
  if (method === "providers/set") { providers.find((p) => p.providerId === params.providerId).current = { apiType: params.apiType, baseUrl: params.baseUrl }; return {}; }
  if (method === "providers/disable") { delete providers.find((p) => p.providerId === params.providerId).current; return {}; }
  if (["session/close", "session/delete", "logout", "auth/logout"].includes(method)) return {};
  throw new Error(`Unknown method ${method}`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) { const pending = requests.get(message.id); requests.delete(message.id); if (message.error) pending?.reject(new Error(message.error.message)); else pending?.resolve(message.result); return; }
  if (message.id === undefined) {
    if (message.method === "session/cancel") {
      if (process.env.ACP_TEST_LOG) appendFileSync(process.env.ACP_TEST_LOG, JSON.stringify(message) + "\n");
      finish(message.params.sessionId, "cancelled");
    }
    return;
  }
  void request(message.method, message.params ?? {}, message.id).then((result) => send({ id: message.id, result }), (error) => send({ id: message.id, error: { code: -32602, message: error.message } }));
});
