import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyDriver, agySpec, parseAgyModelsOutput } from "../src/drivers/acp/agy.js";
import { AntigravityDriver, parseAntigravityTranscript } from "../src/drivers/acp/antigravity.js";
import { normalizeAcpUpdate } from "../src/drivers/acp/mapper.js";
import { mapAcpQuestions, questionMethod } from "../src/drivers/acp/questions.js";
import { ACP_AGENTS, defaultDrivers } from "../src/drivers/registry.js";
import type { DriverHost } from "../src/drivers/types.js";

const tempDirs: string[] = [];
const drivers: AgyDriver[] = [];

afterEach(async () => {
  while (drivers.length) {
    await drivers.pop()!.stop();
  }
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeAgyBinary(
  dir: string,
  options: {
    failModels?: boolean;
    customModels?: { value: string; name: string }[];
    listedSessions?: { sessionId: string; cwd: string; title: string }[];
    cancelRejects?: boolean;
  } = {},
): string {
  const binPath = join(dir, "agy");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const arg = args[0];
if (arg === "--version") {
  console.log("1.5.14");
  process.exit(0);
}
if (arg === "models") {
  if (${JSON.stringify(Boolean(options.failModels))}) {
    console.error("custom provider does not support models subcommand");
    process.exit(1);
  }
  process.stdout.write("\\r⠋ Fetching available models...\\r");
  console.log("gemini-4-neon-high             Gemini 4 Neon (High)");
  console.log("gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)");
  console.log("gemini-4-neon-medium           Gemini 4 Neon (Medium)");
  console.log("gemini-4-neon-low              Gemini 4 Neon (Low)");
  console.log("gemini-3.8-flash-high          Gemini 3.8 Flash (High)");
  console.log("gemini-3.8-flash-low           Gemini 3.8 Flash (Low)");
  console.log("gemini-pro-orchestrator-neon   Orchestrator (Neon)");
  process.exit(0);
}
if (args.includes("--output-format") && args.some((a) => a.startsWith("-p="))) {
  const convIdx = args.indexOf("--conversation");
  const convId = convIdx >= 0 ? args[convIdx + 1] : "side-conv-11111111-2222-3333-4444-555555555555";
  const promptArg = args.find((a) => a.startsWith("-p=")) || "";
  const promptText = promptArg.slice(3);
  const home = process.env.HOME || "";
  if (home) {
    const convDir = path.join(home, ".gemini", "antigravity-cli", "conversations");
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(path.join(convDir, convId + ".db"), "ephemeral");
  }
  console.log(JSON.stringify({ event: "init", conversation_id: convId }));
  console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: convId, tool_summary: "Reading context" } }));
  const reply = convIdx >= 0 ? "FOLLOWUP:" + promptText : "SIDE_OK:" + (promptText.includes("MAIN_CTX_TOKEN") ? "HAS_CTX" : "NO_CTX");
  console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: convId, step_type: "agent_response", text_delta: reply } }));
  console.log(JSON.stringify({ event: "result", result: { conversation_id: convId, status: "SUCCESS", response: reply } }));
  process.exit(0);
}
if (arg !== "acp") {
  process.exit(2);
}

const customModels = ${JSON.stringify(options.customModels ?? null)};
const listedSessions = ${JSON.stringify(options.listedSessions ?? [])};
const cancelRejects = ${JSON.stringify(Boolean(options.cancelRejects))};
let currentModel = customModels ? customModels[0].value : "gemini-4-neon";
let currentThought = "high";
let currentMode = "default";
let inflightPromptId = null;

