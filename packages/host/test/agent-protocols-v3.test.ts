import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ABANDON,
  RpcError,
  acpAgentSettingsSchema,
  type AgentStatus,
  type BackgroundTask,
  type SessionState,
  type SessionUpdate,
} from "@linkshell/wire";
import { AcpClientServices } from "../src/drivers/acp/client-services.js";
import { AcpConnection } from "../src/drivers/acp/connection.js";
import { AcpDriver } from "../src/drivers/acp/driver.js";
import { AcpEditor } from "../src/drivers/acp/editor.js";
import { toConfigOptions } from "../src/drivers/acp/mapper.js";
import { AcpMcpBridge } from "../src/drivers/acp/mcp.js";
import { mapAcpQuestions } from "../src/drivers/acp/questions.js";
import { AcpUpdates } from "../src/drivers/acp/updates.js";
import { ClaudeDriver } from "../src/drivers/claude/driver.js";
import { ClaudeTasks } from "../src/drivers/claude/tasks.js";
import { TranscriptTail, settingsOf, transcriptLine } from "../src/drivers/claude/transcript.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";
import {
  itemToHistory,
  mapApprovalRequest,
  mapGlobalNotice,
  mapNotification,
  mapQuestionRequest,
  type CodexThreadState,
} from "../src/drivers/codex/mapper.js";
import { nestUnder } from "../src/drivers/nesting.js";
import { ACP_AGENTS } from "../src/drivers/registry.js";
import type { DriverHost } from "../src/drivers/types.js";
import { formContent, formQuestions } from "../src/questions.js";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function makeHost() {
  const updates: { agent: string; nativeId: string; update: SessionUpdate }[] = [];
  const stateMap = new Map<string, Map<string, string>>();
  const storeFor = (agent: string, nativeId: string) => {
    const key = `${agent}:${nativeId}`;
    let map = stateMap.get(key);
    if (!map) stateMap.set(key, (map = new Map()));
    return {
      get: (k: string) => map.get(k),
      set: (k: string, v: string) => { map.set(k, v); },
      delete: (k: string) => { map.delete(k); },
    };
  };
  let authChanges = 0;
  const host = {
    update: (agent: string, nativeId: string, update: SessionUpdate) => { updates.push({ agent, nativeId, update }); },
    sessionState: (_agent: string, _nativeId: string, _state: SessionState) => {},
    driverStatus: (_agent: string, _status: AgentStatus) => {},
    authChanged: () => { authChanges += 1; },
    acpChanged: () => {},
    subagentChanged: () => {},
    backgroundTask: (_agent: string, _nativeId: string, _task: BackgroundTask) => {},
    queue: () => {},
    recordUsage: () => {},
    state: storeFor,
    log: () => {},
  } as unknown as DriverHost;
  return { host, updates, stateMap, authChanges: () => authChanges };
}

