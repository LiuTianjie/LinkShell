import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToHost } from "node:timers/promises";
import type { UsageQuery, UsageReport, UsageTotals } from "@linkshell/wire";

type Agent = "codex" | "claude";
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" ? value as Json : {};
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const text = (value: unknown, fallback: string) => typeof value === "string" && value ? value : fallback;
export interface UsageRecord {
  key: string; session: string; agent: Agent; model: string; timestamp: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
}

/** Native logs are cumulative (Codex) or repeated content blocks (Claude), never additive lines. */
export class UsageParser {
  private model = "未知模型";
  private session: string;
  private previous = [0, 0, 0, 0];
  constructor(private agent: Agent, fallbackSession: string) { this.session = fallbackSession; }
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
    target.totals.totalTokens += row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
  };
  for (const row of unique.values()) {
    if (row.timestamp < start.getTime() || row.timestamp > now || (query.agent !== "all" && row.agent !== query.agent)) continue;
    add(total, row); add(daily.get(dateKey(new Date(row.timestamp)))!, row);
    const key = `${row.agent}:${row.model}`;
    let model = models.get(key);
    if (!model) { model = { ...group(), model: row.model, agent: row.agent }; models.set(key, model); }
    add(model, row);
  }
  return { generatedAt: now, days: query.days, agent: query.agent, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    totals: total.totals, daily: [...daily].map(([date, value]) => ({ date, ...value.totals })),
    models: [...models.values()].map(value => ({ agent: value.agent, model: value.model, ...value.totals })).sort((a, b) => b.totalTokens - a.totalTokens), warnings };
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
  }) {}
  async summary(query: UsageQuery): Promise<UsageReport> {
    if (!this.pending && Date.now() - this.scannedAt > 60_000) {
      this.pending = this.scan().then(() => { this.scannedAt = Date.now(); }).finally(() => { this.pending = undefined; });
    }
    await this.pending;
    return summarizeUsage(this.records(), query, Date.now(), this.warnings);
  }
  private *records() { for (const file of this.cache.values()) yield* file.records; }
  private async scan() {
    const seen = new Set<string>(); this.warnings = [];
    // The UI exposes at most 30 days. Older lines still establish Codex's cumulative baseline.
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - 30);
    let skipped = 0;
    const visit = async (directory: string, agent: Agent, depth = 0): Promise<void> => {
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
