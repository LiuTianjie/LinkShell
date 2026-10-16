import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@linkshell/wire";
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
  const hub = {
    listSessions: () => ({ sessions }),
    async subscribe(id: string, _seq: number, subscriber: Subscriber) { const set = subscribers.get(id) ?? new Set<Subscriber>(); set.add(subscriber); subscribers.set(id, set); return { session: sessions.find((item) => item.id === id)!, startSeq: 0 }; },
    unsubscribe(id: string, subscriber: Subscriber) { subscribers.get(id)?.delete(subscriber); },
    onSummary(listener: (summary: SessionSummary) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
  const options = { path, hub, terminals: { list: () => [], onChange: () => () => {} }, computerName: () => "Mac", request, log: vi.fn() };
  const create = () => { const relay = new LiveActivityRelay(options); relays.push(relay); relay.start(); return relay; };
  const relay = create();
  const subscription = { activityId: "activity-1", computerKey: "computer-1", serviceUrl: "https://push.itool.tech", grant: "a".repeat(64), expiresAt: now + 60_000 };
  const body = () => JSON.parse(String(request.mock.calls.at(-1)![1]!.body));
  return { relay, hub, create, subscribers, subscription, request, body, path, advance: (ms: number) => { now += ms; }, setSessions: (next: SessionSummary[]) => { sessions = next; for (const listener of listeners) for (const session of next) listener(session); } };
}

describe("Host-owned Live Activity updates", () => {
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
});
