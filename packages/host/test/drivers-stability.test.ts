import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUpdate } from "@linkshell/wire";
import { openChildRegistry } from "../src/children.js";
import { AcpDriver } from "../src/drivers/acp/driver.js";
import { AcpItemTracker, toHistory } from "../src/drivers/acp/mapper.js";
import { AcpUpdates } from "../src/drivers/acp/updates.js";
import { ClaudeDriver } from "../src/drivers/claude/driver.js";
import { readTranscript, transcriptLine } from "../src/drivers/claude/transcript.js";
import { CodexAppServer } from "../src/drivers/codex/app-server.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";
import { nestHistory, nestUnder } from "../src/drivers/nesting.js";
import type { DriverHost } from "../src/drivers/types.js";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

function makeHost() {
  const updates: { agent: string; nativeId: string; update: SessionUpdate; itemId?: string }[] = [];
  const stateMap = new Map<string, Map<string, string>>();
  const agentMap = new Map<string, Map<string, string>>();
  const storeFor = (root: Map<string, Map<string, string>>, key: string) => {
    let bucket = root.get(key);
    if (!bucket) root.set(key, (bucket = new Map()));
    return {
      get: (k: string) => bucket!.get(k),
      set: (k: string, v: string) => { bucket!.set(k, v); },
      delete: (k: string) => { bucket!.delete(k); },
    };
  };
  const host: DriverHost = {
    update: (agent, nativeId, update, itemId) => updates.push({ agent, nativeId, update, itemId }),
    notice: () => {},
    discovered: () => {},
    detached: () => {},
    state: (agent, nativeId) => storeFor(stateMap, `${agent}:${nativeId}`),
    agentState: (agent) => storeFor(agentMap, agent),
    desktop: () => undefined,
    log: () => {},
  };
  return { host, updates, stateMap };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("drivers/nesting", () => {
  it("forwards ls_message, ls_error, ls_notice, and plan with parentToolCallId", () => {
    const samples: SessionUpdate[] = [
      { sessionUpdate: "ls_message", messageId: "m1", role: "agent", content: [{ type: "text", text: "nested reply" }] },
      { sessionUpdate: "ls_error", message: "boom", hint: "retry" },
      { sessionUpdate: "ls_notice", severity: "info", title: "Subagent note" },
      { sessionUpdate: "plan", entries: [{ content: "step 1", priority: "high", status: "in_progress" }] },
    ];
    for (const update of samples) {
      expect(nestUnder(update, "sub-1")).toEqual({ ...update, parentToolCallId: "sub-1" });
    }
    const history = nestHistory([{ itemId: "h1", updates: samples }], "sub-1");
    expect(history[0]?.itemId).toBe("sub:sub-1:h1");
    expect(history[0]?.updates.every((entry) => entry.parentToolCallId === "sub-1")).toBe(true);
  });
});

describe.runIf(process.platform !== "win32")("CodexAppServer ChildRegistry tracking", () => {
  it("registers codex app-server in ChildRegistry with processGroup and removes it on stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsh-codex-child-"));
    const registry = openChildRegistry(dir);
    const server = new CodexAppServer({
      command: FAKE_CODEX,
      socketPath: join(dir, "codex.sock"),
      clientVersion: "test",
      log: () => {},
      onNotification: () => {},
      onRequest: () => undefined,
      onDown: () => {},
    });
    try {
      await server.start();
      expect(registry.list()).toMatchObject([{ kind: "codex app-server", group: true }]);
      await server.stop();
      expect(registry.list()).toEqual([]);
    } finally {
      await server.stop().catch(() => {});
      await registry.close(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CodexDriver goLive seeding and detach cache eviction", () => {
  it("seeds state.begun for underWay commands in goLive and evicts per-thread caches on detach", async () => {
    const { host, updates } = makeHost();
    const driver = new CodexDriver({
      socketPath: join(tmpdir(), "unused-codex.sock"),
      sharedSocketPath: false,
      desktopBusPath: false,
      clientVersion: "test",
    });
    (driver as unknown as { host: DriverHost }).host = host;

    const internal = driver as unknown as {
      goLive: (threadId: string, joined: { thread: Record<string, unknown>; underWay: Record<string, unknown>[] }) => void;
      onNotification: (method: string, params: unknown, from: "own" | "shared") => void;
      attached: Set<string>;
      threads: Map<string, { begun?: Set<string> }>;
      toolTitles: Map<string, string>;
      spawnDetails: Map<string, unknown>;
      joining: Map<string, unknown[]>;
    };

    internal.attached.add("th-1");
    internal.goLive("th-1", {
      thread: {
        id: "th-1",
        cwd: "/w",
        createdAt: 1,
        updatedAt: 2,
        status: { type: "active" },
        turns: [{ id: "turn-1", status: "inProgress", items: [] }],
      },
      underWay: [
        { type: "commandExecution", id: "cmd-live", command: "npm test", cwd: "/w", status: "inProgress" },
        { type: "collabAgentToolCall", id: "spawn-1", tool: "spawnAgent", prompt: "audit", receiverThreadIds: ["child-1"] },
      ],
    });

    expect(internal.threads.get("th-1")?.begun?.has("cmd-live")).toBe(true);
    expect(internal.toolTitles.has("cmd-live")).toBe(true);
    expect(internal.spawnDetails.has("spawn-1")).toBe(true);

    const beforeLen = updates.length;
    internal.onNotification("item/commandExecution/outputDelta", {
      threadId: "th-1",
      itemId: "cmd-live",
      delta: "PASS suite\n",
    }, "own");
    expect(updates.slice(beforeLen).map((entry) => entry.update)).toContainEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-live",
      appendOutput: "PASS suite\n",
    });

    await driver.detach("th-1");
    expect(internal.toolTitles.has("cmd-live")).toBe(false);
    expect(internal.spawnDetails.has("spawn-1")).toBe(false);
    expect(internal.threads.has("th-1")).toBe(false);
    expect(internal.joining.has("th-1")).toBe(false);
  });
});

