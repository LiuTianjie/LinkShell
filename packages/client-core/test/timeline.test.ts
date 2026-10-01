import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionUpdate } from "@linkshell/wire";
import {
  addOptimisticMessage,
  applyEvent,
  applyEvents,
  emptyView,
  markMessageFailed,
  prependEvents,
  startWindow,
  type TimelineItem,
} from "../src/timeline.js";

let seq = 0;
const ev = (update: SessionUpdate, ts = 1000 + seq): SessionEvent => ({ sessionId: "s", seq: ++seq, ts, update });
const text = (t: string) => ({ type: "text" as const, text: t });
const kinds = (items: TimelineItem[]) => items.map((i) => i.kind);

describe("timeline reducer", () => {
  it("streams an agent message into one item and closes it", () => {
    seq = 0;
    let v = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "user_message_chunk", messageId: "u1", content: text("fix it") }),
      ev({ sessionUpdate: "ls_turn", state: "started" }),
      ev({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("Found ") }),
      ev({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("it") }),
    ]);
    expect(kinds(v.items)).toEqual(["user", "agent"]);
    expect(v.items[1]).toMatchObject({ text: "Found it", streaming: true });
    expect(v).toMatchObject({ state: "running", turnActive: true });
    v = applyEvent(v, ev({ sessionUpdate: "ls_message_done", messageId: "m1", role: "agent" }));
    v = applyEvent(v, ev({ sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" }));
    expect(v.items[1]).toMatchObject({ streaming: false });
    expect(v).toMatchObject({ state: "idle", turnActive: false, lastSeq: 6 });
  });

  it("only re-creates the item a chunk touched", () => {
    seq = 0;
    const v1 = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "user_message_chunk", messageId: "u1", content: text("hi") }),
      ev({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("a") }),
    ]);
    const v2 = applyEvent(v1, ev({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("b") }));
    expect(v2.items[0]).toBe(v1.items[0]);
    expect(v2.items[1]).not.toBe(v1.items[1]);
  });

  it("ignores events it has already applied (replay after reconnect)", () => {
    seq = 0;
    const events = [
      ev({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("one") }),
      ev({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text(" two") }),
    ];
    const once = applyEvents(emptyView("s"), events);
    const twice = applyEvents(once, events);
    expect(twice).toBe(once);
    expect((twice.items[0] as { text: string }).text).toBe("one two");
  });

  it("keeps thoughts separate from the answer with the same message id", () => {
    seq = 0;
    const v = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "agent_thought_chunk", messageId: "m1", content: text("thinking") }, 1000),
      ev({ sessionUpdate: "ls_message_done", messageId: "m1", role: "thought" }, 4000),
      ev({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("answer") }),
    ]);
    expect(kinds(v.items)).toEqual(["thought", "agent"]);
    expect(v.items[0]).toMatchObject({ text: "thinking", streaming: false, ts: 1000, endedTs: 4000 });
  });

  it("merges tool call updates, appends streamed output and records duration", () => {
    seq = 0;
    const v = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "tool_call", toolCallId: "t1", title: "npm test", kind: "execute", status: "in_progress", rawInput: { command: "npm test" } }, 1000),
      ev({ sessionUpdate: "tool_call_update", toolCallId: "t1", appendOutput: "PASS a\n" }),
      ev({ sessionUpdate: "tool_call_update", toolCallId: "t1", appendOutput: "PASS b\n" }),
      ev({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { exitCode: 0 } }, 3500),
    ]);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({
      kind: "tool",
      title: "npm test",
      status: "completed",
      output: "PASS a\nPASS b\n",
      rawOutput: { exitCode: 0 },
      ts: 1000,
      endedTs: 3500,
    });
  });

  it("keeps an edit's diff when the result is only a status line", () => {
    seq = 0;
    const diff = { type: "diff" as const, path: "/p/a.css", oldText: "a {}", newText: "a { color: red }" };
    const note = { type: "content" as const, content: text("The file has been updated.") };
    const v = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "tool_call", toolCallId: "e1", title: "Edit a.css", kind: "edit", status: "in_progress", content: [diff] }),
      ev({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed", content: [note] }),
    ]);
    expect(v.items[0]).toMatchObject({ content: [diff, note] });
    // A result that brings its own diff replaces the old one.
    const newer = { ...diff, newText: "a { color: blue }" };
    const w = applyEvents(v, [ev({ sessionUpdate: "tool_call_update", toolCallId: "e1", content: [newer] })]);
    expect(w.items[0]).toMatchObject({ content: [newer] });
  });

  it("stops streaming text when a tool starts", () => {
    seq = 0;
    const v = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("Let me check") }),
      ev({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.ts", kind: "read", status: "in_progress" }),
    ]);
    expect(v.items[0]).toMatchObject({ streaming: false });
  });

  it("keeps one plan card per turn and updates it in place", () => {
    seq = 0;
    const plan = (done: number) =>
      ev({
        sessionUpdate: "plan",
        entries: ["a", "b", "c"].map((content, i) => ({ content, priority: "medium" as const, status: i < done ? ("completed" as const) : ("pending" as const) })),
      });
    let v = applyEvents(emptyView("s"), [ev({ sessionUpdate: "ls_turn", state: "started" }), plan(1), ev({ sessionUpdate: "agent_message_chunk", messageId: "m", content: text("x") }), plan(2)]);
    expect(kinds(v.items)).toEqual(["plan", "agent"]);
    expect((v.items[0] as { entries: { status: string }[] }).entries.map((e) => e.status)).toEqual(["completed", "completed", "pending"]);
    v = applyEvents(v, [ev({ sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" }), ev({ sessionUpdate: "ls_turn", state: "started" }), plan(0)]);
    expect(kinds(v.items)).toEqual(["plan", "agent", "plan"]);
  });

  it("tracks permission requests and leaves a record when one is answered", () => {
    seq = 0;
    const options = [
      { optionId: "accept", name: "Allow", kind: "allow_once" as const },
      { optionId: "decline", name: "Decline", kind: "reject_once" as const },
    ];
    let v = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "ls_turn", state: "started" }),
      ev({ sessionUpdate: "ls_permission", requestId: "r1", title: "Run command", detail: "rm -rf build", options }),
    ]);
    expect(v.state).toBe("waiting");
    expect(v.permissions).toHaveLength(1);
    v = applyEvent(v, ev({ sessionUpdate: "ls_permission_resolved", requestId: "r1", optionId: "decline" }));
    expect(v.permissions).toHaveLength(0);
    expect(v.state).toBe("running");
    expect(v.items.at(-1)).toMatchObject({ kind: "permission-result", title: "Run command", optionName: "Decline", allowed: false });
    // A duplicate resolution changes nothing.
    const again = applyEvent(v, ev({ sessionUpdate: "ls_permission_resolved", requestId: "r1" }));
    expect(again.items).toBe(v.items);
  });

  it("clears pending permissions and marks cancellation when a turn is cancelled", () => {
    seq = 0;
    const v = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "ls_turn", state: "started" }),
      ev({ sessionUpdate: "ls_permission", requestId: "r1", title: "Run", options: [{ optionId: "a", name: "A", kind: "allow_once" }] }),
      ev({ sessionUpdate: "ls_turn", state: "ended", stopReason: "cancelled" }),
    ]);
    expect(v.permissions).toEqual([]);
    expect(v.items.at(-1)).toMatchObject({ kind: "turn-end", stopReason: "cancelled" });
    expect(v.state).toBe("idle");
  });

  it("confirms an optimistic message in place and flags failures", () => {
    seq = 0;
    let v = addOptimisticMessage(emptyView("s"), "c1", [text("from phone")], 500);
    expect(v.items[0]).toMatchObject({ id: "local-c1", pending: true });
    v = applyEvent(v, ev({ sessionUpdate: "user_message_chunk", messageId: "local-c1", content: text("from phone") }));
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ id: "local-c1", blocks: [text("from phone")] });
    expect(v.items[0]).not.toHaveProperty("pending", true);
    const failed = markMessageFailed(addOptimisticMessage(emptyView("s"), "c2", [text("x")]), "c2");
    expect(failed.items[0]).toMatchObject({ failed: true, pending: false });
  });

  it("reports handoffs after the initial driver, and applies config, commands and usage", () => {
    seq = 0;
    const v = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "ls_driver", driver: "desktop" }),
      ev({ sessionUpdate: "ls_driver", driver: "remote" }),
      ev({
        sessionUpdate: "ls_config",
        options: [
          { id: "model", name: "Model", category: "model", current: "opus", values: [{ value: "opus", name: "Opus" }] },
          { id: "mode", name: "Mode", category: "mode", current: "default", values: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
        ],
      }),
      ev({ sessionUpdate: "current_mode_update", currentModeId: "plan" }),
      ev({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact context" }] }),
      ev({ sessionUpdate: "usage_update", usedTokens: 1200, contextWindow: 200000 }),
      ev({ sessionUpdate: "session_info_update", title: "Fix login" }),
    ]);
    expect(kinds(v.items)).toEqual(["driver"]);
    expect(v.items[0]).toMatchObject({ driver: "remote" });
    expect(v.driver).toBe("remote");
    expect(v.modeId).toBe("plan");
    expect(v.config.find((o) => o.id === "mode")?.current).toBe("plan");
    expect(v.commands).toEqual([{ name: "compact", description: "Compact context" }]);
    expect(v.usage).toEqual({ usedTokens: 1200, contextWindow: 200000 });
    expect(v.title).toBe("Fix login");
  });

  it("shows errors and notices as their own items", () => {
    seq = 0;
    const v = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "ls_error", code: "turn_failed", message: "Claude 鉴权失败", hint: "run claude /login" }),
      ev({ sessionUpdate: "ls_notice", level: "warning", title: "Context almost full" }),
    ]);
    expect(kinds(v.items)).toEqual(["error", "notice"]);
    expect(v.items[0]).toMatchObject({ message: "Claude 鉴权失败", hint: "run claude /login" });
  });

  it("nests a sub-agent's work under the call that spawned it", () => {
    seq = 0;
    let v = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "ls_turn", state: "started" }),
      ev({
        sessionUpdate: "tool_call",
        toolCallId: "task",
        title: "Agent: audit",
        kind: "other",
        status: "in_progress",
        detail: { type: "subagent", action: "spawn", task: "audit", agentType: "Explore" },
      }),
      ev({ sessionUpdate: "agent_message_chunk", parentToolCallId: "task", messageId: "c1", content: text("Looking") }),
      ev({ sessionUpdate: "tool_call", parentToolCallId: "task", toolCallId: "r1", title: "Read a.ts", kind: "read", status: "in_progress" }),
      ev({ sessionUpdate: "tool_call_update", parentToolCallId: "task", toolCallId: "r1", status: "completed" }),
      ev({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("Waiting on the audit") }),
    ]);
    expect(kinds(v.items)).toEqual(["tool", "agent"]);
    const task = v.items[0] as Extract<TimelineItem, { kind: "tool" }>;
    expect(kinds(task.sub!.items)).toEqual(["agent", "tool"]);
    expect(task.sub!.items[1]).toMatchObject({ id: "r1", status: "completed" });
    expect(task.sub!.items[0]).toMatchObject({ streaming: false });

    v = applyEvent(v, ev({ sessionUpdate: "tool_call_update", toolCallId: "task", status: "completed" }));
    expect((v.items[0] as Extract<TimelineItem, { kind: "tool" }>).sub!.items.length).toBe(2);
  });

  it("keeps child work that arrives before its parent call", () => {
    seq = 0;
    let v = applyEvents(emptyView("s"), [
      ev({ sessionUpdate: "tool_call", parentToolCallId: "p", toolCallId: "c", title: "grep", kind: "search", status: "completed" }),
    ]);
    expect(v.items[0]).toMatchObject({ id: "p", kind: "tool", detail: { type: "subagent" } });
    v = applyEvent(v, ev({ sessionUpdate: "tool_call", toolCallId: "p", title: "Agent: x", kind: "other", status: "in_progress" }));
    expect((v.items[0] as Extract<TimelineItem, { kind: "tool" }>).sub!.items.map((i) => i.id)).toEqual(["c"]);
  });
});

