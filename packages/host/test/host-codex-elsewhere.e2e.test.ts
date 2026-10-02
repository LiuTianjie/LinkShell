import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ABANDON, RpcPeer, type SessionEvent } from "@linkshell/wire";
import { connectHost } from "../src/rpc/client.js";
import { startHost, type RunningHost } from "../src/host.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";

// Codex lets one process have a thread loaded at a time. These are the
// threads loaded somewhere other than the host's own app-server: in Codex's
// background server (a plain `codex` in a terminal), which the host joins, and
// in a Codex that takes no other clients (the desktop app), which it can read,
// leave messages for in Codex's own queue, and ask to stop through the app's bus.

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (t: string) => [{ type: "text" as const, text: t }];
const input = (t: string) => [{ type: "text", text: t, text_elements: [] }];
const slowText = Array.from({ length: 40 }, (_, i) => `w${i} `).join("");

/** A device: everything it receives, and what that adds up to. */
async function recorder(host: RunningHost) {
  const client = await connectHost(host.paths.hostSocket);
  const events: SessionEvent[] = [];
  client.on("session.event", (event) => events.push(event));
  const of = (sessionId: string) => events.filter((e) => e.sessionId === sessionId);
  return {
    client,
    of,
    kinds: (sessionId: string) => of(sessionId).map((e) => e.update.sessionUpdate),
    agentText: (sessionId: string) =>
      of(sessionId)
        .map((e) => (e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text" ? e.update.content.text : ""))
        .join(""),
    said: (sessionId: string) =>
      of(sessionId).flatMap((e) => (e.update.sessionUpdate === "user_message_chunk" && e.update.content.type === "text" ? [e.update.content.text] : [])),
    turnsStarted: (sessionId: string) => of(sessionId).filter((e) => e.update.sessionUpdate === "ls_turn" && e.update.state === "started"),
    turnsEnded: (sessionId: string) => of(sessionId).filter((e) => e.update.sessionUpdate === "ls_turn" && e.update.state === "ended"),
    tools: (sessionId: string) => of(sessionId).flatMap((e) => (e.update.sessionUpdate === "tool_call" || e.update.sessionUpdate === "tool_call_update" ? [e.update] : [])),
  };
}

/** A plain `codex` in a terminal: a client of the background server. It sees approval requests; `approves` makes it answer them. */
async function terminalCodex(socketPath: string, options: { approves?: boolean } = {}) {
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const notes: { method: string; params: { item?: { text?: string }; turn?: { status?: string } } }[] = [];
  const peer = new RpcPeer({
    send: (t) => socket.send(t),
    onNotification: (method, params) => notes.push({ method, params: params as (typeof notes)[number]["params"] }),
    onRequest: () => (options.approves ? { decision: "accept" } : ABANDON),
  });
  socket.on("message", (data) => peer.receive(data.toString()));
  await peer.request("initialize", { clientInfo: { name: "codex-tui", title: null, version: "0" }, capabilities: null });
  return { peer, notes, close: () => socket.close() };
}

/** A Codex that takes no other clients (the desktop app): it writes a thread to the disk the Codex processes share, and holds it. */
function deskCodex(disk: string, id: string, cwd: string) {
  const seconds = () => Math.floor(Date.now() / 1000);
  const stored = {
    meta: { id, cwd, name: "On the desk", preview: "", model: "fake-model", createdAt: seconds(), updatedAt: seconds() },
    archived: false,
    turns: [] as { id: string; status: string; startedAt: number; completedAt: number | null; items: Record<string, unknown>[] }[],
  };
  const write = () => writeFileSync(join(disk, `${id}.json`), JSON.stringify(stored));
  const turn = () => stored.turns[stored.turns.length - 1]!;
  return {
    hold: () => writeFileSync(join(disk, `${id}.lock`), String(process.pid)),
    letGo: () => rmSync(join(disk, `${id}.lock`), { force: true }),
    startTurn(message: string) {
      const turnId = `turn-${stored.turns.length + 1}`;
      stored.turns.push({
        id: turnId,
        status: "inProgress",
        startedAt: seconds(),
        completedAt: null,
        items: [{ type: "userMessage", id: `${turnId}-user`, clientId: null, content: input(message) }],
      });
      write();
    },
    add(item: Record<string, unknown>) {
      turn().items.push(item);
      write();
    },
    finish(itemId: string, result: Record<string, unknown>) {
      Object.assign(turn().items.find((item) => item.id === itemId)!, result);
      write();
    },
    endTurn(status = "completed") {
      turn().status = status;
      turn().completedAt = seconds();
      write();
    },
    turnId: () => turn().id,
    /** A turn started with a message from another program. */
    start(clientId: string, content: Record<string, unknown>[]) {
      const turnId = `turn-${stored.turns.length + 1}`;
      stored.turns.push({ id: turnId, status: "inProgress", startedAt: seconds(), completedAt: null, items: [{ type: "userMessage", id: `${turnId}-user`, clientId, content }] });
      write();
    },
    queue: (): { clientUserMessageId: string; input: Record<string, unknown>[] }[] => {
      const path = join(disk, `${id}.queue.json`);
      if (!existsSync(path)) return [];
      // (Read while the other process is writing it, the file is empty for a moment.)
      for (;;) {
        const text = readFileSync(path, "utf8");
        if (text) return JSON.parse(text);
      }
    },
    /** As Codex does when the thread is idle: starts the first message waiting in its queue. */
    runQueued(reply: string) {
      const [next, ...rest] = this.queue();
      writeFileSync(join(disk, `${id}.queue.json`), JSON.stringify(rest));
      const turnId = `turn-${stored.turns.length + 1}`;
      stored.turns.push({
        id: turnId,
        status: "completed",
        startedAt: seconds(),
        completedAt: seconds(),
        items: [
          { type: "userMessage", id: `${turnId}-user`, clientId: next!.clientUserMessageId, content: next!.input },
          { type: "agentMessage", id: `${turnId}-reply`, text: reply },
        ],
      });
      write();
    },
  };
}

/**
 * The desktop app's end of the bus its windows share (length-prefixed JSON):
 * it registers whoever connects, asks it — as it asks every client — whether
 * it runs some thread, and answers a request about a thread it runs itself.
 */
function desktopBus(path: string, handle: (request: { method: string; params: Record<string, unknown> }) => unknown) {
  const requests: Record<string, unknown>[] = [];
  const discoveryAnswers: unknown[] = [];
  const owners: unknown[] = [];
  const server = createServer((socket: Socket) => {
    let buffered = Buffer.alloc(0);
    const write = (message: Record<string, unknown>) => {
      const body = Buffer.from(JSON.stringify(message), "utf8");
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length, 0);
      socket.write(Buffer.concat([head, body]));
    };
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
        const length = buffered.readUInt32LE(0);
        const message = JSON.parse(buffered.subarray(4, 4 + length).toString("utf8"));
        buffered = buffered.subarray(4 + length);
        if (message.type === "client-discovery-response") discoveryAnswers.push(message.response);
        if (message.type !== "request") continue;
        if (message.method === "initialize") {
          write({ type: "response", requestId: message.requestId, resultType: "success", method: "initialize", handledByClientId: "client-9", result: { clientId: "client-9" } });
          write({ type: "client-discovery-request", requestId: "who-runs-it", request: { type: "request", method: "thread-owner-discovery", params: {} } });
          continue;
        }
        if (message.method === "thread-owner-discovery") {
          // The window that runs the thread answers for it; the request proper is then sent to that window.
          owners.push(message.params);
          write({ type: "response", requestId: message.requestId, resultType: "success", method: message.method, handledByClientId: "owner", result: { supportsUntrustedAppInput: true } });
          continue;
        }
        requests.push({ method: message.method, version: message.version, sourceClientId: message.sourceClientId, targetClientId: message.targetClientId, params: message.params });
        try {
          write({ type: "response", requestId: message.requestId, resultType: "success", method: message.method, handledByClientId: "owner", result: handle(message) });
        } catch (error) {
          write({ type: "response", requestId: message.requestId, resultType: "error", error: (error as Error).message });
        }
      }
    });
  });
  server.listen(path);
  return { requests, discoveryAnswers, owners, close: () => new Promise((resolve) => server.close(resolve)) };
}

