import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageParser, UsageStatistics, summarizeUsage } from "../src/usage.js";

const timestamp = "2026-10-17T02:00:00.000Z";
const codex = (input: number, output: number, cached = 0, extra = {}) => JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached }, ...extra } } });
const claude = (output: number) => JSON.stringify({ timestamp, type: "assistant", sessionId: "claude-session", message: { id: "msg-1", model: "claude-test", usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 40, cache_creation_input_tokens: 20 } } });
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("native usage statistics", () => {
  it("subtracts cumulative Codex usage and excludes cached tokens from fresh input", () => {
    const parser = new UsageParser("codex", "session");
    parser.parse(JSON.stringify({ type: "turn_context", payload: { model: "gpt-test" } }));
    expect(parser.parse(codex(100, 20, 40))).toMatchObject({ model: "gpt-test", inputTokens: 60, outputTokens: 20, cacheReadTokens: 40 });
    expect(parser.parse(codex(100, 20, 40))).toBeUndefined();
    expect(parser.parse(codex(160, 30, 60))).toMatchObject({ inputTokens: 40, outputTokens: 10, cacheReadTokens: 20 });
  });
  it("uses last usage when a Codex cumulative counter resets", () => {
    const parser = new UsageParser("codex", "session");
    parser.parse(codex(100, 20));
    expect(parser.parse(codex(20, 5, 0, { last_token_usage: { input_tokens: 20, output_tokens: 5 } }))).toMatchObject({ inputTokens: 20, outputTokens: 5 });
    expect(parser.parse("{broken")).toBeUndefined();
    expect(parser.parse(JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }))).toBeUndefined();
  });
  it("deduplicates Claude blocks and copied Codex history, preserving cache categories", () => {
    const a = new UsageParser("claude", "a"), b = new UsageParser("codex", "b"), fork = new UsageParser("codex", "fork");
    const rows = [a.parse(claude(10))!, a.parse(claude(20))!, b.parse(codex(100, 20, 40))!, fork.parse(codex(100, 20, 40))!];
    const now = Date.parse(timestamp) + 1000;
    const result = summarizeUsage(rows, { days: 7, agent: "all" }, now);
    expect(result.totals).toEqual({ records: 2, sessions: 2, inputTokens: 160, outputTokens: 40, cacheReadTokens: 80, cacheWriteTokens: 20, totalTokens: 300 });
    expect(result.daily).toHaveLength(7);
    expect(result.daily.reduce((sum, day) => sum + day.totalTokens, 0)).toBe(300);
    expect(summarizeUsage(rows, { days: 1, agent: "claude" }, now).totals.totalTokens).toBe(180);
    expect(summarizeUsage(rows, { days: 1, agent: "all" }, now + 3 * 86400000).totals.records).toBe(0);
  });
  it("does not count synthetic Claude errors with zero usage", () => {
    const parser = new UsageParser("claude", "session");
    const row = JSON.parse(claude(0));
    row.message.usage = { input_tokens: 0, output_tokens: 0 };
    expect(parser.parse(JSON.stringify(row))).toBeUndefined();
  });
  it("scans projects, subagents and archives without sending message content", async () => {
    const root = await mkdtemp(join(tmpdir(), "linkshell-usage-")); temporary.push(root);
    const codexRoot = join(root, "codex"), claudeRoot = join(root, "claude");
    await mkdir(join(codexRoot, "archived_sessions"), { recursive: true });
    await mkdir(join(claudeRoot, "projects", "project", "subagents"), { recursive: true });
    const today = new Date().toISOString();
    await writeFile(join(codexRoot, "archived_sessions", "session.jsonl"), codex(100, 20).replace(timestamp, today) + "\n");
    await writeFile(join(claudeRoot, "projects", "project", "subagents", "agent.jsonl"), claude(20).replace(timestamp, today) + "\n{partial");
    const service = new UsageStatistics({ codex: codexRoot, claude: claudeRoot });
    const [first, second] = await Promise.all([service.summary({ days: 7, agent: "all" }), service.summary({ days: 7, agent: "all" })]);
    expect(first.totals.records).toBe(2);
    expect(second.totals).toEqual(first.totals);
    expect(first.warnings).toEqual([]);
    expect(JSON.stringify(first)).not.toContain(root);
    expect(JSON.stringify(first)).not.toContain("msg-1");
    expect((await service.summary({ days: 7, agent: "codex" })).totals.records).toBe(1);
  });
});
