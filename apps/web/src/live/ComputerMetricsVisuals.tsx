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
const size = (bytes: number) => `${(bytes / 1024 ** 3).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} GB`;
const percent = (value: number | null | undefined) => value == null ? "—" : `${metricPercent(value)}%`;
function diskPercent(disk: MachineMetrics["disk"]) {
  return disk && disk.totalBytes > 0 ? Math.min(100, Math.max(0, disk.usedBytes / disk.totalBytes * 100)) : null;
}
export function ComputerResourceReadings({ metrics }: { metrics?: MachineMetrics }) {
  return <dl className="computer-resource-readings">
    <div title={metrics ? `${metrics.cpu.model} · ${metrics.cpu.cores} 个逻辑核心` : undefined}><dt>CPU</dt><dd>{percent(metrics?.cpu.usage)}</dd></div>
    <div title={metrics ? `已用 ${memorySize(metrics)}` : undefined}><dt>内存</dt><dd>{percent(metrics && memoryPercent(metrics))}</dd></div>
    <div title={metrics?.disk ? `主目录磁盘已用 ${size(metrics.disk.usedBytes)} / ${size(metrics.disk.totalBytes)}；可用 ${size(metrics.disk.availableBytes)}` : "此电脑端未提供磁盘读数"}><dt>磁盘</dt><dd>{percent(diskPercent(metrics?.disk))}</dd></div>
  </dl>;
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
/** The list stays compact; full capacity information and history are shown only on request. */
export function ComputerMetricsVisual({ metrics, history }: { metrics: MachineMetrics; history: MachineMetrics[] }) {
  const disk = metrics.disk;
  return <>
    <dl className="computer-resource-details">
      <div><dt>CPU</dt><dd>{metrics.cpu.model || "处理器"} · {metrics.cpu.cores} 个逻辑核心</dd></div>
      <div><dt>物理内存</dt><dd>已用 {memorySize(metrics)}<small>{memoryDescription(metrics)}</small></dd></div>
      <div><dt>主目录磁盘</dt><dd>{disk ? <>已用 {size(disk.usedBytes)} / {size(disk.totalBytes)} · 可用 {size(disk.availableBytes)}<small>{disk.path} · 每 30 秒更新</small></> : "此电脑端未提供磁盘读数"}</dd></div>
    </dl>
    <div className="computer-history">
      <div className="computer-history-heading"><span>最近 2 分钟</span><span><i data-tone="cpu" />CPU<i data-tone="memory" />内存</span></div>
      <div className="computer-history-frame" title="从左到右为时间，从下到上为 0–100%。未采集的时段留空。"><WaveHistory history={history} /></div>
      <div className="computer-history-caption"><span>2 分钟前</span><span>现在</span></div>
    </div>
  </>;
}