let home: string;
let disk: string;
let sharedSocket: string;
let busSocket: string;
let shared: ChildProcess;
let host: RunningHost;
let phone: Awaited<ReturnType<typeof recorder>>;
const logs: string[] = [];

function startShared(): ChildProcess {
  return spawn(process.execPath, [FAKE_CODEX, "app-server", "--listen", `unix://${sharedSocket}`], {
    env: { ...process.env, FAKE_CODEX_DISK: disk },
    stdio: "ignore",
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "lsh-else-"));
  disk = join(home, "codex-disk");
  sharedSocket = join(home, "shared.sock");
  busSocket = join(home, "bus.sock");
  chmodSync(FAKE_CODEX, 0o755);
  shared = startShared();
  await waitFor(() => existsSync(sharedSocket));
  host = await startHost({
    home,
    version: "test",
    discoveryIntervalMs: 0,
    drivers: (paths) => [
      new CodexDriver({
        socketPath: paths.codexSocket,
        command: FAKE_CODEX,
        env: { ...process.env, FAKE_CODEX_DISK: disk },
        hostVersion: "test",
        sharedSocketPath: sharedSocket,
        desktopBusPath: busSocket,
        observeIntervalMs: 20,
        releaseDelayMs: 150,
      }),
    ],
    log: (message) => logs.push(message),
  });
  phone = await recorder(host);
});

