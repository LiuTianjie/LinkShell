import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent, SessionSummary } from "@linkshell/wire";
import { HostLink, type LinkStatus } from "../src/host-link.js";
import { createClientStore } from "../src/store.js";
import { emptyView } from "../src/timeline.js";

const session: SessionSummary = { id: "codex:one", nativeId: "one", agent: "codex", cwd: "/work", state: "idle", pendingPermissions: 0, createdAt: 1, updatedAt: 1, lastSeq: 0, archived: false };
const content = [{ type: "text" as const, text: "Hello" }];

function setup() {
  vi.useFakeTimers();
  const link = new HostLink({ url: "ws://unused" });
  let event!: (event: SessionEvent) => void;
  let summary!: (summary: SessionSummary) => void;
  let restored!: (summary: SessionSummary) => void;
  let status!: (status: LinkStatus) => void;
  vi.spyOn(link, "onEvent").mockImplementation((listener) => { event = listener; return () => {}; });
  vi.spyOn(link, "onSummary").mockImplementation((listener) => { summary = listener; return () => {}; });
  vi.spyOn(link, "onRestored").mockImplementation((listener) => { restored = listener; return () => {}; });
  vi.spyOn(link, "onStatus").mockImplementation((listener) => { status = listener; return () => {}; });
  const call = vi.spyOn(link, "call").mockResolvedValue({ delivery: "started" });
  let n = 0;
  const store = createClientStore(link, { newId: () => `message-${++n}` });
  store.setState({ status: "online", sessions: { [session.id]: session }, views: { [session.id]: emptyView(session.id) }, open: { [session.id]: true }, ready: { [session.id]: true } });
  return { link, store, call, summary, restored, status, event: (seq: number, update: SessionEvent["update"]) => event({ sessionId: session.id, seq, ts: seq, update }), progress: () => store.getState().promptProgress[session.id] };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("prompt feedback across delivery and turn events", () => {
  it("appears immediately and bridges the confirmed message until the host starts working", async () => {
    const { store, summary, event, progress } = setup();
    const sent = store.getState().send(session.id, content);
    expect(progress()?.phase).toBe("sending");
    await sent;
    expect(progress()?.phase).toBe("starting");
    expect(store.getState().views[session.id]?.items[0]).toMatchObject({ accepted: true });
    event(1, { sessionUpdate: "ls_message", messageId: "user", role: "user", content, clientMessageId: "message-1" });
    vi.advanceTimersByTime(16);
    summary({ ...session, lastSeq: 1 });
    expect(progress()?.phase).toBe("starting");
    summary({ ...session, state: "running", activity: { kind: "thinking" } });
    expect(progress()).toBeUndefined();
  });

  it("does not resurrect the wait when a turn finishes before its send response", async () => {
    const { store, call, event, progress } = setup();
    let acknowledge!: (value: { delivery: "started" }) => void;
    call.mockReturnValueOnce(new Promise((resolve) => { acknowledge = resolve; }));
    const sent = store.getState().send(session.id, content);
    event(1, { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
    acknowledge({ delivery: "started" });
    await sent;
    expect(progress()).toBeUndefined();
  });

  it("ignores replayed events and background agents ending while this prompt waits", async () => {
    const { store, event, progress } = setup();
    store.setState({ views: { [session.id]: { ...emptyView(session.id), lastSeq: 10 } } });
    await store.getState().send(session.id, content);
    event(5, { sessionUpdate: "ls_turn", state: "ended" });
    event(11, { sessionUpdate: "ls_turn", state: "ended", parentToolCallId: "child" });
    vi.advanceTimersByTime(16);
    expect(progress()?.phase).toBe("starting");
    event(12, { sessionUpdate: "ls_turn", state: "started" });
    vi.advanceTimersByTime(16);
    expect(progress()).toBeUndefined();
  });

  it("stops on failure and starts feedback again for a retry", async () => {
    const { store, call, progress } = setup();
    call.mockRejectedValueOnce(new Error("connection closed"));
    await expect(store.getState().send(session.id, content)).resolves.toBe("failed");
    expect(progress()).toBeUndefined();
    expect(store.getState().views[session.id]?.items[0]).toMatchObject({ failed: true });
    const retry = store.getState().retry("message-1");
    expect(progress()?.phase).toBe("sending");
    await retry;
    expect(progress()?.phase).toBe("starting");
  });

  it("hands feedback to the queue when the host queues an apparently idle session", async () => {
    const { store, call, progress } = setup();
    call.mockResolvedValueOnce({ delivery: "queued" });
    await store.getState().send(session.id, content);
    expect(progress()).toBeUndefined();
    expect(store.getState().views[session.id]?.items).toEqual([]);
  });

  it("never calls a message queued behind a running turn a new starting turn", async () => {
    const { store, call, summary, progress } = setup();
    summary({ ...session, state: "running" });
    call.mockResolvedValueOnce({ delivery: "queued" });
    const sent = store.getState().send(session.id, content);
    expect(progress()).toBeUndefined();
    expect(store.getState().queueing[session.id]).toHaveLength(1);
    await sent;
    expect(progress()).toBeUndefined();
  });

  it("clears an old acknowledged wait when reconnect restores an idle snapshot", async () => {
    const { store, call, restored, status, progress } = setup();
    await store.getState().send(session.id, content);
    expect(progress()?.phase).toBe("starting");
    status("reconnecting");
    expect(store.getState().ready[session.id]).toBeUndefined();
    status("online");
    expect(store.getState().ready[session.id]).toBeUndefined();
    call.mockResolvedValueOnce({ tasks: [] });
    restored(session);
    expect(progress()).toBeUndefined();
    expect(store.getState().ready[session.id]).toBe(true);
  });

  it("keeps the local wait when the conversation is closed and reopened before a turn starts", async () => {
    const { link, store, call, progress } = setup();
    vi.spyOn(link, "subscribe").mockResolvedValue(session);
    await store.getState().send(session.id, content);
    store.getState().closeSession(session.id);
    call.mockResolvedValue({ tasks: [] });
    store.getState().openSession(session.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().ready[session.id]).toBe(true);
    expect(progress()?.phase).toBe("starting");
  });

  it("does not let an older send response replace a newer message's feedback", async () => {
    const { store, call, progress } = setup();
    let acknowledge!: (value: { delivery: "started" }) => void;
    call.mockReturnValueOnce(new Promise((resolve) => { acknowledge = resolve; }));
    const first = store.getState().send(session.id, content);
    await store.getState().send(session.id, content);
    acknowledge({ delivery: "started" });
    await first;
    expect(progress()).toMatchObject({ clientMessageId: "message-2", phase: "starting" });
  });

  it("ends feedback for an informational command that replies without starting a turn", async () => {
    const { store, event, progress } = setup();
    await store.getState().send(session.id, content);
    event(1, { sessionUpdate: "ls_notice", level: "info", title: "/status", detail: "Ready" });
    vi.advanceTimersByTime(16);
    expect(progress()).toBeUndefined();
  });
});
