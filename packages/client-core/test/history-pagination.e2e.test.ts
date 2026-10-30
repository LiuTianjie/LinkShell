import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHost } from "@linkshell/host";
import { HostStore } from "../../host/src/store.js";
import { HostLink, type SocketLike } from "../src/host-link.js";
import { createClientStore } from "../src/store.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(open = true) {
  const home = mkdtempSync(join(tmpdir(), "lsh-history-pages-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const sessionId = "stored:history";
  const database = new HostStore(join(home, "state.db"));
  try {
    database.upsertSession({ id: sessionId, agent: "stored", nativeId: "history", cwd: home, createdAt: 1, updatedAt: 1 });
    for (let turn = 0; turn < 180; turn++) {
      database.appendEvent(sessionId, { sessionUpdate: "user_message_chunk", messageId: `user-${turn}`, content: { type: "text", text: `Question ${turn}` } });
      database.appendEvent(sessionId, { sessionUpdate: "agent_message_chunk", messageId: `reply-${turn}`, content: { type: "text", text: `Answer ${turn}` } });
    }
  } finally { database.close(); }
  const host = await startHost({ home, version: "history-pages-e2e", tcpPort: 0, drivers: () => [], iceServers: false, log: () => {} });
  cleanups.push(() => host.stop());
  // Delay actual RPC responses without replacing the host's history or subscription logic.
  const proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => proxy.on("listening", resolve));
  const release: (() => void)[] = [];
  const upstreams = new Set<WebSocket>();
  proxy.on("connection", (client) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${host.server.tcpAddress()}`);
    upstreams.add(upstream);
    const queue: string[] = [];
    const histories = new Set<unknown>();
    upstream.on("open", () => { for (const data of queue) upstream.send(data); queue.length = 0; });
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.method === "sessions.history") histories.add(message.id);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString()); else queue.push(data.toString());
    });
    upstream.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const deliver = () => { if (client.readyState === WebSocket.OPEN) client.send(data.toString()); };
      if (histories.delete(message.id)) release.push(deliver); else deliver();
    });
    client.on("close", () => upstream.close());
    upstream.on("close", () => { upstreams.delete(upstream); client.close(); });
    upstream.on("error", () => client.close());
  });
  cleanups.push(async () => {
    for (const socket of proxy.clients) socket.terminate();
    for (const socket of upstreams) socket.terminate();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing test proxy address");
  const link = new HostLink({ url: `ws://127.0.0.1:${address.port}`, createSocket: (url) => new WebSocket(url) as unknown as SocketLike, heartbeatMs: 0, requestTimeoutMs: 3000 });
  const store = createClientStore(link);
  cleanups.push(() => store.getState().disconnect());
  store.getState().connect();
  await vi.waitFor(() => expect(store.getState().sessionsLoaded).toBe(true));
  if (open) {
    store.getState().openSession(sessionId);
    await vi.waitFor(() => expect(store.getState().ready[sessionId]).toBe(true));
    expect(store.getState().views[sessionId]!.startSeq).toBeGreaterThan(0);
  }
  return { store, link, sessionId, release };
}

describe("history page ownership through a real host connection", () => {
  it("does not leak a bookmark lookup's unowned replay into the conversation that opens next", async () => {
    const { store, link, sessionId } = await setup(false);
    // SessionLookup reads metadata with a temporary RPC subscription before Session mounts.
    await link.call("sessions.subscribe", { sessionId, fromSeq: 0 });
    await link.call("sessions.unsubscribe", { sessionId });
    const shown: boolean[] = [];
    const stop = store.subscribe((state, previous) => {
      if (state.views[sessionId] !== previous.views[sessionId] && state.views[sessionId]?.items.length)
        shown.push(!!state.ready[sessionId]);
    });
    cleanups.push(stop);
    store.getState().openSession(sessionId);
    await vi.waitFor(() => expect(store.getState().ready[sessionId]).toBe(true));
    expect(shown).toEqual([true]);
  });

  it("lets a reopened conversation page immediately and ignores the abandoned response and cleanup", async () => {
    const { store, sessionId, release } = await setup();
    const from = store.getState().views[sessionId]!.startSeq;
    const earlier = store.getState().loadEarlier(sessionId);
    await vi.waitFor(() => expect(release).toHaveLength(1));
    store.getState().closeSession(sessionId);
    expect(store.getState().loadingEarlier[sessionId]).toBeUndefined();
    store.getState().openSession(sessionId);
    await vi.waitFor(() => expect(store.getState().ready[sessionId]).toBe(true));
    const current = store.getState().loadEarlier(sessionId);
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release[0]!();
    expect(await earlier).toBe(false);
    expect(store.getState().views[sessionId]!.startSeq).toBe(from);
    expect(store.getState().loadingEarlier[sessionId]).toBe(true);
    release[1]!();
    expect(await current).toBe(true);
    expect(store.getState().views[sessionId]!.startSeq).toBeLessThan(from);
    expect(store.getState().loadingEarlier[sessionId]).toBeUndefined();
  });

  it("does not queue a stale page while offline and allows a fresh page after reconnect", async () => {
    const { store, sessionId, release } = await setup();
    const earlier = store.getState().loadEarlier(sessionId);
    await vi.waitFor(() => expect(release).toHaveLength(1));
    store.getState().disconnect();
    expect(store.getState().loadingEarlier[sessionId]).toBeUndefined();
    expect(await store.getState().loadEarlier(sessionId)).toBe(false);
    expect(await earlier).toBe(false);
    store.getState().connect();
    await vi.waitFor(() => expect(store.getState().ready[sessionId]).toBe(true));
    const current = store.getState().loadEarlier(sessionId);
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release[1]!();
    expect(await current).toBe(true);
    expect(store.getState().loadingEarlier[sessionId]).toBeUndefined();
  });
});
