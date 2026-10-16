import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary, TerminalInfo } from "@linkshell/wire";
import { LiveActivityRelay } from "../src/live-activities.js";
import type { Subscriber } from "../src/hub.js";

const roots: string[] = [], relays: LiveActivityRelay[] = [];
afterEach(() => { relays.splice(0).forEach((relay) => relay.stop()); roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); vi.restoreAllMocks(); });
const first: SessionSummary = { id: "task-1", nativeId: "native-1", agent: "codex", cwd: "/test", state: "running", title: "Codex 正在检查", archived: false, createdAt: 1, updatedAt: 2, lastSeq: 1, pendingPermissions: 0 };

function setup() {
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  const directory = mkdtempSync(join(tmpdir(), "linkshell-live-activity-test-")); roots.push(directory);
  const path = join(directory, "live-activities.json");
  let sessions = [first];
  const subscribers = new Map<string, Set<Subscriber>>();
  const listeners = new Set<(summary: SessionSummary) => void>();
  let terminals: TerminalInfo[] = [];
  const terminalListeners = new Set<(terminal: TerminalInfo, closed: boolean) => void>();
  const hub = {
    listSessions: () => ({ sessions }),
    async subscribe(id: string, _seq: number, subscriber: Subscriber) { const set = subscribers.get(id) ?? new Set<Subscriber>(); set.add(subscriber); subscribers.set(id, set); return { session: sessions.find((item) => item.id === id)!, startSeq: 0 }; },
    unsubscribe(id: string, subscriber: Subscriber) { subscribers.get(id)?.delete(subscriber); },
    onSummary(listener: (summary: SessionSummary) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  const options = { path, hub, terminals: {
    list: () => terminals,
    onChange(listener: (terminal: TerminalInfo, closed: boolean) => void) { terminalListeners.add(listener); return () => { terminalListeners.delete(listener); }; },
  }, computerName: () => "Mac", request, log: vi.fn() };
  const create = () => { const relay = new LiveActivityRelay(options); relays.push(relay); relay.start(); return relay; };
  const relay = create();
  const subscription = { activityId: "activity-1", computerKey: "computer-1", serviceUrl: "https://push.itool.tech", grant: "a".repeat(64), expiresAt: now + 60_000 };
  const body = () => JSON.parse(String(request.mock.calls.at(-1)![1]!.body));
  return { relay, hub, create, subscribers, subscription, request, body, path, advance: (ms: number) => { now += ms; },
    setSessions: (next: SessionSummary[]) => { sessions = next; for (const listener of listeners) for (const session of next) listener(session); },
    setTerminal: (terminal: TerminalInfo, closed = false) => {
      terminals = [...terminals.filter((item) => item.id !== terminal.id), ...(closed ? [] : [terminal])];
      for (const listener of terminalListeners) listener(terminal, closed);
    },
  };
}

describe("Host-owned Live Activity updates", () => {
  it.each(["codex", "claude", "gemini", "antigravity", "copilot", "grok", "opencode", "cursor", "custom-acp"])("delivers %s transitions through the same relay contract", async (agent) => {
    const s = setup();
    const task = { ...first, agent };
    s.setSessions([task]); s.relay.subscribe(s.subscription); await s.relay.flush();
    expect(s.body().contentState).toMatchObject({ agent, phase: "running" });
    for (const [state, phase] of [["waiting", "waiting_for_approval"], ["error", "failed"], ["idle", "completed"]] as const) {
      // Restore a running turn before each independently observable transition.
      s.setSessions([task]); await s.relay.flush();
      s.setSessions([{ ...task, state }]); await s.relay.flush();
      expect(s.body().notice.task).toMatchObject({ id: task.id, agent, phase });
      expect(s.body().contentState.deepLink).toContain("computer=computer-1&session=task-1");
    }
    expect(s.body().event).toBe("end");
  });

  it("keeps observing after the phone disconnects and switches all content to the newest agent", async () => {
    const s = setup();
    const phone: Subscriber = { event() {} }; await s.hub.subscribe(first.id, 0, phone);
    s.relay.subscribe(s.subscription); await s.relay.flush();
    s.hub.unsubscribe(first.id, phone);
    expect(s.subscribers.get(first.id)?.size).toBe(1);
    s.setSessions([first, { ...first, id: "task-2", nativeId: "native-2", agent: "claude", title: "Claude 有了新进展", updatedAt: 3 }]);
    await s.relay.flush();
    expect(s.body().contentState).toMatchObject({ agents: ["claude", "codex"], title: "Claude 有了新进展", agent: "claude" });
    expect(s.body().contentState.deepLink).toContain("computer=computer-1&session=task-2");
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
  });

  it("restores registrations across host restarts and sends end when all work finishes", async () => {
    const s = setup(); s.relay.subscribe(s.subscription); await s.relay.flush();
    const before = s.body().sequence; s.relay.stop();
    const restarted = s.create(); await restarted.flush();
    expect(s.body().sequence).toBeGreaterThan(before);
    s.setSessions([]); await restarted.flush();
    expect(s.body().event).toBe("end");
    expect(JSON.parse(readFileSync(s.path, "utf8"))).toEqual([]);
    expect(s.subscribers.get(first.id)?.size).toBe(0);
  });

  it("retries only the latest snapshot after an uncertain response", async () => {
    const s = setup(); s.request.mockRejectedValueOnce(new Error("timeout"));
    s.relay.subscribe(s.subscription); await s.relay.flush();
    const before = s.body().sequence;
    s.setSessions([{ ...first, title: "最新结果" }]);
    await s.relay.flush(); expect(s.request).toHaveBeenCalledTimes(1);
    s.advance(5000); await s.relay.flush();
    expect(s.request).toHaveBeenCalledTimes(2);
    expect(s.body().contentState.title).toBe("最新结果");
    expect(s.body().sequence).toBeGreaterThan(before);
  });

  it("rejects arbitrary delivery URLs and retires expired grants", async () => {
    const s = setup();
    expect(() => s.relay.subscribe({ ...s.subscription, serviceUrl: "https://elsewhere.example" })).toThrow();
    expect(() => s.relay.subscribe({ ...s.subscription, expiresAt: Date.now() - 1 })).toThrow();
    s.relay.subscribe(s.subscription); s.advance(60_001); await s.relay.flush();
    expect(s.request).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(s.path, "utf8"))).toEqual([]);
  });

  it.each([400, 422, 503])("keeps a registration after HTTP %i and recovers without the phone", async (status) => {
    const s = setup(); s.request.mockResolvedValueOnce(new Response(null, { status }));
    s.relay.subscribe(s.subscription); await s.relay.flush();
    expect(JSON.parse(readFileSync(s.path, "utf8"))).toHaveLength(1);
    s.advance(5000); await s.relay.flush();
    expect(s.request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(s.path, "utf8"))).toHaveLength(1);
  });

  it("alerts for a new question once, keeping its identity through delivery retries", async () => {
    const s = setup(); s.relay.subscribe(s.subscription); await s.relay.flush();
    const waiting = { ...first, asyncQuestions: [{ id: "question-1", title: "先测哪一个？", options: ["锁屏", "灵动岛"] }] };
    s.setSessions([waiting]); s.request.mockRejectedValueOnce(new Error("response lost"));
    await s.relay.flush();
    const notice = s.body().notice;
    expect(notice.task).toMatchObject({ id: first.id, phase: "waiting_for_input" });
    expect(s.body().contentState.noticeId).toBe(notice.id);
    s.advance(5000); await s.relay.flush();
    expect(s.body().notice.id).toBe(notice.id);
    s.setSessions([{ ...waiting, updatedAt: 300 }]); await s.relay.flush();
    expect(s.body().notice).toBeNull();
    expect(s.body().contentState.noticeId).toBe(notice.id);
    s.setSessions([{ ...waiting, asyncQuestions: [{ ...waiting.asyncQuestions[0]!, id: "question-2" }] }]);
    await s.relay.flush(); expect(s.body().notice.id).not.toBe(notice.id);
  });

  it("announces completion while another agent keeps working, then returns to current progress", async () => {
    const s = setup(); s.relay.subscribe(s.subscription); await s.relay.flush();
    s.setSessions([{ ...first, state: "idle", preview: "构建通过", updatedAt: 4 }, { ...first, id: "other", title: "另一个任务", updatedAt: 5 }]);
    await s.relay.flush();
    expect(s.body()).toMatchObject({ event: "update", notice: { task: { id: first.id, phase: "completed" } }, contentState: { phase: "completed", subtitle: "构建通过", runningCount: 1 } });
    await s.relay.flush();
    expect(s.body()).toMatchObject({ notice: null, contentState: { title: "另一个任务", phase: "running" } });
  });

  it("does not alert for historical discovery, and drops questions already answered before delivery", async () => {
    const s = setup(); s.relay.subscribe(s.subscription); await s.relay.flush();
    s.setSessions([first, { ...first, id: "historic", state: "waiting" }]); await s.relay.flush();
    expect(s.body().notice).toBeNull();
    s.setSessions([{ ...first, state: "waiting" }]);
    s.setSessions([first]); await s.relay.flush();
    expect(s.body().notice).toBeNull();
  });

  it("restores a pending transition and expires alerts that are no longer timely", async () => {
    const s = setup(); s.relay.subscribe({ ...s.subscription, expiresAt: Date.now() + 600_000 }); await s.relay.flush();
    s.setSessions([{ ...first, state: "error", updatedAt: 8 }]); s.relay.stop();
    const restarted = s.create(); await restarted.flush();
    expect(s.body().notice.task.phase).toBe("failed");
    s.setSessions([first]); s.setSessions([{ ...first, state: "error", updatedAt: 9 }]);
    s.advance(180_001); await restarted.flush();
    expect(s.body().notice).toBeNull();
  });

  it("announces terminal results without treating a closed terminal as a completed command", async () => {
    const s = setup(); s.relay.subscribe(s.subscription); await s.relay.flush();
    const terminal: TerminalInfo = { id: "term-1", title: "pnpm", command: "pnpm test", cwd: "/test", cols: 80, rows: 24, createdAt: 1, activeAt: 2 };
    s.setTerminal(terminal);
    s.setTerminal({ ...terminal, exitCode: 1, activeAt: 3 }); await s.relay.flush();
    expect(s.body().notice.task).toMatchObject({ kind: "terminal", phase: "failed" });
    s.setTerminal(terminal); s.setTerminal({ ...terminal, exitCode: 0 }, true); await s.relay.flush();
    expect(s.body().notice).toBeNull();
  });

  it("retains pending notices when the phone renews during an in-flight update", async () => {
    const s = setup(); s.relay.subscribe(s.subscription); await s.relay.flush();
    s.setSessions([{ ...first, state: "waiting" }]);
    let finish!: (value: Response) => void;
    s.request.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = s.relay.flush();
    const noticeId = s.body().notice.id;
    s.relay.subscribe(s.subscription);
    finish(new Response(null, { status: 200 })); await pending;
    await s.relay.flush(); expect(s.body().notice.id).toBe(noticeId);
  });
});
