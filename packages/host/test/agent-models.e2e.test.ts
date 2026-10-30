import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@linkshell/wire";
import { connectHost } from "../src/rpc/client.js";
import { startHost } from "../src/host.js";
import type { AgentDriver } from "../src/drivers/types.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";
import { ClaudeDriver } from "../src/drivers/claude/driver.js";
import { AcpDriver } from "../src/drivers/acp/driver.js";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
for (const path of [FAKE_CODEX, FAKE_ACP, FAKE_CLAUDE]) chmodSync(path, 0o755);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function newHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "lsh-models-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** A host in `home` (a new one unless given: the same home is the same host after a restart). */
async function boot(drivers: (paths: { codexSocket: string }, home: string) => AgentDriver[], home = newHome()) {
  const host = await startHost({ home, version: "test", drivers: (paths) => drivers(paths, home), log: () => {} });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    client.close();
    await host.stop();
  };
  const client = await connectHost(host.paths.hostSocket);
  cleanups.push(stop);
  return { home, client, stop };
}

const codex = (socketPath: string, env: Record<string, string>) =>
  new CodexDriver({ socketPath, command: FAKE_CODEX, env: { ...process.env, ...env }, hostVersion: "test" });

const acpAgent = (home: string) =>
  new AcpDriver(
    { id: "fake", label: "Fake", tier: "remote", command: FAKE_ACP, args: [], version: { command: FAKE_ACP, args: ["--version"] }, discover: false },
    { env: { ...process.env, FAKE_ACP_STORE: join(home, "fake-acp-store.json") }, hostVersion: "test" },
  );

const claude = (home: string) => {
  const configDir = join(home, "claude-config");
  return new ClaudeDriver({
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, FAKE_ACP_CLAUDE_DIR: configDir, FAKE_ACP_STORE: join(home, "fake-acp-store.json") },
    hostVersion: "test",
    claudeCommand: FAKE_CLAUDE,
    adapter: { command: FAKE_ACP, args: [] },
  });
};

/** How many sessions the fake ACP agent has opened in `home`: listing models must open none. */
const agentSessions = (home: string) => {
  const path = join(home, "fake-acp-store.json");
  return existsSync(path) ? Object.keys(JSON.parse(readFileSync(path, "utf8")) as object).length : 0;
};

/** The fake ACP agent's model option, as `agents.models` gives it (Claude's adapter is the same fake). */
const fakeModels = { models: [{ value: "fast", name: "Fast" }, { value: "smart", name: "Smart" }], current: "fast" };