function configOptions() {
  const opts = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: customModels || [
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
        { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
      ],
    },
  ];
  if (!customModels && currentModel !== "gemini-pro-orchestrator-neon") {
    opts.push({
      id: "thought_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
      currentValue: currentThought,
      options: currentModel === "gemini-4-neon"
        ? [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "xhigh", name: "Extra" },
          ]
        : [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
    });
  }
  opts.push({
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: currentMode,
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
    ],
  });
  return opts;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  if (msg.method === "initialize") {
    reply({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {}, load: {}, resume: {}, close: {} },
      },
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" },
    });
  } else if (msg.method === "session/list") {
    reply({ sessions: listedSessions });
  } else if (msg.method === "session/new") {
    reply({ sessionId: "cli-session-new", configOptions: configOptions() });
  } else if (msg.method === "session/set_config_option") {
    if (msg.params.configId === "model") currentModel = msg.params.value;
    if (msg.params.configId === "thought_level") currentThought = msg.params.value;
    if (msg.params.configId === "mode") currentMode = msg.params.value;
    reply({ configOptions: configOptions() });
  } else if (msg.method === "session/cancel") {
    if (inflightPromptId !== null) {
      const id = inflightPromptId;
      inflightPromptId = null;
      if (cancelRejects) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32800, message: "Request cancelled" } }) + "\\n");
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } }) + "\\n");
      }
    }
  } else if (msg.method === "session/prompt") {
    const text = (msg.params.prompt || []).map((b) => b.text || "").join("");
    if (text.includes("HOLD_OPEN")) {
      inflightPromptId = msg.id;
      return;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: \`model=\${currentModel} thought=\${currentThought} mode=\${currentMode} text=\${text}\` },
        },
      },
    }) + "\\n");
    reply({ stopReason: "end_turn" });
  } else {
    reply({});
  }
});
`;
  writeFileSync(binPath, script, "utf8");
  chmodSync(binPath, 0o755);
  return binPath;
}

function makeMockHost(): {
  host: DriverHost;
  updates: { nativeId: string; update: unknown }[];
  agentStore: Map<string, string>;
  waitForTurnEnd: (nativeId: string) => Promise<void>;
} {
  const updates: { nativeId: string; update: unknown }[] = [];
  const sessionStore = new Map<string, Map<string, string>>();
  const agentStore = new Map<string, string>();
  const waiters: { nativeId: string; resolve: () => void }[] = [];
  const host: DriverHost = {
    sessionSeen: () => {},
    update: (_agent, nativeId, update) => {
      updates.push({ nativeId, update });
      if ((update as { sessionUpdate?: string; state?: string }).sessionUpdate === "ls_turn" && (update as { state?: string }).state === "ended") {
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.nativeId === nativeId) {
            waiters.splice(i, 1)[0]!.resolve();
          }
        }
      }
    },
    follow: async () => {},
    detached: () => {},
    queue: () => {},
    removed: () => {},
    tasks: () => [],
    desktop: () => undefined,
    state: (_agent, nativeId) => ({
      get: (key) => sessionStore.get(nativeId)?.get(key),
      set: (key, value) => {
        if (!sessionStore.has(nativeId)) sessionStore.set(nativeId, new Map());
        sessionStore.get(nativeId)!.set(key, value);
      },
    }),
    agentState: () => ({
      get: (key) => agentStore.get(key),
      set: (key, value) => agentStore.set(key, value),
    }),
    log: () => {},
  };
  const waitForTurnEnd = (nativeId: string) =>
    new Promise<void>((resolve, reject) => {
      if (updates.some((u) => u.nativeId === nativeId && (u.update as { sessionUpdate?: string; state?: string }).sessionUpdate === "ls_turn" && (u.update as { state?: string }).state === "ended")) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error("timed out waiting for turn end")), 5000);
      waiters.push({
        nativeId,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  return { host, updates, agentStore, waitForTurnEnd };
}

describe("parseAgyModelsOutput", () => {
  it("groups multi-effort models like agy acp configOptions and preserves single-entry models", () => {
    const raw = [
      "\r\x1b[2K⠋ Fetching available models...\r",
      "gemini-4-neon-high             Gemini 4 Neon (High)",
      "gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)",
      "gemini-4-neon-medium           Gemini 4 Neon (Medium)",
      "gemini-4-neon-low              Gemini 4 Neon (Low)",
      "gemini-pro-orchestrator-neon   Orchestrator (Neon)",
      "gemini-3.8-flash-high          Gemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium        Gemini 3.8 Flash (Medium)",
      "gemini-3.8-flash-low           Gemini 3.8 Flash (Low)",
      "gpt-oss-120b-medium            GPT-OSS 120B (Medium)",
    ].join("\n");

    const catalog = parseAgyModelsOutput(raw);
    expect(catalog.models).toEqual([
      { value: "gemini-4-neon", name: "Gemini 4 Neon" },
      { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
      { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
      { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ]);
    expect(catalog.defaultModel).toBe("gemini-4-neon");
    expect(catalog.effortsByModel.get("gemini-4-neon")).toEqual({
      defaultEffort: "high",
      values: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra" },
      ],
    });
    expect(catalog.effortsByModel.get("gemini-3.8-flash")?.values.map((v) => v.value)).toEqual(["low", "medium", "high"]);
    expect(catalog.effortsByModel.has("gemini-pro-orchestrator-neon")).toBe(false);
    expect(catalog.effortsByModel.has("gpt-oss-120b-medium")).toBe(false);

    // Non-TTY `agy models` separates model ID and display name with a single tab.
    const tsv = parseAgyModelsOutput(
      "gemini-4-neon-high\tGemini 4 Neon (High)\ngemini-4-neon-low\tGemini 4 Neon (Low)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n",
    );
    expect(tsv.models).toEqual([
      { value: "gemini-4-neon", name: "Gemini 4 Neon" },
      { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ]);
    expect(tsv.effortsByModel.get("gemini-4-neon")?.values.map((v) => v.value)).toEqual(["low", "high"]);
  });
});

describe("AgyDriver registration & protocol parity", () => {
  it("retries a rejected Desktop send on its own published hub without confirming or interrupting it first", async () => {
    const home = makeTempDir("ls-desktop-hub-");
    const data = join(home, ".gemini", "antigravity");
    const logDir = process.platform === "darwin" ? join(home, "Library", "Logs", "Antigravity") : join(home, ".config", "Antigravity", "logs");
    mkdirSync(logDir, { recursive: true });
    mkdirSync(join(data, "brain", "existing"), { recursive: true });
    mkdirSync(join(data, "daemon"));
    writeFileSync(join(logDir, "language_server.log"), "Language server listening on random port at 55201 for HTTP\n");
    for (const port of [55201, 55202]) {
      writeFileSync(join(data, "daemon", `hub_${port}.json`), JSON.stringify({ pid: process.pid, httpPort: port, csrfToken: `fixture-${port}` }), { mode: 0o600 });
    }
    writeFileSync(join(data, "antigravity_state.pbtxt"), "last_selected_agent_model: MODEL_TEST\n");
    const driver = new AntigravityDriver({ hostVersion: "test", env: { PATH: "", HOME: home, LINKSHELL_HOME: home, ANTIGRAVITY_APP_DATA_DIR: data } });
    const { host, updates } = makeMockHost();
    let attempts = 0;
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(new URL(String(url)).port).toBe("55201");
      expect(new Headers(init?.headers).get("x-codeium-csrf-token")).toBe("fixture-55201");
      if (String(url).endsWith("/SendUserCascadeMessage") && ++attempts === 1) return Response.json({ message: "busy" }, { status: 409 });
      return Response.json({});
    });
    try {
      await driver.start(host);
      const send = () => driver.prompt("existing", [{ type: "text", text: "follow up" }], "same-id");
      const echoes = () => updates.filter(({ update }) => (update as { sessionUpdate: string }).sessionUpdate === "user_message_chunk");
      await expect(send()).rejects.toThrow("busy");
      expect(echoes()).toHaveLength(0);
      await expect(send()).resolves.toBe("started");
      expect(echoes()).toHaveLength(1);
      expect(request.mock.calls.some(([url]) => String(url).endsWith("/CancelCascadeInvocation"))).toBe(false);
    } finally {
      await driver.stop();
      request.mockRestore();
    }
  });

  it("registers agy separately from antigravity desktop with no login gate", () => {
    const byId = new Map(ACP_AGENTS.map((spec) => [spec.id, spec]));
    expect(byId.has("antigravity")).toBe(true);
    expect(byId.has("agy")).toBe(true);
    expect(agySpec({ PATH: "" })).toMatchObject({
      id: "agy",
      label: "AGY",
      command: "agy",
      args: ["acp"],
      discover: true,
    });
    expect(agySpec({ PATH: "" }).authStatus).toBeUndefined();

    const driverList = defaultDrivers({
      hostVersion: "test",
      codexSocket: join(tmpdir(), "unused.sock"),
      env: { PATH: "" },
    });
    expect(driverList.some((d) => d.id === "antigravity")).toBe(true);
    expect(driverList.some((d) => d.id === "agy")).toBe(true);
  });

  it("maps Antigravity interaction permission requests for agy as well", () => {
    const params = {
      sessionId: "s-1",
      toolCall: { toolCallId: "interaction_7", title: "选择运行方式" },
      options: [
        { optionId: "a", name: "本地" },
        { optionId: "b", name: "远端" },
      ],
    };
    expect(questionMethod("agy", "session/request_permission", params)).toBe("antigravity-interaction");
    const mapped = mapAcpQuestions("agy", "session/request_permission", params, "req-7");
    expect(mapped.answer([{ id: "interaction_7", values: ["b"] }])).toEqual({
      outcome: { outcome: "selected", optionId: "b" },
    });
  });

  it("separates CLI sessions from desktop-only sessions, previews model efforts, and splits combined model IDs", async () => {
    const root = makeTempDir("ls-agy-e2e-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    mkdirSync(join(home, ".gemini", "antigravity-cli", "conversations"), { recursive: true });
    mkdirSync(join(home, ".gemini", "antigravity", "brain", "desktop-only-id"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "conversations", "cli-only-id.db"), "");

    const agyBin = makeFakeAgyBinary(binDir, {
      listedSessions: [
        { sessionId: "cli-only-id", cwd: root, title: "CLI Session" },
        { sessionId: "desktop-only-id", cwd: root, title: "Desktop Session" },
      ],
    });

    const driver = new AgyDriver({
      hostVersion: "test",
      env: { ...process.env, HOME: home, LINKSHELL_AGY_PATH: agyBin },
    });
    drivers.push(driver);
    const { host, updates, waitForTurnEnd } = makeMockHost();

    const status = await driver.start(host);
    expect(status).toEqual({ installed: true, version: "1.5.14" });
    // Auth is never gated or assumed missing before trying ACP.
    expect(await driver.authStatus()).toEqual({ state: "unknown" });

    // Cold-start listModels works before creating any session.
    const cold = await driver.listModels(root);
    expect(cold.models.map((m) => m.value)).toEqual(["gemini-4-neon", "gemini-3.8-flash", "gemini-pro-orchestrator-neon"]);
    expect(cold.config?.find((c) => c.id === "thought_level")?.values.map((v) => v.value)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(cold.config?.find((c) => c.id === "mode")?.values.map((v) => v.value)).toContain("plan");

    // Previewing a different model adjusts thought_level choices accurately.
    const flashPreview = await driver.listModels(root, "gemini-3.8-flash");
    expect(flashPreview.config?.find((c) => c.id === "thought_level")?.values.map((v) => v.value)).toEqual(["low", "high"]);
    const orchPreview = await driver.listModels(root, "gemini-pro-orchestrator-neon");
    expect(orchPreview.config?.find((c) => c.id === "thought_level")).toBeUndefined();

    // Desktop-only sessions are excluded from agy discovery to prevent duplicates.
    const sessions = await driver.listSessions(20);
    expect(sessions.map((s) => s.nativeId)).toEqual(["cli-only-id"]);

    // Combined model IDs (e.g. from legacy preferences) split cleanly into base model + thought_level.
    const created = await driver.createSession({ cwd: root, model: "gemini-4-neon-xhigh" });
    expect(created.nativeId).toBe("cli-session-new");
    await driver.setConfig(created.nativeId, "mode", "plan");
    await driver.prompt(created.nativeId, [{ type: "text", text: "hi" }], "msg-1");
    await waitForTurnEnd(created.nativeId);

    const agentText = updates
      .map((entry) => entry.update as { sessionUpdate?: string; content?: { text?: string } })
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text ?? "")
      .join("");
    expect(agentText).toContain("model=gemini-4-neon thought=xhigh mode=plan");
  });

  it("works with CC-Switch / custom providers without official login or `agy models` support", async () => {
    const root = makeTempDir("ls-agy-ccswitch-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const agyBin = makeFakeAgyBinary(binDir, {
      failModels: true,
      customModels: [{ value: "cc-switch-custom-model", name: "CC Switch Model" }],
    });

    const driver = new AgyDriver({
      hostVersion: "test",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        LINKSHELL_AGY_PATH: agyBin,
      },
    });
    drivers.push(driver);
    const { host, updates, waitForTurnEnd } = makeMockHost();

    expect(await driver.start(host)).toEqual({ installed: true, version: "1.5.14" });
    expect(await driver.authStatus()).toEqual({ state: "unknown" });
    // Failing `agy models` degrades gracefully to empty list instead of throwing.
    expect(await driver.listModels(root)).toEqual({ models: [] });

    // Creating a session still works and learns the live custom model list from ACP.
    const created = await driver.createSession({ cwd: root });
    const afterCreate = await driver.listModels(root);
    expect(afterCreate.models).toEqual([{ value: "cc-switch-custom-model", name: "CC Switch Model" }]);

    await driver.prompt(created.nativeId, [{ type: "text", text: "hello" }], "msg-1");
    await waitForTurnEnd(created.nativeId);
    const agentText = updates
      .map((entry) => entry.update as { sessionUpdate?: string; content?: { text?: string } })
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text ?? "")
      .join("");
    expect(agentText).toContain("model=cc-switch-custom-model");
  });

  it("supports read-only side chats with transcript context, follow-up reuse, hidden discovery, and cleanup on close", async () => {
    const root = makeTempDir("ls-agy-side-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    const logsDir = join(home, ".gemini", "antigravity-cli", "brain", "main-sess-1", ".system_generated", "logs");
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(logsDir, "transcript.jsonl"),
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>Please inspect MAIN_CTX_TOKEN</USER_REQUEST>" }) + "\n",
    );

    const agyBin = makeFakeAgyBinary(binDir);
    const driver = new AgyDriver({
      hostVersion: "test",
      env: { ...process.env, HOME: home, LINKSHELL_AGY_PATH: agyBin },
    });
    drivers.push(driver);
    const { host } = makeMockHost();
    await driver.start(host);
    expect(driver.capabilities.side).toBe(true);

    const chunks1: string[] = [];
    const activities1: string[] = [];
    await driver.sideAsk(
      "main-sess-1",
      { sideId: "s-1", cwd: root, question: "What token?", history: [] },
      { text: (d) => chunks1.push(d), activity: (a) => activities1.push(a) },
      new AbortController().signal,
    );
    expect(chunks1.join("")).toBe("SIDE_OK:HAS_CTX");
    expect(activities1).toContain("Reading context");

    // Ephemeral side conversation stays hidden from session discovery.
    const sideConvId = "side-conv-11111111-2222-3333-4444-555555555555";
    const sideDb = join(home, ".gemini", "antigravity-cli", "conversations", `${sideConvId}.db`);
    expect(existsSync(sideDb)).toBe(true);
    expect(driver.sessionExists(sideConvId, root)).toBe(false);

    // Follow-up reuses the same side conversation.
    const chunks2: string[] = [];
    await driver.sideAsk(
      "main-sess-1",
      { sideId: "s-1", cwd: root, question: "And next?", history: [{ question: "What token?", answer: "SIDE_OK:HAS_CTX" }] },
      { text: (d) => chunks2.push(d), activity: () => {} },
      new AbortController().signal,
    );
    expect(chunks2.join("")).toBe("FOLLOWUP:And next?");

    // Closing cleans up ephemeral side files.
    await driver.sideClose("main-sess-1", "s-1");
    expect(existsSync(sideDb)).toBe(false);
  });

  it("handles interrupt-and-send cleanly without emitting a false turn_failed error when ACP rejects with -32800", async () => {
    const root = makeTempDir("ls-agy-interrupt-");
    const home = join(root, "home");
    const binDir = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const agyBin = makeFakeAgyBinary(binDir, { cancelRejects: true });
    const driver = new AgyDriver({
      hostVersion: "test",
      env: { ...process.env, HOME: home, LINKSHELL_AGY_PATH: agyBin },
    });
    drivers.push(driver);
    const { host, updates, waitForTurnEnd } = makeMockHost();
    await driver.start(host);

    const created = await driver.createSession({ cwd: root });
    expect(await driver.prompt(created.nativeId, [{ type: "text", text: "HOLD_OPEN" }], "m-1")).toBe("started");
    expect(await driver.prompt(created.nativeId, [{ type: "text", text: "NEXT_AFTER_INTERRUPT" }], "m-2")).toBe("queued");

    await driver.sendQueuedNow(created.nativeId);
    await waitForTurnEnd(created.nativeId);
    // Wait for the queued follow-up turn to finish as well.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const errors = updates.filter((u) => (u.update as { sessionUpdate?: string }).sessionUpdate === "ls_error");
    expect(errors).toEqual([]);
    const agentText = updates
      .map((entry) => entry.update as { sessionUpdate?: string; content?: { text?: string } })
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text ?? "")
      .join("");
    expect(agentText).toContain("NEXT_AFTER_INTERRUPT");
  });

  it("maps swarm, run_workflow, single-agent invoke_subagent, and desktop DB child workers", async () => {
    // 1. ACP mapper handles swarm / run_workflow / Path
    const swarmAdd = normalizeAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-swarm-1",
      name: "swarm",
      rawInput: { action: "add", name: "reviewer", brief: "Audit API layer", model: "gemini-4-neon" },
    });
    expect(swarmAdd).toMatchObject({
      sessionUpdate: "tool_call",
      detail: { type: "subagent", action: "spawn", agentType: "swarm", name: "reviewer", task: "Audit API layer", model: "gemini-4-neon" },
    });
    const readWithPath = normalizeAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-read-1",
      name: "read_file",
      rawInput: { Path: "/tmp/demo.ts" },
    });
    expect(readWithPath).toMatchObject({ rawInput: { path: "/tmp/demo.ts" } });

    // 2. Desktop transcript parser maps swarm + single invoke_subagent + read_file/edit_file
    const root = makeTempDir("ls-agy-swarm-");
    const dataDir = join(root, "antigravity");
    const parentId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const dbWorkerId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const parentLogs = join(dataDir, "brain", parentId, ".system_generated", "logs");
    const workerLogs = join(dataDir, "brain", dbWorkerId, ".system_generated", "logs");
    mkdirSync(parentLogs, { recursive: true });
    mkdirSync(workerLogs, { recursive: true });

    const parentTranscript = join(parentLogs, "transcript.jsonl");
    writeFileSync(
      parentTranscript,
      [
        JSON.stringify({
          step_index: 0,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            { id: "c1", name: "swarm", args: { action: "add", name: "worker", brief: "Build UI", model: "gemini-4-neon" } },
            { id: "c2", name: "invoke_subagent", args: { Role: "Researcher", Prompt: "Check docs", TypeName: "research", Model: "flash" } },
            { id: "c3", name: "read_file", args: { Path: "/tmp/a.ts" } },
          ],
        }),
        JSON.stringify({ step_index: 1, type: "GENERIC", content: "added worker" }),
        JSON.stringify({ step_index: 2, type: "GENERIC", content: "done" }),
        JSON.stringify({ step_index: 3, type: "GENERIC", content: "file content" }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(workerLogs, "transcript.jsonl"),
      JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", content: "Swarm worker finished audit." }) + "\n",
    );

    const parsed = parseAntigravityTranscript(parentTranscript, 0);
    const toolCalls = parsed.items.flatMap((item) => item.updates).filter((u) => u.sessionUpdate === "tool_call");
    expect(toolCalls[0]).toMatchObject({
      detail: { type: "subagent", action: "spawn", agentType: "swarm", name: "worker", task: "Build UI", model: "gemini-4-neon" },
    });
    expect(toolCalls[1]).toMatchObject({
      detail: { type: "subagent", action: "spawn", agentType: "research", name: "Researcher", task: "Check docs", model: "flash" },
    });
    expect(toolCalls[2]).toMatchObject({ kind: "read", locations: [{ path: "/tmp/a.ts" }] });

    // 3. Desktop DB parent_conversation_id discovery nests Swarm workers whose output had no JSON conversationId
    const db = new DatabaseSync(join(dataDir, "conversation_summaries.db"));
    db.exec(`CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      last_modified_time TEXT,
      workspace_uris TEXT,
      status TEXT,
      parent_conversation_id TEXT,
      killed INTEGER
    )`);
    db.prepare(`INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      parentId, "Main Swarm Task", "2026-11-21T15:00:00Z", JSON.stringify([`file://${root}`]), "CASCADE_RUN_STATUS_IDLE", "", 0,
    );
    db.prepare(`INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      dbWorkerId, "Audit Worker", "2026-11-21T15:01:00Z", JSON.stringify([`file://${root}`]), "CASCADE_RUN_STATUS_IDLE", parentId, 0,
    );
    db.close();

    const desktopDriver = new AntigravityDriver({
      hostVersion: "test",
      env: { PATH: "", HOME: root, ANTIGRAVITY_APP_DATA_DIR: dataDir },
    });
    try {
      const { host } = makeMockHost();
      await desktopDriver.start(host);
      const history = await desktopDriver.attach(parentId, { cwd: root });
      const flat = history.flatMap((item) => item.updates);
      const dbSpawn = flat.find(
        (u) => u.sessionUpdate === "tool_call" && u.detail?.type === "subagent" && u.detail.nativeSessionId === dbWorkerId,
      );
      expect(dbSpawn).toMatchObject({
        sessionUpdate: "tool_call",
        title: "Audit Worker",
        detail: { type: "subagent", action: "spawn", agentType: "swarm", name: "Audit Worker", nativeSessionId: dbWorkerId },
      });
      const nestedMsg = flat.find(
        (u) => u.sessionUpdate === "agent_message_chunk" && u.parentToolCallId === (dbSpawn as { toolCallId: string }).toolCallId,
      );
      expect(nestedMsg).toMatchObject({ content: { type: "text", text: "Swarm worker finished audit." } });
    } finally {
      await desktopDriver.stop();
    }
  });
});