describe("A. ACP v1/v2 security, spec compliance, and lifecycle fixes", () => {
  it.skipIf(process.platform === "win32")("P0.1 + P0.2: blocks dangling symlink escapes, symlink loops, and returns spec JSON-RPC error codes", async () => {
    const root = await mkdtemp(join(tmpdir(), "linkshell-acp-sec-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([mkdir(cwd), mkdir(outside)]);

    const service = new AcpClientServices({
      env: process.env,
      scope: (id) => (id === "s1" ? { cwd, additionalDirectories: [] } : undefined),
      output: () => {},
    });
    cleanups.push(() => service.close());
    const call = (method: string, params: object) => service.request(method, { sessionId: "s1", ...params });

    // Dangling file symlink pointing outside workspace -> MUST reject with -32602 and MUST NOT create file outside!
    const danglingFile = join(cwd, "dangling.txt");
    await symlink(join(outside, "pwned.txt"), danglingFile);
    await expect(call("fs/write_text_file", { path: danglingFile, content: "evil" })).rejects.toMatchObject({ code: -32602 });
    await expect(readFile(join(outside, "pwned.txt"), "utf8")).rejects.toThrow();

    // Dangling directory symlink pointing outside workspace -> MUST reject with -32602!
    const danglingDir = join(cwd, "dangling-dir");
    await symlink(join(outside, "nonexistent-dir"), danglingDir);
    await expect(call("fs/write_text_file", { path: join(danglingDir, "sub", "pwned.txt"), content: "evil" })).rejects.toMatchObject({ code: -32602 });

    // Multi-hop symlink chain escaping workspace -> MUST reject with -32602!
    await symlink(join(cwd, "hop2.txt"), join(cwd, "hop1.txt"));
    await symlink(join(outside, "chain-pwned.txt"), join(cwd, "hop2.txt"));
    await expect(call("fs/write_text_file", { path: join(cwd, "hop1.txt"), content: "evil" })).rejects.toMatchObject({ code: -32602 });

    // Symlink loop -> MUST reject with -32602 (never hang)!
    await symlink(join(cwd, "loop-b"), join(cwd, "loop-a"));
    await symlink(join(cwd, "loop-a"), join(cwd, "loop-b"));
    await expect(call("fs/write_text_file", { path: join(cwd, "loop-a"), content: "loop" })).rejects.toMatchObject({ code: -32602 });

    // Valid internal dangling symlink stays inside workspace and writes to its resolved target!
    const internalTarget = join(cwd, "nested", "real.txt");
    const internalLink = join(cwd, "good-link.txt");
    await symlink(internalTarget, internalLink);
    await call("fs/write_text_file", { path: internalLink, content: "safe" });
    expect(await readFile(internalTarget, "utf8")).toBe("safe");

    // P0.2: Error codes (NEVER -32000 AUTH_REQUIRED!)
    // Out-of-scope -> -32602
    await expect(call("fs/read_text_file", { path: join(outside, "nope.txt") })).rejects.toMatchObject({ code: -32602 });
    // Missing file inside scope -> -32002 RESOURCE_NOT_FOUND
    await expect(call("fs/read_text_file", { path: join(cwd, "missing.txt") })).rejects.toMatchObject({ code: -32002 });
    // ENOTDIR inside scope -> -32002 RESOURCE_NOT_FOUND
    const regularFile = join(cwd, "plain.txt");
    await writeFile(regularFile, "hello");
    await expect(call("fs/read_text_file", { path: join(regularFile, "child.txt") })).rejects.toMatchObject({ code: -32002 });
    // Directory instead of file -> -32602 INVALID_PARAMS
    await expect(call("fs/read_text_file", { path: cwd })).rejects.toMatchObject({ code: -32602 });
    // Invalid UTF-8 bytes -> -32602 INVALID_PARAMS
    const badUtf8 = join(cwd, "binary.bin");
    await writeFile(badUtf8, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    await expect(call("fs/read_text_file", { path: badUtf8 })).rejects.toMatchObject({ code: -32602 });
  });

  it("P0.3: toConfigOptions reads ACP v2 configId, groupId/name, and preserves boolean category", () => {
    const options = toConfigOptions({
      configOptions: [
        {
          configId: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "claude-sonnet",
          options: [
            {
              groupId: "anthropic",
              name: "Anthropic",
              options: [{ value: "claude-sonnet", name: "Sonnet" }],
            },
            {
              groupId: "fallback-group",
              options: [{ value: "claude-haiku", name: "Haiku" }],
            },
          ],
        },
        {
          configId: "fast_mode",
          name: "Fast Mode",
          category: "thought_level",
          type: "boolean",
          currentValue: true,
        },
      ],
    });
    expect(options).toEqual([
      {
        id: "model",
        name: "Model",
        description: undefined,
        category: "model",
        current: "claude-sonnet",
        values: [
          { value: "claude-sonnet", name: "Sonnet", description: undefined, group: "Anthropic" },
          { value: "claude-haiku", name: "Haiku", description: undefined, group: "fallback-group" },
        ],
        source: "configOptions",
      },
      {
        id: "fast_mode",
        name: "Fast Mode",
        description: undefined,
        category: "effort",
        type: "boolean",
        current: "on",
        values: [{ value: "on", name: "开" }, { value: "off", name: "关" }],
        source: "configOptions",
      },
    ]);
  });

  it("P0.4 + P0.5 + P0.6 + P0.10 + P0.12 + P1: AcpDriver v2 config payload, error state_update, promptGen race, logout capability, sendQueuedNow, stateFor corrupt JSON, and validateDirectories", async () => {
    const { host, updates, stateMap } = makeHost();
    const driver = new AcpDriver(
      { id: "test-v2", label: "TestV2", command: process.execPath, args: [], tier: "multi_client" },
      { hostVersion: "test" },
    );
    const rpcCalls: { method: string; params: unknown }[] = [];
    const internal = driver as unknown as {
      host: DriverHost;
      connection: {
        protocolVersion: 1 | 2;
        initializeResult: Record<string, unknown>;
        request: (method: string, params: unknown) => Promise<unknown>;
        notify: (method: string, params: unknown) => void;
        isRunning: boolean;
      };
      stateFor: (nativeId: string, cwd: string) => Record<string, unknown>;
      sessions: Map<string, Record<string, unknown>>;
      children: Map<string, Map<string, { title?: string }>>;
      acpBehavior: Record<string, unknown>;
      onUpdate: (sessionId: string, update: unknown) => void;
      validateDirectories: (settings: { additionalDirectories: string[] }, cwd: string) => Promise<string[]>;
      cachedAuthMethod: string | undefined;
      authenticate: (methodId: string) => Promise<void>;
      acpInfo: () => Record<string, unknown>;
      capabilities: Record<string, unknown>;
      capabilityState: Record<string, unknown>;
      noteCapabilities: (options: unknown[]) => void;
      publish: (nativeId: string, update: SessionUpdate, itemId?: string) => void;
      sendPrompt: (nativeId: string, state: Record<string, unknown>, prompt: unknown[], clientMessageId: string, gen: number) => Promise<void>;
    };
    internal.host = host;

    // P1: corrupt JSON in stateFor does not crash
    stateMap.set("test-v2:s-corrupt", new Map([
      ["acp-settings", "{invalid-json"],
      ["acp-message-aliases", "not-json"],
    ]));
    expect(() => internal.stateFor("s-corrupt", "/tmp")).not.toThrow();

    // P1: validateDirectories rejects missing paths with invalid_params instead of crashing with ENOENT
    await expect(internal.validateDirectories({ additionalDirectories: ["/definitely-missing-dir-linkshell-v3"] }, "/tmp")).rejects.toMatchObject({
      appCode: "invalid_params",
    });

    // Setup mock v2 connection
    const notifications: { method: string; params: unknown }[] = [];
    let promptResolver: ((value: unknown) => void) | undefined;
    const v2Caps = {
      mcpCapabilities: { stdio: true, acp: true, http: true, sse: false },
      sessionCapabilities: {},
    };
    internal.connection = {
      protocolVersion: 2,
      alive: true,
      capabilities: v2Caps,
      initializeResult: {
        protocolVersion: 2,
        authMethods: [{ id: "oauth", name: "OAuth" }],
        agentCapabilities: v2Caps,
      },
      request: async (method: string, params: unknown) => {
        rpcCalls.push({ method, params });
        if (method === "session/set_config_option") return { configOptions: [] };
        if (method === "session/prompt") return new Promise((resolve) => { promptResolver = resolve; });
        return {};
      },
      notify: (method: string, params: unknown) => { notifications.push({ method, params }); },
    } as unknown as typeof internal.connection;
    (internal as unknown as { ensureStarted: () => Promise<void> }).ensureStarted = async () => {};
    Object.defineProperty(driver, "acpBehavior", {
      get: () => ({ turnCompletion: "state-update", busyInput: "concurrent-prompt" }),
      configurable: true,
    });

    // P0.10 + P1: v2 acpInfo advertises logout when authMethods > 0, plus mcpStdio & mcpAcp
    expect((await driver.acpInfo()).features).toMatchObject({
      logout: true,
      mcpStdio: true,
      mcpAcp: true,
    });
    // And when authMethods is empty, v2 logout is false
    internal.connection.initializeResult = { ...internal.connection.initializeResult, authMethods: [] };
    expect((await driver.acpInfo()).features).toMatchObject({ logout: false });
    internal.connection.initializeResult = { ...internal.connection.initializeResult, authMethods: [{ id: "oauth", name: "OAuth" }] };

    // P1: noteCapabilities updates models/modes dynamically
    internal.noteCapabilities([
      { id: "model", name: "Model", category: "model", current: "m1", values: [{ value: "m1", name: "M1" }] },
      { id: "mode", name: "Mode", category: "mode", current: "code", values: [{ value: "code", name: "Code" }] },
    ]);
    expect(internal.capabilityState).toMatchObject({ models: true, modes: true });

    // P0.4: v2 session/set_config_option sends type: "id" (NOT "select")
    const st = internal.stateFor("s1", "/tmp");
    st.loaded = true;
    st.config = [{ id: "model", name: "Model", category: "model", current: "m1", values: [{ value: "m1", name: "M1" }, { value: "m2", name: "M2" }], source: "configOptions" }];
    await driver.setConfig("s1", "model", "m2");
    expect(rpcCalls.find((c) => c.method === "session/set_config_option")?.params).toEqual({
      sessionId: "s1",
      configId: "model",
      type: "id",
      value: "m2",
    });

    // P0.5: v2 state_update with stopReason: "error" (-32000 -> not_logged_in, other -> turn_failed)
    st.turnActive = true;
    st.runningGen = 1;
    st.promptGen = 1;
    st.inflight = 0;
    updates.length = 0;
    internal.onUpdate("s1", {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "error",
      error: { code: -32000, message: "please login" },
    });
    expect(updates.some((u) => u.update.sessionUpdate === "ls_error" && u.update.code === "not_logged_in")).toBe(true);
    expect(updates.some((u) => u.update.sessionUpdate === "ls_turn" && u.update.state === "ended")).toBe(true);

    st.turnActive = true;
    st.runningGen = 2;
    st.promptGen = 2;
    updates.length = 0;
    internal.onUpdate("s1", {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "error",
      error: { code: -32603, message: "upstream boom" },
    });
    expect(updates.some((u) => u.update.sessionUpdate === "ls_error" && u.update.code === "turn_failed" && u.update.message.includes("upstream boom"))).toBe(true);

    // P0.6: concurrent/steered prompt idleReason race: delayed idle for promptGen 1 must NOT end promptGen 2
    st.turnActive = true;
    st.promptGen = 1;
    st.runningGen = 1;
    st.idleReason = undefined;
    st.idleGen = undefined;
    st.inflight = 0;
    updates.length = 0;
    const p2 = driver.prompt("s1", [{ type: "text", text: "steer" }], "c2");
    // Prompt #2 incremented promptGen to 2 and is awaiting session/prompt ACK.
    // Delayed idle from Prompt #1 arrives BEFORE Prompt #2 ACK!
    internal.onUpdate("s1", {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
    });
    // Prompt #2 ACK now arrives!
    promptResolver?.({ messageId: "m2" });
    await p2;
    await new Promise((r) => setTimeout(r, 10));
    expect(st.turnActive).toBe(true);
    expect(updates.some((u) => u.update.sessionUpdate === "ls_turn" && u.update.state === "ended")).toBe(false);
    // Now real idle arrives AFTER Prompt #2 ACK (runningGen === 2) -> ends turn cleanly!
    internal.onUpdate("s1", {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
    });
    expect(st.turnActive).toBe(false);
    expect(updates.some((u) => u.update.sessionUpdate === "ls_turn" && u.update.state === "ended")).toBe(true);

    // P0.12: sendQueuedNow(nativeId, clientMessageId) reorders target item to index 0
    st.turnActive = true;
    st.queue = [
      { content: [{ type: "text", text: "first" }], clientMessageId: "q1" },
      { content: [{ type: "text", text: "second" }], clientMessageId: "q2" },
    ];
    updates.length = 0;
    await driver.sendQueuedNow("s1", "q2");
    expect((st.queue as { clientMessageId: string }[]).map((q) => q.clientMessageId)).toEqual(["q2", "q1"]);

    // D.1: publish() stamps parentToolCallId on subagent ls_error and ls_notice
    internal.children.set("child-s", new Map([["s1", { title: "Reviewer" }]]));
    updates.length = 0;
    internal.publish("child-s", { sessionUpdate: "ls_error", code: "turn_failed", message: "child failed" });
    internal.publish("child-s", { sessionUpdate: "ls_notice", level: "warning", title: "child note" });
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nativeId: "s1",
        update: expect.objectContaining({ sessionUpdate: "ls_error", parentToolCallId: "acp:subagent:child-s" }),
      }),
      expect.objectContaining({
        nativeId: "s1",
        update: expect.objectContaining({ sessionUpdate: "ls_notice", parentToolCallId: "acp:subagent:child-s" }),
      }),
    ]));

    // P1: v2 subagent_update accepted without experimental flag and forwards error message
    updates.length = 0;
    internal.onUpdate("s1", {
      sessionUpdate: "subagent_update",
      sessionId: "child-v2",
      title: "SubV2",
      state: { state: "idle", stopReason: "error", error: { message: "child crashed" } },
    });
    expect(updates).toContainEqual(expect.objectContaining({
      nativeId: "s1",
      update: expect.objectContaining({
        sessionUpdate: "tool_call",
        detail: expect.objectContaining({ type: "subagent", nativeSessionId: "child-v2", state: "failed" }),
        rawOutput: { error: "child crashed" },
      }),
    }));
  });

  it("P0.7 + P1: AcpUpdates handles tool_call_content_chunk (with v2 terminal), strips <previous-conversation> on v2 user_message, and decodes full terminal_update snapshots", () => {
    const updates = new AcpUpdates();

    // P0.7: tool_call_content_chunk appends content and registers v2 terminals
    const chunkUpdates = updates.map({
      sessionUpdate: "tool_call_content_chunk",
      toolCallId: "t1",
      content: { type: "content", content: { type: "text", text: "streamed piece" } },
    }, 2);
    expect(chunkUpdates).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        appendContent: true,
        content: [{ type: "content", content: { type: "text", text: "streamed piece" } }],
      },
    ]);

    const termAttach = updates.map({
      sessionUpdate: "tool_call_content_chunk",
      toolCallId: "t2",
      content: { type: "terminal", terminalId: "term-1" },
    }, 2);
    expect(termAttach).toHaveLength(2);
    expect(termAttach[0]).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "t2", appendContent: true });

    // P1: full snapshot decode of terminal_update containing multi-byte UTF-8 without trailing incomplete bytes
    const fullB64 = Buffer.from("中文完整输出\n", "utf8").toString("base64");
    const snap = updates.map({
      sessionUpdate: "terminal_update",
      terminalId: "term-1",
      output: { data: fullB64 },
    }, 2);
    expect(snap).toEqual([
      expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "t2", replaceOutput: "中文完整输出\n" }),
    ]);

    // P1: v2 user_message strips injected <previous-conversation> context wrapper
    const userMsg = updates.map({
      sessionUpdate: "user_message",
      messageId: "u-v2",
      content: [{ type: "text", text: "<previous-conversation>\nold history\n</previous-conversation>\n\nReal question" }],
    }, 2);
    expect(userMsg).toEqual([
      expect.objectContaining({
        sessionUpdate: "ls_message",
        messageId: "u-v2",
        role: "user",
        content: [{ type: "text", text: "Real question" }],
      }),
    ]);
  });

  it("P0.8: AcpEditor normalizes v2 suggestionId and sends suggestionId on v2 nes/accept and nes/reject", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "linkshell-acp-ed-v2-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const file = join(cwd, "a.ts");
    await writeFile(file, "hello\n");
    const notices: { method: string; params: unknown }[] = [];
    const editor = new AcpEditor({
      settings: () => acpAgentSettingsSchema.parse({}),
      capabilities: () => ({ nes: {}, positionEncoding: "utf-16" }),
      protocolVersion: () => 2,
      request: async <T>(method: string): Promise<T> => {
        if (method === "nes/start") return { sessionId: "ed-v2" } as T;
        if (method === "nes/suggest") {
          return {
            suggestions: [
              { kind: "edit", suggestionId: "sug-1", uri: pathToFileURL(file).href, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "world" }] },
              { kind: "edit", suggestionId: "sug-2", uri: pathToFileURL(file).href, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "other" }] },
            ],
          } as T;
        }
        return {} as T;
      },
      notify: (method, params) => { notices.push({ method, params }); },
    });
    cleanups.push(() => editor.close());

    const opened = await editor.run({ agent: "test", operation: "open", cwd, path: file });
    const suggested = await editor.run({ agent: "test", editorId: opened.editorId, operation: "suggest" });
    expect(suggested.suggestions.map((s) => s.id)).toEqual(["sug-1", "sug-2"]);

    const preview = await editor.run({ agent: "test", editorId: opened.editorId, operation: "preview", suggestionId: "sug-1" });
    await editor.run({ agent: "test", editorId: opened.editorId, operation: "apply", previewId: preview.preview!.id });
    expect(notices.find((n) => n.method === "nes/accept")?.params).toEqual({ sessionId: "ed-v2", suggestionId: "sug-1" });

    await editor.run({ agent: "test", editorId: opened.editorId, operation: "suggest" });
    await editor.run({ agent: "test", editorId: opened.editorId, operation: "reject", suggestionId: "sug-2" });
    expect(notices.find((n) => n.method === "nes/reject")?.params).toEqual({ sessionId: "ed-v2", suggestionId: "sug-2", reason: "rejected" });
  });

  it("P0.9: ACP elicitation/create accepts null toolCallId/serverName and preserves toolCallId on URL elicitation", () => {
    const form = mapAcpQuestions("any", "elicitation/create", {
      mode: "form",
      sessionId: "s1",
      toolCallId: null,
      serverName: null,
      message: "Fill details",
      requestedSchema: { type: "object", properties: { token: { type: "string" } } },
    }, "req-1");
    expect(form.update.toolCallId).toBeUndefined();
    expect(form.update.questions).toHaveLength(1);

    const urlReq = mapAcpQuestions("any", "elicitation/create", {
      mode: "url",
      sessionId: "s1",
      toolCallId: "tc-99",
      serverName: "github",
      elicitationId: "el-1",
      url: "https://github.com/login/device",
      message: "Authorize GitHub",
    }, "req-2");
    expect(urlReq.update).toMatchObject({
      sessionUpdate: "ls_permission",
      toolCallId: "tc-99",
      detail: "来自 MCP 服务 github",
      url: { url: "https://github.com/login/device", elicitationId: "el-1" },
    });
  });

  it("P0.11: AcpConnection configures $/cancel_request with requestId on outbound timeout", async () => {
    const script = [
      "const rl = require('node:readline').createInterface({ input: process.stdin });",
      "const out = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\\n');",
      "rl.on('line', (line) => {",
      "  const m = JSON.parse(line);",
      "  if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 2, agentCapabilities: {} } });",
      "  else if (m.method === '$/cancel_request') out({ method: 'seen/cancel', params: m.params });",
      "});",
    ].join(" ");
    const seen: { method: string; params: unknown }[] = [];
    const conn = new AcpConnection({
      command: process.execPath,
      args: ["-e", script],
      protocolVersion: 2,
      clientVersion: "test",
      onUpdate: () => {},
      onRequest: () => ({}),
      onNotification: (method, params) => { seen.push({ method, params }); },
      onExit: () => {},
    });
    cleanups.push(() => conn.stop());
    await conn.start();
    await expect(conn.request("slow/op", {}, 40)).rejects.toMatchObject({ appCode: "timeout" });
    await new Promise((r) => setTimeout(r, 40));
    expect(seen).toContainEqual({ method: "seen/cancel", params: { requestId: 2 } });
  });

  it("P0.13: questions.ts companions() requires choice base & non-required companion, omits empty choice string, and preserves Claude option preview", () => {
    const form = formQuestions({
      type: "object",
      required: ["note", "flavor_other"],
      properties: {
        // Non-choice base: note_custom MUST remain its own field!
        note: { type: "string", title: "Note" },
        note_custom: { type: "string", title: "Note Custom" },
        // Required companion: flavor_other MUST remain its own field!
        flavor: { type: "string", title: "Flavor", enum: ["a", "b"] },
        flavor_other: { type: "string", title: "Flavor Other" },
        // Valid optional companion for choice base + Claude preview metadata!
        layout: {
          type: "string",
          title: "Layout",
          oneOf: [
            { const: "grid", title: "Grid", _meta: { "_claude/askUserQuestionOption": { preview: "<div>Grid</div>" } } },
            { const: "list", title: "List" },
          ],
        },
        layout_custom: { type: "string", title: "Custom Layout" },
      },
    })!;

    expect(form.questions.map((q) => q.id)).toEqual(["note", "note_custom", "flavor", "flavor_other", "layout"]);
    const layoutQ = form.questions.find((q) => q.id === "layout")!;
    expect(layoutQ.other).toBe(true);
    expect(layoutQ.options?.[0]).toMatchObject({ value: "grid", label: "Grid", preview: "<div>Grid</div>" });

    // Choosing `other` on optional choice field MUST NOT emit `layout: ""`!
    const content = formContent(form, [
      { id: "note", values: ["hi"] },
      { id: "flavor_other", values: ["vanilla"] },
      { id: "layout", values: [], other: "masonry" },
    ]);
    expect(content).toEqual({ note: "hi", flavor_other: "vanilla", layout_custom: "masonry" });
    expect("layout" in content).toBe(false);
  });

  it("P1: AcpMcpBridge routes uncorrelated notifications once instead of duplicating across all pending requests, and Cursor preset includes agent acp alternative", async () => {
    // Cursor preset check
    const cursor = ACP_AGENTS.find((p) => p.id === "cursor");
    expect(cursor?.alternatives).toContainEqual({ command: "agent", args: ["acp"] });

    // Uncorrelated MCP notification check
    const script = [
      "const rl = require('node:readline').createInterface({ input: process.stdin });",
      "const send = (v) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\\n');",
      "const reqs = [];",
      "rl.on('line', (line) => {",
      "  const m = JSON.parse(line);",
      "  reqs.push(m);",
      "  if (reqs.length === 2) {",
      "    send({ method: 'notifications/tools/list_changed', params: {} });",
      "    for (const r of reqs) send({ id: r.id, result: { ok: true } });",
      "  }",
      "});",
    ].join(" ");
    const notices: unknown[] = [];
    const bridge = new AcpMcpBridge({ env: process.env, notify: (v) => { notices.push(v); }, request: async () => ({}) });
    cleanups.push(() => bridge.close());
    const serverId = bridge.open({ type: "acp", name: "uncorr", command: process.execPath, args: ["-e", script], env: {} }, process.cwd());
    bridge.bind([serverId], "s1");
    await Promise.all([
      bridge.request({ serverId, requestId: "a", method: "tools/list" }, new AbortController().signal),
      bridge.request({ serverId, requestId: "b", method: "tools/list" }, new AbortController().signal),
    ]);
    expect(notices.filter((n) => (n as { method: string }).method === "notifications/tools/list_changed")).toHaveLength(1);
  });
});

