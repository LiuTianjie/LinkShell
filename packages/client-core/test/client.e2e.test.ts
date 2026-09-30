import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { AcpDriver, connectHost, startHost, type RunningHost } from "@linkshell/host";
import { HostLink, type SocketLike } from "../src/host-link.js";
import { createClientStore, type ClientStore } from "../src/store.js";

const FAKE_ACP = fileURLToPath(new URL("../../host/test/fixtures/fake-acp.mjs", import.meta.url));
chmodSync(FAKE_ACP, 0o755);

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "lsh-client-"));
  const host: RunningHost = await startHost({
    home,
    version: "test",
    tcpPort: 0,
    drivers: () => [
      new AcpDriver(
        { id: "fake", label: "Fake", tier: "remote", command: FAKE_ACP, args: [], version: { command: FAKE_ACP, args: ["--version"] }, discover: true },
        { env: { ...process.env, FAKE_ACP_STORE: join(home, "store.json") }, hostVersion: "test" },
      ),
    ],
    log: () => {},
  });
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  cleanups.push(() => host.stop());
  const sockets: SocketLike[] = [];
  const link = new HostLink({
    url: `ws://127.0.0.1:${host.server.tcpAddress()}`,
    createSocket: (url) => {
      const socket = new WebSocket(url) as unknown as SocketLike;
      sockets.push(socket);
      return socket;
    },
    minBackoffMs: 50,
    maxBackoffMs: 200,
    requestTimeoutMs: 3000,
    heartbeatMs: 0,
  });
  let n = 0;
  const store: ClientStore = createClientStore(link, { newId: () => `c${++n}` });
  cleanups.push(() => store.getState().disconnect());
  store.getState().connect();
  await waitFor(() => store.getState().sessionsLoaded);
  return { host, link, store, sockets };
}

const text = (t: string) => [{ type: "text" as const, text: t }];
const agentText = (store: ClientStore, id: string) =>
  (store.getState().views[id]?.items ?? []).flatMap((i) => (i.kind === "agent" ? [i.text] : [])).join("|");

describe("client core against a real host", () => {
  it("connects, loads the machine and creates a session with an optimistic first message", async () => {
    const { store } = await setup();
    expect(store.getState()).toMatchObject({ status: "online", machine: { agents: [expect.objectContaining({ id: "fake", installed: true })] } });
    const session = await store.getState().createSession({ agent: "fake", cwd: "/w/app", prompt: text("hello") });
    const view = () => store.getState().views[session.id]!;
    expect(view().items[0]).toMatchObject({ kind: "user", id: "local-c1" });
    await waitFor(() => agentText(store, session.id) === "echo: hello");
    // The host's copy of the message replaced the optimistic one.
    expect(view().items.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(view().items[0]).not.toHaveProperty("pending", true);
    await waitFor(() => store.getState().sessions[session.id]?.title === "hello");
  });

  it("marks a session ready only once its whole backlog is applied", async () => {
    const { host, store } = await setup();
    const session = await store.getState().createSession({ agent: "fake", cwd: "/w/app", prompt: text("hello") });
    await waitFor(() => agentText(store, session.id) === "echo: hello");

    // A second device opens the same session from scratch.
    const other = createClientStore(new HostLink({ url: `ws://127.0.0.1:${host.server.tcpAddress()}`, heartbeatMs: 0 }));
    cleanups.push(() => other.getState().disconnect());
    other.getState().connect();
    await waitFor(() => other.getState().sessionsLoaded);
    other.getState().openSession(session.id);
    expect(other.getState().ready[session.id]).toBeUndefined();
    await waitFor(() => other.getState().ready[session.id]);
    expect(agentText(other, session.id)).toBe("echo: hello");
    other.getState().closeSession(session.id);
    expect(other.getState().ready[session.id]).toBeUndefined();
  });

  it("catches up exactly once after the connection drops while another device sends", async () => {
    const { host, store, sockets, link } = await setup();
    const session = await store.getState().createSession({ agent: "fake", cwd: "/w" });
    await store.getState().send(session.id, text("first"));
    await waitFor(() => agentText(store, session.id).includes("echo: first"));

    sockets[0]!.close();
    await waitFor(() => link.status !== "online");
    const other = await connectHost(host.paths.hostSocket);
    await other.call("sessions.prompt", { sessionId: session.id, clientMessageId: "other-1", content: text("while away") });
    await new Promise((resolve) => setTimeout(resolve, 150));
    other.close();

    await waitFor(() => link.status === "online");
    await waitFor(() => agentText(store, session.id).includes("echo: while away"));
    const texts = store.getState().views[session.id]!.items.flatMap((i) => (i.kind === "user" ? [i.blocks.map((b) => ("text" in b ? b.text : "")).join("")] : []));
    expect(texts).toEqual(["first", "while away"]);
    expect(agentText(store, session.id)).toBe("echo: first|echo: while away");
  });

  it("surfaces a permission request and resolves it", async () => {
    const { store } = await setup();
    const session = await store.getState().createSession({ agent: "fake", cwd: "/w" });
    await store.getState().send(session.id, text("RUN it"));
    const request = await waitFor(() => store.getState().views[session.id]?.permissions[0]);
    expect(request).toMatchObject({ title: "Run echo hi", detail: "echo hi" });
    await store.getState().respond(session.id, request.requestId, "allow-once");
    await waitFor(() => agentText(store, session.id).includes("echo: RUN it"));
    const view = store.getState().views[session.id]!;
    expect(view.permissions).toEqual([]);
    expect(view.items.some((i) => i.kind === "permission-result" && i.allowed)).toBe(true);
    expect(view.items.some((i) => i.kind === "tool" && i.status === "completed")).toBe(true);
  });

  it("keeps a message that couldn't be sent, and sends it on retry", async () => {
    const { store, host } = await setup();
    const session = await store.getState().createSession({ agent: "fake", cwd: "/w" });
    // A prompt the host rejects (empty content is invalid) fails without losing the draft.
    const bad = await store.getState().send(session.id, []);
    expect(bad).toBe("failed");
    const failed = store.getState().views[session.id]!.items.find((i) => i.kind === "user" && i.failed);
    expect(failed).toBeDefined();
    store.getState().discard(failed!.id.slice("local-".length));
    expect(store.getState().views[session.id]!.items.some((i) => i.id === failed!.id)).toBe(false);
    void host;
  });
});
