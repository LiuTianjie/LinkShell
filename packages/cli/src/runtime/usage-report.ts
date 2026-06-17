// Host-side usage aggregator. Scans local agent transcripts on disk and rolls
// them up into the dimensions a usage dashboard needs (cumulative total, peak
// day, activity heatmap by day, streaks, longest task). Fully DECOUPLED from any
// live LinkShell turn — it reads what the agents already wrote to disk, so
// history and externally-started sessions (any process, not just LinkShell) are
// all counted, the same way ccusage / vibe-usage / CodeIsland work.
//
// Counting convention (matches ccusage): sum usage PER API CALL — context is
// re-counted every turn, which is why totals reach billions. This is the usage
// view, the opposite of the single-snapshot "current context occupancy" meter.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  calls: number;
}

export interface UsageBucket extends UsageTotals {
  key: string;
}

export interface UsageReport {
  totals: UsageTotals;
  sessions: number;
  /** Highest single-day token total. */
  peakDayTokens: number;
  /** Longest single session span (first→last activity), milliseconds. */
  longestTaskMs: number;
  /** Consecutive active days ending at the most recent active day. */
  currentStreakDays: number;
  /** Longest run of consecutive active days ever. */
  longestStreakDays: number;
  byDay: UsageBucket[]; // key = YYYY-MM-DD, ascending — drives the heatmap
  byHourWeekday: { weekday: number; hour: number; tokens: number }[]; // 0=Sun
  byTool: UsageBucket[]; // claude-code | codex
  byModel: UsageBucket[]; // claude-opus-4.8, gpt-5.5, ...
  byProject: UsageBucket[]; // cwd basename
  generatedAt: number;
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    calls: 0,
  };
}

// One call's worth of usage, tagged with its dimensions, fed into all buckets.
interface CallSample {
  ts: number; // epoch ms
  sessionId: string; // for per-session duration
  tool: string; // claude-code | codex
  model: string;
  project: string; // cwd basename
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

class Accumulator {
  totals = emptyTotals();
  private day = new Map<string, UsageTotals>();
  private hw = new Map<string, number>(); // "weekday:hour" → tokens
  private tool = new Map<string, UsageTotals>();
  private model = new Map<string, UsageTotals>();
  private project = new Map<string, UsageTotals>();
  // Per-session activity timestamps, for longest-continuous-task duration.
  private sessionTimes = new Map<string, number[]>();

  private bump(map: Map<string, UsageTotals>, key: string, s: CallSample, tokens: number): void {
    let t = map.get(key);
    if (!t) { t = emptyTotals(); map.set(key, t); }
    t.inputTokens += s.input;
    t.outputTokens += s.output;
    t.cacheReadTokens += s.cacheRead;
    t.cacheWriteTokens += s.cacheWrite;
    t.totalTokens += tokens;
    t.calls += 1;
  }

  add(s: CallSample): void {
    const tokens = s.input + s.output + s.cacheRead + s.cacheWrite;
    if (tokens <= 0) return;
    this.totals.inputTokens += s.input;
    this.totals.outputTokens += s.output;
    this.totals.cacheReadTokens += s.cacheRead;
    this.totals.cacheWriteTokens += s.cacheWrite;
    this.totals.totalTokens += tokens;
    this.totals.calls += 1;

    this.bump(this.day, dayKeyOf(s.ts), s, tokens);
    const d = new Date(s.ts);
    const hwKey = `${d.getDay()}:${d.getHours()}`;
    this.hw.set(hwKey, (this.hw.get(hwKey) ?? 0) + tokens);
    this.bump(this.tool, s.tool, s, tokens);
    this.bump(this.model, s.model || "(unknown)", s, tokens);
    this.bump(this.project, s.project || "(unknown)", s, tokens);

    const times = this.sessionTimes.get(s.sessionId);
    if (!times) this.sessionTimes.set(s.sessionId, [s.ts]);
    else times.push(s.ts);
  }