describe("B. Codex app-server protocol fixes", () => {
  it("P0.14: dynamic availableDecisions (execpolicy & network policy), networkApprovalContext + cwd, and grantRoot + reason", () => {
    const cmdReq = mapApprovalRequest("item/commandExecution/requestApproval", {
      threadId: "t1",
      itemId: "call-1",
      command: "curl https://api.example.com",
      cwd: "/repo/app",
      reason: "Fetch schema",
      networkApprovalContext: { host: "api.example.com", protocol: "https" },
      availableDecisions: [
        "accept",
        "acceptForSession",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["curl", "https://api.example.com"] } },
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "api.example.com", action: "allow" } } },
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "api.example.com", action: "deny" } } },
        "decline",
        "cancel",
      ],
    }, "req-cmd")!;

    expect(cmdReq.update.detail).toContain("curl https://api.example.com");
    expect(cmdReq.update.detail).toContain("网络访问：https://api.example.com");
    expect(cmdReq.update.detail).toContain("目录：/repo/app");
    expect(cmdReq.update.detail).toContain("Fetch schema");
    expect(cmdReq.update.options).toHaveLength(7);

    const execOpt = cmdReq.update.options.find((o) => o.optionId === "acceptWithExecpolicyAmendment")!;
    expect(cmdReq.respond(execOpt.optionId)).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["curl", "https://api.example.com"] } },
    });
    const netAllow = cmdReq.update.options.find((o) => o.optionId === "applyNetworkPolicyAmendment:allow" && o.kind === "allow_always")!;
    expect(cmdReq.respond(netAllow.optionId)).toEqual({
      decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "api.example.com", action: "allow" } } },
    });
    const netDeny = cmdReq.update.options.find((o) => o.optionId === "applyNetworkPolicyAmendment:deny" && o.kind === "reject_always")!;
    expect(cmdReq.respond(netDeny.optionId)).toEqual({
      decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "api.example.com", action: "deny" } } },
    });

    // File change approval ALWAYS combines reason AND grantRoot
    const fileReq = mapApprovalRequest("item/fileChange/requestApproval", {
      threadId: "t1",
      itemId: "fc-1",
      reason: "Write generated types",
      grantRoot: "/repo/generated",
    }, "req-fc")!;
    expect(fileReq.update.detail).toContain("Write generated types");
    expect(fileReq.update.detail).toContain("授权写入目录：/repo/generated");
  });

  it("P0.15: Codex mcpServer/elicitation/request supports URL mode (rejects non-http) and safely declines unparseable own-thread forms", async () => {
    const urlReq = mapQuestionRequest("mcpServer/elicitation/request", {
      threadId: "t1",
      serverName: "linear",
      mode: "url",
      url: "https://linear.app/oauth",
      elicitationId: "el-99",
      message: "Sign in to Linear",
      _meta: { callId: "tc-1" },
    }, "q-url")!;
    expect(urlReq.update).toMatchObject({
      sessionUpdate: "ls_permission",
      toolCallId: "tc-1",
      title: "Sign in to Linear",
      detail: "来自 MCP 服务 linear",
      url: { url: "https://linear.app/oauth", elicitationId: "el-99" },
    });
    expect(urlReq.respond("accept")).toEqual({ action: "accept", content: null, _meta: null });
    expect(urlReq.respond("decline")).toEqual({ action: "decline", content: null, _meta: null });
    expect(urlReq.respond("cancel")).toEqual({ action: "cancel", content: null, _meta: null });

    // Reject javascript: URLs
    expect(mapQuestionRequest("mcpServer/elicitation/request", {
      threadId: "t1",
      mode: "url",
      url: "javascript:alert(1)",
    }, "q-bad-url")).toBeUndefined();

    // Unparseable form on LinkShell-owned thread declines safely + emits warning notice instead of ABANDON
    const { host, updates } = makeHost();
    const driver = new CodexDriver({ socketPath: "/tmp/unused.sock", hostVersion: "test", sharedSocketPath: false, desktopBusPath: false });
    const internal = driver as unknown as {
      host: DriverHost;
      attached: Set<string>;
      onServerRequest: (method: string, params: unknown, rpcId: string | number, from: "own" | "shared") => Promise<unknown> | unknown;
    };
    internal.host = host;
    internal.attached.add("t1");

    const ownResult = await internal.onServerRequest("mcpServer/elicitation/request", {
      threadId: "t1",
      serverName: "custom-mcp",
      mode: "form",
      requestedSchema: { type: "object", required: ["nested"], properties: { nested: { type: "object" } } },
    }, 10, "own");
    expect(ownResult).toEqual({ action: "decline", content: null, _meta: null });
    expect(updates).toContainEqual(expect.objectContaining({
      nativeId: "t1",
      update: expect.objectContaining({ sessionUpdate: "ls_notice", level: "warning" }),
    }));

    // Shared thread still returns ABANDON so desktop can answer it
    const sharedResult = await internal.onServerRequest("mcpServer/elicitation/request", {
      threadId: "t1",
      mode: "form",
      requestedSchema: { type: "object", required: ["nested"], properties: { nested: { type: "object" } } },
    }, 11, "shared");
    expect(sharedResult).toBe(ABANDON);
  });

  it("P0.16 + P1: Codex reasoning summaryPartAdded & item/completed fallback, fileChange/outputDelta, mcp progress, notices, hooks, webSearch, locations, plan explanation, and tokenUsage without last", () => {
    const states = new Map<string, CodexThreadState>();
    const stateOf = (id: string) => {
      let s = states.get(id);
      if (!s) states.set(id, (s = {}));
      return s;
    };
    const map = (method: string, params: unknown) => mapNotification(method, params, stateOf);

    // Reasoning streaming + summaryPartAdded separator
    expect(map("item/reasoning/summaryTextDelta", { threadId: "t1", itemId: "r1", delta: "First part" })[0]?.update).toMatchObject({
      sessionUpdate: "agent_thought_chunk", messageId: "r1", content: { type: "text", text: "First part" },
    });
    expect(map("item/reasoning/summaryPartAdded", { threadId: "t1", itemId: "r1", summaryIndex: 0 })).toEqual([]);
    expect(map("item/reasoning/summaryPartAdded", { threadId: "t1", itemId: "r1", summaryIndex: 1 })[0]?.update).toMatchObject({
      sessionUpdate: "agent_thought_chunk", messageId: "r1", content: { type: "text", text: "\n\n" },
    });
    // Completed on streamed reasoning does NOT duplicate summary
    const doneStreamed = map("item/completed", { threadId: "t1", item: { type: "reasoning", id: "r1", summary: ["First part", "Second"] } });
    expect(doneStreamed.map((e) => e.update.sessionUpdate)).toEqual(["ls_message_done"]);

    // Unstreamed reasoning falls back to emitting summary on item/completed before ls_message_done!
    const doneFallback = map("item/completed", { threadId: "t1", item: { type: "reasoning", id: "r2", summary: ["Part A", "Part B"] } });
    expect(doneFallback.map((e) => e.update)).toEqual([
      { sessionUpdate: "agent_thought_chunk", messageId: "r2", content: { type: "text", text: "Part A\n\nPart B" } },
      { sessionUpdate: "ls_message_done", messageId: "r2", role: "thought" },
    ]);

    // item/fileChange/outputDelta & item/mcpToolCall/progress (after item/started begins each card)
    map("item/started", { threadId: "t1", item: { type: "fileChange", id: "fc1", changes: [] } });
    map("item/started", { threadId: "t1", item: { type: "mcpToolCall", id: "mcp1", server: "srv", tool: "run" } });
    expect(map("item/fileChange/outputDelta", { threadId: "t1", itemId: "fc1", delta: "patching...\n" })[0]?.update).toMatchObject({
      sessionUpdate: "tool_call_update", toolCallId: "fc1", appendOutput: "patching...\n",
    });
    expect(map("item/mcpToolCall/progress", { threadId: "t1", itemId: "mcp1", message: "50% done" })[0]?.update).toMatchObject({
      sessionUpdate: "tool_call_update", toolCallId: "mcp1", appendOutput: "50% done\n",
    });

    // model/rerouted, hook/started, hook/completed, global notices
    expect(map("model/rerouted", { threadId: "t1", fromModel: "gpt-5", toModel: "gpt-5-mini", reason: "highRiskCyberActivity" })[0]?.update).toMatchObject({
      sessionUpdate: "ls_notice", level: "warning",
    });
    expect(map("hook/started", { threadId: "t1", run: { id: "h1", eventName: "PreToolUse", statusMessage: "Checking lint" } })[0]?.update).toMatchObject({
      sessionUpdate: "tool_call", toolCallId: "hook:h1", status: "in_progress",
    });
    expect(map("hook/completed", { threadId: "t1", run: { id: "h1", eventName: "PreToolUse", status: "completed", entries: [{ kind: "warning", text: "warn" }] } })[0]?.update).toMatchObject({
      sessionUpdate: "tool_call_update", toolCallId: "hook:h1", status: "completed",
    });
    expect(mapGlobalNotice("deprecationNotice", { summary: "Legacy setting deprecated", details: "Use new setting" })).toMatchObject({
      sessionUpdate: "ls_notice", level: "warning",
    });
    expect(mapGlobalNotice("configWarning", { summary: "Unknown key" })).toMatchObject({
      sessionUpdate: "ls_notice", level: "warning",
    });

    // fileChange locations, webSearch in_progress + action, plan explanation
    const fcHist = itemToHistory({ type: "fileChange", id: "fc-h", status: "completed", changes: [{ path: "/repo/a.ts", diff: "+x" }] })!;
    expect(fcHist.updates[0]).toMatchObject({ locations: [{ path: "/repo/a.ts" }] });
    const wsStart = map("item/started", { threadId: "t1", item: { type: "webSearch", id: "ws1", query: "acp spec", action: { type: "openPage", url: "https://example.com" } } })[0]?.update;
    expect(wsStart).toMatchObject({ sessionUpdate: "tool_call", status: "in_progress", title: "Open: https://example.com" });
    const planUp = map("turn/plan/updated", { threadId: "t1", explanation: "Plan details", plan: [{ step: "S1", status: "inProgress" }] })[0]?.update;
    expect(planUp).toMatchObject({ sessionUpdate: "plan", explanation: "Plan details" });

    // tokenUsage without `last` does NOT misreport cumulative totalTokens as usedTokens
    const usageOnlyTotal = map("thread/tokenUsage/updated", {
      threadId: "t1",
      tokenUsage: { modelContextWindow: 200_000, total: { totalTokens: 999_999, inputTokens: 900_000, outputTokens: 99_999 } },
    })[0]?.update;
    expect(usageOnlyTotal).toMatchObject({ sessionUpdate: "usage_update", contextWindow: 200_000 });
    expect((usageOnlyTotal as { usedTokens?: number }).usedTokens).toBeUndefined();
  });

  it("P0.17 + P1: CodexDriver narrows turn/steer fallback, handles account/updated and thread/settings/updated", async () => {
    const { host, updates, authChanges } = makeHost();
    const driver = new CodexDriver({ socketPath: "/tmp/unused.sock", hostVersion: "test", sharedSocketPath: false, desktopBusPath: false });
    const requests: { method: string; params: unknown }[] = [];
    let steerError: unknown;
    const internal = driver as unknown as {
      host: DriverHost;
      server: { request: (method: string, params: unknown) => Promise<unknown> };
      attached: Set<string>;
      threads: Map<string, CodexThreadState>;
      settings: Map<string, Record<string, unknown>>;
      overrides: Map<string, Record<string, unknown>>;
      models: Promise<unknown[]>;
      onNotification: (method: string, params: unknown, from: "own" | "shared") => void;
    };
    internal.host = host;
    const modelList = [{ id: "gpt-5.4", displayName: "GPT-5.4", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "medium" }];
    internal.models = Promise.resolve(modelList);
    internal.server = {
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "turn/steer") throw steerError;
        if (method === "turn/start") return { turn: { id: "turn-new" } };
        if (method === "model/list") return { data: modelList };
        return {};
      },
    };
    internal.attached.add("t1");
    internal.threads.set("t1", { activeTurnId: "turn-1" });

    // Timeout / auth / invalid_params on turn/steer MUST NOT silently fall back to turn/start!
    steerError = RpcError.app("timeout", "request timed out");
    await expect(driver.prompt("t1", [{ type: "text", text: "steer" }], "c1")).rejects.toMatchObject({ appCode: "timeout" });
    expect(requests.some((r) => r.method === "turn/start")).toBe(false);

    // Explicit stale-turn error DOES fall back to turn/start!
    requests.length = 0;
    steerError = new RpcError(-32600, "no active turn to steer");
    expect(await driver.prompt("t1", [{ type: "text", text: "steer" }], "c2")).toBe("started");
    expect(requests.map((r) => r.method)).toEqual(["turn/steer", "turn/start"]);

    // account/updated refreshes auth
    internal.onNotification("account/updated", { authMode: "chatgpt" }, "own");
    expect(authChanges()).toBe(1);

    // thread/settings/updated updates settings, clears stale overrides, updates plan mode, and announces config
    internal.settings.set("t1", { model: "gpt-5", effort: "medium", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" } });
    internal.overrides.set("t1", { model: "gpt-5-old", effort: "low", permissions: "ask" });
    updates.length = 0;
    internal.onNotification("thread/settings/updated", {
      threadId: "t1",
      threadSettings: {
        model: "gpt-5.4",
        effort: "high",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        collaborationMode: { mode: "plan" },
      },
    }, "own");
    await new Promise((r) => setTimeout(r, 10));
    expect(internal.settings.get("t1")).toMatchObject({
      model: "gpt-5.4",
      effort: "high",
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
    });
    expect(internal.overrides.get("t1")).toEqual({ plan: true });
    expect(updates.some((u) => u.nativeId === "t1" && u.update.sessionUpdate === "ls_config")).toBe(true);
  });
});

