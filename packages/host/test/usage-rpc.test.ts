import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost } from "../src/host.js";
import { connectHost } from "../src/rpc/client.js";

it("serves the same filtered statistics to desktop and phone using the agent environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "ls-usage-rpc-"));
  const codex = join(root, "codex"), claude = join(root, "claude");
  await mkdir(join(claude, "projects"), { recursive: true });
  await writeFile(join(claude, "projects", "sample.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), sessionId: "sample", message: { id: "message", model: "test-model", usage: { input_tokens: 10, output_tokens: 5 } } }) + "\n");
  const host = await startHost({ home: join(root, "host"), version: "test", env: { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude }, drivers: () => [], discoveryIntervalMs: 0, log: () => {} });
  const desktop = await connectHost(host.paths.hostSocket), phone = await connectHost(host.paths.hostSocket);
  try {
    const result = await desktop.call("usage.summary", { days: 7, agent: "all" });
    expect(result.totals.totalTokens).toBe(15);
    expect((await phone.call("usage.summary", { days: 7, agent: "claude" })).totals).toEqual(result.totals);
    expect((await phone.call("usage.summary", { days: 7, agent: "codex" })).totals.records).toBe(0);
    await expect(phone.call("usage.summary", { days: 999, agent: "all" } as never)).rejects.toThrow();
    expect(JSON.stringify(result)).not.toContain(root);
  } finally { desktop.close(); phone.close(); await host.stop(); await rm(root, { recursive: true, force: true }); }
});
