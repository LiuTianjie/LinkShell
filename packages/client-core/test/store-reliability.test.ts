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
});
