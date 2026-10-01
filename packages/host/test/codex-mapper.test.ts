import { describe, expect, it } from "vitest";
import {
  itemToHistory,
  mapApprovalRequest,
  mapNotification,
  threadToDiscovered,
  threadToHistory,
  toCodexInput,
  type CodexThreadState,
} from "../src/drivers/codex/mapper.js";

function mapper() {
  const states = new Map<string, CodexThreadState>();
  const stateOf = (id: string) => {
    let state = states.get(id);
    if (!state) states.set(id, (state = {}));
    return state;
  };
  return { states, map: (method: string, params: unknown) => mapNotification(method, params, stateOf) };
}

describe("codex mapper", () => {
  it("streams an agent message and marks it done", () => {
    const { map } = mapper();
    expect(map("item/agentMessage/delta", { threadId: "t", turnId: "u", itemId: "m", delta: "Hel" })).toEqual([
      { threadId: "t", update: { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "Hel" } } },
    ]);
    expect(
      map("item/completed", { threadId: "t", turnId: "u", item: { type: "agentMessage", id: "m", text: "Hello" } }),
    ).toEqual([{ threadId: "t", update: { sessionUpdate: "ls_message_done", messageId: "m", role: "agent" }, itemId: "m" }]);
  });

  it("shows a review as its start, its findings and its end — not the instruction Codex gives itself", () => {
    const { map } = mapper();
    const kinds = (updates: ReturnType<typeof map>) => updates.map((entry) => entry.update.sessionUpdate);
    const prompt = { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "Review the current code changes." }] };
    const findings = { type: "agentMessage", id: "m1", text: "Nothing to fix." };
    expect(kinds(map("item/started", { threadId: "t", turnId: "u", item: { type: "enteredReviewMode", id: "r1", review: "current changes" } }))).toEqual(["tool_call"]);
    expect(map("item/started", { threadId: "t", turnId: "u", item: prompt })).toEqual([]);
    // The findings come whole, without having been streamed.
    expect(map("item/completed", { threadId: "t", turnId: "u", item: findings }).map((entry) => entry.update)).toEqual([
      { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Nothing to fix." } },
      { sessionUpdate: "ls_message_done", messageId: "m1", role: "agent" },
    ]);
    map("item/completed", { threadId: "t", turnId: "u", item: { type: "exitedReviewMode", id: "r2", review: "Nothing to fix." } });
    // After the review, a message without a client id (typed in the TUI) is the user's again.
    expect(kinds(map("item/started", { threadId: "t", turnId: "u2", item: { ...prompt, id: "u2" } }))).toEqual(["user_message_chunk"]);

    const history = threadToHistory({
      id: "t",
      cwd: "/w",
      createdAt: 1,
      updatedAt: 2,
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [{ type: "enteredReviewMode", id: "r1", review: "current changes" }, prompt, { type: "exitedReviewMode", id: "r2", review: "Nothing to fix." }, findings],
        },
        { id: "turn-2", status: "completed", items: [{ ...prompt, id: "u2" }] },
      ],
    });
    expect(history.map((item) => item.itemId)).toEqual(["r1", "r2", "m1", "u2"]);
  });

  it("tracks the active turn and maps stop reasons", () => {
    const { map, states } = mapper();
    map("turn/started", { threadId: "t", turn: { id: "turn-1", items: [], status: "inProgress" } });
    expect(states.get("t")?.activeTurnId).toBe("turn-1");
    const done = map("turn/completed", {
      threadId: "t",
      turn: { id: "turn-1", items: [], status: "failed", error: { message: "quota exceeded", additionalDetails: "try later" } },
    });
    expect(states.get("t")?.activeTurnId).toBeUndefined();
    expect(done.map((m) => m.update)).toEqual([
      { sessionUpdate: "ls_turn", state: "ended", turnId: "turn-1", stopReason: "error" },
      { sessionUpdate: "ls_error", code: "turn_failed", message: "quota exceeded", hint: "try later" },
    ]);
  });

  it("maps a command's lifecycle to a tool call", () => {
    const { map } = mapper();
    const item = { type: "commandExecution", id: "c1", command: "ls -la", cwd: "/w", status: "inProgress" };
    expect(map("item/started", { threadId: "t", turnId: "u", item })[0]?.update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "ls -la",
      kind: "execute",
      status: "in_progress",
    });
    expect(map("item/commandExecution/outputDelta", { threadId: "t", turnId: "u", itemId: "c1", delta: "a\n" })[0]?.update).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      appendOutput: "a\n",
    });
    const finished = map("item/completed", {
      threadId: "t",
      turnId: "u",
      item: { ...item, status: "failed", exitCode: 2, durationMs: 10, aggregatedOutput: "a\n" },
    })[0];
    expect(finished?.itemId).toBe("c1");
    expect(finished?.update).toMatchObject({ status: "failed", rawOutput: { exitCode: 2 } });
    expect(finished?.update).not.toHaveProperty("appendOutput");
  });

  it("emits the user message once, from item/started", () => {
    const { map } = mapper();
    const item = { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi", text_elements: [] }] };
    const started = map("item/started", { threadId: "t", turnId: "x", item });
    expect(started).toEqual([
      { threadId: "t", update: { sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "hi" } }, itemId: "u1" },
    ]);
    expect(map("item/completed", { threadId: "t", turnId: "x", item })).toEqual([]);
  });

  it("maps thread status, names and resolved requests", () => {
    const { map } = mapper();
    expect(map("thread/status/changed", { threadId: "t", status: { type: "active", activeFlags: ["waitingOnApproval"] } })[0]?.update).toEqual({
      sessionUpdate: "ls_status",
      state: "waiting",
    });
    expect(map("thread/name/updated", { threadId: "t", threadName: "Fix login" })[0]?.update).toEqual({
      sessionUpdate: "session_info_update",
      title: "Fix login",
    });
    expect(map("serverRequest/resolved", { threadId: "t", requestId: 7 })[0]?.update).toEqual({
      sessionUpdate: "ls_permission_resolved",
      requestId: "7",
    });
    expect(map("error", { threadId: "t", turnId: "u", willRetry: true, error: { message: "blip" } })).toEqual([]);
  });

  it("converts thread history and discovery metadata", () => {
    const thread = {
      id: "t",
      cwd: "/w",
      name: "Fix login",
      preview: "the login is broken",
      createdAt: 10,
      updatedAt: 20,
      status: { type: "notLoaded" },
      turns: [
        {
          id: "turn-1",
          status: "completed" as const,
          items: [
            { type: "userMessage", id: "u1", content: [{ type: "text", text: "fix it" }] },
            { type: "reasoning", id: "r1", summary: ["thinking"], content: [] },
            { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "/w/a.ts", kind: { type: "update", move_path: null }, diff: "@@" }] },
            { type: "agentMessage", id: "m1", text: "done" },
            { type: "hookPrompt", id: "h1", fragments: [] },
          ],
        },
      ],
    };
    expect(threadToDiscovered(thread)).toMatchObject({ nativeId: "t", title: "Fix login", createdAt: 10_000, updatedAt: 20_000, state: "idle" });
    const history = threadToHistory(thread);
    expect(history.map((h) => h.itemId)).toEqual(["u1", "r1", "f1", "m1"]);
    expect(history[2]?.updates[0]).toMatchObject({
      sessionUpdate: "tool_call",
      title: "Edit a.ts",
      kind: "edit",
      content: [{ type: "patch", path: "/w/a.ts", change: "update", diff: "@@" }],
    });
    expect(itemToHistory({ type: "agentMessage", id: "empty", text: "" })).toBeUndefined();
  });

  it("maps approval requests to options and back to decisions", () => {
    const request = mapApprovalRequest(
      "item/commandExecution/requestApproval",
      { threadId: "t", turnId: "u", itemId: "c1", command: "rm -rf build" },
      "42",
    );
    expect(request?.update).toMatchObject({ sessionUpdate: "ls_permission", requestId: "42", toolCallId: "c1", detail: "rm -rf build" });
    expect(request?.update.options.map((o) => o.optionId)).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
    expect(request?.respond("acceptForSession")).toEqual({ decision: "acceptForSession" });
    const permissions = mapApprovalRequest(
      "item/permissions/requestApproval",
      { threadId: "t", permissions: { network: { enabled: true }, fileSystem: null } },
      "43",
    );
    expect(permissions?.respond("session")).toEqual({ permissions: { network: { enabled: true }, fileSystem: null }, scope: "session" });
    expect(permissions?.respond("deny")).toEqual({ permissions: {}, scope: "turn" });
    expect(mapApprovalRequest("item/tool/requestUserInput", { threadId: "t" }, "44")).toBeUndefined();
  });

  it("converts client content to Codex input", () => {
    expect(
      toCodexInput([
        { type: "text", text: "look" },
        { type: "image", mimeType: "image/png", data: "AAAA" },
        { type: "resource_link", uri: "file:///w/shot.png", name: "shot.png" },
        { type: "resource_link", uri: "file:///w/src/a.ts", name: "a.ts" },
      ]),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "image", url: "data:image/png;base64,AAAA" },
      { type: "localImage", path: "/w/shot.png" },
      { type: "text", text: "@/w/src/a.ts", text_elements: [] },
    ]);
  });
});

