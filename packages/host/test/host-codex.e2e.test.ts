import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RpcPeer, type SessionEvent, type SessionSummary } from "@linkshell/wire";
import { connectHost, type HostClient } from "../src/rpc/client.js";
import { startHost, type RunningHost } from "../src/host.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";

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

/** A client that records everything it receives. */
async function recorder(host: RunningHost) {
  const client = await connectHost(host.paths.hostSocket);
  const events: SessionEvent[] = [];
  const summaries: SessionSummary[] = [];
  client.on("session.event", (event) => events.push(event));
  client.on("session.summary", ({ session }) => summaries.push(session));
  const of = (sessionId: string) => events.filter((e) => e.sessionId === sessionId);
  const agentText = (sessionId: string) =>
    of(sessionId)
      .map((e) => (e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text" ? e.update.content.text : ""))
      .join("");
  const turnsEnded = (sessionId: string) => of(sessionId).filter((e) => e.update.sessionUpdate === "ls_turn" && e.update.state === "ended");
  return { client, events, summaries, of, agentText, turnsEnded };
}

/** Plays the desktop TUI: a raw app-server client on the Codex socket, like `codex --remote`. */
async function rawCodexClient(socketPath: string) {
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const peer = new RpcPeer({ send: (text) => socket.send(text) });
  socket.on("message", (data) => peer.receive(data.toString()));
  await peer.request("initialize", { clientInfo: { name: "tui", title: null, version: "0" }, capabilities: null });
  return { peer, close: () => socket.close() };
}

const text = (t: string) => [{ type: "text" as const, text: t }];

let home: string;
let host: RunningHost;
let phone: Awaited<ReturnType<typeof recorder>>;
let laptop: Awaited<ReturnType<typeof recorder>>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "lsh-e2e-"));
  chmodSync(FAKE_CODEX, 0o755);
  host = await startHost({
    home,
    version: "test",
    drivers: (paths) => [
      new CodexDriver({
        socketPath: paths.codexSocket,
        command: FAKE_CODEX,
        env: { ...process.env, FAKE_CODEX_SEED: "1" },
        hostVersion: "test",
      }),
    ],
    log: () => {},
  });
  phone = await recorder(host);
  laptop = await recorder(host);
});

