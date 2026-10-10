import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "@linkshell/wire";
import type { ContentBlock, SessionEvent, SessionSummary, SessionUpdate } from "@linkshell/wire";
import type { AgentDriver, DiscoveredSession, DriverHost, HistoryItem } from "../src/drivers/types.js";
import { SessionHub } from "../src/hub.js";
import { HostStore } from "../src/store.js";

class FakeDriver implements AgentDriver {
  readonly id = "fake";
  readonly label = "Fake";
  tier: "multi_client" | "handoff" = "multi_client";
  readonly capabilities = { interrupt: true, steer: false, permissions: true, images: false, fork: false, models: false, modes: false };
  host!: DriverHost;
  history: HistoryItem[] = [];
  attachGate?: Promise<void>;
  attachCalls = 0;
  prompts: { nativeId: string; content: ContentBlock[]; clientMessageId: string }[] = [];
  answers: { requestId: string; optionId: string }[] = [];
  sessions: DiscoveredSession[] = [{ nativeId: "s1", cwd: "/w/app", createdAt: 1, updatedAt: 1 }];
  archives: string[] = [];

  async start(host: DriverHost) {
    this.host = host;
    return { installed: true, version: "1.0" };
  }
  async stop() {}
  status() {
    return { installed: true, version: "1.0" };
  }
  async listSessions() {
    return this.sessions;
  }
  async archivedSessions() { return this.archives; }
  async createSession(options: { cwd: string }) {
    return { nativeId: "new", cwd: options.cwd, createdAt: 2, updatedAt: 2 };
  }
  async attach() {
    this.attachCalls += 1;
    await this.attachGate;
    return this.history;
  }
  async detach() {}
  async prompt(nativeId: string, content: ContentBlock[], clientMessageId: string) {
    this.prompts.push({ nativeId, content, clientMessageId });
    return "started" as const;
  }
  cancels = 0;
  async cancel() {
    this.cancels += 1;
  }
  async respondPermission(_nativeId: string, requestId: string, optionId: string) {
    this.answers.push({ requestId, optionId });
  }
  watches: boolean[] = [];
  watched(_nativeId: string, open: boolean) {
    this.watches.push(open);
  }
  emit(update: SessionUpdate, itemId?: string, nativeId = "s1") {
    this.host.update(this.id, nativeId, update, itemId);
  }
}

const text = (t: string): ContentBlock => ({ type: "text", text: t });
const chunk = (messageId: string, t: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk", messageId, content: text(t) });

let dir: string;
let store: HostStore;
let driver: FakeDriver;
let hub: SessionHub;
let summaries: SessionSummary[];

function collector() {
  const events: SessionEvent[] = [];
  return { events, subscriber: { event: (e: SessionEvent) => events.push(e) } };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lsh-hub-"));
  store = new HostStore(join(dir, "state.db"));
  driver = new FakeDriver();
  hub = new SessionHub(store, [driver]);
  summaries = [];
  hub.onSummary((s) => summaries.push(s));
  await hub.start();
});

