import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToHost } from "node:timers/promises";
import type { UsageQuery, UsageReport, UsageTotals, SessionEvent } from "@linkshell/wire";

type NativeAgent = "codex" | "claude";
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" ? value as Json : {};
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const text = (value: unknown, fallback: string) => typeof value === "string" && value ? value : fallback;
export interface UsageRecord {
  key: string; session: string; agent: string; model: string; timestamp: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens?: number;
}

/** Native logs are cumulative (Codex) or repeated content blocks (Claude), never additive lines. */
export class UsageParser {
  private model = "未知模型";
  private session: string;
  private previous = [0, 0, 0, 0];
  constructor(private agent: NativeAgent, fallbackSession: string) { this.session = fallbackSession; }
  parse(line: string): UsageRecord | undefined {
    let row: Json;
    try { row = object(JSON.parse(line)); } catch { return; }
    const payload = object(row.payload);
    if (this.agent === "codex") {
      if (row.type === "session_meta") this.session = text(payload.id, this.session);
      if (row.type === "turn_context" || (row.type === "event_msg" && payload.type === "thread_settings_applied")) this.model = text(payload.model, this.model);
      if (row.type !== "event_msg" || payload.type !== "token_count") return;
      const info = object(payload.info);
      const total = object(info.total_token_usage);
      if (typeof total.input_tokens !== "number" || typeof total.output_tokens !== "number") return;
      const current = [count(total.input_tokens), count(total.output_tokens), count(total.cached_input_tokens), count(total.cache_creation_input_tokens)];
      const reset = current.some((value, index) => value < this.previous[index]!);
      const last = object(info.last_token_usage);
      const delta = reset
        ? [count(last.input_tokens), count(last.output_tokens), count(last.cached_input_tokens), count(last.cache_creation_input_tokens)]
        : current.map((value, index) => value - this.previous[index]!);
      this.previous = current;
      const [input, output, cached, written] = delta as [number, number, number, number];
      const timestamp = Date.parse(String(row.timestamp));
      if (!Number.isFinite(timestamp) || input + output + written === 0) return;
      // Copied fork history retains timestamps and counters; do not charge it twice.
      return { key: `codex:${timestamp}:${this.model}:${current.join(":")}`, session: this.session, agent: this.agent, model: this.model, timestamp,
        inputTokens: Math.max(0, input - cached - written), outputTokens: output, cacheReadTokens: Math.min(input, cached), cacheWriteTokens: written };
    }
    if (row.type !== "assistant") return;
    const message = object(row.message), usage = object(message.usage);
    if (typeof message.id !== "string" || typeof usage.input_tokens !== "number") return;
    const timestamp = Date.parse(String(row.timestamp));
    if (!Number.isFinite(timestamp)) return;
    if (![usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].some(value => count(value) > 0)) return;
    return { key: `claude:${message.id}`, session: text(row.sessionId, this.session), agent: this.agent,
      model: text(message.model, "未知模型"), timestamp, inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens), cacheWriteTokens: count(usage.cache_creation_input_tokens) };
  }
}
const emptyTotals = (): UsageTotals => ({ records: 0, sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
function mergeRecord(records: Map<string, UsageRecord>, row: UsageRecord) {
  const previous = records.get(row.key);
  if (!previous || row.outputTokens >= previous.outputTokens) records.set(row.key, row);
}
export function summarizeUsage(records: Iterable<UsageRecord>, query: UsageQuery, now = Date.now(), warnings: string[] = []): UsageReport {
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - query.days + 1);
  const unique = new Map<string, UsageRecord>();
  for (const row of records) mergeRecord(unique, row);
  type Group = { totals: UsageTotals; sessions: Set<string> };
  const group = (): Group => ({ totals: emptyTotals(), sessions: new Set() });
  const total = group(), daily = new Map<string, Group>(), models = new Map<string, Group & { model: string; agent: string }>();
  for (let day = new Date(start); day.getTime() <= now; day.setDate(day.getDate() + 1)) daily.set(dateKey(day), group());
  const add = (target: Group, row: UsageRecord) => {
    target.totals.records++; target.sessions.add(`${row.agent}:${row.session}`); target.totals.sessions = target.sessions.size;
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) target.totals[key] += row[key];
    target.totals.totalTokens += row.totalTokens ?? (row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens);
  };
  for (const row of unique.values()) {
    if (row.timestamp < start.getTime() || row.timestamp > now || (query.agent !== "all" && row.agent !== query.agent)) continue;
    add(total, row); add(daily.get(dateKey(new Date(row.timestamp)))!, row);
    const name = modelName(row.model);
    const key = `${row.agent}:${name}`;
    let model = models.get(key);
    if (!model) { model = { ...group(), model: name, agent: row.agent }; models.set(key, model); }
    add(model, row);
  }
  return { generatedAt: now, days: query.days, agent: query.agent, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    totals: total.totals, daily: [...daily].map(([date, value]) => ({ date, ...value.totals })),
    models: [...models.values()].map(value => ({ agent: value.agent, model: value.model, ...value.totals })).sort((a, b) => b.totalTokens - a.totalTokens), warnings };
}

/**
 * One name per model: Claude's API writes `claude-opus-5-5` where its other tools write
 * `claude-opus-5.5`, so the same model would be counted twice.
 */
