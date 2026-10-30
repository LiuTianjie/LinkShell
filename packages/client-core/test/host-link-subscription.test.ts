import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcError, type SessionSummary } from "@linkshell/wire";
import { HostLink, type SocketLike } from "../src/host-link.js";
import { createClientStore } from "../src/store.js";

const session: SessionSummary = {
  id: "codex:one", nativeId: "one", agent: "codex", cwd: "/work", state: "idle",
  pendingPermissions: 0, createdAt: 1, updatedAt: 1, lastSeq: 0, archived: false,
};
type Request = { id: number; method: string; params: Record<string, unknown> };

class TestSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  onmessage: SocketLike["onmessage"] = null;
  readonly subscriptions: Request[] = [];

  open() { this.readyState = 1; this.onopen?.({}); }
  close() { this.readyState = 3; this.onclose?.({}); }
  send(data: string) {
    const request = JSON.parse(data) as Request;
    if (request.method === "sessions.subscribe") { this.subscriptions.push(request); return; }
    const responses: Record<string, unknown> = {
      "machine.info": { machineId: "host", hostname: "Computer", platform: "test", hostVersion: "test", agents: [] },
      "sessions.list": { sessions: [session] },
      "projects.list": { projects: [] },
      "agents.pending": { interactions: [] },
      "sessions.tasks": { tasks: [] },
      "sessions.unsubscribe": {},
    };
    this.resolve(request, responses[request.method] ?? {});
  }
  resolve(request: Request, result: unknown) {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) });
  }
  reject(request: Request, error: RpcError) {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, error: error.toObject() }) });
  }
}

const links: HostLink[] = [];
async function setup() {
  vi.useFakeTimers();
  const socket = new TestSocket();
  const link = new HostLink({ url: "ws://fixture", createSocket: () => socket, heartbeatMs: 0 });
  links.push(link);
  const store = createClientStore(link);
  store.getState().connect();
  socket.open();
  await vi.advanceTimersByTimeAsync(0);
  return { socket, store };
}

afterEach(() => {
  for (const link of links.splice(0)) link.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("session subscription ownership", () => {
  it.each(["success", "not_found"] as const)("ignores an old %s response after the same conversation is reopened", async (outcome) => {
    const { socket, store } = await setup();
    store.getState().openSession(session.id);
    const previous = socket.subscriptions[0]!;
    store.getState().closeSession(session.id);
    store.getState().openSession(session.id);
    const current = socket.subscriptions[1]!;

    if (outcome === "success") socket.resolve(previous, { session: { ...session, title: "Old snapshot" }, startSeq: 0 });
    else socket.reject(previous, RpcError.app("not_found", "Old subscription no longer exists"));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().ready[session.id]).toBeUndefined();

    socket.resolve(current, { session: { ...session, title: "Current snapshot" }, startSeq: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().ready[session.id]).toBe(true);
    expect(store.getState().sessions[session.id]?.title).toBe("Current snapshot");
  });

  it("recovers an initially failed subscription without requiring another close and reopen", async () => {
    const { socket, store } = await setup();
    store.getState().openSession(session.id);
    socket.reject(socket.subscriptions[0]!, RpcError.app("busy", "History is still loading"));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().ready[session.id]).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5000);
    expect(socket.subscriptions).toHaveLength(2);
    socket.resolve(socket.subscriptions[1]!, { session, startSeq: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().ready[session.id]).toBe(true);
  });
});
