import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent, SessionSummary } from "@linkshell/wire";
import { HostLink, type LinkStatus } from "../src/host-link.js";
import { createClientStore } from "../src/store.js";
import { addOptimisticMessage, applyEvents, emptyView } from "../src/timeline.js";

const session: SessionSummary = { id: "codex:history", nativeId: "history", agent: "codex", cwd: "/work", state: "idle", pendingPermissions: 0, createdAt: 1, updatedAt: 1, lastSeq: 0, archived: false };
const chunk = (seq: number, text: string, sessionId = session.id): SessionEvent => ({ sessionId, seq, ts: seq, update: { sessionUpdate: "agent_message_chunk", messageId: "reply", content: { type: "text", text } } });

function setup() {
  vi.useFakeTimers();
  const link = new HostLink({ url: "ws://unused" });
  let event!: (event: SessionEvent) => void;
  let restored!: (summary: SessionSummary) => void;
  let status!: (status: LinkStatus) => void;
  const notifications = new Map<string, (params: unknown) => void>();
  vi.spyOn(link, "onEvent").mockImplementation((listener) => { event = listener; return () => {}; });
  vi.spyOn(link, "onRestored").mockImplementation((listener) => { restored = listener; return () => {}; });
  vi.spyOn(link, "onStatus").mockImplementation((listener) => { status = listener; return () => {}; });
  vi.spyOn(link, "on").mockImplementation((name, listener) => { notifications.set(name, listener as (params: unknown) => void); return () => {}; });
  const call = vi.spyOn(link, "call").mockResolvedValue({ tasks: [] });
  const store = createClientStore(link);
  store.setState({ status: "online", sessions: { [session.id]: session }, views: { [session.id]: emptyView(session.id) }, open: { [session.id]: true } });
  return { store, event, restored, status, call, window: (startSeq: number) => notifications.get("session.window")!({ sessionId: session.id, startSeq }) };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("history replay publication", () => {
  it("publishes a slow backlog as one ready snapshot while other sessions still stream", () => {
    const { store, event, restored } = setup();
    const liveId = "codex:live";
    store.setState((state) => ({ views: { ...state.views, [liveId]: emptyView(liveId) }, open: { ...state.open, [liveId]: true }, ready: { [liveId]: true } }));
    const shown: { ready: boolean; text: string }[] = [];
    store.subscribe((state, previous) => {
      if (state.views[session.id] !== previous.views[session.id]) shown.push({ ready: !!state.ready[session.id], text: state.views[session.id]!.items.flatMap((item) => item.kind === "agent" ? [item.text] : []).join("") });
    });

    event(chunk(1, "The complete "));
    event(chunk(1, "Live reply", liveId));
    vi.advanceTimersByTime(100);
    expect(store.getState().views[liveId]!.items[0]).toMatchObject({ text: "Live reply" });
    expect(shown).toEqual([]);
    event(chunk(2, "history"));
    vi.advanceTimersByTime(100);
    expect(shown).toEqual([]);
    restored({ ...session, lastSeq: 2 });
    expect(shown).toEqual([{ ready: true, text: "The complete history" }]);

    event(chunk(3, " and live changes"));
    vi.advanceTimersByTime(16);
    expect(shown.at(-1)?.text).toBe("The complete history and live changes");
  });

  it("keeps the cached conversation and unsent message during a replacement window", () => {
    const { store, event, restored, status, window } = setup();
    const cached = addOptimisticMessage(applyEvents(emptyView(session.id), [chunk(1, "Cached history")]), "draft", [{ type: "text", text: "Still sending" }]);
    store.setState({ views: { [session.id]: cached }, ready: { [session.id]: true } });
    status("reconnecting");
    status("online");
    window(20);
    event(chunk(21, "Latest history"));
    vi.advanceTimersByTime(100);
    expect(store.getState().views[session.id]).toBe(cached);
    expect(store.getState().ready[session.id]).toBeUndefined();

    restored({ ...session, lastSeq: 21 });
    const view = store.getState().views[session.id]!;
    expect(view.startSeq).toBe(20);
    expect(view.items.some((item) => item.kind === "agent" && item.text === "Cached history")).toBe(false);
    expect(view.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "agent", text: "Latest history" }), expect.objectContaining({ kind: "user", pending: true, id: "local-draft" })]));
  });

  it("discards an interrupted replay before starting again from the visible cursor", () => {
    const { store, event, restored, status } = setup();
    event(chunk(1, "An abandoned response"));
    status("reconnecting");
    status("online");
    event(chunk(1, "Replacement response"));
    restored({ ...session, lastSeq: 1 });
    expect(store.getState().views[session.id]!.items[0]).toMatchObject({ text: "Replacement response" });
  });

  it("ignores an older history-page response while a fresh snapshot is loading", async () => {
    const { store, call, status } = setup();
    const cached = { ...applyEvents(emptyView(session.id), [chunk(21, "Cached tail")]), startSeq: 20 };
    store.setState({ views: { [session.id]: cached }, ready: { [session.id]: true } });
    let answer!: (value: { events: SessionEvent[]; startSeq: number }) => void;
    call.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const loading = store.getState().loadEarlier(session.id);
    status("reconnecting");
    status("online");
    answer({ events: [chunk(1, "Earlier content")], startSeq: 0 });
    expect(await loading).toBe(false);
    expect(store.getState().views[session.id]).toBe(cached);
  });
});
