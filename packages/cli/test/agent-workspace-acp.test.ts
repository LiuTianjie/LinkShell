import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnvelope } from "@linkshell/protocol";
import { parseAcpInitializeCapabilities } from "../src/runtime/acp/acp-client.js";
import { AgentWorkspaceProxy } from "../src/runtime/acp/agent-workspace.js";

const proxies: AgentWorkspaceProxy[] = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.stop();
});

function makeFakeAcpAgent(): { command: string; logPath: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "linkshell-acp-workspace-"));
  const serverPath = join(cwd, "fake-acp-agent.mjs");
  const logPath = join(cwd, "messages.jsonl");
  writeFileSync(serverPath, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = ${JSON.stringify(logPath)};
let pendingPromptId = null;
let sessionId = "sess-acp-1";

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function log(message) {
  appendFileSync(logPath, JSON.stringify(message) + "\\n");
}

function emitUpdate(update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function handle(message) {
  log(message);
  if ("result" in message || "error" in message) {
    if (pendingPromptId != null) {
      emitUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "allowed" },
      });
      send({ jsonrpc: "2.0", id: pendingPromptId, result: { stopReason: "end_turn" } });
      pendingPromptId = null;
    }
    return;
  }
  if (!("id" in message)) return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false },
        },
        sessionCapabilities: {
          "session/list": true,
        },
      },
    });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessions: [] } });
    return;
  }
  if (message.method === "session/load") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/prompt") {
    const text = JSON.stringify(message.params ?? {});
    if (text.includes("need-perm")) {
      pendingPromptId = message.id;
      send({
        jsonrpc: "2.0",
        id: "perm-1",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolName: "Bash", input: { command: "ls" } },
        },
      });
      return;
    }
    emitUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking-about-it" },
    });
    emitUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Read",
      kind: "read",
      status: "pending",
      rawInput: { path: "foo.ts" },
    });
    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      rawOutput: { ok: true },
    });
    emitUpdate({
      sessionUpdate: "plan",
      entries: [
        { content: "step-one", status: "completed" },
        { content: "step-two", status: "in_progress" },
      ],
    });
    emitUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello-from-acp" },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  handle(JSON.parse(line));
});
`, "utf8");
  return { command: `node ${JSON.stringify(serverPath)}`, logPath, cwd };
}

async function waitForLog(logPath: string, method: string, timeoutMs = 4000): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const entries = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (entries.some((entry) => entry.method === method)) return entries;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

async function waitForSent(sent: any[], type: string, timeoutMs = 4000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = sent.find((envelope) => envelope.type === type);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${type}; got ${sent.map((e) => e.type).join(",")}`);
}

function makeWorkspace(fake: { command: string; cwd: string }) {
  const sent: any[] = [];
  const proxy = new AgentWorkspaceProxy({
    sessionId: "session-1",
    cwd: fake.cwd,
    availableProviders: ["claude"],
    command: fake.command,
    discoverProcesses: () => [],
    send: (envelope) => sent.push(envelope),
  });
  proxies.push(proxy);
  return { proxy, sent };
}

describe("parseAcpInitializeCapabilities", () => {
  it("claims only advertised optional methods", () => {
    const caps = parseAcpInitializeCapabilities({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false },
      },
      sessionCapabilities: { "session/list": true },
    });
    expect(caps.loadSession).toBe(true);
    expect(caps.listSession).toBe(true);
    expect(caps.images).toBe(true);
    expect(caps.audio).toBe(false);
    expect(caps.setModel).toBe(false);
    expect(caps.forkSession).toBe(false);
  });

  it("treats session/cancel as ACP v1 baseline when initialize omits it", () => {
    const caps = parseAcpInitializeCapabilities({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false },
      },
    });
    expect(caps.cancel).toBe(true);
    expect(caps.listSession).toBe(false);
    expect(caps.setModel).toBe(false);
    expect(caps.forkSession).toBe(false);
    expect(caps.audio).toBe(false);
  });
});