afterAll(async () => {
  phone?.client.close();
  laptop?.client.close();
  await host?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("host + Codex driver (fake app-server)", () => {
  let sessionId: string;

  it("reports the agent and discovers existing threads with their titles", async () => {
    const info = await phone.client.call("machine.info", {});
    expect(info.agents).toEqual([
      expect.objectContaining({
        id: "codex",
        installed: true,
        version: "0.0.0-fake",
        tier: "multi_client",
        auth: { state: "ok", method: "chatgpt" },
      }),
    ]);
    const { sessions } = await phone.client.call("sessions.list", {});
    const seeded = sessions.find((s) => s.title === "Seeded thread");
    expect(seeded).toMatchObject({ agent: "codex", cwd: "/seed/project", preview: "what is 2+2" });

    await phone.client.call("sessions.subscribe", { sessionId: seeded!.id, fromSeq: 0 });
    await waitFor(() => phone.of(seeded!.id).some((e) => e.update.sessionUpdate === "available_commands_update"));
    expect(phone.of(seeded!.id).map((e) => e.update.sessionUpdate).slice(0, 4)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
      "ls_message_done",
      "ls_status",
    ]);
    // What `/` offers: the commands the app-server can run, then the project's skills that are on.
    const commands = phone.of(seeded!.id).find((e) => e.update.sessionUpdate === "available_commands_update")?.update;
    expect(commands?.sessionUpdate === "available_commands_update" && commands.availableCommands.map((c) => c.name)).toEqual([
      "compact",
      "review",
      "init",
      "tidy",
    ]);
    const config = phone.of(seeded!.id).find((e) => e.update.sessionUpdate === "ls_config")?.update;
    expect(config).toMatchObject({
      options: expect.arrayContaining([expect.objectContaining({ id: "permissions", category: "mode" })]),
    });
  });

  it("creates a session from the phone and streams the reply", async () => {
    const { session } = await phone.client.call("sessions.create", { agent: "codex", cwd: home });
    sessionId = session.id;
    await phone.client.call("sessions.subscribe", { sessionId, fromSeq: 0 });
    expect(await phone.client.call("sessions.prompt", { sessionId, clientMessageId: "c1", content: text("hello world") })).toEqual({
      delivery: "started",
    });
    await waitFor(() => phone.turnsEnded(sessionId).length === 1);
    expect(phone.agentText(sessionId)).toBe("echo: hello world");
    const user = phone.of(sessionId).find((e) => e.update.sessionUpdate === "user_message_chunk");
    expect(user?.update).toMatchObject({ content: { type: "text", text: "hello world" } });
    expect(host.hub.getSession(sessionId)).toMatchObject({ state: "idle", title: "hello world", preview: "echo: hello world" });
  });

  it("runs /compact, /review and a skill from the phone the way the TUI does", async () => {
    const { session } = await phone.client.call("sessions.create", { agent: "codex", cwd: home });
    const id = session.id;
    await phone.client.call("sessions.subscribe", { sessionId: id, fromSeq: 0 });
    await phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: "k1", content: text("hello") });
    await waitFor(() => phone.turnsEnded(id).length === 1);
    const tools = () =>
      phone.of(id).flatMap((e) => (e.update.sessionUpdate === "tool_call" ? [e.update.title] : []));
    const said = () =>
      phone.of(id).flatMap((e) => (e.update.sessionUpdate === "user_message_chunk" && e.update.content.type === "text" ? [[e.update.messageId, e.update.content.text]] : []));

    expect(await phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: "k2", content: text("/compact") })).toEqual({ delivery: "started" });
    await waitFor(() => phone.turnsEnded(id).length === 2);
    expect(tools()).toEqual(["Context compacted"]);
    // The command shows as what the user sent, under the id the phone's own copy has.
    expect(said()).toContainEqual(["local-k2", "/compact"]);
    expect(phone.agentText(id)).toBe("echo: hello");

    await phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: "k3", content: text("/review only the tests") });
    await waitFor(() => phone.turnsEnded(id).length === 3);
    expect(tools()).toEqual(["Context compacted", "Review started", "Review finished"]);
    const started = phone.of(id).find((e) => e.update.sessionUpdate === "tool_call" && e.update.title === "Review started")?.update;
    expect(started).toMatchObject({ rawInput: { review: "only the tests" } });
    // Codex's instruction to itself isn't shown as something the user said; its findings, sent whole, are shown.
    expect(said().map(([, said]) => said)).toEqual(["hello", "/compact", "/review only the tests"]);
    expect(phone.agentText(id)).toBe("echo: hellolooks fine");

    // A skill goes as the skill itself plus `$name`, like the TUI sends it.
    await phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: "k4", content: text("/tidy the docs") });
    await waitFor(() => phone.turnsEnded(id).length === 4);
    expect(phone.agentText(id)).toBe("echo: hellolooks fineecho: $tidy the docs");
    const skill = phone.of(id).find((e) => e.update.sessionUpdate === "user_message_chunk" && e.update.content.type === "resource_link")?.update;
    expect(skill).toMatchObject({ messageId: "local-k4", content: { kind: "skill", name: "tidy", uri: "/skills/tidy/SKILL.md" } });

    // Not a command or a skill: an ordinary message.
    await phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: "k5", content: text("/etc/hosts has what") });
    await waitFor(() => phone.turnsEnded(id).length === 5);
    expect(phone.agentText(id)).toContain("echo: /etc/hosts has what");

    // Compacting waits for the turn to end rather than cutting into it.
    await phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: "k6", content: text("SLOW") });
    await waitFor(() => host.hub.getSession(id).state === "running");
    await expect(phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: "k7", content: text("/compact") })).rejects.toMatchObject({
      appCode: "busy",
    });
    expect(await phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: "k7", content: text("/compact"), whenBusy: "queue" })).toEqual({
      delivery: "queued",
    });
    await waitFor(() => phone.turnsEnded(id).length === 7);
    expect(tools().filter((title) => title === "Context compacted")).toHaveLength(2);
  });

  it("gives a second client the identical log, and a retried send is not delivered twice", async () => {
    await laptop.client.call("sessions.subscribe", { sessionId, fromSeq: 0 });
    // (The last live event may still be on its way to the phone's own connection.)
    await waitFor(() => phone.of(sessionId).length === laptop.of(sessionId).length);
    expect(laptop.of(sessionId).map((e) => e.seq)).toEqual(phone.of(sessionId).map((e) => e.seq));
    expect(await phone.client.call("sessions.prompt", { sessionId, clientMessageId: "c1", content: text("hello world") })).toEqual({
      delivery: "duplicate",
    });
  });

  it("lets one client interrupt a turn another client started, and steer into a running turn", async () => {
    await phone.client.call("sessions.prompt", { sessionId, clientMessageId: "c2", content: text("SLOW please") });
    await waitFor(() => laptop.of(sessionId).some((e) => e.update.sessionUpdate === "agent_message_chunk" && JSON.stringify(e.update).includes("w1 ")));
    expect(await laptop.client.call("sessions.prompt", { sessionId, clientMessageId: "c3", content: text("also check tests") })).toEqual({
      delivery: "steered",
    });
    await laptop.client.call("sessions.cancel", { sessionId });
    const ended = await waitFor(() => phone.turnsEnded(sessionId)[1]);
    expect(ended.update).toMatchObject({ stopReason: "cancelled" });
    expect(phone.agentText(sessionId)).not.toContain("w39");
    expect(phone.of(sessionId).some((e) => JSON.stringify(e.update).includes("also check tests"))).toBe(true);
  });

  it("broadcasts an approval to every client and applies whichever answer comes first", async () => {
    await phone.client.call("sessions.prompt", { sessionId, clientMessageId: "c4", content: text("RUN the build") });
    const request = await waitFor(() => phone.of(sessionId).find((e) => e.update.sessionUpdate === "ls_permission"));
    await waitFor(() => laptop.of(sessionId).some((e) => e.seq === request.seq));
    expect(host.hub.getSession(sessionId)).toMatchObject({ state: "waiting", pendingPermissions: 1 });
    const requestId = (request.update as { requestId: string }).requestId;

    await laptop.client.call("sessions.permission", { sessionId, requestId, optionId: "accept" });
    await expect(phone.client.call("sessions.permission", { sessionId, requestId, optionId: "decline" })).rejects.toMatchObject({
      appCode: "not_found",
    });
    await waitFor(() => phone.turnsEnded(sessionId).length === 3);
    const kinds = phone.of(sessionId).filter((e) => e.seq > request.seq).map((e) => e.update.sessionUpdate);
    expect(kinds).toContain("ls_permission_resolved");
    const toolOutput = phone.of(sessionId).find((e) => e.update.sessionUpdate === "tool_call_update" && e.update.appendOutput === "hi\n");
    expect(toolOutput).toBeDefined();
    expect(host.hub.getSession(sessionId)).toMatchObject({ pendingPermissions: 0, state: "idle" });
  });

  it("resumes a reconnecting client from its last seq, with nothing missing or repeated", async () => {
    const all = phone.of(sessionId);
    const cursor = all[all.length - 4]!.seq;
    const again = await recorder(host);
    await again.client.call("sessions.subscribe", { sessionId, fromSeq: cursor });
    expect(again.of(sessionId).map((e) => e.seq)).toEqual(all.slice(-3).map((e) => e.seq));
    again.client.close();
  });

  it("picks up a thread opened in the desktop TUI and mirrors it to the phone live", async () => {
    const tui = await rawCodexClient(host.paths.codexSocket);
    const started = await tui.peer.request<{ thread: { id: string } }>("thread/start", { cwd: "/desk/project" });
    const tuiSessionId = `codex:${started.thread.id}`;
    await waitFor(() => phone.summaries.some((s) => s.id === tuiSessionId));

    await tui.peer.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "typed on desktop", text_elements: [] }],
    });
    // The host follows the thread without anyone subscribing; the phone joins afterwards and gets it all.
    await waitFor(() => host.hub.getSession(tuiSessionId).state === "idle" && host.hub.getSession(tuiSessionId).lastSeq > 3);
    await phone.client.call("sessions.subscribe", { sessionId: tuiSessionId, fromSeq: 0 });
    expect(phone.agentText(tuiSessionId)).toBe("echo: typed on desktop");

    // And the phone can reply into the desktop's thread. (Imported history
    // carries items, not turn boundaries, so this is the first turn end seen.)
    await phone.client.call("sessions.prompt", { sessionId: tuiSessionId, clientMessageId: "p1", content: text("from phone") });
    await waitFor(() => phone.turnsEnded(tuiSessionId).length === 1);
    expect(phone.agentText(tuiSessionId)).toContain("echo: from phone");
    tui.close();
  }, 15_000);

  it("lets the phone send the first message into a TUI session nobody has typed in yet", async () => {
    const tui = await rawCodexClient(host.paths.codexSocket);
    const started = await tui.peer.request<{ thread: { id: string } }>("thread/start", { cwd: "/desk/empty" });
    const id = `codex:${started.thread.id}`;
    await waitFor(() => phone.summaries.some((s) => s.id === id));
    await phone.client.call("sessions.subscribe", { sessionId: id, fromSeq: 0 });
    expect(await phone.client.call("sessions.prompt", { sessionId: id, clientMessageId: "first", content: text("first from phone") })).toEqual({
      delivery: "started",
    });
    await waitFor(() => phone.agentText(id).includes("echo: first from phone"));
    expect(phone.of(id).some((e) => e.update.sessionUpdate === "user_message_chunk")).toBe(true);
    tui.close();
  }, 15_000);

  it("archives, renames and deletes natively; a delete from another Codex client reaches the phone", async () => {
    const { session } = await phone.client.call("sessions.create", { agent: "codex", cwd: "/w/house", prompt: text("keep") });
    await waitFor(() => host.hub.getSession(session.id).state === "idle" && host.hub.getSession(session.id).lastSeq > 2);
    const tui = await rawCodexClient(host.paths.codexSocket);
    const listed = async () => (await tui.peer.request<{ data: { id: string; name: string | null }[] }>("thread/list", {})).data;

    await phone.client.call("sessions.rename", { sessionId: session.id, title: "House chores" });
    expect((await listed()).find((t) => t.id === session.nativeId)?.name).toBe("House chores");
    await phone.client.call("sessions.archive", { sessionId: session.id, archived: true });
    expect((await listed()).map((t) => t.id)).not.toContain(session.nativeId);
    await phone.client.call("sessions.archive", { sessionId: session.id, archived: false });
    expect((await listed()).map((t) => t.id)).toContain(session.nativeId);

    const removed: string[] = [];
    phone.client.on("session.removed", ({ sessionId }) => removed.push(sessionId));
    await phone.client.call("sessions.delete", { sessionId: session.id });
    await waitFor(() => removed.includes(session.id));
    expect((await listed()).map((t) => t.id)).not.toContain(session.nativeId);

    // Deleted in the TUI (another client): LinkShell forgets it too.
    const other = await phone.client.call("sessions.create", { agent: "codex", cwd: "/w/house", prompt: text("other") });
    await waitFor(() => host.hub.getSession(other.session.id).state === "idle" && host.hub.getSession(other.session.id).lastSeq > 2);
    await tui.peer.request("thread/delete", { threadId: other.session.nativeId });
    await waitFor(() => removed.includes(other.session.id));
    expect(() => host.hub.getSession(other.session.id)).toThrow(/not found/);
    tui.close();
  }, 15_000);

  it("tells a desktop shim how to attach the Codex TUI to the shared server", async () => {
    const launch = await phone.client.call("desktop.launch", { agent: "codex", sessionId, args: ["--no-alt-screen"] });
    expect(launch).toEqual({
      command: FAKE_CODEX,
      args: ["--remote", `unix://${host.paths.codexSocket}`, "resume", sessionId.slice("codex:".length), "--no-alt-screen"],
    });
  });

  it("restarts a crashed app-server and keeps serving", async () => {
    const tui = await rawCodexClient(host.paths.codexSocket);
    await tui.peer.request("fake/crash", {}).catch(() => {});
    await waitFor(() => host.hub.getSession(sessionId).state === "offline");
    await waitFor(() => {
      const codex = host.machineInfo().agents[0];
      return codex?.installed && !codex.problem;
    }, 10_000);
    const { session } = await phone.client.call("sessions.create", { agent: "codex", cwd: home });
    await phone.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await phone.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "after-crash", content: text("still here") });
    await waitFor(() => phone.turnsEnded(session.id).length === 1);
    expect(phone.agentText(session.id)).toBe("echo: still here");
  });

  it("forks a session through a turn: the new one opens with that much of the conversation and goes its own way", async () => {
    const { session } = await phone.client.call("sessions.create", { agent: "codex", cwd: home });
    await phone.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    for (const [id, message] of [["f1", "first question"], ["f2", "second question"]] as const) {
      const before = phone.turnsEnded(session.id).length;
      await phone.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: id, content: text(message) });
      await waitFor(() => phone.turnsEnded(session.id).length === before + 1);
    }
    const firstReply = phone.of(session.id).find((e) => e.update.sessionUpdate === "agent_message_chunk")!.update as { messageId: string };

    const { session: fork } = await phone.client.call("sessions.fork", { sessionId: session.id, itemId: firstReply.messageId });
    expect(fork.id).not.toBe(session.id);
    expect(fork.cwd).toBe(session.cwd);
    await laptop.client.call("sessions.subscribe", { sessionId: fork.id, fromSeq: 0 });
    await waitFor(() => laptop.agentText(fork.id) === "echo: first question");
    // The whole conversation when no point is named.
    const { session: whole } = await phone.client.call("sessions.fork", { sessionId: session.id });
    await laptop.client.call("sessions.subscribe", { sessionId: whole.id, fromSeq: 0 });
    await waitFor(() => laptop.agentText(whole.id) === "echo: first questionecho: second question");

    await laptop.client.call("sessions.prompt", { sessionId: fork.id, clientMessageId: "f3", content: text("another way") });
    await waitFor(() => laptop.agentText(fork.id).endsWith("echo: another way"));
    // The original is untouched.
    expect(phone.agentText(session.id)).toBe("echo: first questionecho: second question");
    expect(host.hub.getSession(session.id).lastSeq).toBe(phone.of(session.id).at(-1)!.seq);
  });

  it("rejects bad params and unknown methods with typed errors", async () => {
    await expect(phone.client.call("sessions.prompt", { sessionId, clientMessageId: "x", content: [] })).rejects.toMatchObject({
      data: { code: "invalid_params" },
    });
    await expect(phone.client.call("sessions.subscribe", { sessionId: "codex:nope", fromSeq: 0 })).rejects.toMatchObject({
      appCode: "not_found",
    });
  });
});
