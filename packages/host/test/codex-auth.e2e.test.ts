import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";

const command = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

describe("Codex authentication through the host", () => {
  it.each([
    { name: "ChatGPT", account: { account: { type: "chatgpt" }, requiresOpenaiAuth: true }, auth: { state: "ok", method: "chatgpt" } },
    { name: "API key", account: { account: { type: "apiKey" }, requiresOpenaiAuth: true }, auth: { state: "ok", method: "api_key" } },
    { name: "custom provider without account login", account: { account: null, requiresOpenaiAuth: false }, auth: { state: "ok", method: "provider" } },
    { name: "no account detected", account: { account: null, requiresOpenaiAuth: true }, auth: { state: "unknown" } },
    { name: "older Codex reporting Not logged in", account: undefined, auth: { state: "unknown" } },
  ])("allows creating and continuing a session with $name", async ({ account, auth }) => {
    const home = mkdtempSync(join(tmpdir(), "lsh-auth-"));
    let host: RunningHost | undefined;
    let client: Awaited<ReturnType<typeof connectHost>> | undefined;
    try {
      host = await startHost({
        home, version: "test", log: () => {},
        drivers: (paths) => [new CodexDriver({
          command, socketPath: paths.codexSocket, hostVersion: "test",
          sharedSocketPath: false, desktopBusPath: false,
          env: { ...process.env, CODEX_HOME: home, FAKE_CODEX_LOGGED_OUT: "1", FAKE_CODEX_ACCOUNT: JSON.stringify(account) },
        })],
      });
      client = await connectHost(host.paths.hostSocket);
      const info = await client.call("machine.info", {});
      expect(info.agents[0]).toMatchObject({ id: "codex", installed: true, auth });
      // Both existing clients disable Codex when this is "missing".
      expect(info.agents[0]!.auth?.state).not.toBe("missing");
      const { session } = await client.call("sessions.create", { agent: "codex", cwd: home });
      await client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
      const reply: string[] = [];
      client.on("session.event", ({ update }) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") reply.push(update.content.text);
      });
      await client.call("sessions.prompt", { sessionId: session.id, clientMessageId: "auth-check", content: [{ type: "text", text: "hello" }] });
      await expect.poll(() => reply.join(""), { timeout: 5000 }).toBe("echo: hello");
    } finally {
      client?.close();
      await host?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
