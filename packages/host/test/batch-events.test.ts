import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@linkshell/wire";
import { coalesceWireEvents } from "../src/hub-helpers.js";
import { SessionHub } from "../src/hub.js";
import { HostRpcServer } from "../src/rpc/server.js";
import { HostStore } from "../src/store.js";
import { TerminalManager } from "../src/terminals.js";

function makeFakeDriver() {
  return {
    id: "fake",
    label: "Fake",
    behavior: { desktop: "none" as const },
    start: async () => {},
    stop: async () => {},
    status: () => ({ id: "fake", label: "Fake", installed: true }),
    discover: async () => [],
    createSession: async ({ cwd }: { cwd: string }) => ({ nativeId: "n1", cwd, createdAt: Date.now(), updatedAt: Date.now() }),
    attach: async () => [],
    detach: async () => {},
    sendPrompt: async () => {},
    cancel: async () => {},
    respondPermission: async () => {},
  };
}

describe("R2 batched agent message protocol & backward compatibility", () => {
  it("coalesces contiguous text chunks and append-only tool output while preserving seq monotonicity and boundaries", () => {
    const events: SessionEvent[] = [
      { sessionId: "s1", seq: 1, ts: 100, update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello " } } },
      { sessionId: "s1", seq: 2, ts: 105, update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "world" } } },
      { sessionId: "s1", seq: 3, ts: 110, update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "!" } } },
      // replace: true must NEVER merge into the prior chunk
      { sessionId: "s1", seq: 4, ts: 115, update: { sessionUpdate: "agent_message_chunk", messageId: "m1", replace: true, content: { type: "text", text: "Replaced" } } },
      // Different messageId starts a new entry
      { sessionId: "s1", seq: 5, ts: 120, update: { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Second" } } },
      // Thought chunks coalesce independently
      { sessionId: "s1", seq: 6, ts: 125, update: { sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "Think " } } },
      { sessionId: "s1", seq: 7, ts: 130, update: { sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "hard" } } },
      // Append-only tool output deltas coalesce, but a status update breaks the run
      { sessionId: "s1", seq: 8, ts: 135, update: { sessionUpdate: "tool_call_update", toolCallId: "tc1", appendOutput: "line1\n" } },
      { sessionId: "s1", seq: 9, ts: 140, update: { sessionUpdate: "tool_call_update", toolCallId: "tc1", appendOutput: "line2\n" } },
      { sessionId: "s1", seq: 10, ts: 145, update: { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed", appendOutput: "done\n" } },
    ];

    const out = coalesceWireEvents(events);
    expect(out).toHaveLength(6);
    expect(out[0]).toMatchObject({ seq: 3, ts: 100, update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello world!" } } });
    expect(out[1]).toMatchObject({ seq: 4, update: { replace: true, content: { text: "Replaced" } } });
    expect(out[2]).toMatchObject({ seq: 5, update: { messageId: "m2", content: { text: "Second" } } });
    expect(out[3]).toMatchObject({ seq: 7, ts: 125, update: { sessionUpdate: "agent_thought_chunk", content: { text: "Think hard" } } });
    expect(out[4]).toMatchObject({ seq: 9, ts: 135, update: { sessionUpdate: "tool_call_update", toolCallId: "tc1", appendOutput: "line1\nline2\n" } });
    expect(out[5]).toMatchObject({ seq: 10, update: { sessionUpdate: "tool_call_update", status: "completed", appendOutput: "done\n" } });
  });

  it("serves batched session.events to opt-in clients and legacy session.event to older clients simultaneously", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-r2-test-"));
    const store = new HostStore(join(dir, "state.db"));
    const hub = new SessionHub(store, [makeFakeDriver() as never], () => {}, dir);
    const terminals = new TerminalManager({ store, log: () => {} } as never);
    const rpc = new HostRpcServer({
      hub,
      terminals,
      socketPath: join(dir, "host.sock"),
      machineInfo: () => ({ machineId: "m1", hostname: "Mac", platform: "darwin", hostVersion: "0.4.119", agents: [] }),
      log: () => {},
    });

    try {
      const session = await hub.createSession({ agent: "fake", cwd: dir });

      function attachMockPeer() {
        const sent: Array<{ method?: string; id?: number; params?: unknown; result?: unknown }> = [];
        let onMsg: ((text: string) => void) | undefined;
        let onClose: (() => void) | undefined;
        let reqId = 1;
        const pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
        rpc.connect({
          local: false,
          send(text) {
            const msg = JSON.parse(text) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };
            sent.push(msg);
            if (msg.id !== undefined) {
              const resolver = pending.get(msg.id);
              if (resolver) {
                pending.delete(msg.id);
                resolver(msg);
              }
            }
          },
          onMessage(fn) { onMsg = fn; },
          onClose(fn) { onClose = fn; },
          close() { onClose?.(); },
        });
        return {
          sent,
          close() { onClose?.(); },
          call(method: string, params: Record<string, unknown>) {
            const id = reqId++;
            return new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
              pending.set(id, resolve);
              onMsg?.(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            });
          },
        };
      }

      // 1. Seed 40 uncompacted chunks during an active turn before subscribing so we verify
      //    mid-turn backlog replay batching vs legacy replay (note: ls_turn ended with 0
      //    subscribers compacts stored chunks immediately, which is tested separately).
      hub.driverHost.update("fake", "n1", { sessionUpdate: "ls_turn", state: "started" });
      for (let i = 0; i < 40; i++) {
        hub.driverHost.update("fake", "n1", { sessionUpdate: "agent_message_chunk", messageId: "m-hist", content: { type: "text", text: `h${i} ` } });
      }

      const legacyPeer = attachMockPeer();
      const modernPeer = attachMockPeer();

      await legacyPeer.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
      await modernPeer.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0, batchEvents: true });

      const legacyBacklogNotifs = legacyPeer.sent.filter((m) => m.method === "session.event");
      const modernBacklogBatchNotifs = modernPeer.sent.filter((m) => m.method === "session.events");
      const modernLegacyNotifs = modernPeer.sent.filter((m) => m.method === "session.event");

      expect(legacyBacklogNotifs.length).toBeGreaterThanOrEqual(41);
      expect(modernLegacyNotifs).toHaveLength(0);
      expect(modernBacklogBatchNotifs).toHaveLength(1);
      const coalescedBacklog = (modernBacklogBatchNotifs[0]!.params as { events: SessionEvent[] }).events;
      // 40 contiguous text chunks coalesced into 1 event right after turn start!
      expect(coalescedBacklog.filter((e) => e.update.sessionUpdate === "agent_message_chunk")).toHaveLength(1);
      hub.driverHost.update("fake", "n1", { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });

      // 2. Live streaming burst + immediate boundary flush on permission / turn end
      legacyPeer.sent.length = 0;
      modernPeer.sent.length = 0;

      hub.driverHost.update("fake", "n1", { sessionUpdate: "ls_turn", state: "started" });
      for (let i = 0; i < 30; i++) {
        hub.driverHost.update("fake", "n1", { sessionUpdate: "agent_message_chunk", messageId: "m-live", content: { type: "text", text: `t${i} ` } });
      }
      // Permission request must flush synchronously with zero delay!
      hub.driverHost.update("fake", "n1", {
        sessionUpdate: "ls_permission",
        requestId: "perm-1",
        title: "Run tests?",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      hub.driverHost.update("fake", "n1", { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });

      // Legacy peer got every individual session.event (including all 30 uncoalesced chunks)
      const legacyLiveEvents = legacyPeer.sent
        .filter((m) => m.method === "session.event")
        .map((m) => m.params as SessionEvent);
      expect(legacyLiveEvents.length).toBeGreaterThanOrEqual(33);
      expect(legacyLiveEvents.filter((e) => e.update.sessionUpdate === "agent_message_chunk")).toHaveLength(30);
      // Modern peer got coalesced session.events immediately:
      // ls_turn(started) + leading-edge t0 (0 ms TTFT) + coalesced (t1..t29 + ls_permission) + ls_permission_resolved + ls_turn(ended) = <= 5 frames vs 34 legacy frames!
      const modernLiveBatches = modernPeer.sent.filter((m) => m.method === "session.events");
      expect(modernLiveBatches.length).toBeLessThanOrEqual(5);
      const allModernLive = modernLiveBatches.flatMap((m) => (m.params as { events: SessionEvent[] }).events);
      expect(allModernLive.filter((e) => e.update.sessionUpdate === "agent_message_chunk").length).toBeLessThanOrEqual(2);
      const combinedText = allModernLive
        .filter((e) => e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text")
        .map((e) => (e.update as { content: { text: string } }).content.text)
        .join("");
      expect(combinedText).toContain("t0 ");
      expect(combinedText).toContain("t29 ");
      expect(allModernLive.some((e) => e.update.sessionUpdate === "ls_permission")).toBe(true);
      expect(allModernLive.some((e) => e.update.sessionUpdate === "ls_turn" && e.update.state === "ended")).toBe(true);

      legacyPeer.close();
      modernPeer.close();
    } finally {
      await rpc.stop();
      await hub.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