describe("Claude transcript telemetry, late-flush dedup, cache eviction, and SIGINT-only interrupt", () => {
  it("emits usage_update from assistant JSONL message.usage and preserves multi-line history items", () => {
    const line1 = JSON.stringify({
      type: "assistant",
      uuid: "u-part-1",
      timestamp: "2026-11-13T00:00:01.000Z",
      message: {
        id: "msg_01",
        model: "claude-sonnet-4-6",
        stop_reason: null,
        content: [{ type: "thinking", thinking: "checking" }],
        usage: { input_tokens: 100, output_tokens: 5 },
      },
    });
    const line2 = JSON.stringify({
      type: "assistant",
      uuid: "u-part-2",
      timestamp: "2026-11-13T00:00:02.000Z",
      message: {
        id: "msg_01",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "All done." }],
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 50,
        },
      },
    });
    const turnDone = JSON.stringify({
      type: "system",
      subtype: "turn_duration",
      timestamp: "2026-11-13T00:00:02.500Z",
      durationMs: 1500,
    });

    // Streaming chunk with stop_reason === null does not prematurely emit turn usage.
    expect(transcriptLine(line1).updates.some((u) => u.sessionUpdate === "usage_update")).toBe(false);

    const completed = transcriptLine(line2).updates;
    expect(completed).toContainEqual({
      sessionUpdate: "usage_update",
      usedTokens: 570,
      tokens: {
        totalTokens: 600,
        inputTokens: 120,
        outputTokens: 30,
        cachedReadTokens: 400,
        cachedWriteTokens: 50,
      },
      accounting: {
        id: "claude:msg_01",
        scope: "turn",
        model: "claude-sonnet-4-6",
        timestamp: Date.parse("2026-11-13T00:00:02.000Z"),
      },
    });

    const dir = mkdtempSync(join(tmpdir(), "lsh-claude-usage-"));
    try {
      const file = join(dir, "s1.jsonl");
      writeFileSync(file, `${line1}\n${line2}\n${turnDone}\n`);
      const history = toHistory(readTranscript(file).updates);
      const flat = history.flatMap((item) => item.updates.map((u) => u.sessionUpdate));
      expect(flat).toContain("usage_update");
      expect(flat).toContain("ls_turn");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("suppresses late SDK flushes via +2s grace and message ID dedup, evicts caches on detach, and sends only SIGINT to foreign holders", async () => {
    vi.useFakeTimers();
    const { host, updates } = makeHost();
    const driver = new ClaudeDriver({
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(tmpdir(), "lsh-claude-cfg-none") },
      hostVersion: "test",
      adapter: { command: process.execPath, args: [] },
    });
    (driver as unknown as { host: DriverHost }).host = host;

    const internal = driver as unknown as {
      beginTranscriptStream: (nativeId: string) => void;
      endTranscriptStream: (nativeId: string) => void;
      recordStreamedUpdate: (nativeId: string, update: SessionUpdate) => void;
      onTranscriptLine: (nativeId: string, line: string) => void;
      interruptElsewhere: (nativeId: string) => Promise<void>;
      elsewhere: (nativeId: string) => Promise<{ pid: number; working: boolean } | undefined>;
      foreignHolders: (nativeId: string) => Promise<{ pid: number }[]>;
      seenLines: Map<string, Set<string>>;
      hiddenTools: Map<string, Set<string>>;
      backgroundAgents: Map<string, Set<string>>;
      observed: Map<string, unknown>;
      tasks: Map<string, unknown>;
      streamedTranscripts: Map<string, unknown>;
    };

    // Real claude-agent-acp (ACP v1): user_message_chunk carries "local-c1" while agent_message_chunk has no messageId.
    // A +500ms late sdk-ts assistant flush with message.id "msg_01" must still be suppressed by the +2s grace window.
    vi.setSystemTime(new Date("2026-11-13T01:00:00.000Z"));
    internal.beginTranscriptStream("s-acp-v1");
    internal.recordStreamedUpdate("s-acp-v1", {
      sessionUpdate: "user_message_chunk",
      messageId: "local-c1",
      content: { type: "text", text: "prompt from phone" },
    });
    internal.recordStreamedUpdate("s-acp-v1", {
      sessionUpdate: "agent_message_chunk",
      messageId: undefined as unknown as string,
      content: { type: "text", text: "streamed without id" },
    });
    internal.endTranscriptStream("s-acp-v1");
    await vi.advanceTimersByTimeAsync(500);
    internal.onTranscriptLine("s-acp-v1", JSON.stringify({
      type: "assistant",
      uuid: "u-late-v1",
      timestamp: new Date(Date.now()).toISOString(),
      entrypoint: "sdk-ts",
      message: { id: "msg_01", stop_reason: "end_turn", content: [{ type: "text", text: "streamed without id" }] },
    }));
    expect(updates).toHaveLength(0);

    // An external SDK turn starting within the grace window sets externalTurnAfterClose so both prompt and reply pass through.
    await vi.advanceTimersByTimeAsync(400);
    internal.onTranscriptLine("s-acp-v1", JSON.stringify({
      type: "user",
      uuid: "u-ext-user",
      timestamp: new Date(Date.now()).toISOString(),
      entrypoint: "sdk-ts",
      message: { role: "user", content: [{ type: "text", text: "external sdk prompt" }] },
    }));
    internal.onTranscriptLine("s-acp-v1", JSON.stringify({
      type: "assistant",
      uuid: "u-ext-reply",
      timestamp: new Date(Date.now()).toISOString(),
      entrypoint: "sdk-ts",
      message: { id: "msg_02", stop_reason: "end_turn", content: [{ type: "text", text: "external sdk reply" }] },
    }));
    expect(updates.filter((entry) => entry.nativeId === "s-acp-v1" && entry.update.sessionUpdate === "agent_message_chunk")).toHaveLength(1);
    updates.length = 0;

    internal.beginTranscriptStream("s-late");
    internal.recordStreamedUpdate("s-late", {
      sessionUpdate: "agent_message_chunk",
      messageId: "msg_streamed",
      content: { type: "text", text: "already streamed" },
    });
    internal.endTranscriptStream("s-late");

    // Even 3 seconds after endTranscriptStream, a late flush of the streamed messageId is suppressed,
    // while an unrelated external SDK message passes through after closedAt.
    await vi.advanceTimersByTimeAsync(3000);
    internal.onTranscriptLine("s-late", JSON.stringify({
      type: "assistant",
      uuid: "u-late",
      entrypoint: "sdk-ts",
      message: { id: "msg_streamed", stop_reason: "end_turn", content: [{ type: "text", text: "already streamed" }] },
    }));
    expect(updates).toHaveLength(0);

    internal.onTranscriptLine("s-late", JSON.stringify({
      type: "assistant",
      uuid: "u-external",
      entrypoint: "sdk-ts",
      model: "claude-sonnet-4-6",
      message: { id: "msg_external", stop_reason: "end_turn", content: [{ type: "text", text: "external client" }] },
    }));
    expect(updates.some((entry) => entry.update.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(internal.seenLines.has("s-late")).toBe(true);
    expect(internal.observed.has("s-late")).toBe(true);

    internal.tasks.set("s-late", new Map());
    await driver.detach("s-late");
    expect(internal.seenLines.has("s-late")).toBe(false);
    expect(internal.hiddenTools.has("s-late")).toBe(false);
    expect(internal.backgroundAgents.has("s-late")).toBe(false);
    expect(internal.observed.has("s-late")).toBe(false);
    expect(internal.tasks.has("s-late")).toBe(false);
    expect(internal.streamedTranscripts.has("s-late")).toBe(false);

    // Foreign Claude holder stays busy across the full wait budget: only SIGINT is ever sent, never SIGTERM.
    const signals: (NodeJS.Signals | number | undefined)[] = [];
    vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal?: NodeJS.Signals | number) => {
      signals.push(signal);
      return true;
    }) as typeof process.kill);
    internal.elsewhere = async () => ({ pid: 424242, working: true });
    internal.foreignHolders = async () => [{ pid: 424242 }];

    const interrupting = internal.interruptElsewhere("s-busy");
    const asserted = expect(interrupting).rejects.toMatchObject({ appCode: "busy" });
    await vi.advanceTimersByTimeAsync(7000);
    await asserted;
    expect(signals).toEqual(["SIGINT"]);
  });
});