afterAll(async () => {
  phone?.client.close();
  await host?.stop();
  shared?.kill();
  rmSync(home, { recursive: true, force: true });
});

const prompt = (sessionId: string, clientMessageId: string, message: string) =>
  phone.client.call("sessions.prompt", { sessionId, clientMessageId, content: text(message) });

describe("a Codex thread held by a Codex that can't be joined (the desktop app)", () => {
  const id = "codex:desk-thread";
  let desk: ReturnType<typeof deskCodex>;

  it("opens with what that Codex has finished so far, and shows it as running there", async () => {
    desk = deskCodex(disk, "desk-thread", "/desk/project");
    desk.hold();
    desk.startTurn("fix the build");
    desk.add({ type: "agentMessage", id: "a1", text: "Looking." });
    desk.add({ type: "commandExecution", id: "c1", command: "make", cwd: "/desk/project", status: "inProgress" });
    await host.hub.refreshDiscovery();

    await phone.client.call("sessions.subscribe", { sessionId: id, fromSeq: 0 });
    expect(phone.said(id)).toEqual(["fix the build"]);
    expect(phone.agentText(id)).toBe("Looking.");
    // The command still running there isn't shown half-done.
    expect(phone.tools(id)).toEqual([]);
    expect(host.hub.getSession(id)).toMatchObject({ state: "running", driver: "desktop" });
    const notice = phone.of(id).find((e) => e.update.sessionUpdate === "ls_notice")?.update;
    expect(notice).toMatchObject({ title: expect.stringContaining("另一个 Codex") });
    expect(logs.filter((line) => line.includes("attach"))).toEqual([]);
  });

  it("follows what that Codex writes, each item once and only when it is complete", async () => {
    desk.finish("c1", { status: "completed", exitCode: 0, aggregatedOutput: "ok\n", durationMs: 5 });
    desk.add({ type: "agentMessage", id: "a2", text: "Built." });
    await waitFor(() => phone.agentText(id) === "Looking.Built.");
    expect(phone.tools(id)).toEqual([
      expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "c1", title: "make", status: "completed" }),
      expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", appendOutput: "ok\n" }),
    ]);
    // Looked at again and again, nothing comes twice.
    await sleep(100);
    expect(phone.kinds(id).filter((kind) => kind === "ls_message_done")).toHaveLength(2);
    expect(phone.tools(id)).toHaveLength(2);
  });

  it("leaves a message from the phone in Codex's own queue, which that Codex starts when its turn ends", async () => {
    expect(await prompt(id, "d0", "never mind")).toEqual({ delivery: "queued" });
    expect(await prompt(id, "d1", "from the phone")).toEqual({ delivery: "queued" });
    expect(host.hub.getSession(id).queue).toEqual([
      { clientMessageId: "d0", text: "never mind", images: 0 },
      { clientMessageId: "d1", text: "from the phone", images: 0 },
    ]);
    // Taken back before it started.
    expect(await phone.client.call("sessions.unqueue", { sessionId: id, clientMessageId: "d0" })).toEqual({ removed: true });
    await waitFor(() => desk.queue().length === 1);
    expect(desk.queue()[0]).toMatchObject({ clientUserMessageId: "d1", input: [{ type: "text", text: "from the phone" }] });
    // What only the app-server that has the thread can do isn't queued.
    await expect(prompt(id, "d2", "/compact")).rejects.toMatchObject({ appCode: "busy", message: expect.stringContaining("另一个 Codex") });
    expect(phone.said(id)).toEqual(["fix the build"]);

    desk.endTurn();
    desk.runQueued("On it.");
    await waitFor(() => phone.agentText(id) === "Looking.Built.On it.");
    // The phone's own copy of the message is the one that shows as sent.
    const sent = phone.of(id).find((e) => e.update.sessionUpdate === "user_message_chunk" && e.update.messageId === "local-d1");
    expect(sent?.update).toMatchObject({ content: { type: "text", text: "from the phone" } });
    await waitFor(() => host.hub.getSession(id).queue === undefined);
    expect(host.hub.getSession(id).state).toBe("idle");
  });

  it("stops its turn by asking the desktop app, and says so when that can't be done", async () => {
    desk.startTurn("a long job");
    await waitFor(() => host.hub.getSession(id).state === "running");
    // No desktop app to ask.
    await expect(phone.client.call("sessions.cancel", { sessionId: id })).rejects.toMatchObject({
      appCode: "busy",
      message: expect.stringMatching(/Codex 桌面 App.*请在电脑上停止/),
    });

    const bus = desktopBus(busSocket, (request) => {
      desk.endTurn("interrupted");
      return { interruptedTurnId: request.params.expectedTurnId, ok: true };
    });
    await waitFor(() => existsSync(busSocket));
    await phone.client.call("sessions.cancel", { sessionId: id });
    expect(bus.requests).toEqual([
      {
        method: "thread-follower-interrupt-turn",
        version: 4,
        sourceClientId: "client-9",
        targetClientId: "owner",
        params: { conversationId: "desk-thread", mode: "user-stop", expectedTurnId: desk.turnId() },
      },
    ]);
    expect(bus.owners).toEqual([{ hostId: "local", conversationId: "desk-thread" }]);
    // Asked, like every client on the bus, whether it runs a thread: it never does.
    expect(bus.discoveryAnswers).toEqual([{ canHandle: false }]);
    await waitFor(() => host.hub.getSession(id).state === "idle");
    // The app refusing is "can't be stopped from here" too.
    desk.startTurn("another long job");
    await waitFor(() => host.hub.getSession(id).state === "running");
    await bus.close();
    const refusing = desktopBus(busSocket, () => {
      throw new Error("no-client-found");
    });
    await expect(phone.client.call("sessions.cancel", { sessionId: id })).rejects.toMatchObject({ appCode: "busy" });
    await refusing.close();
    desk.endTurn();
    await waitFor(() => host.hub.getSession(id).state === "idle");
  });

  it("puts a waiting message into the running turn, and starts one at once when idle, by asking the desktop app", async () => {
    desk.startTurn("a third long job");
    await waitFor(() => host.hub.getSession(id).state === "running");
    expect(await prompt(id, "s1", "look at main only")).toEqual({ delivery: "queued" });
    await waitFor(() => desk.queue().length === 1);
    // No desktop app to ask: it stays waiting, and the phone is told what can be done instead.
    await expect(phone.client.call("sessions.sendQueued", { sessionId: id, clientMessageId: "s1" })).rejects.toMatchObject({
      appCode: "busy",
      message: expect.stringContaining("Steer"),
    });
    expect(desk.queue()).toHaveLength(1);

    const bus = desktopBus(busSocket, (request) => {
      const params = request.params as { clientUserMessageId?: string; input?: Record<string, unknown>[]; turnStart?: { request: { clientUserMessageId: string; input: Record<string, unknown>[] } } };
      if (request.method === "thread-follower-steer-turn") {
        desk.add({ type: "userMessage", id: `steered-${params.clientUserMessageId}`, clientId: params.clientUserMessageId, content: params.input });
        return { result: { turnId: desk.turnId() } };
      }
      desk.start(params.turnStart!.request.clientUserMessageId, params.turnStart!.request.input);
      return { result: { turn: { id: desk.turnId() } } };
    });
    await waitFor(() => existsSync(busSocket));
    await phone.client.call("sessions.sendQueued", { sessionId: id, clientMessageId: "s1" });
    expect(bus.requests).toEqual([
      {
        method: "thread-follower-steer-turn",
        version: 1,
        sourceClientId: "client-9",
        targetClientId: "owner",
        params: expect.objectContaining({
          conversationId: "desk-thread",
          clientUserMessageId: "s1",
          input: [expect.objectContaining({ type: "text", text: "look at main only" })],
          // The app reads these from every message it steers.
          restoreMessage: expect.objectContaining({ id: "s1", text: "look at main only", cwd: "/desk/project", context: expect.objectContaining({ prompt: "look at main only" }) }),
        }),
      },
    ]);
    // In the turn, as the phone's own message, and no longer waiting anywhere.
    await waitFor(() => phone.of(id).some((e) => e.update.sessionUpdate === "user_message_chunk" && e.update.messageId === "local-s1"));
    await waitFor(() => host.hub.getSession(id).queue === undefined);
    expect(desk.queue()).toEqual([]);

    desk.endTurn();
    await waitFor(() => host.hub.getSession(id).state === "idle");
    // Idle: started there at once instead of waiting in the queue.
    expect(await prompt(id, "s2", "and now the server")).toEqual({ delivery: "started" });
    expect(bus.requests[1]).toMatchObject({
      method: "thread-follower-start-turn",
      version: 2,
      targetClientId: "owner",
      params: { conversationId: "desk-thread", turnStart: { request: { threadId: "desk-thread", clientUserMessageId: "s2", input: [{ type: "text", text: "and now the server" }] }, context: {} } },
    });
    expect(desk.queue()).toEqual([]);
    await waitFor(() => phone.of(id).some((e) => e.update.sessionUpdate === "user_message_chunk" && e.update.messageId === "local-s2"));
    await waitFor(() => host.hub.getSession(id).state === "running");
    desk.endTurn();
    await waitFor(() => host.hub.getSession(id).state === "idle");
    await bus.close();
  });

  it("is an ordinary session again once that Codex lets go, with nothing twice and nothing missing", async () => {
    // Written just before it closed, after the host last looked.
    desk.startTurn("one more thing");
    desk.add({ type: "agentMessage", id: "a3", text: "Done." });
    desk.endTurn();
    desk.letGo();

    expect(await prompt(id, "d3", "from the phone again")).toEqual({ delivery: "started" });
    await waitFor(() => phone.turnsEnded(id).length === 1);
    expect(phone.said(id)).toEqual(["fix the build", "from the phone", "a long job", "another long job", "a third long job", "look at main only", "and now the server", "one more thing", "from the phone again"]);
    expect(phone.agentText(id)).toBe("Looking.Built.On it.Done.echo: from the phone again");
    expect(phone.tools(id)).toHaveLength(2);
    expect(host.hub.getSession(id)).toMatchObject({ state: "idle", driver: "none" });
    // What the phone has is the log, in order.
    expect(phone.of(id).map((e) => e.seq)).toEqual(Array.from({ length: phone.of(id).length }, (_, i) => i + 1));

    // Nobody has it open: the host lets go of it, and that Codex can open it again.
    await phone.client.call("sessions.unsubscribe", { sessionId: id });
    await waitFor(() => !existsSync(join(disk, "desk-thread.lock")));
  });
});