describe("history in pages", () => {
  function session(): SessionEvent[] {
    seq = 0;
    return [
      ev({ sessionUpdate: "ls_config", options: [] }),
      ev({ sessionUpdate: "user_message_chunk", messageId: "u1", content: text("first") }),
      ev({ sessionUpdate: "ls_turn", state: "started" }),
      ev({ sessionUpdate: "agent_thought_chunk", messageId: "t1", content: text("hm") }),
      ev({ sessionUpdate: "agent_thought_chunk", messageId: "t1", content: text("m") }),
      ev({ sessionUpdate: "ls_message_done", messageId: "t1", role: "thought" }),
      ev({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read a.ts", kind: "read", status: "in_progress", rawInput: { path: "a.ts" } }),
      ev({ sessionUpdate: "tool_call_update", toolCallId: "c1", appendOutput: "line 1\n" }),
      ev({ sessionUpdate: "tool_call_update", toolCallId: "c1", appendOutput: "line 2\n" }),
      ev({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: text("ok") }] }),
      ev({ sessionUpdate: "tool_call", toolCallId: "task", title: "Explore", kind: "other", status: "in_progress", detail: { type: "subagent", action: "spawn" } }),
      ev({ sessionUpdate: "agent_message_chunk", messageId: "sub1", content: text("looking"), parentToolCallId: "task" }),
      ev({ sessionUpdate: "tool_call", toolCallId: "sub-c", title: "Grep", kind: "search", status: "in_progress", parentToolCallId: "task" }),
      ev({ sessionUpdate: "tool_call_update", toolCallId: "sub-c", status: "completed", parentToolCallId: "task" }),
      ev({ sessionUpdate: "agent_message_chunk", messageId: "sub1", content: text(" done"), parentToolCallId: "task" }),
      ev({ sessionUpdate: "tool_call_update", toolCallId: "task", status: "completed" }),
      ev({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("All ") }),
      ev({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: text("good") }),
      ev({ sessionUpdate: "ls_message_done", messageId: "m1", role: "agent" }),
      ev({ sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" }),
      ev({ sessionUpdate: "user_message_chunk", messageId: "u2", content: text("second") }),
      ev({ sessionUpdate: "user_message_chunk", messageId: "u2", content: text(" part") }),
      ev({ sessionUpdate: "ls_turn", state: "started" }),
      ev({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: text("Sure") }),
      ev({ sessionUpdate: "ls_turn", state: "ended", stopReason: "cancelled" }),
    ];
  }

  /** What the host sends for a window starting after `cut`: the later events only. */
  const from = (events: SessionEvent[], cut: number) => applyEvents(startWindow(emptyView("s"), cut), events.slice(cut));

  it("shows the same timeline wherever the page boundary falls", () => {
    const events = session();
    const whole = applyEvents(emptyView("s"), events);
    for (let cut = 1; cut < events.length; cut++) {
      const windowed = from(events, cut);
      expect(windowed.startSeq).toBe(cut);
      const joined = prependEvents(windowed, events.slice(0, cut), 0);
      // (A thought cut off by the boundary ends at the boundary: its duration is the one approximation.)
      const comparable = (items: TimelineItem[]) => items.map((item) => (item.kind === "thought" ? { ...item, endedTs: undefined } : item));
      expect(comparable(joined.items), `cut after event ${cut}`).toEqual(comparable(whole.items));
      expect(joined.index).toEqual(whole.index);
      expect(joined).toMatchObject({ startSeq: 0, lastSeq: whole.lastSeq, turnActive: false });
    }
  });

  it("adds pages one after another", () => {
    const events = session();
    const whole = applyEvents(emptyView("s"), events);
    let view = from(events, 20);
    view = prependEvents(view, events.slice(9, 20), 9);
    expect(view.startSeq).toBe(9);
    view = prependEvents(view, events.slice(0, 9), 0);
    expect(view.items).toEqual(whole.items);
  });

  it("starts over when the host's backlog skips ahead, keeping unsent messages", () => {
    const events = session();
    let view = applyEvents(emptyView("s"), events.slice(0, 6));
    view = addOptimisticMessage(view, "c9", [text("not sent yet")]);
    const skipped = startWindow(view, 20);
    expect(skipped).toMatchObject({ lastSeq: 0, startSeq: 20 });
    expect(skipped.items).toMatchObject([{ id: "local-c9", pending: true }]);
    // A backlog that continues from what the view has changes nothing.
    expect(startWindow(view, view.lastSeq)).toBe(view);
    // One that starts before it: the host's log is behind the view (its state was reset), so the view starts over too.
    expect(startWindow(view, 3)).toMatchObject({ lastSeq: 0, startSeq: 3 });
  });
});

