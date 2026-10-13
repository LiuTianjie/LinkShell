import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent } from "@linkshell/wire";
import { startHost, type RunningHost } from "../../src/host.js";
import { CodexDriver } from "../../src/drivers/codex/driver.js";
import { ClaudeDriver } from "../../src/drivers/claude/driver.js";
import { connectHost, type HostClient } from "../../src/rpc/client.js";
import { modelFixture, type ModelRequest, type ModelReply } from "./model-fixture.js";

import { binaries, verifyToolchain } from "./toolchain.js";
export { binaries } from "./toolchain.js";

export async function until(check: () => boolean, description: string, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function harness(agent: "codex" | "claude", reply: (request: ModelRequest) => ModelReply) {
  verifyToolchain();
  const root = realpathSync(mkdtempSync(join(process.env.LINKSHELL_REAL_AGENT_ROOT ?? "/tmp", "ls-real-")));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const nativeHome = join(root, agent); mkdirSync(nativeHome);
  const api = await modelFixture(reply);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, LANG: "en_US.UTF-8", TMPDIR: root,
    CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"),
    ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "sk-ant-linkshell-fixture-not-a-credential",
    ANTHROPIC_MODEL: "claude-sonnet-4-5", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  };
  if (agent === "codex") writeFileSync(join(nativeHome, "config.toml"), [
    'model = "linkshell-test-model"', 'model_provider = "linkshell_fixture"', 'cli_auth_credentials_store = "file"',
    '[model_providers.linkshell_fixture]', 'name = "LinkShell fixture"', `base_url = "${api.url}/v1"`,
    'wire_api = "responses"', 'supports_websockets = false', 'requires_openai_auth = false',
  ].join("\n"));
  const clients: HostClient[] = [];
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  let host: RunningHost;
  async function boot() {
    return startHost({ home: join(root, "host"), version: "real-contract", env, iceServers: false, discoveryIntervalMs: 0,
      drivers: (paths) => agent === "codex"
        ? [new CodexDriver({ socketPath: paths.codexSocket, command: binaries.codex, env, hostVersion: "real-contract", sharedSocketPath: false, desktopBusPath: false })]
        : [new ClaudeDriver({ claudeCommand: binaries.claude, env, hostVersion: "real-contract", busyWindowMs: 1000 })],
      log: (message) => logs.push(message),
    });
  }
  const removeRoot = () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try { host = await boot(); } catch (error) { await api.close(); await removeRoot(); throw error; }
  return { root, workspace, env, api, logs, get host() { return host; },
    async connect() {
      const client = await connectHost(host.paths.hostSocket); clients.push(client);
      const events: SessionEvent[] = []; client.on("session.event", (event) => events.push(event));
      return { client, events, text: (id: string) => events.flatMap(({ sessionId, update }) => sessionId === id && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []).join("") };
    },
    launch(command: string, args: string[]) {
      const child = spawn(command, args, { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
      let output = ""; child.stdout!.on("data", (data) => output += data); child.stderr!.on("data", (data) => output += data);
      const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve({ code, output })); });
      return { child, done };
    },
    async restart() { for (const client of clients.splice(0)) client.close(); await host.stop(); host = await boot(); },
    async close() {
      await Promise.all(children.map((child) => new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.once("close", () => resolve()); child.kill("SIGKILL");
      })));
      for (const client of clients) client.close();
      try { await host.stop(); } finally {
        // Native CLI descendants may still be exiting after their launcher closes.
        // Retry transient filesystem races, but keep persistent cleanup failures visible.
        try { await api.close(); } finally { await removeRoot(); }
      }
    },
  };
}

export const content = (text: string) => [{ type: "text" as const, text }];
export const completed = (events: SessionEvent[], id: string) => events.filter((event) => event.sessionId === id && event.update.sessionUpdate === "ls_turn" && event.update.state === "ended");
