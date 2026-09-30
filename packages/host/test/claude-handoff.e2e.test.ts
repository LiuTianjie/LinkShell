import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent, SessionSummary } from "@linkshell/wire";
import { ClaudeDriver } from "../src/drivers/claude/driver.js";
import { connectHost, type HostClient } from "../src/rpc/client.js";
import { startHost, type RunningHost } from "../src/host.js";

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

async function boot(e: Env, busyWindowMs = 60_000) {
  const host = await startHost({
    home: e.home,
    version: "test",
    drivers: () => [
      new ClaudeDriver({ env: e.env, hostVersion: "test", claudeCommand: FAKE_CLAUDE, adapter: { command: FAKE_ACP, args: [] }, busyWindowMs }),
    ],
    log: () => {},
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

  it("won't become a second writer next to a claude started without linkshell", async () => {
    const e = makeEnv();
    const host = await boot(e, 400);
    const p = await phone(host);
    // A session made on the desktop earlier, then reopened with plain `claude --resume`.
    const desk = await terminal(host, e);
    desk.type("first");
    await waitFor(() => host.hub.getSession(desk.id).title === "Task: first", 8000);
    await desk.quit();
    // The host notices the terminal left: nobody drives the session now.
    await waitFor(() => host.hub.getSession(desk.id).driver === "none");
    const nativeId = desk.id.slice("claude:".length);
    const plain = spawn(FAKE_CLAUDE, ["--resume", nativeId], { cwd: e.workDir, env: e.env, stdio: ["pipe", "ignore", "ignore"] });
    cleanups.push(() => void plain.kill("SIGKILL"));
    // The process holds the session: taking over must be refused, with a way forward.
    await expect(
      p.client.call("sessions.prompt", { sessionId: desk.id, clientMessageId: "x", content: text("hi") }),
    ).rejects.toMatchObject({ appCode: "busy", message: expect.stringContaining("linkshell claude --resume") });
    await new Promise<void>((resolve) => {
      plain.once("exit", () => resolve());
      plain.kill("SIGTERM");
    });
    // Once it's gone, the phone can continue.
    expect(await p.client.call("sessions.prompt", { sessionId: desk.id, clientMessageId: "y", content: text("now me") })).toEqual({
      delivery: "started",
    });
    await p.client.call("sessions.subscribe", { sessionId: desk.id, fromSeq: 0 });
    await waitFor(() => p.agentTexts(desk.id).includes("echo: now me"));
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

  it("cancel needs a takeover while the desktop drives", async () => {
    const e = makeEnv();
    const host = await boot(e);
    const p = await phone(host);
    const desk = await terminal(host, e);
    desk.type("x");
    await waitFor(() => host.hub.getSession(desk.id).title === "Task: x");
    await expect(p.client.call("sessions.cancel", { sessionId: desk.id })).rejects.toMatchObject({ appCode: "not_supported" });
    await p.client.call("sessions.takeover", { sessionId: desk.id });
    expect(desk.yields).toEqual([desk.id]);
    expect(host.hub.getSession(desk.id).driver).toBe("remote");
  }, 15_000);
});