describe("a Codex thread the host loaded itself", () => {
  it("is let go when no device has it open, so another Codex can open it — unless it has left something running", async () => {
    const started = async (message: string) => {
      const { session } = await phone.client.call("sessions.create", { agent: "codex", cwd: "/own/project" });
      await phone.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
      await prompt(session.id, `own-${message}`, message);
      await waitFor(() => phone.turnsEnded(session.id).length === 1);
      await phone.client.call("sessions.unsubscribe", { sessionId: session.id });
      return session;
    };
    const plain = await started("hello");
    const serving = await started("BACKGROUND start the dev server");
    // Idle and unwatched: unloaded, its lock gone, and a terminal's Codex can load it.
    await waitFor(() => !existsSync(join(disk, `${plain.nativeId}.lock`)));
    const terminal = await terminalCodex(sharedSocket);
    await terminal.peer.request("thread/resume", { threadId: plain.nativeId });
    terminal.close();
    // The one with a dev server running stays loaded: unloading it would end the server.
    await sleep(400);
    expect(existsSync(join(disk, `${serving.nativeId}.lock`))).toBe(true);

    // Opened again on the phone, each carries on, once.
    await waitFor(() => !existsSync(join(disk, `${plain.nativeId}.lock`)));
    await phone.client.call("sessions.subscribe", { sessionId: plain.id, fromSeq: host.hub.getSession(plain.id).lastSeq });
    expect(await prompt(plain.id, "own-again", "again")).toEqual({ delivery: "started" });
    await waitFor(() => phone.turnsEnded(plain.id).length === 2);
    expect(phone.said(plain.id)).toEqual(["hello", "again"]);
    expect(phone.agentText(plain.id)).toBe("echo: helloecho: again");
  });
});

