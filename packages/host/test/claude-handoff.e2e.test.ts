import { execSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent, SessionSummary } from "@linkshell/wire";
import { ClaudeDriver } from "../src/drivers/claude/driver.js";
import { connectHost, type HostClient } from "../src/rpc/client.js";
import { startHost, type RunningHost } from "../src/host.js";
import { HostStore } from "../src/store.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
chmodSync(FAKE_CLAUDE, 0o755);
chmodSync(FAKE_ACP, 0o755);

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Env {
  home: string;
  configDir: string;
  workDir: string;
  env: NodeJS.ProcessEnv;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function makeEnv(): Env {
  // Canonical paths, as a terminal's process.cwd() reports them.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "lsh-claude-")));
  const configDir = join(home, "claude-config");
  const workDir = join(home, "work", "my-app");
  mkdirSync(workDir, { recursive: true });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, FAKE_ACP_CLAUDE_DIR: configDir };
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return { home, configDir, workDir, env };
}

async function boot(e: Env, busyWindowMs = 60_000, holderCheckMs = 3000) {
  const host = await startHost({
    home: e.home,
    version: "test",
    drivers: () => [
      new ClaudeDriver({ env: e.env, hostVersion: "test", claudeCommand: FAKE_CLAUDE, adapter: { command: FAKE_ACP, args: [] }, busyWindowMs, holderCheckMs }),
    ],
    log: process.env.DEBUG_HOST ? (m) => console.log("[host]", m) : () => {},
  });
  cleanups.push(() => host.stop());
  return host;
}

async function phone(host: RunningHost) {
  const client = await connectHost(host.paths.hostSocket);
  cleanups.push(() => client.close());
  const events: SessionEvent[] = [];
  const summaries: SessionSummary[] = [];
  client.on("session.event", (event) => events.push(event));
  client.on("session.summary", ({ session }) => summaries.push(session));
  const of = (id: string) => events.filter((e) => e.sessionId === id);
  const agentTexts = (id: string) => {
    // Concatenate chunks per message id.
    const byId = new Map<string, string>();
    for (const e of of(id)) {
      if (e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text") {
        byId.set(e.update.messageId, (byId.get(e.update.messageId) ?? "") + e.update.content.text);
      }
    }
    return [...byId.values()];
  };
  const userTexts = (id: string) =>
    of(id).flatMap((e) => (e.update.sessionUpdate === "user_message_chunk" && e.update.content.type === "text" ? [e.update.content.text] : []));
  return { client, events, summaries, of, agentTexts, userTexts };
}

/** Plays `linkshell claude`: runs the TUI the host asks for, steps aside on desktop.yield, reclaims on demand. */
async function terminal(host: RunningHost, e: Env, sessionId?: string) {
  const client: HostClient = await connectHost(host.paths.hostSocket);
  cleanups.push(() => client.close());
  let tui: ChildProcess | undefined;
  const activity: string[] = [];
  const yields: string[] = [];
  const run = (command: string, args: string[]) => {
    tui = spawn(command, args, { cwd: e.workDir, env: e.env, stdio: ["pipe", "ignore", "ignore"] });
    cleanups.push(() => void tui?.kill("SIGKILL"));
  };
  const launch = await client.call("desktop.launch", { agent: "claude", args: [], cwd: e.workDir, sessionId });
  run(launch.command, launch.args);
  const id = launch.sessionId!;
  client.on("desktop.yield", async ({ sessionId: yielded }) => {
    yields.push(yielded);
    const current = tui!;
    await new Promise<void>((resolve) => {
      current.once("exit", () => resolve());
      current.kill("SIGTERM");
    });
    await client.call("desktop.yielded", { sessionId: yielded });
  });
  client.on("desktop.remoteActivity", ({ line }) => activity.push(line));
  return {
    id,
    launch,
    activity,
    yields,
    type: (text: string) => tui!.stdin!.write(`${text}\n`),
    async reclaim() {
      const spec = await client.call("desktop.reclaim", { sessionId: id });
      run(spec.command, spec.args);
      return spec;
    },
    quit: async () => {
      const current = tui!;
      await new Promise<void>((resolve) => {
        current.once("exit", () => resolve());
        current.kill("SIGTERM");
      });
      client.close();
    },
  };
}

const text = (t: string) => [{ type: "text" as const, text: t }];