describe("agents.models", () => {
  it("lists Codex's models from its app-server, with the configured model as the default", async () => {
    const { client } = await boot((paths) => [
      codex(paths.codexSocket, {
        FAKE_CODEX_MODELS: "1",
        FAKE_CODEX_CONFIG_MODEL: "gpt-mini",
        FAKE_CODEX_PROJECT_MODELS: JSON.stringify({ "/projects/big": "gpt-big" }),
      }),
    ]);
    // The names a session's own model option shows; Codex's hidden models left out.
    expect(await client.call("agents.models", { agent: "codex" })).toMatchObject({
      models: [
        { value: "gpt-big", name: "GPT Big", description: "The large one" },
        { value: "gpt-mini", name: "GPT Mini" },
      ],
      current: "gpt-mini",
    });
    // A project's own configuration is read for its directory.
    expect((await client.call("agents.models", { agent: "codex", cwd: "/projects/big" })).current).toBe("gpt-big");
    const selected = await client.call("agents.models", { agent: "codex", model: "gpt-big" });
    expect(selected.current).toBe("gpt-mini");
    expect(selected.config?.find((option) => option.id === "effort")?.values.map((option) => option.value)).toEqual(["low", "medium"]);
    expect(selected.config?.find((option) => option.id === "permissions")?.values.some((option) => option.value === "read-only")).toBe(true);
    await expect(client.call("agents.models", { agent: "nobody" })).rejects.toThrow("unknown agent nobody");

    // The model picked goes to thread/start; none picked leaves Codex to choose, as before.
    const { session } = await client.call("sessions.create", { agent: "codex", cwd: "/projects/app", model: "gpt-big" });
    expect(session.model).toBe("gpt-big");
    const { session: plain } = await client.call("sessions.create", { agent: "codex", cwd: "/projects/app" });
    expect(plain.model).toBe("fake-model");
  });

  it("falls back to the listed default with a Codex that can't read its configuration, and to nothing without a list", async () => {
    const older = await boot((paths) => [codex(paths.codexSocket, { FAKE_CODEX_MODELS: "1" })]);
    expect(await older.client.call("agents.models", { agent: "codex" })).toMatchObject({ current: "gpt-big", models: [{ value: "gpt-big" }, { value: "gpt-mini" }] });
    const oldest = await boot((paths) => [codex(paths.codexSocket, {})]);
    expect(await oldest.client.call("agents.models", { agent: "codex" })).toMatchObject({ models: [] });
  });

  it("offers an ACP agent's models from its latest session, across a host restart, without opening one to ask", async () => {
    const first = await boot((_paths, home) => [acpAgent(home)]);
    // It names its models only to a session, and has had none here.
    expect(await first.client.call("agents.models", { agent: "fake" })).toEqual({ models: [] });
    expect(agentSessions(first.home)).toBe(0);
    await first.client.call("sessions.create", { agent: "fake", cwd: "/w" });
    expect(await first.client.call("agents.models", { agent: "fake" })).toMatchObject(fakeModels);
    const initial = await first.client.call("agents.models", { agent: "fake" });
    const mode = initial.config?.find((option) => option.category === "mode");
    expect(mode?.current).toBe("default");
    await first.client.call("sessions.create", { agent: "fake", cwd: "/w", config: { [mode!.id]: "yolo" } });
    expect((await first.client.call("agents.models", { agent: "fake" })).config?.find((option) => option.id === mode!.id)?.current).toBe("default");
    // One started on another model doesn't make that the default.
    const { session } = await first.client.call("sessions.create", { agent: "fake", cwd: "/w", model: "smart" });
    expect(await first.client.call("agents.models", { agent: "fake" })).toMatchObject(fakeModels);
    await first.stop();

    const second = await boot((_paths, home) => [acpAgent(home)], first.home);
    const opened = agentSessions(first.home);
    expect(await second.client.call("agents.models", { agent: "fake" })).toMatchObject(fakeModels);
    expect(agentSessions(first.home)).toBe(opened);
    // Opening an earlier session (on its own model) keeps the default a new one gets.
    await second.client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    expect(await second.client.call("agents.models", { agent: "fake" })).toMatchObject(fakeModels);
  });

  it("lists Claude's models once a session has told them, keeps them across a restart, and starts a session on the model picked", async () => {
    const { home, client, stop } = await boot((_paths, home) => [claude(home)]);
    const workDir = join(home, "work");
    mkdirSync(workDir, { recursive: true });
    const events: SessionEvent[] = [];
    client.on("session.event", (event) => events.push(event));
    const latest = (sessionId: string, kind: "ls_config" | "ls_notice") => events.filter((e) => e.sessionId === sessionId && e.update.sessionUpdate === kind).at(-1)?.update;
    const modelOf = (sessionId: string) => {
      const config = latest(sessionId, "ls_config");
      return config?.sessionUpdate === "ls_config" ? config.options.find((option) => option.id === "model")?.current : undefined;
    };
    // Asking would mean starting Claude: no list yet.
    expect(await client.call("agents.models", { agent: "claude" })).toEqual({ models: [] });
    expect(agentSessions(home)).toBe(0);
    await client.call("sessions.create", { agent: "claude", cwd: workDir });
    expect(await client.call("agents.models", { agent: "claude" })).toMatchObject(fakeModels);
    const { session } = await client.call("sessions.create", { agent: "claude", cwd: workDir, model: "smart" });
    await client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    // That session is on the model picked; a new one still starts on Claude's default.
    expect(await waitFor(() => modelOf(session.id) === "smart")).toBe(true);
    expect(latest(session.id, "ls_notice")).toBeUndefined();
    expect(await client.call("agents.models", { agent: "claude" })).toMatchObject(fakeModels);
    // A model Claude doesn't offer: the session starts on its default, and says so.
    const { session: other } = await client.call("sessions.create", { agent: "claude", cwd: workDir, model: "nope" });
    await client.call("sessions.subscribe", { sessionId: other.id, fromSeq: 0 });
    expect(await waitFor(() => latest(other.id, "ls_notice"))).toMatchObject({ level: "warning", title: "所选模型 nope 不可用，已使用 Claude 的默认模型" });
    expect(modelOf(other.id)).toBe("fast");
    await stop();

    // Right after a restart, before any Claude has been started.
    const again = await boot((_paths, home) => [claude(home)], home);
    const opened = agentSessions(home);
    expect(await again.client.call("agents.models", { agent: "claude" })).toMatchObject(fakeModels);
    expect(agentSessions(home)).toBe(opened);
  });
});
