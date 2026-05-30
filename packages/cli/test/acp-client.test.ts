import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpClient } from "../src/runtime/acp/acp-client.js";
import { claudePermissionModeFor, parseClaudeJsonlSession } from "../src/runtime/acp/claude-sdk-client.js";
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
    send({ jsonrpc: "2.0", id: message.id, result: { threads: [{ id: "thread-1", cwd: ${JSON.stringify(cwd)}, title: "Test thread" }] } });
  } else if (message.method === "thread/turns/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { turns: [] } });
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
    await client.prompt({
      sessionId: "thread-1",
      content: [{ type: "text", text: "hello" }],
      clientMessageId: "client-msg-1",
      reasoningEffort: "high",
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

    const entries = await waitForLogEntries(fake.logPath, 6);
    expect(entries.map((entry) => entry.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "thread/start",
      "turn/start",
      "thread/compact/start",
    ]);
    expect(entries[0].params).toEqual({
      clientInfo: { name: "LinkShell", version: "0.1" },
      capabilities: { experimentalApi: true },
    });
    expect(entries[4].params).toMatchObject({
      threadId: "thread-1",
      effort: "high",
      model: "default",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "default",
          reasoning_effort: "high",
        },
      },
      // workspace_write → codex's tagged sandbox + on-request approval
      // (the old object-shaped `permissions` was rejected by codex serde).
      sandboxPolicy: {
        type: "workspaceWrite",
        networkAccess: false,
      },
      approvalPolicy: "on-request",
    });
    expect(entries[5].params).toEqual({ threadId: "thread-1" });
    expect(entries[4].params).not.toHaveProperty("permissions");
    expect(entries[4].params).not.toHaveProperty("permissionProfile");
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
    expect(entries[3].params.model).toBe("default");
    expect(entries[3].params).not.toHaveProperty("effort");
  });

  it("sends a model fallback for plan mode without an explicit model", async () => {
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
    expect(entries[3].params.model).toBe("default");
    expect(entries[3].params.collaborationMode).toEqual({
      mode: "plan",
      settings: { model: "default" },
    });
  });

  it("uses thread/turns/list for paged Codex history", async () => {
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
    await client.listTurns({ sessionId: "thread-1", limit: 25, cursor: "cursor-1" });

    const entries = await waitForLogEntries(fake.logPath, 3);
    expect(entries.map((entry) => entry.method)).toEqual([
      "initialize",
      "initialized",
      "thread/turns/list",
    ]);
    expect(entries[2].params).toEqual({
      threadId: "thread-1",
      limit: 25,
      cursor: "cursor-1",
      sortDirection: "desc",
      itemsView: "full",
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

describe("Claude SDK option mapping", () => {
  it("maps LinkShell permission and collaboration modes onto Claude SDK modes", () => {
    expect(claudePermissionModeFor({})).toBe("default");
    expect(claudePermissionModeFor({ permissionMode: "workspace_write" })).toBe("acceptEdits");
    expect(claudePermissionModeFor({ permissionMode: "full_access" })).toBe("bypassPermissions");
    expect(claudePermissionModeFor({ permissionMode: "read_only" })).toBe("plan");
    expect(claudePermissionModeFor({ permissionMode: "full_access", collaborationMode: "plan" })).toBe("plan");
  });
});

describe("Claude JSONL history parsing", () => {
  it("converts Claude Code transcript entries into provider thread items", () => {
    const parsed = parseClaudeJsonlSession({
      cwd: "/repo",
      sessionId: "claude-session-1",
      text: [
        JSON.stringify({
          type: "user",
          uuid: "user-uuid",
          timestamp: "2026-05-25T10:00:00.000Z",
          message: {
            role: "user",
            content: "run the tests",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-uuid",
          timestamp: "2026-05-25T10:00:01.000Z",
          message: {
            id: "msg-1",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [
              { type: "text", text: "I will run them." },
              { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pnpm test" } },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "tool-result-uuid",
          timestamp: "2026-05-25T10:00:02.000Z",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "ok", is_error: false },
            ],
          },
        }),
      ].join("\n"),
    }) as any;

    expect(parsed.thread).toMatchObject({
      id: "claude-session-1",
      cwd: "/repo",
      model: "claude-sonnet-4-5",
      title: "run the tests",
      preview: "I will run them.",
    });
    expect(parsed.thread.turns.flatMap((turn: any) => turn.items)).toEqual([
      {
        id: "user-uuid",
        type: "userMessage",
        content: [{ type: "text", text: "run the tests" }],
      },
      {
        id: "msg-1",
        type: "agentMessage",
        content: [{ type: "text", text: "I will run them." }],
        status: "completed",
      },
      {
        id: "tool-1",
        type: "commandExecution",
        toolName: "Bash",
        tool: "Bash",
        input: { command: "pnpm test" },
        toolInput: { command: "pnpm test" },
        command: "pnpm test",
        cwd: "/repo",
        path: undefined,
        status: "running",
      },
      {
        id: "tool-1",
        type: "commandExecution",
        toolName: "Bash",
        tool: "Bash",
        input: { command: "pnpm test" },
        toolInput: { command: "pnpm test" },
        command: "pnpm test",
        cwd: "/repo",
        path: undefined,
        status: "completed",
        output: "ok",
        aggregatedOutput: "ok",
        isError: false,
      },
    ]);
  });

  it("uses the transcript cwd when Claude history is listed from another project", () => {
    const parsed = parseClaudeJsonlSession({
      cwd: "/fallback",
      sessionId: "claude-session-cwd",
      text: JSON.stringify({
        type: "user",
        uuid: "user-uuid",
        timestamp: "2026-05-25T10:00:00.000Z",
        cwd: "/actual/project",
        message: {
          role: "user",
          content: "hello",
        },
      }),
    }) as any;

    expect(parsed.thread.cwd).toBe("/actual/project");
  });
});