afterEach(async () => {
  await hub.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SessionHub", () => {
  it("reconciles native archives omitted from discovery without deleting history or hiding older active sessions", async () => {
    driver.history = [{ itemId: "m0", updates: [chunk("m0", "still readable")] }];
    await hub.subscribe("fake:s1", 0, collector().subscriber);
    store.patchSession("fake:s1", { state: "running", title: "Native title" });
    await hub.rename("fake:s1", "Local title");
    driver.sessions = [{ nativeId: "s2", cwd: "/w/app", createdAt: 2, updatedAt: 2 }];
    driver.archives = ["s1", "unknown"];
    await hub.refreshDiscovery();
    expect(hub.listSessions({}).sessions.map((s) => s.id)).toEqual(["fake:s2"]);
    expect(hub.getSession("fake:s1")).toMatchObject({ archived: true, state: "idle", updatedAt: 1 });
    expect(store.readEvents("fake:s1", 0, 10).some((event) => event.update.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(store.getSession("fake:unknown")).toBeUndefined();
    expect(summaries.at(-1)).toMatchObject({ id: "fake:s1", archived: true });
    await hub.rename("fake:s1", "");
    expect(hub.getSession("fake:s1").title).toBe("Native title");

    driver.sessions = [{ nativeId: "s1", cwd: "/w/app", createdAt: 1, updatedAt: 1, state: "idle", archived: false }];
    driver.archives = [];
    await hub.refreshDiscovery();
    expect(hub.listSessions({}).sessions.map((s) => s.id)).toEqual(["fake:s2", "fake:s1"]);
  });

  it("reconciles archives when restarting with a cached running session", async () => {
    await hub.stop();
    store.patchSession("fake:s1", { state: "running" });
    driver.sessions = [];
    driver.archives = ["s1"];
    hub = new SessionHub(store, [driver]);
    await hub.start({ discoveryIntervalMs: 0 });
    expect(hub.listSessions({}).sessions).toEqual([]);
    expect(hub.getSession("fake:s1")).toMatchObject({ archived: true, state: "idle" });
  });

  it("shows a history load failure and still serves cached messages; reopening retries", async () => {
    store.appendEvent("fake:s1", chunk("cached", "cached reply"), 1);
    const attach = vi.spyOn(driver, "attach").mockRejectedValueOnce(new Error("unreadable history"));
    const got = collector();
    const failed = await hub.subscribe("fake:s1", 0, got.subscriber);
    expect(got.events.map((event) => event.update)).toEqual([
      chunk("cached", "cached reply"),
      { sessionUpdate: "ls_status", state: "error" },
      expect.objectContaining({ sessionUpdate: "ls_error", code: "history_unavailable", message: "读取会话消息失败：unreadable history" }),
    ]);
    expect(failed.session.state).toBe("error");
    expect(failed.session.updatedAt).toBe(1);
    hub.unsubscribe("fake:s1", got.subscriber);
    driver.history = [{ itemId: "restored", updates: [chunk("restored", "restored reply")] }];
    const retry = collector();
    await hub.subscribe("fake:s1", failed.session.lastSeq, retry.subscriber);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(retry.events.map((event) => event.update)).toContainEqual(chunk("restored", "restored reply"));
  });

  it("does not report a fresh session without messages as a load failure", async () => {
    vi.spyOn(driver, "attach").mockRejectedValueOnce(RpcError.app("not_ready", "no messages yet"));
    const got = collector();
    await hub.subscribe("fake:s1", 0, got.subscriber);
    expect(got.events).toEqual([]);
  });

  it("keeps durable task status and output independent of turn completion and rejects broad cancellation", async () => {
    await hub.subscribe("fake:s1", 0, collector().subscriber);
    const task = { id: "b1", toolCallId: "c1", title: "build", kind: "shell" as const, startedAt: 1, state: "running" as const };
    driver.emit({ sessionUpdate: "ls_task", task });
    driver.emit({ sessionUpdate: "tool_call", toolCallId: "c1", title: "build", kind: "execute", status: "in_progress" });
    driver.emit({ sessionUpdate: "tool_call_update", toolCallId: "c1", appendOutput: "before\n" });
    driver.emit({ sessionUpdate: "ls_turn", state: "ended" });
    driver.emit({ sessionUpdate: "tool_call_update", toolCallId: "c1", appendOutput: "after 世界\n" });
    expect(hub.getSession("fake:s1").tasks).toEqual({ total: 1, running: 1 });
    expect(hub.taskOutput("fake:s1", "b1").text).toBe("before\nafter 世界\n");
    await expect(hub.stopTask("fake:s1", "b1")).rejects.toThrow("不能在手机上停止");
    expect(driver.cancels).toBe(0);
    driver.emit({ sessionUpdate: "ls_task", task: { ...task, state: "failed", exitCode: 3 } });
    const restored = new SessionHub(store, [driver]);
    expect(restored.tasks("fake:s1")[0]).toMatchObject({ id: "b1", state: "failed", exitCode: 3 });
    expect(hub.getSession("fake:s1").tasks).toEqual({ total: 1, running: 0 });
    expect(hub.tasks("fake:s1")[0]!.lastSeq).toBeGreaterThan(1);
  });
  it("discovers sessions on start", () => {
    expect(hub.listSessions({}).sessions.map((s) => s.id)).toEqual(["fake:s1"]);
  });

  it("offers a session still driven at the desk the commands its agent named elsewhere", async () => {
    driver.tier = "handoff";
    driver.sessions = [
      { nativeId: "s1", cwd: "/w/app", createdAt: 1, updatedAt: 1 },
      { nativeId: "s2", cwd: "/w/app", createdAt: 1, updatedAt: 2 },
      { nativeId: "s3", cwd: "/w/other", createdAt: 1, updatedAt: 3 },
      { nativeId: "s4", cwd: "/w/elsewhere", createdAt: 1, updatedAt: 4 },
    ];
    await hub.refreshDiscovery();
    const names = (events: SessionEvent[]) =>
      events.flatMap((e) => (e.update.sessionUpdate === "available_commands_update" ? [e.update.availableCommands.map((c) => c.name)] : []));
    const commands = (...list: string[]): SessionUpdate => ({
      sessionUpdate: "available_commands_update",
      availableCommands: list.map((name) => ({ name, description: "" })),
    });

    // Nothing known yet: nothing to offer.
    const none = collector();
    await hub.subscribe("fake:s4", 0, none.subscriber);
    expect(names(none.events)).toEqual([]);

    // The agent ran here for s2 and s3 and said what it can do there.
    await hub.subscribe("fake:s2", 0, collector().subscriber);
    await hub.subscribe("fake:s3", 0, collector().subscriber);
    driver.emit(commands("compact", "app-skill"), undefined, "s2");
    driver.emit(commands("compact", "other-skill"), undefined, "s3");

    // Same folder first; any other of the agent's sessions otherwise. It doesn't count as activity.
    const same = collector();
    await hub.subscribe("fake:s1", 0, same.subscriber);
    expect(names(same.events)).toEqual([["compact", "app-skill"]]);
    expect(hub.getSession("fake:s1").updatedAt).toBe(1);
    const any = collector();
    hub.unsubscribe("fake:s4", none.subscriber);
    await hub.subscribe("fake:s4", 0, any.subscriber);
    expect(names(any.events)).toHaveLength(1);

    // Its own list, once it has one, is the one that counts — and nothing more is borrowed.
    driver.emit(commands("compact", "mine"), undefined, "s1");
    const again = collector();
    await hub.subscribe("fake:s1", 0, again.subscriber);
    expect(names(again.events)).toEqual([["compact", "app-skill"], ["compact", "mine"]]);
  });

  it("keeps the times of imported history when the agent only says when the session last changed", async () => {
    // Discovered with one time for both (ACP agents, Claude): created "now", but its messages are from before.
    driver.sessions = [{ nativeId: "s1", cwd: "/w/app", createdAt: 5000, updatedAt: 5000 }];
    await hub.refreshDiscovery();
    driver.history = [
      { itemId: "m0", ts: 1000, updates: [chunk("m0", "first")] },
      { itemId: "m1", updates: [chunk("m1", "no time of its own")] },
      { itemId: "m2", ts: 3000, updates: [chunk("m2", "later")] },
      { itemId: "m3", ts: 9000, updates: [chunk("m3", "never after its last change")] },
    ];
    const got = collector();
    await hub.subscribe("fake:s1", 0, got.subscriber);
    expect(got.events.map((e) => e.ts)).toEqual([1000, 1000, 3000, 5000]);
  });

  it("imports history on first subscribe, then streams live events with no gap", async () => {
    driver.history = [{ itemId: "m0", updates: [chunk("m0", "old"), { sessionUpdate: "ls_message_done", messageId: "m0", role: "agent" }] }];
    const first = collector();
    await hub.subscribe("fake:s1", 0, first.subscriber);
    driver.emit(chunk("m1", "new"));
    expect(first.events.map((e) => e.seq)).toEqual([1, 2, 3]);

    // A second client that already has seq 2 gets exactly the rest, then live.
    const second = collector();
    await hub.subscribe("fake:s1", 2, second.subscriber);
    driver.emit(chunk("m1", "er"));
    expect(second.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(first.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(driver.attachCalls).toBe(1);
  });

  it("tells the driver when the first device opens a session and when the last one leaves", async () => {
    const first = collector();
    const second = collector();
    await hub.subscribe("fake:s1", 0, first.subscriber);
    await hub.subscribe("fake:s1", 0, second.subscriber);
    expect(driver.watches).toEqual([true]);
    hub.unsubscribe("fake:s1", first.subscriber);
    expect(driver.watches).toEqual([true]);
    hub.unsubscribe("fake:s1", second.subscriber);
    // (Leaving twice is leaving once.)
    hub.unsubscribe("fake:s1", second.subscriber);
    expect(driver.watches).toEqual([true, false]);
  });

  it("buffers live updates during attach and drops completions the history already has", async () => {
    let release!: () => void;
    driver.attachGate = new Promise((resolve) => (release = resolve));
    driver.history = [{ itemId: "u1", updates: [{ sessionUpdate: "user_message_chunk", messageId: "u1", content: text("hi") }] }];
    const { events, subscriber } = collector();
    const subscribing = hub.subscribe("fake:s1", 0, subscriber);
    // Arrives while history is still loading: the same user message (already in history) and a new chunk.
    driver.emit({ sessionUpdate: "user_message_chunk", messageId: "u1", content: text("hi") }, "u1");
    driver.emit(chunk("m1", "hello"));
    release();
    await subscribing;
    expect(events.map((e) => e.update.sessionUpdate)).toEqual(["user_message_chunk", "agent_message_chunk"]);
  });

  it("re-attach after a disconnect only appends items it has not logged", async () => {
    driver.history = [{ itemId: "m0", updates: [chunk("m0", "old")] }];
    await hub.subscribe("fake:s1", 0, collector().subscriber);
    driver.host.detached("fake", "s1");
    driver.history = [
      { itemId: "m0", updates: [chunk("m0", "old")] },
      { itemId: "m1", updates: [chunk("m1", "made while we were away")] },
    ];
    const late = collector();
    await hub.subscribe("fake:s1", 1, late.subscriber);
    expect(driver.attachCalls).toBe(2);
    expect(late.events.map((e) => (e.update as { messageId?: string }).messageId)).toEqual(["m1"]);
  });

  it("titles from the first user message and previews the last agent reply", async () => {
    await hub.subscribe("fake:s1", 0, collector().subscriber);
    driver.emit({ sessionUpdate: "user_message_chunk", messageId: "u1", content: text("Fix the flaky login test") }, "u1");
    driver.emit(chunk("m1", "Found it: "));
    driver.emit(chunk("m1", "a race in auth.ts"));
    const before = summaries.length;
    driver.emit({ sessionUpdate: "ls_message_done", messageId: "m1", role: "agent" }, "m1");
    const summary = hub.getSession("fake:s1");
    expect(summary.title).toBe("Fix the flaky login test");
    expect(summary.preview).toBe("Found it: a race in auth.ts");
    expect(summaries.length).toBe(before + 1);
  });

  it("does not deliver the same client message twice", async () => {
    expect(await hub.prompt("fake:s1", "c-1", [text("go")])).toBe("started");
    expect(await hub.prompt("fake:s1", "c-1", [text("go")])).toBe("duplicate");
    expect(driver.prompts).toHaveLength(1);
  });

  it("tracks permission requests, routes answers and clears leftovers when the turn ends", async () => {
    await hub.subscribe("fake:s1", 0, collector().subscriber);
    const options = [
      { optionId: "accept", name: "Allow", kind: "allow_once" as const },
      { optionId: "decline", name: "Decline", kind: "reject_once" as const },
    ];
    driver.emit({ sessionUpdate: "ls_turn", state: "started", turnId: "t1" });
    driver.emit({ sessionUpdate: "ls_permission", requestId: "r1", title: "Run", options });
    driver.emit({ sessionUpdate: "ls_permission", requestId: "r2", title: "Run", options });
    expect(hub.getSession("fake:s1")).toMatchObject({ pendingPermissions: 2, state: "waiting" });

    await expect(hub.respondPermission("fake:s1", "r1", "nope")).rejects.toMatchObject({ appCode: "invalid_params" });
    await hub.respondPermission("fake:s1", "r1", "accept");
    expect(driver.answers).toEqual([{ requestId: "r1", optionId: "accept" }]);
    driver.emit({ sessionUpdate: "ls_permission_resolved", requestId: "r1", optionId: "accept" });
    driver.emit({ sessionUpdate: "ls_permission_resolved", requestId: "r1" }); // duplicate: ignored
    expect(hub.getSession("fake:s1").pendingPermissions).toBe(1);

    driver.emit({ sessionUpdate: "ls_turn", state: "ended", turnId: "t1", stopReason: "cancelled" });
    expect(hub.getSession("fake:s1")).toMatchObject({ pendingPermissions: 0, state: "idle" });
    const kinds = store.readEvents("fake:s1", 0).map((e) => e.update.sessionUpdate);
    expect(kinds.filter((k) => k === "ls_permission_resolved")).toHaveLength(2);
    await expect(hub.respondPermission("fake:s1", "r2", "accept")).rejects.toMatchObject({ appCode: "not_found" });
  });

  it("shows the live activity and the oldest pending permission in summaries", async () => {
    await hub.subscribe("fake:s1", 0, collector().subscriber);
    const options = [{ optionId: "accept", name: "Allow", kind: "allow_once" as const }];
    driver.emit({ sessionUpdate: "ls_turn", state: "started", turnId: "t1" });
    expect(hub.getSession("fake:s1").activity).toEqual({ kind: "thinking" });
    driver.emit({ sessionUpdate: "tool_call", toolCallId: "c1", title: "npm test", kind: "execute", status: "in_progress" });
    expect(summaries.at(-1)?.activity).toEqual({ kind: "tool", title: "npm test", toolKind: "execute" });

    // Streaming text announces the change once, not once per chunk.
    const before = summaries.length;
    driver.emit(chunk("m1", "a"));
    driver.emit(chunk("m1", "b"));
    expect(summaries.length).toBe(before + 1);
    expect(hub.listSessions({}).sessions[0]?.activity).toEqual({ kind: "responding" });

    driver.emit({ sessionUpdate: "ls_permission", requestId: "r1", title: "Run rm", detail: "rm -rf build", options });
    driver.emit({ sessionUpdate: "ls_permission", requestId: "r2", title: "Run ls", options });
    expect(hub.getSession("fake:s1").permission).toMatchObject({ requestId: "r1", title: "Run rm", detail: "rm -rf build" });
    driver.emit({ sessionUpdate: "ls_permission_resolved", requestId: "r1", optionId: "accept" });
    expect(summaries.at(-1)?.permission?.requestId).toBe("r2");

    driver.emit({ sessionUpdate: "ls_turn", state: "ended", turnId: "t1", stopReason: "end_turn" });
    const done = hub.getSession("fake:s1");
    expect(done.activity).toBeUndefined();
    expect(done.permission).toBeUndefined();
    expect(summaries.at(-1)).not.toHaveProperty("activity");
  });

  it("imports history quietly: one summary, no live activity", async () => {
    driver.history = [
      { itemId: "u1", updates: [{ sessionUpdate: "user_message_chunk", messageId: "u1", content: text("run tests") }] },
      { itemId: "t", updates: [{ sessionUpdate: "ls_turn", state: "started", turnId: "t" }] },
      { itemId: "c1", updates: [{ sessionUpdate: "tool_call", toolCallId: "c1", title: "npm test", kind: "execute", status: "completed" }] },
      { itemId: "c2", updates: [{ sessionUpdate: "tool_call", toolCallId: "c2", title: "npm run lint", kind: "execute", status: "completed" }] },
      { itemId: "m1", updates: [chunk("m1", "all green"), { sessionUpdate: "ls_message_done", messageId: "m1", role: "agent" }] },
    ];
    const before = summaries.length;
    await hub.subscribe("fake:s1", 0, collector().subscriber);
    expect(summaries.length - before).toBe(1);
    const session = hub.getSession("fake:s1");
    expect(session).toMatchObject({ title: "run tests", preview: "all green", state: "idle" });
    expect(session.activity).toBeUndefined();
    expect(session.updatedAt).toBe(1);
  });

  describe("messages sent while a turn runs", () => {
    const queued = () => hub.getSession("fake:s1").queue?.map((entry) => entry.text) ?? [];
    const sent = () => driver.prompts.map((prompt) => (prompt.content[0] as { text: string }).text);
    const turn = (state: "started" | "ended") =>
      driver.emit(state === "started" ? { sessionUpdate: "ls_turn", state } : { sessionUpdate: "ls_turn", state, stopReason: "end_turn" });
    const send = (id: string, message: string) => hub.prompt("fake:s1", id, [text(message)], "queue");

    beforeEach(async () => {
      await hub.subscribe("fake:s1", 0, collector().subscriber);
    });

    it("wait in a queue everyone sees, and go out one per turn, in order", async () => {
      expect(await send("a", "first")).toBe("started");
      turn("started");
      expect(await send("b", "second")).toBe("queued");
      expect(await send("c", "third")).toBe("queued");
      expect(queued()).toEqual(["second", "third"]);
      expect(summaries.at(-1)?.queue?.map((entry) => entry.clientMessageId)).toEqual(["b", "c"]);
      expect(sent()).toEqual(["first"]);
      // A sub-agent finishing is not the turn ending.
      driver.emit({ sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn", parentToolCallId: "task" });
      expect(sent()).toEqual(["first"]);

      turn("ended");
      await Promise.resolve();
      expect(sent()).toEqual(["first", "second"]);
      expect(queued()).toEqual(["third"]);
      // While anything waits, a new message joins the queue rather than jumping it.
      turn("started");
      expect(await send("d", "fourth")).toBe("queued");
      turn("ended");
      await Promise.resolve();
      turn("started");
      turn("ended");
      await Promise.resolve();
      expect(sent()).toEqual(["first", "second", "third", "fourth"]);
      expect(queued()).toEqual([]);
      expect(summaries.at(-1)?.queue).toBeUndefined();
    });

    it("can be reordered and taken back", async () => {
      turn("started");
      await send("a", "one");
      await send("b", "two");
      await send("c", "three");
      hub.reorderQueue("fake:s1", ["c", "a"]);
      expect(queued()).toEqual(["three", "one", "two"]);
      expect(hub.unqueue("fake:s1", "a")).toBe(true);
      expect(hub.unqueue("fake:s1", "a")).toBe(false);
      expect(queued()).toEqual(["three", "two"]);
      // Taken back, it can be sent again (edited) under the same id.
      expect(await send("a", "one, reworded")).toBe("queued");
      expect(queued()).toEqual(["three", "two", "one, reworded"]);
    });

    it("can be sent at once: the running turn is stopped and the chosen message is next", async () => {
      turn("started");
      await send("a", "one");
      await send("b", "two");
      await hub.sendQueuedNow("fake:s1", "b");
      expect(driver.cancels).toBe(1);
      expect(queued()).toEqual(["two", "one"]);
      expect(sent()).toEqual([]);
      driver.emit({ sessionUpdate: "ls_turn", state: "ended", stopReason: "cancelled" });
      await Promise.resolve();
      expect(sent()).toEqual(["two"]);
      expect(queued()).toEqual(["one"]);
    });

    it("goes straight into the running turn when the agent takes input mid-turn", async () => {
      (driver.capabilities as { steer: boolean }).steer = true;
      turn("started");
      await send("a", "one");
      await send("b", "two");
      await hub.sendQueuedNow("fake:s1");
      expect(driver.cancels).toBe(0);
      expect(sent()).toEqual(["one"]);
      expect(queued()).toEqual(["two"]);
    });

    it("are dropped by stop", async () => {
      turn("started");
      await send("a", "one");
      await hub.cancel("fake:s1");
      expect(queued()).toEqual([]);
      turn("ended");
      await Promise.resolve();
      expect(sent()).toEqual([]);
    });

    it("go out as before when the client doesn't ask to queue", async () => {
      turn("started");
      expect(await hub.prompt("fake:s1", "a", [text("now")])).toBe("started");
      expect(sent()).toEqual(["now"]);
    });
  });

  it("creates a session, attaches it and sends the first prompt", async () => {
    const summary = await hub.createSession({ agent: "fake", cwd: "/w/other", prompt: [text("start")], clientMessageId: "c-9" });
    expect(summary).toMatchObject({ id: "fake:new", cwd: "/w/other" });
    expect(driver.prompts).toEqual([{ nativeId: "new", content: [text("start")], clientMessageId: "c-9" }]);
    await expect(hub.createSession({ agent: "missing", cwd: "/" })).rejects.toMatchObject({ appCode: "not_found" });
  });
});

describe("SessionHub discovery refresh", () => {
  it("deletes a session the agent no longer has", async () => {
    (driver as unknown as { delete: () => Promise<void> }).delete = async () => {
      throw new Error("no rollout found for thread id s1");
    };
    await hub.delete("fake:s1");
    expect(hub.listSessions({}).sessions).toEqual([]);
  });

  it("keeps a session where it was in the list when it is only opened", async () => {
    const before = hub.getSession("fake:s1").updatedAt;
    await hub.subscribe("fake:s1", 0, collector().subscriber);
    // What an agent says about a session whenever one is opened: its state, who drives it, its settings.
    driver.emit({ sessionUpdate: "ls_status", state: "idle" });
    driver.emit({ sessionUpdate: "ls_driver", driver: "none" });
    driver.emit({ sessionUpdate: "ls_config", options: [] });
    expect(hub.getSession("fake:s1")).toMatchObject({ updatedAt: before, state: "idle" });
    // A turn starting is activity.
    driver.emit({ sessionUpdate: "ls_turn", state: "started" });
    expect(hub.getSession("fake:s1").updatedAt).toBeGreaterThan(before);
  });

  it("keeps a renamed session where it was in the list", async () => {
    const before = hub.getSession("fake:s1").updatedAt;
    expect((await hub.rename("fake:s1", "A better name")).title).toBe("A better name");
    // The agent recording the name touches its own files, and may report the new title itself.
    driver.sessions = [{ nativeId: "s1", cwd: "/w/app", createdAt: 1, updatedAt: Date.now(), title: "A better name" }];
    await hub.refreshDiscovery();
    await hub.subscribe("fake:s1", 0, collector().subscriber);
    driver.emit({ sessionUpdate: "session_info_update", title: "A better name" });
    expect(hub.getSession("fake:s1").updatedAt).toBe(before);
    // Real activity afterwards moves it as usual.
    driver.emit(chunk("m9", "working"));
    expect(hub.getSession("fake:s1").updatedAt).toBeGreaterThan(before);
  });

  it("picks up sessions started outside LinkShell and only announces real changes", async () => {
    const before = summaries.length;
    await hub.refreshDiscovery();
    expect(summaries.length).toBe(before); // nothing new
    driver.sessions = [
      ...driver.sessions,
      { nativeId: "s2", cwd: "/w/other", title: "Made in a plain terminal", createdAt: 5, updatedAt: 5 },
    ];
    await hub.refreshDiscovery();
    expect(summaries.slice(before).map((s) => s.id)).toEqual(["fake:s2"]);
    expect(hub.getSession("fake:s2").title).toBe("Made in a plain terminal");
  });
});