describe("C. Claude Code & ACP v1 steering protocol fixes", () => {
  it("P0.12 + P0.18 + P0.19 + P0.20 + P0.21 + P1: ClaudeDriver context forwarding, ensureRemote MCP params, sendQueuedNow reorder, desktopLaunch flags, win32 interrupt guard, and _session/steering", async () => {
    const { host, updates } = makeHost();
    const claudeCfg = await mkdtemp(join(tmpdir(), "lsh-claude-v3-"));
    cleanups.push(() => rm(claudeCfg, { recursive: true, force: true }));
    const driver = new ClaudeDriver({
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeCfg },
      hostVersion: "test",
      adapter: { command: process.execPath, args: [] },
    });
    const internal = driver as unknown as {
      host: DriverHost;
      waiting: Map<string, { content: unknown[]; clientMessageId: string; context?: string }[]>;
      elsewhere: (nativeId: string) => Promise<{ pid: number; working: boolean } | undefined>;
      interruptElsewhere: (nativeId: string) => Promise<void>;
      remote: Set<string>;
      sessions: Map<string, Record<string, unknown>>;
      connection: {
        protocolVersion: 1 | 2;
        initializeResult: Record<string, unknown>;
        request: (method: string, params: unknown) => Promise<unknown>;
        notify: (method: string, params: unknown) => void;
      };
      sessionParameters: (cwd: string, settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
      ensureRemote: (nativeId: string) => Promise<void>;
      desktopTargets: Map<string, { cwd: string; settings: Record<string, unknown> }>;
      resumeRemote: (nativeId: string, cwd: string, params: Record<string, unknown>) => Promise<void>;
      handoff: (nativeId: string, mode: "resume" | "interrupt") => Promise<void>;
      sendWaiting: (nativeId: string) => Promise<void>;
      routedMeta: (nativeId: string) => Record<string, unknown>;
    };
    internal.host = host;

    // P0.18: prompt() preserves 4th `context` parameter on `waiting` queue when held elsewhere
    internal.elsewhere = async () => ({ pid: 12345, working: true });
    expect(await driver.prompt("s-wait", [{ type: "text", text: "hello" }], "c-1", "extra-ctx")).toBe("queued");
    expect(await driver.prompt("s-wait", [{ type: "text", text: "second" }], "c-2", "ctx-2")).toBe("queued");
    expect(internal.waiting.get("s-wait")?.[0]?.context).toBe("extra-ctx");
    expect(internal.waiting.get("s-wait")?.[1]?.context).toBe("ctx-2");

    // P0.12: sendQueuedNow reorders `waiting` target to index 0 before interrupting
    const origInterrupt = internal.interruptElsewhere.bind(driver);
    let interruptCalled = false;
    internal.interruptElsewhere = async () => { interruptCalled = true; };
    await driver.sendQueuedNow("s-wait", "c-2");
    expect(interruptCalled).toBe(true);
    expect(internal.waiting.get("s-wait")?.map((w) => w.clientMessageId)).toEqual(["c-2", "c-1"]);
    internal.interruptElsewhere = origInterrupt;

    // P0.19: ensureRemote uses sessionParameters(cwd, settings) (MCP servers included) merged with routedMeta
    const projectDir = join(claudeCfg, "projects", "-repo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "s-remote.jsonl"), `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`);
    const resumeRpcCalls: { method: string; params: unknown }[] = [];
    internal.elsewhere = async () => undefined;
    (internal as unknown as { host: DriverHost & { desktop?: () => undefined; driver?: () => void } }).host.desktop = () => undefined;
    (internal as unknown as { host: DriverHost & { driver?: () => void } }).host.driver = () => {};
    internal.sessionParameters = async () => ({ cwd: "/repo", mcpServers: [{ name: "my-mcp", command: "node", args: [] }], _meta: { fromParams: true } });
    internal.routedMeta = () => ({ _meta: { fromRoute: true } });
    const origRpc = (internal as unknown as { rpc: unknown }).rpc;
    (internal as unknown as { rpc: (method: string, params: unknown) => Promise<unknown> }).rpc = async (method, params) => {
      resumeRpcCalls.push({ method, params });
      return { configOptions: [] };
    };
    const st = { cwd: "/repo", loaded: false, settings: acpAgentSettingsSchema.parse({}), messageAliases: new Map(), config: [], permissions: new Map(), questions: new Map(), toolCalls: new Set(), queue: [] };
    internal.sessions.set("s-remote", st);
    await internal.ensureRemote("s-remote");
    delete (internal as unknown as { rpc?: unknown }).rpc;
    void origRpc;
    expect(resumeRpcCalls).toContainEqual({
      method: "session/resume",
      params: {
        sessionId: "s-remote",
        cwd: "/repo",
        mcpServers: [{ name: "my-mcp", command: "node", args: [] }],
        _meta: { fromParams: true, fromRoute: true },
      },
    });

    // P0.20: ACP v1 _session/steering mid-turn injection & promptRequired fallback
    const rpcCalls: { method: string; params: unknown }[] = [];
    let steeringResult: unknown = { outcome: "injected" };
    internal.connection = {
      protocolVersion: 1,
      alive: true,
      initializeResult: { protocolVersion: 1, _meta: { steering: { supported: true } }, agentCapabilities: {} },
      request: async (method: string, params: unknown) => {
        rpcCalls.push({ method, params });
        if (method === "_session/steering") return steeringResult;
        return {};
      },
      notify: () => {},
    } as unknown as typeof internal.connection;
    (internal as unknown as { ensureStarted: () => Promise<void> }).ensureStarted = async () => {};
    (internal as unknown as { modes: Map<string, string> }).modes.set("s-steer", "remote");
    internal.sessions.set("s-steer", {
      cwd: "/repo",
      loaded: true,
      turnActive: true,
      promptGen: 1,
      runningGen: 1,
      inflight: 1,
      queue: [],
      permissions: new Map(),
      questions: new Map(),
      toolCalls: new Set(),
      config: [],
      modeRevision: 0,
      tracker: { feed: (u: SessionUpdate) => [{ update: u }], close: () => [] },
      updates: new AcpUpdates(),
      messageAliases: new Map(),
      deferredUserUpdates: [],
      settings: acpAgentSettingsSchema.parse({}),
    });
    updates.length = 0;
    expect(await driver.prompt("s-steer", [{ type: "text", text: "steer now" }], "c-steer", "ctx-s")).toBe("steered");
    expect(rpcCalls[0]).toMatchObject({
      method: "_session/steering",
      params: { sessionId: "s-steer", _meta: { steering: { idleBehavior: "promptRequired" } } },
    });
    // Injected steering must echo user_message_chunk since claude-agent-acp does not echo it
    expect(updates.some((u) => u.nativeId === "s-steer" && u.update.sessionUpdate === "user_message_chunk")).toBe(true);

    // If _session/steering returns promptRequired while turn is still active -> queued
    steeringResult = { outcome: "promptRequired", reason: "noRunningTurn" };
    expect(await driver.prompt("s-steer", [{ type: "text", text: "after" }], "c-after")).toBe("queued");

    // P1: desktopLaunch handles -c / --continue / --fork-session / bare --resume without fabricating a --session-id
    const contLaunch = await driver.desktopLaunch(["--continue", "--model", "opus"], undefined, { cwd: "/repo" });
    expect(contLaunch.nativeId).toBeUndefined();
    expect(contLaunch.args).not.toContain("--session-id");

    const forkLaunch = await driver.desktopLaunch(["--resume", "11111111-1111-1111-1111-111111111111", "--fork-session"], undefined, { cwd: "/repo" });
    expect(forkLaunch.nativeId).toBeUndefined();
    expect(forkLaunch.args).not.toContain("--session-id");

    const pickerLaunch = await driver.desktopLaunch(["-r"], undefined, { cwd: "/repo" });
    expect(pickerLaunch.nativeId).toBeUndefined();
    expect(pickerLaunch.args).not.toContain("--session-id");

    const fresh = await driver.desktopLaunch(["--model", "sonnet"], undefined, { cwd: "/repo" });
    expect(fresh.nativeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh.args).toContain("--session-id");

    // P1: interruptElsewhere guards win32 without calling process.kill
    internal.elsewhere = async () => ({ pid: 99999, working: true });
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const killSpy = vi.spyOn(process, "kill");
      await expect(internal.interruptElsewhere("s-win")).rejects.toMatchObject({ appCode: "busy" });
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }
  });

  it("P0.21 + P1: Claude transcript settingsOf ignores spoofed tool inputs, tracks TaskCreate/TaskUpdate/ExitPlanMode plans, handles model_context_window_exceeded, redacted_thinking, server_tool_use, 1M contextWindow, and UTF-8 safe TranscriptTail", async () => {
    // Spoofed `"model"` and `"permissionMode"` inside tool input MUST NOT hijack settingsOf()!
    const spoofedAssistant = JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        model: "claude-sonnet-4-6",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: 'echo \'{"model":"fake-model","permissionMode":"bypassPermissions"}\'' } },
        ],
      },
    });
    expect(settingsOf(spoofedAssistant)).toEqual({ model: "claude-sonnet-4-6", effort: undefined, fast: undefined });
    const spoofedUser = JSON.stringify({
      type: "user",
      message: { role: "user", content: 'look at {"permissionMode":"bypassPermissions"}' },
    });
    expect(settingsOf(spoofedUser)).toBeUndefined();

    // TaskCreate -> tool_result -> TaskUpdate -> tool_result -> plan updates, plus ExitPlanMode successful -> markdown plan
    const hidden = new Set<string>();
    transcriptLine(JSON.stringify({
      type: "assistant",
      message: {
        id: "m-task-1",
        content: [{ type: "tool_use", id: "tc-1", name: "TaskCreate", input: { subject: "Write tests" } }],
      },
    }), { hidden });
    const createRes = transcriptLine(JSON.stringify({
      type: "user",
      toolUseResult: { task: { id: "1", subject: "Write tests" } },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc-1", content: "Task #1 created successfully: Write tests" }],
      },
    }), { hidden });
    expect(createRes.updates).toContainEqual(expect.objectContaining({
      sessionUpdate: "plan",
      entries: [{ content: "Write tests", priority: "medium", status: "pending" }],
    }));

    transcriptLine(JSON.stringify({
      type: "assistant",
      message: {
        id: "m-task-2",
        content: [{ type: "tool_use", id: "tc-2", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }],
      },
    }), { hidden });
    const updateRes = transcriptLine(JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc-2", content: "Updated task #1 status" }],
      },
    }), { hidden });
    expect(updateRes.updates).toContainEqual(expect.objectContaining({
      sessionUpdate: "plan",
      entries: [{ content: "Write tests", priority: "medium", status: "completed" }],
    }));

    // ExitPlanMode records pending plan markdown and emits plan only on non-error tool_result
    transcriptLine(JSON.stringify({
      type: "assistant",
      message: {
        id: "m-exit-1",
        content: [{ type: "tool_use", id: "epm-1", name: "ExitPlanMode", input: { plan: "# My Plan\n- Step 1" } }],
      },
    }), { hidden });
    const exitOk = transcriptLine(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "epm-1", content: "Approved" }] },
    }), { hidden });
    expect(exitOk.updates).toContainEqual(expect.objectContaining({
      sessionUpdate: "plan",
      markdown: "# My Plan\n- Step 1",
    }));

    // model_context_window_exceeded -> ls_turn ended (max_tokens) + 1M contextWindow + redacted_thinking + server_tool_use + web_search_tool_result
    const special = transcriptLine(JSON.stringify({
      type: "assistant",
      message: {
        id: "m-special",
        model: "claude-opus-4-6[1m]",
        stop_reason: "model_context_window_exceeded",
        usage: { input_tokens: 1000, output_tokens: 500 },
        content: [
          { type: "redacted_thinking", data: "opaque" },
          { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "linkshell" } },
          { type: "web_search_tool_result", tool_use_id: "srv-1", content: [{ type: "web_search_result", title: "LinkShell", url: "https://example.com" }] },
        ],
      },
    }), { hidden });
    expect(special.updates).toContainEqual(expect.objectContaining({ sessionUpdate: "agent_thought_chunk", messageId: "m-special" }));
    expect(special.updates).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "srv-1", kind: "fetch" }));
    expect(special.updates).toContainEqual(expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "srv-1", status: "completed" }));
    expect(special.updates).toContainEqual(expect.objectContaining({ sessionUpdate: "usage_update", contextWindow: 1_000_000 }));
    expect(special.updates).toContainEqual(expect.objectContaining({ sessionUpdate: "ls_turn", state: "ended", stopReason: "max_tokens" }));

    // TranscriptTail.writtenMeanwhile slices on raw 0x0a bytes without corrupting partial multi-byte UTF-8 lines
    const dir = await mkdtemp(join(tmpdir(), "linkshell-tail-utf8-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "s.jsonl");
    await writeFile(file, Buffer.alloc(0));
    const tail = new TranscriptTail({ locate: () => file, offset: 0, onLine: () => {} });
    tail.pause();
    const line1 = Buffer.from('{"text":"中文第一行"}\n', "utf8");
    const partialCjk = Buffer.from('{"text":"中', "utf8");
    await writeFile(file, Buffer.concat([line1, partialCjk.subarray(0, partialCjk.length - 1)]));
    const seenLines: string[] = [];
    expect(tail.writtenMeanwhile((l) => { seenLines.push(l); return l.includes("中文第一行"); })).toBe(true);
    expect(seenLines).toEqual(['{"text":"中文第一行"}']);
    // Complete the second line and verify no replacement character U+FFFD!
    await writeFile(file, Buffer.concat([line1, Buffer.from('{"text":"中文第二行"}\n', "utf8")]));
    const secondLines: string[] = [];
    expect(tail.writtenMeanwhile((l) => { secondLines.push(l); return l.includes("中文第二行") && !l.includes("\uFFFD"); })).toBe(true);
    expect(secondLines).toEqual(['{"text":"中文第二行"}']);
  });

  it("P1: ClaudeTasks.file normalizes Windows backslashes, spaces in path, and UID-less temp directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "linkshell-claude-task-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const taskDir = join(dir, "claude", "my project", "sess-1", "tasks");
    await mkdir(taskDir, { recursive: true });
    const outputFile = join(taskDir, "bg-1.output");
    await writeFile(outputFile, "hello task\n");

    const tasks = new ClaudeTasks(() => {});
    tasks.observe(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "echo hi" } }] },
    }));
    // Spaces in parent path + UID-less `/claude/...` temp directory
    tasks.observe(JSON.stringify({
      type: "user",
      toolUseResult: { backgroundTaskId: "bg-1" },
      message: { content: [{ type: "tool_result", tool_use_id: "b1", content: `Output is being written to: ${outputFile}.` }] },
    }));
    expect(tasks.records.get("bg-1")).toMatchObject({ id: "bg-1", output: true });
    expect(tasks.file("sess-1", "bg-1")).toBeDefined();
  });
});

describe("D. Cross-driver subagent nesting safety", () => {
  it("nestUnder stamps parentToolCallId on plan, ls_error, and ls_notice without unsafe casts", () => {
    const plan = nestUnder({ sessionUpdate: "plan", entries: [{ content: "A", priority: "medium", status: "pending" }] }, "parent-1");
    const err = nestUnder({ sessionUpdate: "ls_error", code: "turn_failed", message: "boom" }, "parent-1");
    const notice = nestUnder({ sessionUpdate: "ls_notice", level: "warning", title: "heads up" }, "parent-1");
    expect(plan).toMatchObject({ sessionUpdate: "plan", parentToolCallId: "parent-1" });
    expect(err).toMatchObject({ sessionUpdate: "ls_error", parentToolCallId: "parent-1" });
    expect(notice).toMatchObject({ sessionUpdate: "ls_notice", parentToolCallId: "parent-1" });
  });
});
