import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent, SessionUpdate } from "@linkshell/wire";
import type { AgentDriver, DriverHost } from "../src/drivers/types.js";
import { SessionHub } from "../src/hub.js";
import { imageOf, parseImageUri, slimEvent } from "../src/slim.js";
import { HostStore } from "../src/store.js";

// A long session reaches a phone in pages: the latest turns first, earlier
// ones on request, and never its pictures unless they are looked at.

class QuietDriver implements AgentDriver {
  readonly id = "fake";
  readonly label = "Fake";
  readonly tier = "multi_client" as const;
  readonly capabilities = { interrupt: true, steer: false, permissions: true, images: false, fork: false, models: false, modes: false };
  host!: DriverHost;
  async start(host: DriverHost) {
    this.host = host;
    return { installed: true, version: "1.0" };
  }
  async stop() {}
  status() {
    return { installed: true, version: "1.0" };
  }
  async listSessions() {
    return [{ nativeId: "s1", cwd: "/w/app", createdAt: 1, updatedAt: 1 }];
  }
  async createSession(options: { cwd: string }) {
    return { nativeId: "new", cwd: options.cwd, createdAt: 2, updatedAt: 2 };
  }
  async attach() {
    return [];
  }
  async detach() {}
  async prompt() {
    return "started" as const;
  }
  async cancel() {}
  async respondPermission() {}
  emit(update: SessionUpdate) {
    this.host.update(this.id, "s1", update);
  }
}

const PICTURE = "A".repeat(200_000);

let dir: string;
let store: HostStore;
let driver: QuietDriver;
let hub: SessionHub;

