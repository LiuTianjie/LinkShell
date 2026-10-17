import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageParser, UsageStatistics, summarizeUsage, usageEventRecords } from "../src/usage.js";

import { HostStore } from "../src/store.js";
import type { SessionEvent } from "@linkshell/wire";

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

describe("all-agent usage", () => {
  it("counts scoped work, ignores context snapshots and deduplicates replay", () => {
    const event = (seq: number, agent = "gemini"): SessionEvent & { agent: string } => ({ agent, sessionId: `${agent}:one`, seq, ts: Date.parse(timestamp),
      update: { sessionUpdate: "usage_update", accounting: { id: "turn-one", scope: "turn", model: "model-a" }, tokens: { totalTokens: 120, inputTokens: 100, outputTokens: 20, cachedReadTokens: 40 } } });
    const context: SessionEvent & { agent: string } = { ...event(3), update: { sessionUpdate: "usage_update", usedTokens: 60000, contextWindow: 100000 } };
    const rows = [...usageEventRecords([event(1), event(2), context, event(4, "custom-agent"), event(5, "codex")])];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, totalTokens: 120 });
    expect(summarizeUsage(rows, { days: 1, agent: "custom-agent" }, Date.parse(timestamp) + 1).totals.totalTokens).toBe(120);
  });
  it("establishes cumulative baseline before the date range, and never charges reset history", () => {
    const events = [100, 160, 160, 20, 40].map((total, i): SessionEvent & { agent: string } => ({
      agent: "copilot", sessionId: "copilot:one", seq: i, ts: Date.parse(timestamp) + i,
      update: { sessionUpdate: "usage_update", accounting: { id: `turn-${i}`, scope: "session" },
        tokens: { totalTokens: total, inputTokens: total, outputTokens: 0 } },
    }));
    expect([...usageEventRecords(events)].map(row => row.totalTokens)).toEqual([60, 20]);
  });
  it("keeps every registered agent including custom agents and shows missing reports explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "linkshell-usage-")); temporary.push(root);
    const store = new HostStore(join(root, "state.db"));
    try {
      const now = Date.now();
      for (const agent of ["gemini", "grok", "custom-agent"]) {
        store.upsertSession({ id: `${agent}:one`, nativeId: "one", agent, cwd: root, createdAt: now, updatedAt: now });
        store.appendEvent(`${agent}:one`, { sessionUpdate: "usage_update", accounting: { id: "work-one", scope: "turn" }, tokens: { totalTokens: 42, inputTokens: 40, outputTokens: 2 } }, now);
      }
      const ids = ["codex", "claude", "gemini", "antigravity", "copilot", "grok", "opencode", "cursor", "custom-agent"];
      const service = new UsageStatistics({ codex: join(root, "codex"), claude: join(root, "claude") }, {
        agents: () => ids.map(id => ({ id, label: id })), events: () => store.usageEvents(),
      });
      const report = await service.summary({ days: 7, agent: "all" });
      expect(report.agents?.map(agent => agent.id)).toEqual(ids);
      expect(report.totals.totalTokens).toBe(126);
      expect(report.agents?.find(agent => agent.id === "cursor")).toMatchObject({ status: "no_data", records: 0 });
      expect((await service.summary({ days: 7, agent: "grok" })).totals.totalTokens).toBe(42);
      expect(JSON.stringify(report)).not.toContain(root);
    } finally { store.close(); }
  });
});
