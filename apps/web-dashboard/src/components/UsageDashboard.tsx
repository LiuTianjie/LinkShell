import { useMemo, useState } from "react";
import type { AgentUsageReport } from "../lib/types";
import { IconClose } from "./icons";

// Usage dashboard (Image #5 spec): summary cards + a GitHub-contribution-style
// Token activity heatmap + compact by-tool / by-model breakdowns. No charting
// library — the heatmap is a CSS grid of colored squares, cards are text. Data
// comes from the host aggregating ALL on-disk transcripts (decoupled from any
// live turn), so it reflects history + externally-started sessions too.

function formatTokens(n: number): string {
  if (n >= 1e8) return (n / 1e8).toFixed(1) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
  return String(Math.round(n));
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
}

type HeatMode = "daily" | "weekly" | "cumulative";

const WEEKS = 53;
const DAY_MS = 86_400_000;

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface Cell {
  date: Date;
  key: string;
  value: number; // mode-dependent value driving color
  daily: number; // raw daily tokens (always shown in tooltip)
}

function buildHeatmap(byDay: AgentUsageReport["byDay"], mode: HeatMode): { weeks: Cell[][]; max: number; monthLabels: { col: number; label: string }[] } {
  const daily = new Map<string, number>();
  for (const d of byDay) daily.set(d.key, d.totalTokens);

  // Window: WEEKS columns ending today, aligned so each column starts Sunday.
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(today.getTime() - (WEEKS * 7 - 1) * DAY_MS);
  start.setDate(start.getDate() - start.getDay()); // back to Sunday

  // Precompute weekly sums (Sunday-anchored) and cumulative totals.
  const weekSum = new Map<string, number>();
  if (mode === "weekly") {
    for (const [k, v] of daily) {
      const d = new Date(k + "T12:00:00");
      d.setDate(d.getDate() - d.getDay());
      const wk = dayKey(d);
      weekSum.set(wk, (weekSum.get(wk) ?? 0) + v);
    }
  }

  const weeks: Cell[][] = [];
  const monthLabels: { col: number; label: string }[] = [];
  let cumulative = 0;
  let col = 0;
  let lastMonth = -1;
  for (let cursor = new Date(start); cursor <= today; col++) {
    const week: Cell[] = [];
    for (let row = 0; row < 7; row++) {
      const d = new Date(cursor.getTime() + row * DAY_MS);
      const k = dayKey(d);
      const dv = daily.get(k) ?? 0;
      if (mode === "cumulative") cumulative += dv;
      let value = dv;
      if (mode === "weekly") {
        const wk = new Date(d);
        wk.setDate(wk.getDate() - wk.getDay());
        value = weekSum.get(dayKey(wk)) ?? 0;
      } else if (mode === "cumulative") {
        value = cumulative;
      }
      week.push({ date: d, key: k, value, daily: dv });
    }
    // Month label when the week's first day enters a new month.
    const m = week[0]!.date.getMonth();
    if (m !== lastMonth) {
      monthLabels.push({ col, label: `${m + 1}月` });
      lastMonth = m;
    }
    weeks.push(week);
    cursor = new Date(cursor.getTime() + 7 * DAY_MS);
  }

  let max = 0;
  for (const w of weeks) for (const c of w) max = Math.max(max, c.value);
  return { weeks, max, monthLabels };
}

function cellColor(value: number, max: number): { className: string; style?: React.CSSProperties } {
  if (value <= 0 || max <= 0) return { className: "bg-surface-raised" };
  const t = value / max;
  const op = t > 0.66 ? 1 : t > 0.33 ? 0.72 : t > 0.1 ? 0.48 : 0.28;
  return { className: "", style: { backgroundColor: `rgba(96,165,250,${op})` } };
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-3">
      <span className="font-mono text-xl font-semibold text-content-primary tabular-nums">{value}</span>
      <span className="text-2xs text-content-muted">{label}</span>
    </div>
  );
}

function BreakdownBars({ title, buckets }: { title: string; buckets: AgentUsageReport["byTool"] }) {
  const top = buckets.slice(0, 6);
  const max = top.reduce((m, b) => Math.max(m, b.totalTokens), 0);
  if (top.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="mb-3 text-2xs font-semibold uppercase tracking-wider text-content-faint">{title}</p>
      <div className="space-y-2">
        {top.map((b) => (
          <div key={b.key} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-xs text-content-secondary" title={b.key}>{b.key}</span>
            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-raised">
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${max > 0 ? (b.totalTokens / max) * 100 : 0}%`, backgroundColor: "rgba(96,165,250,0.7)" }}
              />
            </div>
            <span className="w-14 shrink-0 text-right font-mono text-2xs tabular-nums text-content-muted">{formatTokens(b.totalTokens)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function UsageDashboardContent({ report }: { report: AgentUsageReport | null }) {
  const [mode, setMode] = useState<HeatMode>("daily");
  const heat = useMemo(() => (report ? buildHeatmap(report.byDay, mode) : null), [report, mode]);

  if (!report) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-content-muted">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-content-faint border-t-accent" />
        <p className="text-sm">正在扫描本机会话记录…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 divide-x divide-border rounded-2xl border border-border bg-surface sm:grid-cols-5">
        <StatCard value={formatTokens(report.totals.totalTokens)} label="累计 Token 数" />
        <StatCard value={formatTokens(report.peakDayTokens)} label="峰值 Token 数" />
        <StatCard value={formatDuration(report.longestTaskMs)} label="最长任务时长" />
        <StatCard value={`${report.currentStreakDays} 天`} label="当前连续天数" />
        <StatCard value={`${report.longestStreakDays} 天`} label="最长连续天数" />
      </div>

      {/* Token activity heatmap */}
      <div className="rounded-2xl border border-border bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-content-primary">Token 活动</h3>
          <div className="flex items-center gap-1 text-2xs">
            {([["daily", "每日"], ["weekly", "每周"], ["cumulative", "累计"]] as const).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-2 py-1 transition-colors ${mode === m ? "bg-surface-overlay text-content-primary" : "text-content-muted hover:text-content-secondary"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {heat && (
          <div className="overflow-x-auto">
            <div className="inline-flex flex-col gap-1">
              <div className="flex gap-1">
                {heat.weeks.map((week, ci) => (
                  <div key={ci} className="flex flex-col gap-1">
                    {week.map((cell) => {
                      const c = cellColor(cell.value, heat.max);
                      return (
                        <div
                          key={cell.key}
                          className={`h-3 w-3 rounded-[3px] ${c.className}`}
                          style={c.style}
                          title={`${cell.key} · ${formatTokens(cell.daily)} tokens`}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="relative mt-1.5 h-4 text-2xs text-content-faint">
                {heat.monthLabels.map((ml) => (
                  <span key={ml.col} className="absolute" style={{ left: `${ml.col * 16}px` }}>
                    {ml.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <BreakdownBars title="工具分布" buckets={report.byTool} />
        <BreakdownBars title="模型分布" buckets={report.byModel} />
        <BreakdownBars title="项目分布" buckets={report.byProject} />
      </div>
    </div>
  );
}

export function UsageDashboard({
  report,
  onClose,
}: {
  report: AgentUsageReport | null;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas/95 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-base font-semibold text-content-primary">用量统计</h2>
        <button onClick={onClose} className="codex-btn-ghost px-2 py-1.5" aria-label="关闭">
          <IconClose size={16} />
        </button>
      </div>
      <div className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-5 py-6">
        <UsageDashboardContent report={report} />
      </div>
    </div>
  );
}
