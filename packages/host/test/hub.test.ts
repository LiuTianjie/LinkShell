import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentBlock, SessionEvent, SessionSummary, SessionUpdate } from "@linkshell/wire";
import type { AgentDriver, DiscoveredSession, DriverHost, HistoryItem } from "../src/drivers/types.js";
import { SessionHub } from "../src/hub.js";
import { HostStore } from "../src/store.js";

class FakeDriver implements AgentDriver {
  readonly id = "fake";
  readonly label = "Fake";
  readonly tier = "multi_client" as const;
  readonly capabilities = { interrupt: true, steer: false, permissions: true, images: false, fork: false, models: false, modes: false };
  host!: DriverHost;
  history: HistoryItem[] = [];
  attachGate?: Promise<void>;
  attachCalls = 0;
  prompts: { nativeId: string; content: ContentBlock[]; clientMessageId: string }[] = [];
  answers: { requestId: string; optionId: string }[] = [];
  sessions: DiscoveredSession[] = [{ nativeId: "s1", cwd: "/w/app", createdAt: 1, updatedAt: 1 }];

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
  async cancel() {}
  async respondPermission(_nativeId: string, requestId: string, optionId: string) {
    this.answers.push({ requestId, optionId });
  }
  emit(update: SessionUpdate, itemId?: string) {
    this.host.update(this.id, "s1", update, itemId);
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

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SessionHub", () => {
  it("discovers sessions on start", () => {
    expect(hub.listSessions({}).sessions.map((s) => s.id)).toEqual(["fake:s1"]);
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

  it("creates a session, attaches it and sends the first prompt", async () => {
    const summary = await hub.createSession({ agent: "fake", cwd: "/w/other", prompt: [text("start")], clientMessageId: "c-9" });
    expect(summary).toMatchObject({ id: "fake:new", cwd: "/w/other" });
    expect(driver.prompts).toEqual([{ nativeId: "new", content: [text("start")], clientMessageId: "c-9" }]);
    await expect(hub.createSession({ agent: "missing", cwd: "/" })).rejects.toMatchObject({ appCode: "not_found" });
  });
});

describe("SessionHub discovery refresh", () => {
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
