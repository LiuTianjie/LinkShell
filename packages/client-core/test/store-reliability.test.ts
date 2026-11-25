import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock, SessionEvent, SessionSummary } from "@linkshell/wire";
import { HostLink } from "../src/host-link.js";
import { createClientStore, type OutboxItem } from "../src/store.js";

const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];

const baseSession: SessionSummary = {
  id: "codex:s1",
  nativeId: "s1",
  agent: "codex",
  cwd: "/work",
  state: "idle",
  pendingPermissions: 0,
  createdAt: 1,
  updatedAt: 1,
  lastSeq: 0,
  archived: false,
};

afterEach(() => vi.restoreAllMocks());

describe("client store reliability", () => {
  it("creates a session with an initial prompt atomically in a single sessions.create RPC", async () => {
    const link = new HostLink({ url: "ws://host-atomic" });
    const call = vi.spyOn(link, "call").mockResolvedValue({ session: { ...baseSession, state: "running" } });
    vi.spyOn(link, "subscribe").mockResolvedValue(undefined);

    let seq = 0;
    const store = createClientStore(link, { newId: () => `id-${++seq}` });
    const created = await store.getState().createSession({
      agent: "codex",
      cwd: "/work",
      prompt: text("Ship atomic create"),
    });

    expect(created.id).toBe("codex:s1");
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      "sessions.create",
      {
        agent: "codex",
        cwd: "/work",
        worktree: undefined,
        requestId: "create-id-1",
        model: undefined,
        prompt: text("Ship atomic create"),
        clientMessageId: "id-1",
      },
      60_000,
    );
    expect(store.getState().views["codex:s1"]?.items[0]).toMatchObject({
      kind: "user",
      id: "local-id-1",
      pending: true,
      accepted: true,
    });
  });

  it("treats duplicate delivery as accepted and clears outbox and prompt progress", async () => {
    const link = new HostLink({ url: "ws://host-dup" });
    vi.spyOn(link, "call").mockResolvedValue({ delivery: "duplicate" });

    const store = createClientStore(link, { newId: () => "dup-1" });
    store.setState({ sessions: { [baseSession.id]: baseSession } });

    const delivery = await store.getState().send(baseSession.id, text("Retry same id"), { clientMessageId: "dup-1" });
    expect(delivery).toBe("duplicate");
    expect(store.getState().outbox).toEqual({});
    expect(store.getState().promptProgress[baseSession.id]).toBeUndefined();
    expect(store.getState().views[baseSession.id]?.items[0]).toMatchObject({
      kind: "user",
      id: "local-dup-1",
      pending: true,
      accepted: true,
    });
  });

  it("persists unsent/failed outbox items via outboxStorage and hydrates sync or async across restarts", async () => {
    const savedByKey = new Map<string, OutboxItem[]>();
    const storage = {
      load: vi.fn((key: string) => savedByKey.get(key) ?? []),
      save: vi.fn((key: string, items: OutboxItem[]) => {
        savedByKey.set(key, items);
      }),
    };

    // 1. Send fails while offline -> persisted under outboxKey.
    const link1 = new HostLink({ url: "ws://computer-1" });
    vi.spyOn(link1, "call").mockRejectedValue(new Error("offline"));
    const store1 = createClientStore(link1, {
      outboxKey: "computer-1",
      outboxStorage: storage,
      newId: () => "msg-1",
    });
    store1.setState({ sessions: { [baseSession.id]: baseSession } });

    expect(await store1.getState().send(baseSession.id, text("Don't lose me"))).toBe("failed");
    expect(savedByKey.get("computer-1")).toEqual([
      {
        clientMessageId: "msg-1",
        sessionId: baseSession.id,
        content: text("Don't lose me"),
        createdAt: expect.any(Number),
      },
    ]);

    // 2. Recreate store (app restarted) with synchronous load -> failed message is restored in outbox & view, and can be retried!
    const link2 = new HostLink({ url: "ws://computer-1" });
    vi.spyOn(link2, "call").mockResolvedValue({ delivery: "started" });
    const store2 = createClientStore(link2, {
      outboxKey: "computer-1",
      outboxStorage: storage,
    });

    expect(store2.getState().outbox["msg-1"]).toEqual({
      sessionId: baseSession.id,
      content: text("Don't lose me"),
    });
    expect(store2.getState().views[baseSession.id]?.items[0]).toMatchObject({
      kind: "user",
      id: "local-msg-1",
      pending: false,
      failed: true,
    });

    await store2.getState().retry("msg-1");
    expect(store2.getState().outbox).toEqual({});
    expect(savedByKey.get("computer-1")).toEqual([]);
    expect(store2.getState().views[baseSession.id]?.items[0]).toMatchObject({
      kind: "user",
      id: "local-msg-1",
      pending: true,
      accepted: true,
    });

    // 3. Async load hydration + host echo confirmation cleans up outbox without doubling user blocks.
    const asyncItems: OutboxItem[] = [
      { clientMessageId: "msg-2", sessionId: baseSession.id, content: text("Already received by host"), createdAt: 500 },
    ];
    let resolveLoad!: (items: OutboxItem[]) => void;
    const asyncSaved: OutboxItem[][] = [];
    let eventListener!: (event: SessionEvent) => void;
    const link3 = new HostLink({ url: "ws://computer-2" });
    vi.spyOn(link3, "onEvent").mockImplementation((fn) => {
      eventListener = fn;
      return () => {};
    });
    const store3 = createClientStore(link3, {
      outboxKey: "computer-2",
      outboxStorage: {
        load: () => new Promise<OutboxItem[]>((resolve) => { resolveLoad = resolve; }),
        save: (_key, items) => { asyncSaved.push(items); },
      },
    });

    resolveLoad(asyncItems);
    await Promise.resolve();
    expect(store3.getState().outbox["msg-2"]).toBeDefined();

    // Open and mark session ready, then deliver host's user_message_chunk echo for local-msg-2.
    store3.setState({
      status: "online",
      open: { [baseSession.id]: true },
      ready: { [baseSession.id]: true },
    });
    vi.useFakeTimers();
    eventListener({
      sessionId: baseSession.id,
      seq: 1,
      ts: 600,
      update: { sessionUpdate: "user_message_chunk", messageId: "local-msg-2", content: { type: "text", text: "Already received by host" } },
    });
    await vi.advanceTimersByTimeAsync(20);
    vi.useRealTimers();

    expect(store3.getState().outbox).toEqual({});
    expect(asyncSaved.at(-1)).toEqual([]);
    expect(store3.getState().views[baseSession.id]?.items[0]).toMatchObject({
      kind: "user",
      id: "local-msg-2",
      blocks: text("Already received by host"),
    });
    expect((store3.getState().views[baseSession.id]?.items[0] as { failed?: boolean }).failed).toBeUndefined();
  });

  it("evicts oldest closed views via LRU on closeSession while preserving open and outbox-backed views", () => {
    const link = new HostLink({ url: "ws://host-lru" });
    vi.spyOn(link, "subscribe").mockResolvedValue(undefined);
    vi.spyOn(link, "unsubscribe").mockImplementation(() => {});

    const store = createClientStore(link, { maxClosedViews: 2 });
    for (const id of ["s1", "s2", "s3", "s4"]) {
      store.getState().openSession(id);
      store.getState().closeSession(id);
    }
    // Only the 2 most recently closed views remain cached.
    expect(Object.keys(store.getState().views).sort()).toEqual(["s3", "s4"]);

    // Protect a closed view that still holds an unsent outbox entry from eviction while keeping total closed views capped.
    store.setState((state) => ({ outbox: { ...state.outbox, "m-keep": { sessionId: "s3", content: text("keep me") } } }));
    store.getState().openSession("s5");
    store.getState().closeSession("s5");
    expect(store.getState().views["s3"]).toBeDefined();
    expect(store.getState().views["s4"]).toBeUndefined();
    expect(store.getState().views["s5"]).toBeDefined();

    // Closing s6 evicts s5 (oldest unprotected closed view) while keeping protected s3 and newest s6.
    store.getState().openSession("s6");
    store.getState().closeSession("s6");
    expect(store.getState().views["s3"]).toBeDefined();
    expect(store.getState().views["s5"]).toBeUndefined();
    expect(store.getState().views["s6"]).toBeDefined();
  });

  it("removes the optimistic pending bubble when retry() delivers to the host queue", async () => {
    const link = new HostLink({ url: "ws://host-retry-queue" });
    const call = vi.spyOn(link, "call");
    call.mockRejectedValueOnce(new Error("offline"));
    call.mockResolvedValueOnce({ delivery: "queued" });

    const store = createClientStore(link, { newId: () => "retry-q1" });
    store.setState({ sessions: { [baseSession.id]: baseSession } });

    expect(await store.getState().send(baseSession.id, text("Try later"))).toBe("failed");
    expect(store.getState().views[baseSession.id]?.items).toHaveLength(1);

    await store.getState().retry("retry-q1");
    expect(store.getState().outbox).toEqual({});
    expect(store.getState().views[baseSession.id]?.items).toEqual([]);
  });

  it("clears outbox entries confirmed in summary.queue and deduplicates replayed events on retry", async () => {
    let summaryListener!: (summary: SessionSummary) => void;
    let eventListener!: (event: SessionEvent) => void;
    let restoredListener!: (summary: SessionSummary) => void;
    const link = new HostLink({ url: "ws://host-summary-dedup" });
    vi.spyOn(link, "onSummary").mockImplementation((fn) => {
      summaryListener = fn;
      return () => {};
    });
    vi.spyOn(link, "onEvent").mockImplementation((fn) => {
      eventListener = fn;
      return () => {};
    });
    vi.spyOn(link, "onRestored").mockImplementation((fn) => {
      restoredListener = fn;
      return () => {};
    });
    vi.spyOn(link, "call").mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ tasks: [] });

    const store = createClientStore(link, { newId: () => "q-confirmed" });
    store.setState({ status: "online", sessions: { [baseSession.id]: baseSession } });

    expect(await store.getState().send(baseSession.id, text("Queued before disconnect"))).toBe("failed");
    expect(store.getState().outbox["q-confirmed"]).toBeDefined();
    expect(store.getState().views[baseSession.id]?.items).toHaveLength(1);

    // Host summary announces that `q-confirmed` is already in its queue -> outbox & stale bubble clear immediately.
    summaryListener({
      ...baseSession,
      state: "running",
      queue: [{ clientMessageId: "q-confirmed", text: "Queued before disconnect", images: 0 }],
    });
    expect(store.getState().outbox["q-confirmed"]).toBeUndefined();
    expect(store.getState().views[baseSession.id]?.items).toEqual([]);

    // Subscribe replay deduplicates events delivered twice on a subscribe retry.
    store.setState({ open: { [baseSession.id]: true } });
    const ev1: SessionEvent = {
      sessionId: baseSession.id,
      seq: 1,
      ts: 100,
      update: { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "hello" } },
    };
    eventListener(ev1);
    eventListener(ev1);
    restoredListener({ ...baseSession, lastSeq: 1 });
    expect(store.getState().views[baseSession.id]?.items).toMatchObject([{ kind: "agent", id: "a1", text: "hello" }]);
  });
});