export function modelName(model: string): string {
  return model.replace(/^(claude-[a-z]+-\d+)-(\d)(?=$|[-[])/, "$1.$2");
}

export interface UsageEventSource {
  agents(): { id: string; label: string }[];
  events(): Iterable<SessionEvent & { agent: string }>;
}

/** Context occupancy and older unscoped updates cannot be safely summed. */
export function* usageEventRecords(events: Iterable<SessionEvent & { agent: string }>): Iterable<UsageRecord> {
  const previous = new Map<string, number[]>();
  const seen = new Set<string>();
  for (const event of events) {
    const update = event.update;
    if (event.agent === "codex" || event.agent === "claude" || update.sessionUpdate !== "usage_update" || !update.tokens || !update.accounting) continue;
    const { tokens, accounting } = update;
    const key = `${event.sessionId}:${accounting.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const values = [tokens.totalTokens, tokens.inputTokens, tokens.outputTokens, tokens.cachedReadTokens ?? 0, tokens.cachedWriteTokens ?? 0];
    if (values.some(value => !Number.isSafeInteger(value) || value < 0)) continue;
    let delta = values;
    if (accounting.scope === "session") {
      const baseline = previous.get(event.sessionId);
      previous.set(event.sessionId, values);
      // Attaching mid-session must not charge older usage to today's date.
      if (!baseline || values.some((value, i) => value < baseline[i]!)) continue;
      delta = values.map((value, i) => value - baseline[i]!);
    }
    const [total, input, output, cached, written] = delta as [number, number, number, number, number];
    if (!total) continue;
    // ACP implementations differ on whether cache tokens are included in input.
    const exclusive = total >= input + output + cached + written;
    yield { key, session: event.sessionId, agent: event.agent, model: accounting.model ?? "未知模型",
      timestamp: accounting.timestamp ?? event.ts, totalTokens: total,
      inputTokens: exclusive ? input : Math.max(0, input - cached - written), outputTokens: output,
      cacheReadTokens: cached, cacheWriteTokens: written };
  }
}

/** On-demand, coalesced scans; unchanged files retain only numeric usage, never conversation content. */
export class UsageStatistics {
  private cache = new Map<string, { stamp: string; records: UsageRecord[] }>();
  private pending?: Promise<void>;
  private scannedAt = 0;
  private warnings: string[] = [];
  constructor(private roots = {
    codex: process.env.CODEX_HOME || join(homedir(), ".codex"),
    claude: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  }, private source?: UsageEventSource) {}
  async summary(query: UsageQuery): Promise<UsageReport> {
    if (!this.pending && Date.now() - this.scannedAt > 60_000) {
      this.pending = this.scan().then(() => { this.scannedAt = Date.now(); }).finally(() => { this.pending = undefined; });
    }
    await this.pending;
    const records = [...this.records(), ...usageEventRecords(this.source?.events() ?? [])];
    const now = Date.now();
    const report = summarizeUsage(records, query, now, this.warnings);
    const catalog = new Map((this.source?.agents() ?? [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }]).map(agent => [agent.id, agent]));
    for (const record of records) if (!catalog.has(record.agent)) catalog.set(record.agent, { id: record.agent, label: record.agent });
    report.agents = [...catalog.values()].map(agent => {
      const totals = summarizeUsage(records, { ...query, agent: agent.id }, now).totals;
      const native = agent.id === "codex" || agent.id === "claude";
      return { ...agent, source: native ? "native" : "acp", status: totals.records ? "available" : "no_data",
        records: totals.records, totalTokens: totals.totalTokens,
        note: native ? "本机原生日志（含归档）" : agent.id === "copilot" ? "LinkShell 接收的累计用量差值；首条仅建立基线" : "LinkShell 已记录的 Agent 用量；未上报的会话不计入" };
    });
    return report;
  }
  private *records() { for (const file of this.cache.values()) yield* file.records; }
  private async scan() {
    const seen = new Set<string>(); this.warnings = [];
    // The UI exposes at most 30 days. Older lines still establish Codex's cumulative baseline.
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - 30);
    let skipped = 0;
    const visit = async (directory: string, agent: NativeAgent, depth = 0): Promise<void> => {
      if (depth > 12) { skipped++; return; }
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") skipped++; return; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { await visit(path, agent, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        seen.add(path);
        try {
          const metadata = await stat(path), stamp = `${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
          const cached = this.cache.get(path);
          if (cached?.stamp === stamp) {
            cached.records = cached.records.filter(record => record.timestamp >= since.getTime());
            continue;
          }
          if (metadata.mtimeMs < since.getTime()) { this.cache.delete(path); continue; }
          if (metadata.size > 256 * 1024 * 1024) { skipped++; this.cache.delete(path); continue; }
          const parser = new UsageParser(agent, entry.name), records = new Map<string, UsageRecord>();
          const stream = createReadStream(path, { encoding: "utf8" });
          const lines = createInterface({ input: stream, crlfDelay: Infinity });
          let batch = 0;
          try {
            for await (const line of lines) {
              const record = parser.parse(line);
              if (record && record.timestamp >= since.getTime()) mergeRecord(records, record);
              if (++batch % 128 === 0) await yieldToHost();
            }
          }
          finally { lines.close(); stream.destroy(); }
          this.cache.set(path, { stamp, records: [...records.values()] });
        } catch { skipped++; this.cache.delete(path); }
      }
    };
    await visit(join(this.roots.codex, "sessions"), "codex");
    await visit(join(this.roots.codex, "archived_sessions"), "codex");
    await visit(join(this.roots.claude, "projects"), "claude");
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
    if (skipped) this.warnings.push(`${skipped} 个日志文件或目录无法读取或超出扫描限制，统计可能不完整。`);
  }
}