/** One turn: the user's message, `tools` tool calls (each with a screenshot when `pictures`), the reply. */
function turn(n: number, tools: number, pictures = false) {
  driver.emit({ sessionUpdate: "user_message_chunk", messageId: `u${n}`, content: { type: "text", text: `question ${n}` } });
  driver.emit({ sessionUpdate: "ls_turn", state: "started" });
  for (let i = 0; i < tools; i++) {
    const toolCallId = `t${n}-${i}`;
    driver.emit({ sessionUpdate: "tool_call", toolCallId, title: "Screenshot", kind: "other", status: "in_progress" });
    driver.emit({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      content: pictures
        ? [
            { type: "content", content: { type: "text", text: "saved" } },
            { type: "content", content: { type: "image", mimeType: "image/png", data: PICTURE } },
          ]
        : [{ type: "content", content: { type: "text", text: "done" } }],
    });
  }
  driver.emit({ sessionUpdate: "agent_message_chunk", messageId: `a${n}`, content: { type: "text", text: `answer ${n}` } });
  driver.emit({ sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
}

function collector() {
  const events: SessionEvent[] = [];
  const windows: number[] = [];
  return { events, windows, subscriber: { event: (e: SessionEvent) => events.push(e), window: (seq: number) => windows.push(seq) } };
}

const kinds = (events: SessionEvent[]) => events.map((event) => event.update.sessionUpdate);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lsh-history-"));
  store = new HostStore(join(dir, "state.db"));
  driver = new QuietDriver();
  hub = new SessionHub(store, [driver]);
  await hub.start();
  await hub.subscribe("fake:s1", 0, collector().subscriber);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("session history in pages", () => {
  it("keeps a corrected teammate launch running through a long quiet command", () => {
    driver.emit({ sessionUpdate: "tool_call", toolCallId: "member", title: "frontend", kind: "other", status: "completed", detail: { type: "subagent", action: "spawn" } });
    expect(hub.getSession("fake:s1").subagents?.running).toBe(0);
    driver.emit({ sessionUpdate: "tool_call_update", toolCallId: "member", status: "in_progress", detail: { type: "subagent", action: "spawn", state: "running" } });
    driver.emit({ sessionUpdate: "ls_turn", parentToolCallId: "member", state: "started" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20 * 60_000);
    try {
      expect(hub.getSession("fake:s1").subagents?.running).toBe(1);
      expect(hub.subagents("fake:s1")[0]?.running).toBe(true);
      driver.emit({ sessionUpdate: "tool_call_update", toolCallId: "member", status: "completed", detail: { type: "subagent", action: "spawn", state: "completed" } });
      driver.emit({ sessionUpdate: "ls_turn", parentToolCallId: "member", state: "ended", stopReason: "end_turn" });
      expect(hub.getSession("fake:s1").subagents?.running).toBe(0);
    } finally { clock.mockRestore(); }
  });
  it("restores a workflow launch failure without waiting for a background run that was never created", () => {
    driver.emit({ sessionUpdate: "tool_call", toolCallId: "wf-failed", title: "Workflow", kind: "other", status: "in_progress", detail: { type: "subagent", action: "spawn", workflow: {} } });
    driver.emit({ sessionUpdate: "tool_call_update", toolCallId: "wf-failed", status: "failed" });
    expect(hub.subagents("fake:s1")).toMatchObject([{ toolCallId: "wf-failed", running: false, failed: true, workflow: { state: "failed" }, lastSeq: store.getSession("fake:s1")!.lastSeq }]);
  });

  it("returns the current workflow roster even when its launch and progress are outside the history window", async () => {
    driver.emit({ sessionUpdate: "tool_call", toolCallId: "wf", title: "Workflow", kind: "other", status: "in_progress", detail: { type: "subagent", action: "spawn", workflow: {} } });
    driver.emit({ sessionUpdate: "tool_call_update", toolCallId: "wf", status: "in_progress", detail: { type: "subagent", action: "spawn", task: "Current task", workflow: {
      name: "Workflow overview", state: "running", started: 1, completed: 0,
      phases: [{ id: "p", title: "Implementation", order: 1 }], agents: [{ id: "a", title: "Mobile UI", state: "running", phaseId: "p", toolCallId: "worker" }],
    } } });
    const seq = store.getSession("fake:s1")!.lastSeq;
    for (let n = 1; n <= 30; n++) turn(n, 10);
    const client = collector();
    const { startSeq } = await hub.subscribe("fake:s1", 0, client.subscriber);
    expect(startSeq).toBeGreaterThan(seq);
    expect(hub.subagents("fake:s1")).toMatchObject([{ toolCallId: "wf", task: "Current task", lastSeq: seq, workflow: {
      phases: [{ title: "Implementation" }], agents: [{ title: "Mobile UI", toolCallId: "worker" }],
    } }]);
  });

  it("sends a short session whole", async () => {
    turn(1, 2);
    turn(2, 2);
    const client = collector();
    const { startSeq } = await hub.subscribe("fake:s1", 0, client.subscriber);
    expect(startSeq).toBe(0);
    expect(client.windows).toEqual([]);
    expect(client.events.map((event) => event.seq)).toEqual(client.events.map((_, i) => i + 1));
  });

  it("opens a long session at its latest turns, with the settings from before them", async () => {
    driver.emit({ sessionUpdate: "ls_config", options: [{ id: "model", name: "Model", category: "model", current: "opus", values: [{ value: "opus", name: "Opus" }] }] });
    driver.emit({ sessionUpdate: "session_info_update", title: "Long one" });
    for (let n = 1; n <= 40; n++) turn(n, 10);
    const last = store.getSession("fake:s1")!.lastSeq;

    const client = collector();
    const { startSeq } = await hub.subscribe("fake:s1", 0, client.subscriber);
    expect(startSeq).toBeGreaterThan(0);
    expect(client.windows).toEqual([startSeq]);
    // The settings first, then whole turns up to the end.
    expect(kinds(client.events).slice(0, 3)).toEqual(["ls_config", "session_info_update", "user_message_chunk"]);
    const page = client.events.filter((event) => event.seq > startSeq);
    expect(page.at(-1)!.seq).toBe(last);
    expect(page.length).toBe(last - startSeq);
    expect(page.length).toBeGreaterThanOrEqual(120);
    expect(page.length).toBeLessThan(200);

    // Earlier pages, back to the beginning, are whole turns too and cover everything once.
    const seen = new Set(page.map((event) => event.seq));
    let before = startSeq + 1;
    let pages = 0;
    while (before > 1) {
      const earlier = hub.history("fake:s1", before);
      expect(earlier.events.at(-1)!.seq).toBe(before - 1);
      expect(earlier.events[0]!.seq).toBe(earlier.startSeq + 1);
      if (earlier.startSeq > 0) expect(earlier.events[0]!.update.sessionUpdate).toBe("user_message_chunk");
      for (const event of earlier.events) {
        expect(seen.has(event.seq)).toBe(false);
        seen.add(event.seq);
      }
      before = earlier.startSeq + 1;
      pages += 1;
    }
    expect(seen.size).toBe(last);
    expect(pages).toBeGreaterThan(3);
    expect(hub.history("fake:s1", 1)).toEqual({ events: [], startSeq: 0 });
  });

  it("cuts a turn that is too big for one page", async () => {
    turn(1, 1000);
    const client = collector();
    const { startSeq } = await hub.subscribe("fake:s1", 0, client.subscriber);
    const page = client.events.filter((event) => event.seq > startSeq);
    expect(page.length).toBe(600);
    // The turn was already running where the page starts: the client is told.
    expect(client.events.find((event) => event.seq <= startSeq && event.update.sessionUpdate === "ls_turn")).toBeTruthy();
  });

  it("lets a returning client catch up, unless it missed too much", async () => {
    for (let n = 1; n <= 5; n++) turn(n, 5);
    const at = store.getSession("fake:s1")!.lastSeq;
    turn(6, 5);
    const near = collector();
    expect((await hub.subscribe("fake:s1", at, near.subscriber)).startSeq).toBe(at);
    expect(near.windows).toEqual([]);
    expect(near.events[0]!.seq).toBe(at + 1);

    for (let n = 7; n <= 100; n++) turn(n, 10);
    const far = collector();
    const { startSeq } = await hub.subscribe("fake:s1", at, far.subscriber);
    expect(startSeq).toBeGreaterThan(at);
    expect(far.windows).toEqual([startSeq]);
  });

  it("keeps pictures out of what it sends, and serves them one by one", async () => {
    for (let n = 1; n <= 30; n++) turn(n, 10, true);
    const client = collector();
    const { startSeq } = await hub.subscribe("fake:s1", 0, client.subscriber);
    expect(startSeq).toBeGreaterThan(0);
    // 60 MB of screenshots are in the log; the page that is sent is a few KB.
    const sent = client.events.map((event) => slimEvent(event, { lazyImages: true }));
    expect(JSON.stringify(sent).length).toBeLessThan(200_000);
    const withPicture = sent.find((event) => event.update.sessionUpdate === "tool_call_update")!;
    const content = (withPicture.update as Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>).content!;
    expect(content[1]).toEqual({ type: "content", content: { type: "image", mimeType: "image/png", uri: `linkshell-event:${withPicture.seq}/0` } });
    const ref = parseImageUri(`linkshell-event:${withPicture.seq}/0`)!;
    expect(imageOf(hub.readEvent("fake:s1", ref.seq)!, ref.index)).toEqual({ mimeType: "image/png", data: PICTURE });
    // A client that can't load pictures gets a note in their place.
    const plain = slimEvent(client.events.find((event) => event.seq === withPicture.seq)!);
    expect((plain.update as typeof withPicture.update & { content: unknown[] }).content[1]).toEqual({ type: "content", content: { type: "text", text: "[图片]" } });
  });

  it("cuts very long text and leaves ordinary events untouched", () => {
    const long: SessionEvent = { sessionId: "s", seq: 7, ts: 1, update: { sessionUpdate: "tool_call_update", toolCallId: "t", rawOutput: { stdout: "x".repeat(300_000) } } };
    const slim = slimEvent(long);
    const stdout = ((slim.update as { rawOutput: { stdout: string } }).rawOutput).stdout;
    expect(stdout.length).toBeLessThan(25_000);
    expect(stdout).toContain("已省略");
    const small: SessionEvent = { sessionId: "s", seq: 8, ts: 1, update: { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "hi" } } };
    expect(slimEvent(small)).toBe(small);
  });

  it("loads audio and binary resource payloads losslessly without cutting their base64", () => {
    const data = Buffer.alloc(40_000, 7).toString("base64");
    const event: SessionEvent = { sessionId: "s", seq: 3, ts: 1, update: { sessionUpdate: "ls_message", role: "agent", messageId: "m", content: [
      { type: "audio", mimeType: "audio/wav", data, annotations: { audience: ["user"] } },
      { type: "resource", resource: { uri: "attachment:document.pdf", mimeType: "application/pdf", blob: data } },
    ] } };
    const sent = slimEvent(event, { lazyImages: true });
    expect(JSON.stringify(sent)).not.toContain(data.slice(0, 50));
    expect(sent.update).toMatchObject({ content: [{ type: "audio", uri: "linkshell-event:3/0", annotations: { audience: ["user"] } }, { type: "resource", resource: { uri: "attachment:document.pdf", assetUri: "linkshell-event:3/1" } }] });
    expect(imageOf(event, 0)).toEqual({ mimeType: "audio/wav", data });
    expect(imageOf(event, 1)).toEqual({ mimeType: "application/pdf", data });
  });

  it("treats the first native v2 user snapshot as a turn boundary, not its later replacements", () => {
    const text = (value: string) => ({ type: "text" as const, text: value });
    const first = store.appendEvent("fake:s1", { sessionUpdate: "ls_message", role: "user", messageId: "u1", content: [text("first")] });
    const reply = store.appendEvent("fake:s1", { sessionUpdate: "ls_message", role: "agent", messageId: "a1", content: [text("reply")] });
    store.appendEvent("fake:s1", { sessionUpdate: "ls_message", role: "user", messageId: "u1", content: [text("replaced")] });
    const second = store.appendEvent("fake:s1", { sessionUpdate: "ls_message", role: "user", messageId: "u2", content: [text("second")] });
    expect(store.turnEnd("fake:s1", first.seq)).toBe(second.seq - 1);
    expect(store.turnEnd("fake:s1", reply.seq)).toBe(second.seq - 1);
  });

  it("describes events logged by an older host, once", () => {
    for (let n = 1; n <= 3; n++) turn(n, 2);
    const expected = store.pageStart("fake:s1", store.getSession("fake:s1")!.lastSeq, { minEvents: 5, minBytes: 1e9, maxEvents: 100, maxBytes: 1e9, eventBytes: 1e9 });
    expect(expected).toBeGreaterThan(0);
    store.close();
    const raw = new DatabaseSync(join(dir, "state.db"));
    raw.exec("DELETE FROM event_meta; PRAGMA user_version = 0;");
    raw.close();
    store = new HostStore(join(dir, "state.db"));
    expect(store.pageStart("fake:s1", store.getSession("fake:s1")!.lastSeq, { minEvents: 5, minBytes: 1e9, maxEvents: 100, maxBytes: 1e9, eventBytes: 1e9 })).toBe(expected);
  });

  it("serves workflow agents and their nested conversations independently", () => {
    driver.emit({ sessionUpdate: "tool_call", toolCallId: "wf", title: "Research", kind: "other", status: "in_progress", detail: { type: "subagent", action: "spawn", workflow: { state: "running" } } });
    driver.emit({ sessionUpdate: "tool_call", toolCallId: "worker", parentToolCallId: "wf", title: "Read sources", kind: "other", status: "in_progress", detail: { type: "subagent", action: "spawn" } });
    driver.emit({ sessionUpdate: "agent_message_chunk", messageId: "m1", parentToolCallId: "worker", content: { type: "text", text: "Found a source" } });
    driver.emit({ sessionUpdate: "tool_call_update", toolCallId: "worker", parentToolCallId: "wf", status: "failed" });
    expect(hub.subagent("fake:s1", "worker").map((event) => event.update.sessionUpdate)).toEqual(["tool_call", "agent_message_chunk", "tool_call_update"]);
    expect(hub.subagent("fake:s1", "wf").map((event) => event.update.sessionUpdate)).toEqual(["tool_call", "tool_call", "agent_message_chunk", "tool_call_update"]);
    expect(hub.subagents("fake:s1").find((agent) => agent.toolCallId === "worker")).toMatchObject({ running: false, failed: true });
  });

  it("lists a session's sub-agents and serves each one's conversation, wherever in the history they are", async () => {
    const spawn = (id: string, task: string) =>
      driver.emit({ sessionUpdate: "tool_call", toolCallId: id, title: `Agent: ${task}`, kind: "other", status: "in_progress", detail: { type: "subagent", action: "spawn", task, agentType: "Explore" } });
    const under = (id: string, update: SessionUpdate) => driver.emit({ ...update, parentToolCallId: id } as SessionUpdate);
    driver.emit({ sessionUpdate: "user_message_chunk", messageId: "u0", content: { type: "text", text: "look around" } });
    driver.emit({ sessionUpdate: "ls_turn", state: "started" });
    spawn("task-a", "map the api");
    under("task-a", { sessionUpdate: "ls_turn", state: "started" });
    under("task-a", { sessionUpdate: "agent_message_chunk", messageId: "sa1", content: { type: "text", text: "reading routes" } });
    spawn("task-b", "check the tests");
    under("task-b", { sessionUpdate: "agent_message_chunk", messageId: "sb1", content: { type: "text", text: "found 3" } });
    driver.emit({ sessionUpdate: "tool_call_update", toolCallId: "task-b", status: "completed" });
    // A background agent: its call returns at once, its turn goes on.
    driver.emit({ sessionUpdate: "tool_call_update", toolCallId: "task-a", status: "completed" });
    driver.emit({ sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
    // Many turns later the calls are far outside the first page.
    for (let n = 1; n <= 40; n++) turn(n, 10);

    const client = collector();
    const { startSeq, session } = await hub.subscribe("fake:s1", 0, client.subscriber);
    expect(startSeq).toBeGreaterThan(20);
    expect(session.subagents).toEqual({ total: 2, running: 1 });
    // The one still working comes with the window, so its next output has a card to go under.
    expect(client.events.filter((event) => event.seq <= startSeq && event.update.sessionUpdate === "tool_call").map((event) => (event.update as { toolCallId: string }).toolCallId)).toEqual(["task-a"]);
    expect(hub.subagents("fake:s1")).toMatchObject([
      { toolCallId: "task-b", task: "check the tests", agentType: "Explore", running: false },
      { toolCallId: "task-a", task: "map the api", running: true },
    ]);
    expect(hub.subagents("fake:s1")[0]!.endedAt).toBeGreaterThan(0);
    const conversation = hub.subagent("fake:s1", "task-a");
    expect(kinds(conversation)).toEqual(["tool_call", "ls_turn", "agent_message_chunk", "tool_call_update"]);
    expect(conversation.every((event) => event.seq <= startSeq)).toBe(true);
    expect(() => hub.subagent("fake:s1", "nope")).toThrow();

    // It finishes: the tally everyone sees follows.
    under("task-a", { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
    expect(hub.getSession("fake:s1").subagents).toEqual({ total: 2, running: 0 });
    spawn("task-c", "one more");
    expect(hub.getSession("fake:s1").subagents).toEqual({ total: 3, running: 1 });

    // The same answers from a log written before these were indexed.
    store.close();
    const raw = new DatabaseSync(join(dir, "state.db"));
    raw.exec("DELETE FROM event_meta; PRAGMA user_version = 0;");
    raw.close();
    store = new HostStore(join(dir, "state.db"));
    hub = new SessionHub(store, [driver]);
    await hub.start();
    expect(hub.subagents("fake:s1").map((agent) => [agent.toolCallId, agent.running])).toEqual([["task-c", true], ["task-b", false], ["task-a", false]]);
  });
});
