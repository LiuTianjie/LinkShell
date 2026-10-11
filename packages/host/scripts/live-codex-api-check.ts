// The real Codex CLI against a loopback Responses fixture: no account or paid API calls.
// Checks that saved API keys and provider env keys survive the complete host -> Codex -> HTTP
// request -> streamed client reply, including a second turn in the same session.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { startHost, type RunningHost } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";
import type { SessionEvent } from "@linkshell/wire";

for (const method of ["api-key", "provider-env", "provider-no-auth"] as const) {
  const home = mkdtempSync("/tmp/lsh-api-");
  const codexHome = join(home, "codex");
  const workspace = join(home, "workspace");
  mkdirSync(codexHome); mkdirSync(workspace);
  const key = "linkshell-test-key-not-a-real-credential";
  const expectedAuth = method === "provider-no-auth" ? undefined : `Bearer ${key}`;
  const requests: { auth: boolean; model: unknown; prompt: boolean }[] = [];
  const failures: string[] = [];
  const api = createServer(async (request, response) => {
    if (request.url !== "/v1/responses" || request.method !== "POST") { response.writeHead(404).end(); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const encoded = Buffer.concat(chunks);
      const body = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(encoded)
        : request.headers["content-encoding"] === "gzip" ? gunzipSync(encoded) : encoded;
      const payload = JSON.parse(body.toString());
      const authenticated = request.headers.authorization === expectedAuth;
      requests.push({ auth: authenticated, model: payload.model, prompt: JSON.stringify(payload.input).includes("API-AUTH-CHECK") });
      if (!authenticated) { response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Fixture API key missing", type: "authentication_error" } })); return; }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let sequence = 0;
      const emit = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
      const id = `resp_${requests.length}`;
      const item = { id: `msg_${requests.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "API-AUTH-OK", annotations: [] }] };
      emit("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
      emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      emit("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      emit("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "API-AUTH-OK" });
      emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "API-AUTH-OK" });
      emit("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500).end();
    }
  });
  let host: RunningHost | undefined;
  let client: Awaited<ReturnType<typeof connectHost>> | undefined;
  try {
    api.listen(0, "127.0.0.1"); await once(api, "listening");
    const port = (api.address() as { port: number }).port;
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "linkshell-test-model"', 'model_provider = "linkshell_test"',
      'cli_auth_credentials_store = "file"',
      '[model_providers.linkshell_test]', 'name = "LinkShell API fixture"',
      `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"',
      'supports_websockets = false', `requires_openai_auth = ${method === "api-key"}`,
      ...(method === "provider-env" ? ['env_key = "LINKSHELL_TEST_API_KEY"'] : []),
    ].join("\n"));
    if (method === "api-key") writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: key }), { mode: 0o600 });
    // Do not inherit the developer's credentials, provider, proxy, or Codex home.
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, LANG: "en_US.UTF-8",
      ...(method === "provider-env" ? { LINKSHELL_TEST_API_KEY: key } : {}) };
    host = await startHost({
      home: join(home, "host"), version: "api-check", env, iceServers: false, discoveryIntervalMs: 0, log: () => {},
      drivers: (paths) => [new CodexDriver({ socketPath: paths.codexSocket, env, hostVersion: "api-check", sharedSocketPath: false, desktopBusPath: false })],
    });
    client = await connectHost(host.paths.hostSocket);
    const agent = (await client.call("machine.info", {})).agents[0]!;
    assert.equal(agent.installed, true); assert.equal(agent.problem, undefined);
    assert.equal(agent.auth?.state, "ok");
    assert.equal(agent.auth?.method, method === "api-key" ? "api_key" : "provider");
    const events: SessionEvent[] = [];
    client.on("session.event", (event) => events.push(event));
    const { session } = await client.call("sessions.create", { agent: "codex", cwd: workspace });
    await client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
    for (let turn = 1; turn <= 2; turn++) {
      const start = events.length;
      await client.call("sessions.prompt", { sessionId: session.id, clientMessageId: `check-${turn}`, content: [{ type: "text", text: "API-AUTH-CHECK: Reply briefly without tools." }] });
      const deadline = Date.now() + 30_000;
      while (!events.slice(start).some(({ update }) => update.sessionUpdate === "ls_turn" && update.state === "ended") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      const current = events.slice(start);
      const reply = current.flatMap(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []).join("");
      assert.equal(reply, "API-AUTH-OK", `${method} turn ${turn}: did not receive the API reply`);
      assert.equal(host.hub.getSession(session.id).state, "idle");
    }
    assert.deepEqual(failures, []);
    assert.equal(requests.length, 2);
    assert(requests.every((request) => request.auth && request.prompt && request.model === "linkshell-test-model"));
    console.log(`PASS ${method}: provider preserved, HTTP authentication checked, two streamed turns completed`);
  } finally {
    client?.close(); await host?.stop();
    api.closeAllConnections(); await new Promise<void>((resolve) => api.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}
