import type { MachineMetrics } from "@linkshell/wire";
import { historySamples, memoryPercent } from "./machine-metrics";

export function metricPercent(value: number | null | undefined) { return value == null ? "—" : Math.round(value); }
export function memorySize(metrics: MachineMetrics) {
  const gib = (bytes: number) => (bytes / 1024 ** 3).toLocaleString("zh-CN", { maximumFractionDigits: 1 });
  return `${gib(metrics.memory.usedBytes)} / ${gib(metrics.memory.totalBytes)} GB`;
}
export function memoryDescription(metrics: MachineMetrics) {
  return metrics.memory.includesCache === false
    ? "整机已用物理内存，扣除可回收缓存；包含系统和压缩内存，不等同于内存压力。"
    : "整机物理内存使用量，包含系统和缓存；不等同于应用内存或内存压力。";
}
function Readings({ metrics }: { metrics: MachineMetrics }) {
  return <div className="computer-readings">
    <div className="computer-cpu" title={`${metrics.cpu.model} · ${metrics.cpu.cores} 个逻辑核心`}>
      <strong>{metricPercent(metrics.cpu.usage)}</strong><div><span>%</span><span className="computer-metric-label">CPU</span></div>
    </div>
    <div className="computer-memory" title={memoryDescription(metrics)}>
      <span className="computer-metric-label">内存</span><div><strong>{metricPercent(memoryPercent(metrics))}</strong><span>%</span></div>
      <small>{memorySize(metrics)}</small>
    </div>
  </div>;
}
function WaveHistory({ history }: { history: MachineMetrics[] }) {
  const samples = historySamples(history);
  const series = (kind: "cpu" | "memory") => {
    const runs: { x: number; y: number }[][] = [];
    let run: { x: number; y: number }[] = [];
    samples.forEach((sample, column) => {
      const value = sample && (kind === "cpu" ? sample.cpu.usage : memoryPercent(sample));
      if (value == null) { if (run.length) runs.push(run); run = []; return; }
      run.push({ x: 3 + column * 10, y: 99 - value * .94 });
    });
    if (run.length) runs.push(run);
    return runs.map((points, index) => {
      const first = points[0]!, last = points.at(-1)!;
      const path = points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ");
      return <g key={index} data-tone={kind}>
        {kind === "cpu" && points.length > 1 && <path className="computer-wave-fill" d={`${path} L${last.x} 99 L${first.x} 99 Z`} />}
        <path className="computer-wave-line" d={path} />
        <circle cx={last.x} cy={last.y} r="2.25" />
      </g>;
    });
  };
  return <svg className="computer-wave" viewBox="0 0 236 106" preserveAspectRatio="none" aria-hidden="true">
    {[5, 52, 99].map((y) => <line key={y} className="computer-wave-guide" x1="0" x2="236" y1={y} y2={y} />)}
    {series("cpu")}{series("memory")}
  </svg>;
}
/** The one computer card (docs/design/visual-system.md): CPU and memory now, and their last two minutes. */
export function ComputerMetricsVisual({ metrics, history }: { metrics: MachineMetrics; history: MachineMetrics[] }) {
  return <><Readings metrics={metrics} /><div className="computer-history-frame" title="最近 2 分钟，从左到右为时间，从下到上为 0–100%。未采集的时段留空。">
    <WaveHistory history={history} />
  </div></>;
}