describe("AcpDriver detach cache eviction and alias restoration", () => {
  it("clears per-session tracker, updates, messageAliases, deferredUserUpdates, and toolCalls on detach and restores aliases", async () => {
    const { host } = makeHost();
    const driver = new AcpDriver(
      { id: "gemini", label: "Gemini", command: "gemini", args: ["--acp"], tier: "multi_client" },
      { hostVersion: "test" },
    );
    (driver as unknown as { host: DriverHost }).host = host;
    host.state("gemini", "a-1").set("acp-message-aliases", JSON.stringify([["native-u1", "local-c1"]]));

    const internal = driver as unknown as {
      sessions: Map<string, {
        cwd: string;
        loaded: boolean;
        turnActive: boolean;
        queue: unknown[];
        permissions: Map<string, unknown>;
        config: unknown[];
        tracker: AcpItemTracker;
        updates: AcpUpdates;
        messageAliases: Map<string, string>;
        deferredUserUpdates: SessionUpdate[];
        toolCalls: Map<string, SessionUpdate>;
      }>;
      restoreMessageAliases: (nativeId: string, state: { messageAliases: Map<string, string> }) => void;
    };

    const tracker = new AcpItemTracker();
    tracker.feed({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "cached" } });
    const state = {
      cwd: "/w",
      loaded: false,
      turnActive: false,
      queue: [],
      permissions: new Map(),
      config: [],
      tracker,
      updates: new AcpUpdates(),
      messageAliases: new Map([["native-u1", "local-c1"]]),
      deferredUserUpdates: [{ sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "hi" } } as SessionUpdate],
      toolCalls: new Map([["tc-1", { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "sh", status: "in_progress" } as SessionUpdate]]),
    };
    internal.sessions.set("a-1", state);

    await driver.detach("a-1");
    expect(state.messageAliases.size).toBe(0);
    expect(state.deferredUserUpdates).toEqual([]);
    expect(state.toolCalls.size).toBe(0);
    expect(toHistory([])).toEqual([]);

    internal.restoreMessageAliases("a-1", state);
    expect(state.messageAliases.get("native-u1")).toBe("local-c1");
  });
});
