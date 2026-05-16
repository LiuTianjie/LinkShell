import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpClient } from "../src/runtime/acp/acp-client.js";
import { resolveAgentCommand } from "../src/runtime/acp/provider-resolver.js";

const clients: AcpClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  delete process.env.LINKSHELL_CLAUDE_PROVIDER;
});

function makeFakeAppServer(): { command: string; logPath: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "linkshell-acp-test-"));
  const serverPath = join(cwd, "fake-app-server.mjs");
  const logPath = join(cwd, "messages.jsonl");
  writeFileSync(serverPath, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = ${JSON.stringify(logPath)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  appendFileSync(logPath, JSON.stringify(message) + "\\n");
  if (!("id" in message)) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
  } else if (message.method === "model/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
        defaultModel: "gpt-5.5",
        reasoningEfforts: ["minimal", "high"]
      }
    });
  } else if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } });
  } else if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-1" } } });
  } else if (message.method === "thread/compact/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
  } else if (message.method === "thread/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { threads: [{ id: "thread-1", cwd: ${JSON.stringify(cwd)}, title: "Remote test thread", status: "running", runningTurnId: "turn-1", archived: false }] } });
  } else if (message.method === "thread/turns/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        turns: [{
          id: "turn-1",
          createdAt: "2026-05-16T01:00:00.000Z",
          input: [{ type: "text", text: "Remote user prompt" }],
          output: [{ type: "text", text: "Remote assistant answer" }],
          status: "completed"
        }]
      }
    });
  } else {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
`, "utf8");
  return { command: `node ${serverPath}`, logPath, cwd };
}

async function waitForLogEntries(logPath: string, count: number): Promise<Array<Record<string, any>>> {
  const { readFileSync } = await import("node:fs");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const entries = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (entries.length >= count) return entries;
    } catch {
      // File may not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

describe("AcpClient codex app-server protocol", () => {
  it("uses app-server initialize, initialized notification, model/list, and permissions on turn/start", async () => {
    const fake = makeFakeAppServer();
    const client = new AcpClient({
      command: fake.command,
      protocol: "codex-app-server",
      framing: "newline",
      cwd: fake.cwd,
      onNotification: () => {},
      onRequest: () => ({}),
      onExit: () => {},
    });
    clients.push(client);

    await client.initialize();
    const models = await client.listModels();
    const session = await client.newSession({ cwd: fake.cwd });
    const sessions = await client.listSessions();
    const turns = await client.listTurns({ sessionId: "thread-1" });
    await client.prompt({
      sessionId: "thread-1",
      content: [{ type: "text", text: "hello" }],
      clientMessageId: "client-msg-1",
      reasoningEffort: "high",
      serviceTier: "fast",
      permissionMode: "workspace_write",
      collaborationMode: "plan",
      cwd: fake.cwd,
    });
    await client.compact({ sessionId: "thread-1" });

    expect(models).toMatchObject({
      models: [{ id: "gpt-5.5", label: "GPT-5.5" }],
      defaultModel: "gpt-5.5",
    });
    expect(session).toMatchObject({ thread: { id: "thread-1" } });
    expect((sessions as any).sessions).toContainEqual(
      expect.objectContaining({
        id: "thread-1",
        title: "Remote test thread",
        status: "running",
        runningTurnId: "turn-1",
      }),
    );
    expect(turns).toMatchObject({
      turns: [expect.objectContaining({ id: "turn-1" })],
    });

    const entries = await waitForLogEntries(fake.logPath, 8);
    expect(entries.map((entry) => entry.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "thread/start",
      "thread/list",
      "thread/turns/list",
      "turn/start",
      "thread/compact/start",
    ]);
    expect(entries[0].params).toEqual({
      clientInfo: { name: "LinkShell", version: "0.1" },
      capabilities: { experimentalApi: true },
    });
    expect(entries[6].params).toMatchObject({
      threadId: "thread-1",
      effort: "high",
      service_tier: "fast",
      collaborationMode: {
        mode: "plan",
        settings: {
          reasoning_effort: "high",
          service_tier: "fast",
        },
      },
      permissions: {
        type: "managed",
        fileSystem: {
          type: "restricted",
          entries: [{ access: "write" }],
        },
      },
    });
    expect(entries[5].params).toMatchObject({ threadId: "thread-1", limit: 200 });
    expect(entries[7].params).toEqual({ threadId: "thread-1" });
    expect(entries[6].params).not.toHaveProperty("permissionProfile");
  });

  it("omits default collaboration mode and null settings for ordinary turns", async () => {
    const fake = makeFakeAppServer();
    const client = new AcpClient({
      command: fake.command,
      protocol: "codex-app-server",
      framing: "newline",
      cwd: fake.cwd,
      onNotification: () => {},
      onRequest: () => ({}),
      onExit: () => {},
    });
    clients.push(client);

    await client.initialize();
    await client.newSession({ cwd: fake.cwd });
    await client.prompt({
      sessionId: "thread-1",
      content: [{ type: "text", text: "hello" }],
      clientMessageId: "client-msg-ordinary",
      collaborationMode: "default",
      cwd: fake.cwd,
    });

    const entries = await waitForLogEntries(fake.logPath, 4);
    expect(entries.map((entry) => entry.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(entries[3].params).not.toHaveProperty("collaborationMode");
    expect(entries[3].params).not.toHaveProperty("model");
    expect(entries[3].params).not.toHaveProperty("effort");
  });

  it("sends an empty settings object for plan mode without optional strings", async () => {
    const fake = makeFakeAppServer();
    const client = new AcpClient({
      command: fake.command,
      protocol: "codex-app-server",
      framing: "newline",
      cwd: fake.cwd,
      onNotification: () => {},
      onRequest: () => ({}),
      onExit: () => {},
    });
    clients.push(client);

    await client.initialize();
    await client.newSession({ cwd: fake.cwd });
    await client.prompt({
      sessionId: "thread-1",
      content: [{ type: "text", text: "plan this" }],
      clientMessageId: "client-msg-plan",
      collaborationMode: "plan",
      cwd: fake.cwd,
    });

    const entries = await waitForLogEntries(fake.logPath, 4);
    expect(entries[3].method).toBe("turn/start");
    expect(entries[3].params.collaborationMode).toEqual({
      mode: "plan",
      settings: {},
    });
  });
});

describe("resolveAgentCommand", () => {
  it("uses the Claude Agent SDK by default when the SDK package is installed", () => {
    expect(resolveAgentCommand({ provider: "claude" })).toMatchObject({
      protocol: "claude-agent-sdk",
      framing: "newline",
    });
  });

  it("can force Claude onto stream-json with an environment override", () => {
    process.env.LINKSHELL_CLAUDE_PROVIDER = "stream-json";
    expect(resolveAgentCommand({ provider: "claude" })).toMatchObject({
      protocol: "claude-stream-json",
      framing: "newline",
    });
  });

  it("keeps explicit claude commands on the stream-json fallback path", () => {
    expect(resolveAgentCommand({ provider: "claude", command: "claude" })).toMatchObject({
      protocol: "claude-stream-json",
      framing: "newline",
    });
  });

  it("keeps codex app-server commands on app-server framing", () => {
    expect(resolveAgentCommand({ provider: "codex", command: "codex app-server --listen stdio://" })).toMatchObject({
      protocol: "codex-app-server",
      framing: "newline",
    });
  });
});