  private toBuckets(map: Map<string, UsageTotals>): UsageBucket[] {
    return [...map.entries()]
      .map(([key, t]) => ({ key, ...t }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }

  finish(sessions: number, generatedAt: number): UsageReport {
    const byDay = [...this.day.entries()]
      .map(([key, t]) => ({ key, ...t }))
      .sort((a, b) => a.key.localeCompare(b.key));

    const peakDayTokens = byDay.reduce((m, d) => Math.max(m, d.totalTokens), 0);

    // Longest CONTINUOUS work segment across all sessions. A Claude session
    // file can be resumed days later, so first→last would absurdly count idle
    // days. Instead, sort each session's call timestamps and split whenever the
    // gap exceeds IDLE_SPLIT_MS; the longest unbroken segment is the task length.
    const IDLE_SPLIT_MS = 30 * 60_000;
    let longestTaskMs = 0;
    for (const times of this.sessionTimes.values()) {
      if (times.length === 0) continue;
      times.sort((a, b) => a - b);
      let segStart = times[0]!;
      let prev = times[0]!;
      for (let i = 1; i < times.length; i++) {
        const cur = times[i]!;
        if (cur - prev > IDLE_SPLIT_MS) {
          longestTaskMs = Math.max(longestTaskMs, prev - segStart);
          segStart = cur;
        }
        prev = cur;
      }
      longestTaskMs = Math.max(longestTaskMs, prev - segStart);
    }

    const { currentStreakDays, longestStreakDays } = computeStreaks(byDay.map((d) => d.key), generatedAt);

    const byHourWeekday = [...this.hw.entries()].map(([k, tokens]) => {
      const parts = k.split(":");
      return { weekday: Number(parts[0]), hour: Number(parts[1]), tokens };
    });

    return {
      totals: this.totals,
      sessions,
      peakDayTokens,
      longestTaskMs,
      currentStreakDays,
      longestStreakDays,
      byDay,
      byHourWeekday,
      byTool: this.toBuckets(this.tool),
      byModel: this.toBuckets(this.model),
      byProject: this.toBuckets(this.project),
      generatedAt,
    };
  }
}

// Streaks over a sorted set of active day-keys (YYYY-MM-DD). Current streak
// counts back from today (or yesterday — a gap of "today not yet active" still
// keeps an unbroken run alive). Uses UTC-noon to step days, dodging DST edges.
function computeStreaks(dayKeys: string[], now: number): { currentStreakDays: number; longestStreakDays: number } {
  if (dayKeys.length === 0) return { currentStreakDays: 0, longestStreakDays: 0 };
  const set = new Set(dayKeys);
  const dayMs = 86_400_000;
  const toKey = (ms: number) => dayKeyOf(ms);

  // Longest run.
  let longest = 1;
  let run = 1;
  const sorted = [...dayKeys].sort();
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + "T12:00:00").getTime();
    const cur = new Date(sorted[i] + "T12:00:00").getTime();
    const gapDays = Math.round((cur - prev) / dayMs);
    if (gapDays === 1) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
  }

  // Current run: walk backwards from today; if today isn't active, allow
  // starting from yesterday (today simply hasn't happened yet).
  let cursor = new Date(toKey(now) + "T12:00:00").getTime();
  if (!set.has(toKey(cursor))) cursor -= dayMs; // today inactive → start at yesterday
  let current = 0;
  while (set.has(toKey(cursor))) {
    current += 1;
    cursor -= dayMs;
  }

  return { currentStreakDays: current, longestStreakDays: longest };
}

function parseTs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const p = Date.parse(value);
    return Number.isNaN(p) ? undefined : p;
  }
  return undefined;
}

function walkJsonl(dir: string, onFile: (path: string) => void): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkJsonl(full, onFile);
    else if (entry.endsWith(".jsonl")) onFile(full);
  }
}

// Claude: ~/.claude/projects/**/*.jsonl — each assistant line carries
// message.usage. Skip <synthetic> (internal, no real usage).
function ingestClaude(acc: Accumulator): number {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return 0;
  let sessions = 0;
  walkJsonl(root, (path) => {
    sessions += 1;
    const sessionId = basename(path, ".jsonl");
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { return; }
    let fileCwd = "";
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (typeof o?.cwd === "string" && !fileCwd) fileCwd = o.cwd;
      if (o?.type !== "assistant") continue;
      const msg = o.message;
      const usage = msg?.usage;
      const model = typeof msg?.model === "string" ? msg.model : "";
      if (!usage || model === "<synthetic>" || !model) continue;
      const ts = parseTs(o.timestamp);
      if (ts === undefined) continue;
      acc.add({
        ts,
        sessionId,
        tool: "claude-code",
        model,
        project: basename(o.cwd || fileCwd || "(unknown)"),
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheWrite: usage.cache_creation_input_tokens || 0,
      });
    }
  });
  return sessions;
}

// Codex: ~/.codex/sessions/**/rollout-*.jsonl — token_count events carry
// info.last_token_usage (per-turn delta; total_token_usage is cumulative and
// would double-count). cached_input_tokens is a subset of input_tokens.
function ingestCodex(acc: Accumulator): number {
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return 0;
  let sessions = 0;
  walkJsonl(root, (path) => {
    if (!basename(path).startsWith("rollout-")) return;
    sessions += 1;
    const sessionId = basename(path, ".jsonl");
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { return; }
    let model = "";
    let cwd = "";
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      const p = o?.payload ?? {};
      const type = p.type ?? o?.type;
      if (type === "session_meta") {
        if (typeof p.cwd === "string") cwd = p.cwd;
        if (typeof p.model === "string") model = p.model;
        continue;
      }
      if (type === "turn_context") {
        if (typeof p.model === "string") model = p.model;
        continue;
      }
      if (type !== "token_count") continue;
      const last = p.info?.last_token_usage;
      if (!last) continue;
      const ts = parseTs(o.timestamp);
      if (ts === undefined) continue;
      const cacheRead = last.cached_input_tokens || 0;
      const rawInput = last.input_tokens || 0;
      acc.add({
        ts,
        sessionId,
        tool: "codex",
        model: model || "gpt-5",
        project: basename(cwd || "(unknown)"),
        input: Math.max(0, rawInput - cacheRead),
        output: (last.output_tokens || 0) + (last.reasoning_output_tokens || 0),
        cacheRead,
        cacheWrite: 0,
      });
    }
  });
  return sessions;
}

let _cachedReport: UsageReport | null = null;
let _cachedAt = 0;

export function aggregateUsage(): UsageReport {
  const now = Date.now();
  if (_cachedReport && now - _cachedAt < 60_000) return _cachedReport;
  const acc = new Accumulator();
  const sessions = ingestClaude(acc) + ingestCodex(acc);
  _cachedReport = acc.finish(sessions, now);
  _cachedAt = now;
  return _cachedReport;
}