describe("a Codex thread in Codex's background server (a plain codex in a terminal)", () => {
  let terminal: Awaited<ReturnType<typeof terminalCodex>>;
  let threadId: string;
  let id: string;

  it("is joined there while its turn runs: the history once, then what happens next", async () => {
    terminal = await terminalCodex(sharedSocket);
    threadId = (await terminal.peer.request<{ thread: { id: string } }>("thread/start", { cwd: "/term/project" })).thread.id;
    id = `codex:${threadId}`;
    await terminal.peer.request("turn/start", { threadId, input: input("SLOW count") });
    // Some of the reply has been written by the time the phone opens the session.
    await waitFor(() => terminal.notes.filter((note) => note.method === "item/agentMessage/delta").length > 5);
    await host.hub.refreshDiscovery();

    await phone.client.call("sessions.subscribe", { sessionId: id, fromSeq: 0 });
    expect(logs.filter((line) => line.includes("attach"))).toEqual([]);
    expect(host.hub.getSession(id).state).toBe("running");
    expect(phone.turnsStarted(id)).toHaveLength(1);
    await waitFor(() => phone.turnsEnded(id).length === 1);
    // The message it was in the middle of arrives whole, not from where the phone came in.
    expect(phone.agentText(id)).toBe(slowText);
    expect(phone.said(id)).toEqual(["SLOW count"]);
    expect(host.hub.getSession(id)).toMatchObject({ state: "idle", preview: slowText.trim() });
    expect(host.hub.getSession(id).driver).toBeUndefined();
  });

  it("takes a message from the phone, which the terminal sees too", async () => {
    expect(await prompt(id, "s1", "from the phone")).toEqual({ delivery: "started" });
    await waitFor(() => phone.turnsEnded(id).length === 2);
    expect(phone.agentText(id)).toBe(`${slowText}echo: from the phone`);
    expect(terminal.notes.some((note) => note.method === "item/completed" && note.params.item?.text === "echo: from the phone")).toBe(true);
    // `linkshell codex` on this session goes to the server the thread is in, not the host's own.
    expect(await phone.client.call("desktop.launch", { agent: "codex", sessionId: id, args: [] })).toEqual({
      command: FAKE_CODEX,
      args: ["--remote", `unix://${sharedSocket}`, "resume", threadId],
    });
  });

  it("stops, from the phone, a turn the terminal started", async () => {
    await terminal.peer.request("turn/start", { threadId, input: input("SLOW again") });
    await waitFor(() => phone.agentText(id).endsWith("w2 "));
    await phone.client.call("sessions.cancel", { sessionId: id });
    const ended = await waitFor(() => phone.turnsEnded(id)[2]);
    expect(ended.update).toMatchObject({ stopReason: "cancelled" });
    expect(terminal.notes.some((note) => note.method === "turn/completed" && note.params.turn?.status === "interrupted")).toBe(true);
    expect(phone.agentText(id)).not.toContain("w39 w0");
  });

  it("puts an approval asked there to the phone, and the phone's answer through", async () => {
    await terminal.peer.request("turn/start", { threadId, input: input("RUN the build") });
    const request = await waitFor(() => phone.of(id).find((e) => e.update.sessionUpdate === "ls_permission"));
    const requestId = (request.update as { requestId: string }).requestId;
    expect(host.hub.getSession(id)).toMatchObject({ state: "waiting", pendingPermissions: 1 });
    await phone.client.call("sessions.permission", { sessionId: id, requestId, optionId: "accept" });
    await waitFor(() => phone.turnsEnded(id).length === 4);
    expect(phone.tools(id).some((update) => update.sessionUpdate === "tool_call_update" && update.appendOutput === "hi\n")).toBe(true);
    expect(host.hub.getSession(id)).toMatchObject({ state: "idle", pendingPermissions: 0 });
  });

  it("is let go when no device has it open, and opens again where the terminal can join it, with nothing twice", async () => {
    await phone.client.call("sessions.unsubscribe", { sessionId: id });
    terminal.close();
    // The terminal quit and the host stopped following: the background server unloads it,
    // and any Codex could open it now.
    await waitFor(() => !existsSync(join(disk, `${threadId}.lock`)));

    const before = phone.of(id).length;
    await phone.client.call("sessions.subscribe", { sessionId: id, fromSeq: host.hub.getSession(id).lastSeq });
    expect(await prompt(id, "s2", "back again")).toEqual({ delivery: "started" });
    await waitFor(() => phone.turnsEnded(id).length === 5);
    // A thread that lived in the background server is opened there again, not
    // in the host's own app-server: a `codex resume` in a terminal joins it.
    expect(Number(readFileSync(join(disk, `${threadId}.lock`), "utf8"))).toBe(shared.pid);
    const back = await terminalCodex(sharedSocket);
    const resumed = await back.peer.request<{ thread: { turns: unknown[] } }>("thread/resume", { threadId });
    expect(resumed.thread.turns).toHaveLength(5);
    back.close();
    const added = phone.of(id).slice(before);
    expect(added.flatMap((e) => (e.update.sessionUpdate === "user_message_chunk" ? [e.update.content] : []))).toEqual([{ type: "text", text: "back again" }]);
    expect(phone.said(id)).toEqual(["SLOW count", "from the phone", "SLOW again", "RUN the build", "back again"]);
    expect(phone.of(id).map((e) => e.seq)).toEqual(Array.from({ length: phone.of(id).length }, (_, i) => i + 1));
    await phone.client.call("sessions.unsubscribe", { sessionId: id });
  });

  it("shows a command that is running when it joins, and its result when it ends", async () => {
    const approving = await terminalCodex(sharedSocket, { approves: true });
    const started = await approving.peer.request<{ thread: { id: string } }>("thread/start", { cwd: "/term/other" });
    const other = `codex:${started.thread.id}`;
    await approving.peer.request("turn/start", { threadId: started.thread.id, input: input("RUN LONG") });
    await waitFor(() => approving.notes.some((note) => note.method === "item/commandExecution/outputDelta"));
    await host.hub.refreshDiscovery();

    await phone.client.call("sessions.subscribe", { sessionId: other, fromSeq: 0 });
    expect(phone.tools(other)).toEqual([expect.objectContaining({ sessionUpdate: "tool_call", title: "echo hi", status: "in_progress" })]);
    await waitFor(() => phone.turnsEnded(other).length === 1);
    // What it printed before the phone came in is there too.
    expect(phone.tools(other).at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed", appendOutput: "hi\n" });
    expect(phone.agentText(other)).toBe("echo: RUN LONG");
    expect(phone.said(other)).toEqual(["RUN LONG"]);
    approving.close();
  });

  it("carries on in the host's own app-server when the background server goes away", async () => {
    const again = await terminalCodex(sharedSocket);
    const started = await again.peer.request<{ thread: { id: string } }>("thread/start", { cwd: "/term/last" });
    const last = `codex:${started.thread.id}`;
    await again.peer.request("turn/start", { threadId: started.thread.id, input: input("first") });
    await waitFor(() => again.notes.some((note) => note.method === "turn/completed"));
    await host.hub.refreshDiscovery();
    await phone.client.call("sessions.subscribe", { sessionId: last, fromSeq: 0 });
    expect(phone.agentText(last)).toBe("echo: first");

    again.close();
    shared.kill();
    await waitFor(() => logs.some((line) => line.includes("lost Codex's background server")));
    expect(await prompt(last, "l1", "still here")).toEqual({ delivery: "started" });
    await waitFor(() => phone.agentText(last) === "echo: firstecho: still here");
    expect(phone.said(last)).toEqual(["first", "still here"]);
  });
});
