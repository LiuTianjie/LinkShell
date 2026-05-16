import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Envelope } from "@linkshell/protocol";
import { CodexRpcBridge } from "../src/runtime/acp/codex-rpc-bridge.js";

const bridges: CodexRpcBridge[] = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop();
});

function makeFakeAppServer(): { command: string; logPath: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "linkshell-codex-rpc-test-"));
  const serverPath = join(cwd, "fake-codex-app-server.mjs");
  const logPath = join(cwd, "messages.jsonl");
  writeFileSync(serverPath, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = ${JSON.stringify(logPath)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  appendFileSync(logPath, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-1", turnId: "turn-1" } });
    send({ jsonrpc: "2.0", id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", command: ["pwd"] } });
  } else if (!message.method && message.id === "approval-1") {
    send({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { requestId: "approval-1" } });
  }
});
`, "utf8");
  return { command: `node ${serverPath}`, logPath, cwd };
}

async function waitForEnvelopes(items: Envelope[], count: number): Promise<Envelope[]> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (items.length >= count) return items;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return items;
}

describe("CodexRpcBridge", () => {
  it("passes app-server JSON-RPC through without rewriting ids", async () => {
    const fake = makeFakeAppServer();
    const envelopes: Envelope[] = [];
    const bridge = new CodexRpcBridge({
      command: fake.command,
      cwd: fake.cwd,
      hostDeviceId: "host-1",
      send: (envelope) => envelopes.push(envelope),
    });
    bridges.push(bridge);

    bridge.send({
      jsonrpc: "2.0",
      id: "mobile-init-1",
      method: "initialize",
      params: { clientInfo: { name: "linkshell_mobile" }, capabilities: { experimentalApi: true } },
    });
    const received = await waitForEnvelopes(envelopes, 3);

    expect(received.map((envelope) => envelope.type)).toEqual([
      "agent.codex.rpc",
      "agent.codex.rpc",
      "agent.codex.rpc",
    ]);
    expect(received[0]?.payload).toMatchObject({ id: "mobile-init-1", result: { ok: true } });
    expect(received[2]?.payload).toMatchObject({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
    });

    bridge.send({
      jsonrpc: "2.0",
      id: "approval-1",
      result: { decision: "accept" },
    });
    await waitForEnvelopes(envelopes, 4);

    const logged = readFileSync(fake.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(logged[0]).toMatchObject({ id: "mobile-init-1", method: "initialize" });
    expect(logged[1]).toMatchObject({ id: "approval-1", result: { decision: "accept" } });
  });
});