describe("AgentWorkspaceProxy ACP subprocess", () => {
  it("runs initialize → session/new → session/prompt and forwards session/update", async () => {
    const fake = makeFakeAcpAgent();
    const { proxy, sent } = makeWorkspace(fake);

    await proxy.handleEnvelope(createEnvelope({
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      payload: { cwd: fake.cwd, provider: "claude" },
    }));

    const opened = await waitForSent(sent, "agent.v2.conversation.opened");
    const conversationId = opened.payload.conversation.id as string;

    const promptDone = proxy.handleEnvelope(createEnvelope({
      type: "agent.v2.prompt",
      sessionId: "session-1",
      payload: {
        conversationId,
        clientMessageId: "m1",
        contentBlocks: [{ type: "text", text: "hello" }],
      },
    }));
    await promptDone;

    const payloads = sent
      .filter((envelope) => envelope.type === "agent.v2.event")
      .map((envelope) => envelope.payload);
    expect(payloads.some((payload) => JSON.stringify(payload).includes("thinking-about-it"))).toBe(true);
    expect(payloads.some((payload) => payload.item?.type === "tool_call" && payload.item?.toolCall?.name === "Read")).toBe(true);
    expect(payloads.some((payload) => payload.item?.toolCall?.id === "call-1" && payload.item?.toolCall?.status === "completed")).toBe(true);
    expect(payloads.some((payload) => payload.item?.type === "plan" && JSON.stringify(payload).includes("step-one"))).toBe(true);
    expect(payloads.some((payload) => JSON.stringify(payload).includes("hello-from-acp"))).toBe(true);

    const methods = (await waitForLog(fake.logPath, "session/prompt")).map((entry) => entry.method);
    expect(methods).toEqual(expect.arrayContaining(["initialize", "session/new", "session/prompt"]));
  });

  it("round-trips session/request_permission on the subprocess connection", async () => {
    const fake = makeFakeAcpAgent();
    const { proxy, sent } = makeWorkspace(fake);

    await proxy.handleEnvelope(createEnvelope({
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      payload: { cwd: fake.cwd, provider: "claude" },
    }));
    const opened = await waitForSent(sent, "agent.v2.conversation.opened");
    const conversationId = opened.payload.conversation.id as string;

    const promptDone = proxy.handleEnvelope(createEnvelope({
      type: "agent.v2.prompt",
      sessionId: "session-1",
      payload: {
        conversationId,
        clientMessageId: "m-perm",
        contentBlocks: [{ type: "text", text: "need-perm" }],
      },
    }));

    const request = await waitForSent(sent, "agent.v2.permission.request");
    expect(request.payload.toolName).toBe("Bash");

    await proxy.handleEnvelope(createEnvelope({
      type: "agent.v2.permission.respond",
      sessionId: "session-1",
      payload: {
        conversationId,
        requestId: request.payload.requestId,
        outcome: "allow",
      },
    }));
    await promptDone;

    const assistant = sent.find((envelope) =>
      envelope.type === "agent.v2.event" && JSON.stringify(envelope.payload).includes("allowed"),
    );
    expect(assistant, "permission allow should resume the ACP turn").toBeDefined();

    const entries = await waitForLog(fake.logPath, "session/prompt");
    const permissionResult = entries.find((entry) => entry.id === "perm-1" && "result" in entry);
    expect(permissionResult).toBeDefined();
    expect(permissionResult?.result).toMatchObject({
      outcome: { outcome: "selected" },
    });
  });

  it("forwards advertised capabilities and invokes session/list + session/cancel", async () => {
    const fake = makeFakeAcpAgent();
    const { proxy, sent } = makeWorkspace(fake);

    await proxy.handleEnvelope(createEnvelope({
      type: "agent.v2.conversation.open",
      sessionId: "session-1",
      payload: { cwd: fake.cwd, provider: "claude" },
    }));
    const opened = await waitForSent(sent, "agent.v2.conversation.opened");
    const caps = sent.filter((envelope) => envelope.type === "agent.v2.capabilities").at(-1);
    expect(caps).toBeDefined();
    const provider = caps.payload.providers.find((item: { id: string }) => item.id === "claude");
    expect(provider.features.loadSession).toBe(true);
    expect(provider.features.sessionList).toBe(true);
    expect(provider.features.cancel).toBe(true);
    expect(provider.features.images).toBe(true);
    expect(provider.features.audio).toBe(false);
    expect(provider.features.setModel).toBe(false);
    expect(caps.payload.supportsSessionLoad).toBe(true);
    expect(caps.payload.supportsAudio).toBe(false);

    await proxy.handleEnvelope(createEnvelope({
      type: "agent.v2.conversation.list",
      sessionId: "session-1",
      payload: {},
    }));
    await waitForLog(fake.logPath, "session/list");

    await proxy.handleEnvelope(createEnvelope({
      type: "agent.v2.prompt",
      sessionId: "session-1",
      payload: {
        conversationId: opened.payload.conversation.id,
        clientMessageId: "m-cancel",
        contentBlocks: [{ type: "text", text: "hello" }],
      },
    }));
    await waitForSent(sent, "agent.v2.event");

    await proxy.handleEnvelope(createEnvelope({
      type: "agent.v2.cancel",
      sessionId: "session-1",
      payload: { conversationId: opened.payload.conversation.id },
    }));
    const entries = await waitForLog(fake.logPath, "session/cancel");
    expect(entries.some((entry) => entry.method === "session/cancel")).toBe(true);
  });
});
