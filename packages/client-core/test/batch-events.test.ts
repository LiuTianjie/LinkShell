import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionSummary } from "@linkshell/wire";
import { HostLink, createClientStore, type SocketLike } from "../src/index.js";

function makeSessionSummary(id: string): SessionSummary {
  return {
    id,
    agent: "codex",
    nativeId: id,
    cwd: "/tmp/proj",
    state: "idle",
    pendingPermissions: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    lastSeq: 0,
    archived: false,
  };
}

function makeMockPair(options: { supportBatchEvents: boolean }) {
  let onClientMessage: ((event: { data: unknown }) => void) | null = null;
  let lastSubscribeParams: Record<string, unknown> | undefined;
  const socket: SocketLike = {
    readyState: 1,
    send(text) {
      const msg = JSON.parse(text) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (msg.method === "machine.info") {
        queueMicrotask(() =>
          onClientMessage?.({
            data: JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { machineId: "m1", hostname: "Mac", platform: "darwin", hostVersion: "0.4.119", agents: [] },
            }),
          }),
        );
      } else if (msg.method === "sessions.list") {
        queueMicrotask(() => onClientMessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessions: [] } }) }));
      } else if (msg.method === "projects.list") {
        queueMicrotask(() => onClientMessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { projects: [] } }) }));
      } else if (msg.method === "agents.pending") {
        queueMicrotask(() => onClientMessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { interactions: [] } }) }));
      } else if (msg.method === "sessions.subscribe") {
        lastSubscribeParams = msg.params;
        const sessionId = String(msg.params?.sessionId ?? "s1");
        const backlog: SessionEvent[] = [
          { sessionId, seq: 1, ts: 1000, update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Backlog A" } } },
          { sessionId, seq: 2, ts: 1010, update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: " + B" } } },
        ];
        queueMicrotask(() => {
          if (options.supportBatchEvents && msg.params?.batchEvents) {
            onClientMessage?.({
              data: JSON.stringify({ jsonrpc: "2.0", method: "session.events", params: { sessionId, events: backlog } }),
            });
          } else {
            for (const ev of backlog) {
              onClientMessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: ev }) });
            }
          }
          onClientMessage?.({
            data: JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { session: makeSessionSummary(sessionId), startSeq: 0 },
            }),
          });
        });
      }
    },
    close() {},
    onopen: null,
    onclose: null,
    onerror: null,
    get onmessage() { return onClientMessage; },
    set onmessage(fn) { onClientMessage = fn; },
  };
  return {
    socket,
    getSubscribeParams: () => lastSubscribeParams,
    pushNotification(method: string, params: unknown) {
      onClientMessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method, params }) });
    },
  };
}

describe("ClientStore & HostLink R2/R4 batching + backward compatibility + leading-edge flush", () => {
  it.each([true, false])("works seamlessly when host supportBatchEvents=%s and flushes idle first live token immediately", async (supportBatchEvents) => {
    const pair = makeMockPair({ supportBatchEvents });
    const link = new HostLink({ url: "ws://mock", createSocket: () => pair.socket, heartbeatMs: 0 });
    const store = createClientStore(link);
    const seenSeqs: number[] = [];
    link.onEvents((events) => {
      for (const ev of events) seenSeqs.push(ev.seq);
    });

    link.start();
    pair.socket.onopen?.({});
    await new Promise<void>((resolve) => {
      if (link.status === "online") return resolve();
      const unsub = link.onStatus((s) => { if (s === "online") { unsub(); resolve(); } });
    });

    store.getState().openSession("s1");
    await new Promise<void>((resolve) => {
      if (store.getState().ready["s1"]) return resolve();
      const unsub = store.subscribe((s) => { if (s.ready["s1"]) { unsub(); resolve(); } });
    });

    // Modern client always advertises batchEvents: true
    expect(pair.getSubscribeParams()?.batchEvents).toBe(true);
    // Both paths deliver identical timeline state and notify onEvents subscribers
    const initialMsg = store.getState().views["s1"]?.items[0];
    expect(initialMsg).toMatchObject({ kind: "agent", text: "Backlog A + B" });
    expect(seenSeqs).toEqual([1, 2]);

    // Idle live event flushes synchronously (0 ms delay, no 16 ms wait!)
    const liveEvent: SessionEvent = {
      sessionId: "s1",
      seq: 3,
      ts: 2000,
      update: { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Instant!" } },
    };
    if (supportBatchEvents) {
      pair.pushNotification("session.events", { sessionId: "s1", events: [liveEvent] });
    } else {
      pair.pushNotification("session.event", liveEvent);
    }
    const itemsAfterImmediate = store.getState().views["s1"]?.items ?? [];
    expect(itemsAfterImmediate.some((item) => item.kind === "agent" && item.text === "Instant!")).toBe(true);
    expect(store.getState().views["s1"]?.lastSeq).toBe(3);

    link.stop();
  });
});