describe("command titles", () => {
  it("unwraps the login-shell wrapper", async () => {
    const { unwrapShell } = await import("../src/drivers/codex/mapper.js");
    expect(unwrapShell("/bin/zsh -lc 'touch approved.txt'")).toBe("touch approved.txt");
    expect(unwrapShell("bash -c \"ls -la\"")).toBe("ls -la");
    expect(unwrapShell("/bin/zsh -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(unwrapShell("git status")).toBe("git status");
  });

  it("uses Codex's parsed command actions for the title", () => {
    const states = new Map();
    const map = (item: Record<string, unknown>) =>
      mapNotification("item/started", { threadId: "t", turnId: "u", item }, (id) => states.get(id) ?? states.set(id, {}).get(id))[0]?.update;
    expect(map({ type: "commandExecution", id: "a", command: "/bin/zsh -lc 'cat src/a.ts'", commandActions: [{ type: "read", command: "cat src/a.ts", name: "a.ts", path: "src/a.ts" }] })).toMatchObject({
      title: "Read a.ts",
      kind: "read",
    });
    expect(map({ type: "commandExecution", id: "b", command: "/bin/zsh -lc 'rg TODO src'", commandActions: [{ type: "search", command: "rg TODO src", query: "TODO", path: "src" }] })).toMatchObject({
      title: "Search “TODO” in src",
      kind: "search",
    });
    expect(map({ type: "commandExecution", id: "c", command: "/bin/zsh -lc 'npm test'", commandActions: [{ type: "unknown", command: "npm test" }] })).toMatchObject({
      title: "npm test",
      kind: "execute",
      rawInput: { command: "npm test" },
    });
  });
});

describe("client message ids", () => {
  it("uses the client's id for messages sent through LinkShell", () => {
    const history = itemToHistory({ type: "userMessage", id: "u9", clientId: "c-42", content: [{ type: "text", text: "hi" }] });
    expect(history?.itemId).toBe("u9");
    expect(history?.updates[0]).toMatchObject({ messageId: "local-c-42" });
    expect(itemToHistory({ type: "userMessage", id: "u8", clientId: null, content: [{ type: "text", text: "tui" }] })?.updates[0]).toMatchObject({
      messageId: "u8",
    });
  });
});