describe("Claude handoff (fake claude TUI + fake ACP adapter)", () => {
  it("backfills teammate steps into a legacy host log and corrects completed-at-launch without duplicating history", async () => {
    const e = makeEnv(); const host = await boot(e); const p = await phone(host); const desk = await terminal(host, e);
    await p.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });
    desk.type("prepare"); await waitFor(() => p.agentTexts(desk.id).includes("echo: prepare"));
    const native = desk.id.slice("claude:".length);
    const dir = join(e.configDir, "projects", e.workDir.replace(/[^a-zA-Z0-9]/g, "-"));
    const transcript = join(dir, `${native}.jsonl`), children = join(dir, native, "subagents");
    await desk.quit(); await host.stop(); mkdirSync(children, { recursive: true });
    const legacy = new HostStore(join(e.home, "state.db"));
    const write = (path: string, entry: object) => appendFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), uuid: randomUUID(), ...entry }) + "\n");
    for (const [name, done] of [["frontend", true], ["backend", false]] as const) {
      const call = `call-${name}`, agentId = `a${name}-123`;
      write(transcript, { type: "assistant", message: { content: [{ type: "tool_use", id: call, name: "Agent", input: { name, description: `${name} work`, subagent_type: "general-purpose" } }] } });
      write(transcript, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: call, content: "Spawned successfully" }] }, toolUseResult: { status: "teammate_spawned", agentId, name } });
      writeFileSync(join(children, `agent-${agentId}.meta.json`), JSON.stringify({ taskKind: "in_process_teammate", name }));
      const child = join(children, `agent-${agentId}.jsonl`);
      write(child, { type: "assistant", isSidechain: true, message: { id: `${name}-step`, stop_reason: "tool_use", content: [{ type: "tool_use", id: `${name}-read`, name: "Read", input: { file_path: "/repo/a.ts" } }] } });
      write(child, { type: "user", isSidechain: true, message: { content: [{ type: "tool_result", tool_use_id: `${name}-read`, content: "file contents" }] } });
      if (done) write(child, { type: "assistant", isSidechain: true, message: { id: `${name}-report`, stop_reason: "end_turn", content: text("real finished report") } });
      legacy.appendEvent(desk.id, { sessionUpdate: "tool_call", toolCallId: call, title: `${name} work`, kind: "other", status: "in_progress", detail: { type: "subagent", action: "spawn", agentType: "general-purpose" } });
      legacy.appendEvent(desk.id, { sessionUpdate: "tool_call_update", toolCallId: call, status: "completed", content: [{ type: "content", content: { type: "text", text: "Spawned successfully" } }] });
      legacy.markItemLogged(desk.id, `tool:${call}`);
    }
    legacy.close();
    const restarted = await boot(e); const p2 = await phone(restarted);
    await p2.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });
    expect(restarted.hub.subagents(desk.id).find((a) => a.toolCallId === "call-frontend")).toMatchObject({ name: "frontend", state: "completed", running: false });
    expect(restarted.hub.subagents(desk.id).find((a) => a.toolCallId === "call-backend")).toMatchObject({ name: "backend", state: "unknown", running: false });
    const before = restarted.hub.subagent(desk.id, "call-frontend");
    expect(before.some((e) => e.update.sessionUpdate === "tool_call" && e.update.toolCallId === "frontend-read")).toBe(true);
    expect(before.findLast((e) => e.update.sessionUpdate === "tool_call_update" && e.update.toolCallId === "call-frontend")?.update).toMatchObject({ content: [] });
    await restarted.stop();
    const again = await boot(e); const p3 = await phone(again);
    await p3.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });
    const replay = again.hub.subagent(desk.id, "call-frontend");
    expect(replay.filter((e) => e.update.sessionUpdate === "agent_message_chunk" && e.update.messageId === "frontend-report")).toHaveLength(1);
    expect(replay.filter((e) => e.update.sessionUpdate === "tool_call" && e.update.toolCallId === "frontend-read")).toHaveLength(1);
  }, 20_000);
  it("follows shell tasks after the remote turn, reconciles restart history and marks an exited holder unknown", async () => {
    const e = makeEnv(); e.env.FAKE_ACP_EXPECT_RAW_GOAL = "1"; const host = await boot(e, 60_000, 100); const p = await phone(host);
    const { session } = await p.client.call("sessions.create", { agent: "claude", cwd: e.workDir });
    await p.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await p.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "prepare", content: text("prepare") });
    await waitFor(() => p.agentTexts(session.id).includes("echo: prepare"));
    const native = session.nativeId;
    const dir = join(e.configDir, "projects", e.workDir.replace(/[^a-zA-Z0-9]/g, "-"));
    const transcript = join(dir, `${native}.jsonl`);
    const write = (entry: object) => appendFileSync(transcript, JSON.stringify({ uuid: randomUUID(), timestamp: new Date().toISOString(), sessionId: native, cwd: e.workDir, entrypoint: "sdk-ts", ...entry }) + "\n");
    const start = (id: string) => {
      write({ type: "assistant", message: { content: [{ type: "tool_use", id: `call-${id}`, name: "Bash", input: { command: "sleep 60", description: "same task" } }] } });
      write({ type: "user", toolUseResult: { backgroundTaskId: id }, message: { content: [{ type: "tool_result", tool_use_id: `call-${id}`, content: "background" }] } });
    };
    start("b1"); start("b2");
    await waitFor(() => host.hub.tasks(session.id).filter((task) => task.state === "running").length === 2);
    expect(host.hub.tasks(session.id).every((task) => !task.canStop)).toBe(true);
    write({ type: "attachment", attachment: { type: "queued_command", prompt: "<task-notification><task-id>b1</task-id><status>failed</status><summary>exit code 144</summary></task-notification>" } });
    await waitFor(() => host.hub.tasks(session.id).find((task) => task.id === "b1")?.state === "failed");
    await host.stop();
    const restarted = await boot(e, 60_000, 100); const p2 = await phone(restarted);
    await p2.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await waitFor(() => restarted.hub.tasks(session.id).find((task) => task.id === "b2")?.state === "unknown");
    expect(restarted.hub.tasks(session.id).find((task) => task.id === "b1")).toMatchObject({ state: "failed", exitCode: 144 });
  });
  it("streams new child files and workflow workers while the desktop's main conversation is idle", async () => {
    const e = makeEnv();
    const host = await boot(e);
    const p = await phone(host);
    const desk = await terminal(host, e);
    await p.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });
    desk.type("prepare");
    await waitFor(() => p.agentTexts(desk.id).includes("echo: prepare"));
    const native = desk.id.slice("claude:".length);
    const dir = join(e.configDir, "projects", e.workDir.replace(/[^a-zA-Z0-9]/g, "-"));
    const transcript = join(dir, `${native}.jsonl`);
    const children = join(dir, native, "subagents");
    mkdirSync(children, { recursive: true });
    const write = (path: string, entry: Record<string, unknown>) => appendFileSync(path, JSON.stringify({ sessionId: native, cwd: e.workDir, entrypoint: "cli", uuid: randomUUID(), timestamp: new Date().toISOString(), ...entry }) + "\n");
    write(transcript, { type: "assistant", message: { id: "spawn", content: [{ type: "tool_use", id: "agent-live", name: "Agent", input: { description: "Read sources" } }], stop_reason: "tool_use" } });
    writeFileSync(join(children, "agent-a1.meta.json"), JSON.stringify({ toolUseId: "agent-live" }));
    write(join(children, "agent-a1.jsonl"), { type: "assistant", isSidechain: true, message: { id: "child-live", content: [{ type: "text", text: "live child output" }], stop_reason: "end_turn" } });
    await waitFor(() => p.agentTexts(desk.id).includes("live child output"));
    expect(p.of(desk.id).find((event) => event.update.sessionUpdate === "agent_message_chunk" && event.update.messageId === "child-live")?.update).toMatchObject({ parentToolCallId: "agent-live" });

    const run = join(children, "workflows", "wf_live");
    mkdirSync(run, { recursive: true });
    write(transcript, { type: "assistant", message: { id: "wf-spawn", content: [{ type: "tool_use", id: "wf-call", name: "Workflow", input: { name: "research" } }], stop_reason: "tool_use" } });
    write(transcript, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "wf-call", content: "Running in background" }] }, toolUseResult: { status: "async_launched", taskId: "wf-task", runId: "wf_live", workflowName: "research" } });
    writeFileSync(join(run, "journal.jsonl"), JSON.stringify({ type: "started", agentId: "w1" }) + "\n");
    write(join(run, "agent-w1.jsonl"), { type: "assistant", isSidechain: true, message: { id: "wf-text", content: [{ type: "text", text: "workflow worker output" }], stop_reason: "end_turn" } });
    await waitFor(() => p.agentTexts(desk.id).includes("workflow worker output"));
    const worker = "workflow:wf_live:w1";
    expect(host.hub.subagent(desk.id, worker).some((event) => event.update.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(host.hub.subagents(desk.id).find((agent) => agent.toolCallId === "wf-call")?.running).toBe(true);
    write(transcript, { type: "system", subtype: "task_notification", task_id: "wf-task", status: "stopped" });
    await waitFor(() => host.hub.subagents(desk.id).find((agent) => agent.toolCallId === "wf-call")?.workflow?.state === "stopped");
    expect(host.hub.subagents(desk.id).find((agent) => agent.toolCallId === worker)).toMatchObject({ running: true, state: "running" });
    write(transcript, { type: "system", subtype: "task_progress", task_id: "wf-task", workflow_progress: [{ type: "workflow_agent", agentId: "w1", state: "killed" }] });
    await waitFor(() => host.hub.subagents(desk.id).find((agent) => agent.toolCallId === worker)?.state === "stopped");
    expect(host.hub.subagents(desk.id).find((agent) => agent.toolCallId === worker)).toMatchObject({ running: false, failed: undefined });

    // The run was already terminal in the host log. A more complete final
    // artifact can arrive while the host is down and must replace that snapshot.
    await desk.quit();
    await host.stop();
    const finals = join(dir, native, "workflows");
    mkdirSync(finals, { recursive: true });
    writeFileSync(join(finals, "wf_live.json"), JSON.stringify({ runId: "wf_live", workflowName: "Finished run", status: "completed", workflowProgress: [
      { type: "workflow_phase", index: 1, title: "Reviewed" },
      { type: "workflow_agent", agentId: "w1", label: "Updated label", state: "done", phaseIndex: 1 },
    ] }));
    const restarted = await boot(e);
    const returning = await phone(restarted);
    await returning.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });
    expect(restarted.hub.subagents(desk.id).find((agent) => agent.toolCallId === "wf-call")?.workflow).toMatchObject({
      state: "completed", name: "Finished run", phases: [{ title: "Reviewed" }], agents: [{ title: "Updated label", state: "completed" }],
    });
  }, 20_000);

  it("reports Claude as a handoff agent with its login state", async () => {
    const e = makeEnv();
    const host = await boot(e);
    const info = host.machineInfo();
    expect(info.agents[0]).toMatchObject({
      id: "claude",
      installed: true,
      version: "9.9.9",
      tier: "handoff",
      auth: { state: "ok", method: "claude.ai" },
    });
  });

  it("relays desktop → phone → desktop with no duplicated messages", async () => {
    const e = makeEnv();
    const host = await boot(e);
    const p = await phone(host);

    // 1. Desktop: the TUI runs the session; the phone follows the transcript live.
    const desk = await terminal(host, e);
    expect(desk.launch.args).toEqual(["--session-id", desk.id.slice("claude:".length)]);
    await p.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });
    desk.type("hello from desk");
    await waitFor(() => p.agentTexts(desk.id).includes("echo: hello from desk"));
    expect(host.hub.getSession(desk.id)).toMatchObject({ driver: "desktop", title: "Task: hello from desk", cwd: e.workDir });

    // 2. Phone sends: the terminal steps aside, the host continues the same session.
    expect(await p.client.call("sessions.prompt", { sessionId: desk.id, clientMessageId: "p1", content: text("from phone") })).toEqual({
      delivery: "started",
    });
    expect(desk.yields).toEqual([desk.id]);
    await waitFor(() => p.agentTexts(desk.id).includes("echo: from phone"));
    expect(host.hub.getSession(desk.id).driver).toBe("remote");
    await waitFor(() => desk.activity.some((line) => line.includes("from phone")));

    // 3. Back at the desk: reclaim relaunches the TUI on the same session.
    const spec = await desk.reclaim();
    expect(spec.args).toEqual(["--resume", desk.id.slice("claude:".length)]);
    await waitFor(() => host.hub.getSession(desk.id).driver === "desktop");
    desk.type("back at desk");
    await waitFor(() => p.agentTexts(desk.id).includes("echo: back at desk"));

    // Every message appears exactly once in the phone's log.
    expect(p.userTexts(desk.id)).toEqual(["hello from desk", "from phone", "back at desk"]);
    expect(p.agentTexts(desk.id)).toEqual(["echo: hello from desk", "echo: from phone", "echo: back at desk"]);

    // 4. A fresh client (and a host restart) rebuild the same log without duplicates.
    await desk.quit();
    await host.stop();
    cleanups.pop();
    const again = await boot(e);
    const p2 = await phone(again);
    await p2.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(p2.userTexts(desk.id)).toEqual(["hello from desk", "from phone", "back at desk"]);
    expect(p2.agentTexts(desk.id)).toEqual(["echo: hello from desk", "echo: from phone", "echo: back at desk"]);
  }, 30_000);

  it("leaves a never-messaged terminal session alone when the phone tries to take it, and deletes it cleanly", async () => {
    const e = makeEnv();
    const host = await boot(e);
    const p = await phone(host);
    const desk = await terminal(host, e);
    await p.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });

    // Nothing to resume yet: refused before the terminal is asked to step aside.
    const failure = await p.client.call("sessions.takeover", { sessionId: desk.id }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ data: { code: "not_ready" } });
    expect(desk.yields).toEqual([]);
    expect(host.hub.getSession(desk.id).driver).toBe("desktop");

    // Once the terminal has quit, deleting it needs nothing from Claude.
    await desk.quit();
    await waitFor(() => host.hub.getSession(desk.id).driver !== "desktop");
    await p.client.call("sessions.delete", { sessionId: desk.id });
    const { sessions } = await p.client.call("sessions.list", { includeArchived: true });
    expect(sessions.some((session) => session.id === desk.id)).toBe(false);
  }, 20_000);

  it("shows the settings of a desktop-driven session; a choice waits for the takeover instead of forcing it", async () => {
    const e = makeEnv();
    const host = await boot(e);
    const p = await phone(host);
    const desk = await terminal(host, e);
    await p.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });
    desk.type("hello from desk");
    await waitFor(() => p.agentTexts(desk.id).includes("echo: hello from desk"));
    const lastConfig = () =>
      p.of(desk.id).findLast((event) => event.update.sessionUpdate === "ls_config")?.update as
        | { options: { id: string; current: string }[] }
        | undefined;
    await waitFor(() => lastConfig()?.options.some((option) => option.id === "model"));

    // What the session runs with on the computer is what the phone shows: here its permission mode, changed at the desk.
    const mode = () => lastConfig()?.options.find((option) => option.id === "mode")?.current;
    expect(mode()).toBe("default");
    const nativeId = desk.id.slice("claude:".length);
    appendFileSync(
      join(e.configDir, "projects", e.workDir.replace(/[^a-zA-Z0-9]/g, "-"), `${nativeId}.jsonl`),
      JSON.stringify({ type: "user", uuid: randomUUID(), isSidechain: false, sessionId: nativeId, cwd: e.workDir, entrypoint: "cli", permissionMode: "plan", timestamp: new Date().toISOString(), message: { role: "user", content: "plan it first" } }) + "\n",
    );
    await waitFor(() => mode() === "plan");

    // Chosen while the desktop drives: remembered, no takeover.
    await p.client.call("sessions.setConfig", { sessionId: desk.id, optionId: "model", value: "smart" });
    expect(desk.yields).toEqual([]);
    expect(host.hub.getSession(desk.id).driver).toBe("desktop");
    await waitFor(() => lastConfig()?.options.find((option) => option.id === "model")?.current === "smart");

    // The phone takes over by sending: the choice applies to the resumed session.
    await p.client.call("sessions.prompt", { sessionId: desk.id, clientMessageId: "p1", content: text("from phone") });
    await waitFor(() => p.agentTexts(desk.id).includes("echo: from phone"));
    expect(host.hub.getSession(desk.id).driver).toBe("remote");
    await waitFor(() => lastConfig()?.options.find((option) => option.id === "model")?.current === "smart");
    // …and it keeps the mode it had at the desk.
    expect(mode()).toBe("plan");
    // No throwaway session from reading the settings shows up.
    await host.hub.refreshDiscovery();
    expect((await p.client.call("sessions.list", {})).sessions.map((session) => session.id)).toEqual([desk.id]);
  }, 30_000);

  it("shows tool calls from the desktop with their results", async () => {
    const e = makeEnv();
    const host = await boot(e);
    const p = await phone(host);
    const desk = await terminal(host, e);
    await p.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });
    desk.type("TOOL please");
    await waitFor(() => p.agentTexts(desk.id).includes("echo: TOOL please"));
    const call = p.of(desk.id).find((ev) => ev.update.sessionUpdate === "tool_call");
    expect(call?.update).toMatchObject({ title: "List files", kind: "execute" });
    const result = p.of(desk.id).find((ev) => ev.update.sessionUpdate === "tool_call_update");
    expect(result?.update).toMatchObject({ status: "completed", content: [{ type: "content", content: { type: "text", text: "a.txt" } }] });
    expect(p.of(desk.id).some((ev) => ev.update.sessionUpdate === "agent_thought_chunk")).toBe(true);
  }, 15_000);

  it("continues a session a plain claude has open: at once when it is idle, after its turn when it is working", async () => {
    const e = makeEnv();
    const host = await boot(e, 60_000, 100);
    const p = await phone(host);
    // A session made on the desktop earlier, then reopened with plain `claude --resume`.
    const desk = await terminal(host, e);
    desk.type("first");
    await waitFor(() => host.hub.getSession(desk.id).title === "Task: first", 8000);
    await desk.quit();
    // The host notices the terminal left: nobody drives the session now.
    await waitFor(() => host.hub.getSession(desk.id).driver === "none");
    const nativeId = desk.id.slice("claude:".length);
    const transcript = join(e.configDir, "projects", e.workDir.replace(/[^a-zA-Z0-9]/g, "-"), `${nativeId}.jsonl`);
    await p.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });
    const plain = spawn(FAKE_CLAUDE, ["--resume", nativeId], { cwd: e.workDir, env: e.env, stdio: ["pipe", "ignore", "ignore"] });
    cleanups.push(() => void plain.kill("SIGKILL"));
    const notices = () => p.of(desk.id).flatMap((ev) => (ev.update.sessionUpdate === "ls_notice" ? [ev.update.title] : []));
    const queued = () => host.hub.getSession(desk.id).queue?.map((entry) => entry.text) ?? [];

    // In the middle of a turn there (a prompt with no reply yet): the message waits, where the phone can see it.
    appendFileSync(
      transcript,
      JSON.stringify({ type: "user", uuid: randomUUID(), isSidechain: false, sessionId: nativeId, cwd: e.workDir, entrypoint: "cli", timestamp: new Date().toISOString(), message: { role: "user", content: "typed in the terminal" } }) + "\n",
    );
    expect(await p.client.call("sessions.prompt", { sessionId: desk.id, clientMessageId: "x", content: text("after that") })).toEqual({ delivery: "queued" });
    expect(queued()).toEqual(["after that"]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(host.hub.getSession(desk.id).driver).toBe("none");
    // Its turn ends: the message goes out, and the phone is told the terminal won't show it.
    appendFileSync(
      transcript,
      JSON.stringify({ type: "assistant", uuid: randomUUID(), isSidechain: false, sessionId: nativeId, cwd: e.workDir, entrypoint: "cli", timestamp: new Date().toISOString(), message: { id: "msg_done", role: "assistant", content: [{ type: "text", text: "terminal done" }], stop_reason: "end_turn" } }) + "\n",
    );
    await waitFor(() => p.agentTexts(desk.id).includes("echo: after that"));
    expect(queued()).toEqual([]);
    expect(notices()).toEqual(["已在手机上接着做"]);
    // Idle from here on: the next message is simply sent.
    expect(await p.client.call("sessions.prompt", { sessionId: desk.id, clientMessageId: "y", content: text("now me") })).toEqual({ delivery: "started" });
    await waitFor(() => p.agentTexts(desk.id).includes("echo: now me"));
    // The terminal goes on: the phone steps back and follows it.
    plain.stdin!.write("back at the desk\n");
    await waitFor(() => host.hub.getSession(desk.id).driver === "none");
    await waitFor(() => p.agentTexts(desk.id).includes("echo: back at the desk"));
    expect(notices()).toEqual(["已在手机上接着做", "电脑上继续了这个会话"]);
    expect(p.userTexts(desk.id)).toEqual(["first", "typed in the terminal", "after that", "now me", "back at the desk"]);
  }, 20_000);

  it("sends a waiting message at once, or stops the turn, by interrupting the claude that runs it", async () => {
    const e = makeEnv();
    const host = await boot(e, 60_000, 100);
    const p = await phone(host);
    const desk = await terminal(host, e);
    desk.type("first");
    await waitFor(() => host.hub.getSession(desk.id).title === "Task: first", 8000);
    await desk.quit();
    await waitFor(() => host.hub.getSession(desk.id).driver === "none");
    const nativeId = desk.id.slice("claude:".length);
    const transcript = join(e.configDir, "projects", e.workDir.replace(/[^a-zA-Z0-9]/g, "-"), `${nativeId}.jsonl`);
    await p.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });
    const working = async () => {
      const plain = spawn(FAKE_CLAUDE, ["--resume", nativeId], { cwd: e.workDir, env: e.env, stdio: ["pipe", "ignore", "ignore"] });
      cleanups.push(() => void plain.kill("SIGKILL"));
      // (Up and running, with its own command line, before anyone looks for it.)
      await waitFor(() => execSync(`ps -ww -o command= -p ${plain.pid}`).toString().includes(nativeId));
      appendFileSync(
        transcript,
        JSON.stringify({ type: "user", uuid: randomUUID(), isSidechain: false, sessionId: nativeId, cwd: e.workDir, entrypoint: "cli", timestamp: new Date().toISOString(), message: { role: "user", content: "a long job" } }) + "\n",
      );
      return { gone: new Promise<NodeJS.Signals | null>((resolve) => plain.once("exit", (_code, signal) => resolve(signal))) };
    };

    // "Send now": the terminal's turn is interrupted, and the message goes out.
    let { gone } = await working();
    expect(await p.client.call("sessions.prompt", { sessionId: desk.id, clientMessageId: "x", content: text("urgent") })).toEqual({ delivery: "queued" });
    await p.client.call("sessions.sendQueued", { sessionId: desk.id });
    expect(await gone).toBe("SIGINT");
    await waitFor(() => p.agentTexts(desk.id).includes("echo: urgent"));
    // Text can arrive before the prompt settles; the desktop resumes after that turn finishes.
    await waitFor(() => host.hub.getSession(desk.id).state === "idle");
    expect(host.hub.getSession(desk.id).queue ?? []).toEqual([]);

    // Stop: the turn on the computer is interrupted, and what was waiting is dropped.
    // (The terminal is opened again and starts a turn: the phone has stepped back.)
    ({ gone } = await working());
    await waitFor(() => host.hub.getSession(desk.id).driver === "none");
    expect(await p.client.call("sessions.prompt", { sessionId: desk.id, clientMessageId: "y", content: text("never mind") })).toEqual({ delivery: "queued" });
    await p.client.call("sessions.cancel", { sessionId: desk.id });
    expect(await gone).toBe("SIGINT");
    expect(host.hub.getSession(desk.id).queue ?? []).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(p.userTexts(desk.id)).not.toContain("never mind");
  }, 25_000);

  it("continues a session the Claude desktop app has open, after its turn, and follows the app when it writes again", async () => {
    const e = makeEnv();
    const host = await boot(e, 60_000, 100);
    const p = await phone(host);
    const desk = await terminal(host, e);
    desk.type("first");
    await waitFor(() => host.hub.getSession(desk.id).title === "Task: first", 8000);
    await desk.quit();
    await waitFor(() => host.hub.getSession(desk.id).driver === "none");
    const nativeId = desk.id.slice("claude:".length);
    const transcript = join(e.configDir, "projects", e.workDir.replace(/[^a-zA-Z0-9]/g, "-"), `${nativeId}.jsonl`);
    await p.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });

    // Another Claude has the session open, as Claude itself records it. Its
    // command line doesn't name the session (it was created in that process).
    const holder = (entrypoint: string) => {
      const pid = Number(execSync("sleep 60 >/dev/null 2>&1 & echo $!", { shell: "/bin/sh" }).toString().trim());
      cleanups.push(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      });
      mkdirSync(join(e.configDir, "sessions"), { recursive: true });
      writeFileSync(join(e.configDir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: nativeId, entrypoint, kind: "interactive" }));
      return pid;
    };
    const say = (role: "user" | "assistant", textValue: string) =>
      appendFileSync(
        transcript,
        JSON.stringify({
          type: role,
          uuid: randomUUID(),
          isSidechain: false,
          sessionId: nativeId,
          cwd: e.workDir,
          entrypoint: "claude-desktop",
          timestamp: new Date().toISOString(),
          message:
            role === "user"
              ? { role, content: textValue }
              : { id: `msg_${randomUUID().slice(0, 8)}`, role, content: [{ type: "text", text: textValue }], stop_reason: "end_turn" },
        }) + "\n",
      );

    // The desktop app, in the middle of a turn: the message waits for it.
    holder("claude-desktop");
    say("user", "app working");
    expect(await p.client.call("sessions.prompt", { sessionId: desk.id, clientMessageId: "y", content: text("from phone") })).toEqual({ delivery: "queued" });
    expect(host.hub.getSession(desk.id).queue?.map((entry) => entry.text)).toEqual(["from phone"]);
    // An explicit takeover would mean two Claudes writing one turn: refused, with what to do instead.
    await expect(p.client.call("sessions.takeover", { sessionId: desk.id })).rejects.toMatchObject({ appCode: "busy", message: expect.stringContaining("排队") });
    say("assistant", "app done");
    // The app's turn is over: the phone continues, and is told the app won't show it.
    await waitFor(() => p.agentTexts(desk.id).includes("echo: from phone"));
    expect(host.hub.getSession(desk.id).driver).toBe("remote");
    const notices = () => p.of(desk.id).flatMap((ev) => (ev.update.sessionUpdate === "ls_notice" ? [ev.update.title] : []));
    expect(notices()).toEqual(["已在手机上接着做"]);

    // The app continues the session: the phone steps back and shows what the app does.
    say("user", "back in the app");
    say("assistant", "app again");
    await waitFor(() => host.hub.getSession(desk.id).driver === "none");
    await waitFor(() => p.agentTexts(desk.id).includes("app again"));
    expect(notices()).toEqual(["已在手机上接着做", "电脑上继续了这个会话"]);
    // Everything once, in the order it happened.
    expect(p.userTexts(desk.id)).toEqual(["first", "app working", "from phone", "back in the app"]);
    expect(p.agentTexts(desk.id)).toEqual(["echo: first", "app done", "echo: from phone", "app again"]);
  }, 20_000);

  it("opened in the middle of the computer's turn: what is under way keeps its own time, and what Claude writes again after compacting isn't shown again", async () => {
    const e = makeEnv();
    const nativeId = randomUUID();
    const dir = join(e.configDir, "projects", e.workDir.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, `${nativeId}.jsonl`);
    const began = Date.now() - 10 * 60_000;
    const entry = (type: string, uuid: string, at: number, rest: Record<string, unknown>) =>
      JSON.stringify({ type, uuid, isSidechain: false, sessionId: nativeId, cwd: e.workDir, entrypoint: "cli", timestamp: new Date(at).toISOString(), ...rest }) + "\n";
    const ask = entry("user", "u1", began, { message: { role: "user", content: "run the long build" } });
    const call = entry("assistant", "a1", began + 60_000, {
      message: { id: "msg_1", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_build", name: "Bash", input: { command: "make all" } }] },
    });
    writeFileSync(transcript, ask + call);
    const host = await boot(e, 60_000, 100);
    const p = await phone(host);
    await host.hub.refreshDiscovery();
    const id = `claude:${nativeId}`;
    await p.client.call("sessions.subscribe", { sessionId: id, fromSeq: 0 });
    const calls = () => p.of(id).filter((ev) => ev.update.sessionUpdate === "tool_call");
    await waitFor(() => calls().length === 1);
    // The command has been running for nine minutes, not since the phone looked.
    expect(Math.abs(calls()[0]!.ts - (began + 60_000))).toBeLessThan(1000);
    expect(host.hub.getSession(id).state).toBe("running");

    // Claude compacts and writes what it kept again, then goes on.
    appendFileSync(transcript, entry("system", "b1", Date.now(), { subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 9, postTokens: 1 } }) + ask + call);
    appendFileSync(transcript, entry("user", "r1", Date.now(), { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_build", content: "built" }] } }));
    await waitFor(() => p.of(id).some((ev) => ev.update.sessionUpdate === "tool_call_update" && ev.update.status === "completed"));
    expect(calls().map((ev) => (ev.update as { toolCallId: string }).toolCallId)).toEqual(["toolu_build", expect.stringMatching(/^compact:/)]);
    expect(p.userTexts(id)).toEqual(["run the long build"]);
  }, 20_000);

  it("starts a Claude session from the phone and hands it to the desktop", async () => {
    const e = makeEnv();
    const host = await boot(e);
    const p = await phone(host);
    const { session } = await p.client.call("sessions.create", { agent: "claude", cwd: e.workDir });
    await p.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    await p.client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "a", content: text("phone first") });
    await waitFor(() => p.agentTexts(session.id).includes("echo: phone first"));
    expect(host.hub.getSession(session.id).driver).toBe("remote");
    const config = p.of(session.id).find((ev) => ev.update.sessionUpdate === "ls_config");
    expect(config?.update).toMatchObject({ options: expect.arrayContaining([expect.objectContaining({ id: "model" })]) });

    // `linkshell claude --resume <id>` on the desktop takes it back.
    const desk = await terminal(host, e, session.id);
    expect(desk.launch.args).toEqual(["--resume", session.nativeId]);
    await waitFor(() => host.hub.getSession(session.id).driver === "desktop");
    desk.type("desk second");
    await waitFor(() => p.agentTexts(session.id).includes("echo: desk second"));
    expect(p.userTexts(session.id)).toEqual(["phone first", "desk second"]);
  }, 20_000);

  it("stop from the phone ends the turn a linkshell claude terminal runs, by taking over", async () => {
    const e = makeEnv();
    const host = await boot(e);
    const p = await phone(host);
    const desk = await terminal(host, e);
    desk.type("x");
    await waitFor(() => host.hub.getSession(desk.id).title === "Task: x");
    await p.client.call("sessions.cancel", { sessionId: desk.id });
    expect(desk.yields).toEqual([desk.id]);
    expect(host.hub.getSession(desk.id).driver).toBe("remote");
  }, 15_000);
});
