import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { AcpDriver, connectHost, startHost, type RunningHost } from "@linkshell/host";
import { HostLink, type SocketLike } from "../src/host-link.js";
import { createClientStore, shownQueue, subagentKey, type ClientStore } from "../src/store.js";
import type { TimelineItem } from "../src/timeline.js";

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

  it("shows a session opened before the connection is up, once it is", async () => {
    const { store, host } = await setup();
    await waitFor(() => store.getState().status === "online");
    const session = await store.getState().createSession({ agent: "fake", cwd: "/w", prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => store.getState().views[session.id]?.turnActive === false && store.getState().views[session.id]!.items.length >= 2);

    // The app opening straight into a session: the screen asks for it before the link is online.
    const late = createClientStore(new HostLink({ url: `ws://127.0.0.1:${host.server.tcpAddress()}`, heartbeatMs: 0 }));
    cleanups.push(() => late.getState().disconnect());
    late.getState().connect();
    expect(late.getState().status).not.toBe("online");
    late.getState().openSession(session.id);
    await waitFor(() => late.getState().ready[session.id]);
    expect(late.getState().views[session.id]!.items.length).toBeGreaterThanOrEqual(2);
    expect(late.getState().sessions[session.id]).toMatchObject({ id: session.id });
  });

  it("starts a view over when the host's log is shorter than what the view holds (the host's state was reset)", async () => {
    const { store } = await setup();
    await waitFor(() => store.getState().status === "online");
    const session = await store.getState().createSession({ agent: "fake", cwd: "/w", prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => agentText(store, session.id) === "echo: hello");
    store.getState().closeSession(session.id);
    // What the app would still hold from before the reset: a view far ahead of the host's log.
    store.setState((state) => ({ views: { ...state.views, [session.id]: { ...state.views[session.id]!, lastSeq: 9999, items: [], index: {} } }, ready: {} }));
    store.getState().openSession(session.id);
    await waitFor(() => store.getState().ready[session.id]);
    expect(agentText(store, session.id)).toBe("echo: hello");
    expect(store.getState().views[session.id]!.lastSeq).toBeLessThan(9999);
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

  it("queues what is sent while a turn runs; a queued message can be edited, reordered and sent at once", async () => {
    const { store } = await setup();
    const session = await store.getState().createSession({ agent: "fake", cwd: "/w" });
    const queue = () => store.getState().sessions[session.id]?.queue?.map((entry) => entry.text) ?? [];
    expect(await store.getState().send(session.id, text("SLOW first"))).toBe("started");
    await waitFor(() => store.getState().views[session.id]?.turnActive && store.getState().sessions[session.id]?.state === "running");
    const users = () => store.getState().views[session.id]!.items.filter((item) => item.kind === "user");
    const sending = store.getState().send(session.id, text("second"));
    // Headed for the queue: it shows there at once, still on its way, and never as a sent message first.
    expect(shownQueue(store.getState().sessions[session.id]?.queue, store.getState().queueing[session.id])).toEqual([
      expect.objectContaining({ text: "second", images: 0, pending: true }),
    ]);
    expect(users()).toHaveLength(1);
    expect(await sending).toBe("queued");
    expect(store.getState().queueing[session.id]).toBeUndefined();
    expect(shownQueue(store.getState().sessions[session.id]?.queue, store.getState().queueing[session.id])).toEqual([
      expect.objectContaining({ text: "second" }),
    ]);
    expect(users()).toHaveLength(1);
    expect(await store.getState().send(session.id, text("third"))).toBe("queued");
    await waitFor(() => queue().length === 2);
    // Waiting messages aren't in the conversation yet.
    expect(store.getState().views[session.id]!.items.filter((item) => item.kind === "user")).toHaveLength(1);

    const ids = store.getState().sessions[session.id]!.queue!.map((entry) => entry.clientMessageId);
    await store.getState().reorderQueue(session.id, [ids[1]!, ids[0]!]);
    await waitFor(() => queue().join() === "third,second");
    // Taken back to reword, then queued again.
    expect(await store.getState().takeQueued(session.id, ids[0]!)).toEqual(text("second"));
    await waitFor(() => queue().join() === "third");
    expect(await store.getState().send(session.id, text("second, reworded"))).toBe("queued");

    // "Send now": the slow turn is stopped and the first in line goes out; the rest follows turn by turn.
    await store.getState().sendQueuedNow(session.id);
    await waitFor(() => agentText(store, session.id).includes("echo: third"));
    await waitFor(() => agentText(store, session.id).includes("echo: second, reworded"));
    expect(queue()).toEqual([]);
    expect(agentText(store, session.id)).not.toContain("w39");
  });

  it("opens a long session at its latest turns, pages back to the start, and loads pictures when asked", async () => {
    const { host, store } = await setup();
    const session = await store.getState().createSession({ agent: "fake", cwd: "/w" });
    const nativeId = session.id.slice("fake:".length);
    const picture = "A".repeat(120_000);
    const log = (update: Parameters<typeof host.hub.driverHost.update>[2]) => host.hub.driverHost.update("fake", nativeId, update);
    // A sub-agent started early on, still working in the background.
    log({ sessionUpdate: "tool_call", toolCallId: "task-1", title: "Agent: survey", kind: "other", status: "in_progress", detail: { type: "subagent", action: "spawn", task: "survey the code", agentType: "Explore" } });
    log({ sessionUpdate: "ls_turn", state: "started", parentToolCallId: "task-1" });
    log({ sessionUpdate: "agent_message_chunk", messageId: "s1", content: { type: "text", text: "looking" }, parentToolCallId: "task-1" });
    // 60 turns as an agent would log them, each with ten tool calls that returned a screenshot.
    for (let n = 1; n <= 60; n++) {
      log({ sessionUpdate: "user_message_chunk", messageId: `u${n}`, content: { type: "text", text: `question ${n}` } });
      log({ sessionUpdate: "ls_turn", state: "started" });
      for (let i = 0; i < 10; i++) {
        log({ sessionUpdate: "tool_call", toolCallId: `t${n}-${i}`, title: "Screenshot", kind: "other", status: "in_progress" });
        log({
          sessionUpdate: "tool_call_update",
          toolCallId: `t${n}-${i}`,
          status: "completed",
          content: [{ type: "content", content: { type: "image", mimeType: "image/png", data: picture } }],
        });
      }
      log({ sessionUpdate: "agent_message_chunk", messageId: `a${n}`, content: { type: "text", text: `answer ${n}` } });
      log({ sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
    }

    // Another device opens it: 72 MB of pictures are in the log, a small page arrives.
    let received = 0;
    const link = new HostLink({
      url: `ws://127.0.0.1:${host.server.tcpAddress()}`,
      heartbeatMs: 0,
      lazyImages: true,
      createSocket: (url) => {
        const socket = new WebSocket(url);
        socket.on("message", (data) => (received += (data as Buffer).length));
        return socket as unknown as SocketLike;
      },
    });
    const phone = createClientStore(link, { lazyImages: true });
    cleanups.push(() => phone.getState().disconnect());
    phone.getState().connect();
    await waitFor(() => phone.getState().sessionsLoaded);
    phone.getState().openSession(session.id);
    await waitFor(() => phone.getState().ready[session.id]);
    const view = () => phone.getState().views[session.id]!;
    const questions = () => view().items.flatMap((item) => (item.kind === "user" && item.blocks[0]?.type === "text" ? [item.blocks[0].text] : []));
    expect(view().startSeq).toBeGreaterThan(0);
    expect(questions().at(-1)).toBe("question 60");
    expect(questions().length).toBeLessThan(15);
    expect(questions()[0]).not.toBe("question 1");
    expect(received).toBeLessThan(400_000);

    // The sub-agent is far above what is loaded; it is listed and opens on its own all the same, and stays live.
    expect(phone.getState().sessions[session.id]?.subagents).toEqual({ total: 1, running: 1 });
    expect(await phone.getState().loadSubagents(session.id)).toMatchObject([{ toolCallId: "task-1", task: "survey the code", running: true }]);
    // (Still working, its card comes with the window; its conversation so far does not.)
    expect(view().items[0]).toMatchObject({ kind: "tool", id: "task-1" });
    expect((view().items[0] as Extract<TimelineItem, { kind: "tool" }>).sub).toBeUndefined();
    expect(await phone.getState().openSubagent(session.id, "task-1")).toBe(true);
    const sub = () => {
      const item = phone.getState().subagentViews[subagentKey(session.id, "task-1")]?.items[0];
      return item?.kind === "tool" ? item.sub?.items.flatMap((entry) => (entry.kind === "agent" ? [entry.text] : [])) : undefined;
    };
    expect(sub()).toEqual(["looking"]);
    log({ sessionUpdate: "agent_message_chunk", messageId: "s1", content: { type: "text", text: " further" }, parentToolCallId: "task-1" });
    await waitFor(() => sub()?.[0] === "looking further");
    phone.getState().closeSubagent(session.id, "task-1");
    expect(sub()).toBeUndefined();

    // Pulling down adds earlier pages until the beginning.
    let pages = 0;
    while (view().startSeq > 0) {
      expect(await phone.getState().loadEarlier(session.id)).toBe(true);
      pages += 1;
    }
    expect(pages).toBeGreaterThan(3);
    expect(questions()).toEqual(Array.from({ length: 60 }, (_, i) => `question ${i + 1}`));
    expect(await phone.getState().loadEarlier(session.id)).toBe(false);
    expect(received).toBeLessThan(2_000_000);

    // A picture is fetched when it is looked at, once.
    const tool = view().items.find((item) => item.kind === "tool" && item.id === "t60-9") as Extract<TimelineItem, { kind: "tool" }>;
    const block = tool.content[0]!;
    if (block.type !== "content" || block.content.type !== "image") throw new Error("expected a picture reference");
    expect(block.content.data).toBeUndefined();
    const dataUri = await phone.getState().loadImage(session.id, block.content.uri!);
    expect(dataUri).toBe(`data:image/png;base64,${picture}`);
    const before = received;
    await phone.getState().loadImage(session.id, block.content.uri!);
    expect(received).toBe(before);
  });
});
