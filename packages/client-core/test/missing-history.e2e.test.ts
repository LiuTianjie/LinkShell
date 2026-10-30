import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { connectHost, HostStore, startHost } from "@linkshell/host";
import { HostLink, type SocketLike } from "../src/host-link.js";
import { createClientStore } from "../src/store.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor(check: () => unknown, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("deleted history against a real host", () => {
  it.each(["archived", "full-page"] as const)("leaves the loading state when a cached %s conversation was deleted while offline", async (scenario) => {
    const home = mkdtempSync(join(tmpdir(), "ls-missing-history-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const id = "fixture:missing-history";
    const now = Date.now();
    const seed = new HostStore(join(home, "state.db"));
    try {
      seed.upsertSession({ id, agent: "fixture", nativeId: "missing-history", cwd: home, title: "Previously loaded conversation", createdAt: now, updatedAt: now, state: "idle" });
      seed.appendEvent(id, { sessionUpdate: "agent_message_chunk", messageId: "reply", content: { type: "text", text: "History cached before disconnect" } }, now);
      seed.appendEvent(id, { sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" }, now);
      if (scenario === "archived") seed.patchSession(id, { archived: true });
      // A full first page cannot prove a cached session was deleted, and refresh
      // deliberately retains archived summaries regardless of the active list size.
      if (scenario === "full-page") for (let i = 0; i < 201; i++) {
        seed.upsertSession({ id: `fixture:other-${i}`, agent: "fixture", nativeId: `other-${i}`, cwd: home, createdAt: now - i - 1, updatedAt: now - i - 1, state: "idle" });
      }
    } finally { seed.close(); }

    const host = await startHost({ home, version: "missing-history-test", env: {}, drivers: () => [], tcpPort: 0, discoveryIntervalMs: 0, iceServers: false, log: () => {} });
    cleanups.push(() => host.stop());
    const admin = await connectHost(host.paths.hostSocket);
    cleanups.push(() => admin.close());
    const sockets: WebSocket[] = [];
    let missingReplies = 0;
    const link = new HostLink({
      url: `ws://127.0.0.1:${host.server.tcpAddress()}`,
      heartbeatMs: 0,
      createSocket: (url) => {
        const socket = new WebSocket(url);
        socket.on("message", (raw) => {
          const response = JSON.parse(String(raw)) as { error?: { data?: { code?: string } } };
          if (response.error?.data?.code === "not_found") missingReplies++;
        });
        sockets.push(socket);
        return socket as unknown as SocketLike;
      },
    });
    const store = createClientStore(link);
    cleanups.push(() => store.getState().disconnect());
    store.getState().connect();
    await waitFor(() => store.getState().sessionsLoaded, "initial session list");
    if (scenario === "archived") await store.getState().loadArchived();
    store.getState().openSession(id);
    await waitFor(() => store.getState().ready[id], "initial history subscription");
    expect(store.getState().views[id]?.items[0]).toMatchObject({ text: "History cached before disconnect" });

    const closed = new Promise<void>((resolve) => sockets[0]!.once("close", () => resolve()));
    store.getState().disconnect();
    await closed;
    await admin.call("sessions.delete", { sessionId: id });
    expect(store.getState().sessions[id]).toBeDefined();

    store.getState().connect();
    await waitFor(() => missingReplies > 0 && store.getState().status === "online", "authoritative missing-session response");
    await store.getState().refresh();
    const state = store.getState();
    expect((await link.call("sessions.list", { limit: 200 })).sessions).toHaveLength(scenario === "full-page" ? 200 : 0);
    // No stale summary remains to keep rendering the conversation's syncing state;
    // the existing route lookup can now report that the session no longer exists.
    expect(state.sessions[id]).toBeUndefined();
    expect(state.views[id]).toBeUndefined();
    expect(state.open[id]).toBeUndefined();
    expect(state.ready[id]).toBeUndefined();
    await expect(link.call("sessions.subscribe", { sessionId: id, fromSeq: 0 })).rejects.toMatchObject({ appCode: "not_found" });
  });
});
