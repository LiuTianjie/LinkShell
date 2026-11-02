import type { MachineMetrics } from "@linkshell/wire";
import { historySamples, memoryPercent } from "./machine-metrics";
import type { ComputerVisual } from "./computer-visuals";

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
function PixelHistory({ history }: { history: MachineMetrics[] }) {
  const rows = 10;
  return <svg className="computer-history" viewBox="0 0 192 80" aria-hidden="true">
    {historySamples(history).map((sample, column) => {
      const cpu = sample?.cpu.usage;
      const memory = sample && memoryPercent(sample);
      const memoryRow = memory == null ? -1 : Math.round(memory / 100 * (rows - 1));
      return Array.from({ length: rows }, (_, row) => {
        const tone = row === memoryRow ? "memory" : cpu != null && row < Math.ceil(cpu / 100 * rows) ? "cpu" : row < memoryRow ? "memory-fill" : "empty";
        return <rect key={`${column}-${row}`} x={column * 8 + 1.5} y={73.5 - row * 8} width="5" height="5" data-tone={tone} data-pending={!sample || undefined} />;
      });
    })}
  </svg>;
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
        <rect x={last.x - 2} y={last.y - 2} width="4" height="4" />
      </g>;
    });
  };
  return <svg className="computer-wave" viewBox="0 0 236 106" preserveAspectRatio="none" aria-hidden="true">
    {[5, 52, 99].map((y) => <line key={y} className="computer-wave-guide" x1="0" x2="236" y1={y} y2={y} />)}
    {series("cpu")}{series("memory")}
  </svg>;
}
function Dial({ value }: { value: number | null }) {
  const tick = (index: number, radius: number) => {
    const angle = (135 + index / 31 * 270) * Math.PI / 180;
    return { x: 70 + Math.cos(angle) * radius, y: 70 + Math.sin(angle) * radius };
  };
  return <div className="computer-dial">
    <svg viewBox="0 0 140 140" aria-hidden="true">{Array.from({ length: 32 }, (_, index) => {
      const a = tick(index, 55), b = tick(index, index % 4 === 0 ? 44 : 48);
      return <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} data-active={value != null && index < Math.ceil(value / 100 * 32) || undefined} />;
    })}</svg>
    <div className="computer-dial-value"><strong>{metricPercent(value)}<small>%</small></strong><span>CPU</span></div>
    <span className="computer-dial-limit">0 — 100</span>
  </div>;
}
function DialReadings({ metrics }: { metrics: MachineMetrics }) {
  const memory = memoryPercent(metrics);
  return <div className="computer-dial-readings">
    <Dial value={metrics.cpu.usage} />
    <div className="computer-dial-memory" title={memoryDescription(metrics)}>
      <span className="computer-metric-label">内存</span><strong>{metricPercent(memory)}<small>%</small></strong>
      <div className="computer-memory-segments" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <i key={index} data-active={memory != null && index < Math.ceil(memory / 100 * 12) || undefined} />)}</div>
      <small>{memorySize(metrics)}</small>
    </div>
  </div>;
}
function Meters({ metrics }: { metrics: MachineMetrics }) {
  return <div className="computer-meters">{[
    { name: "CPU", tone: "cpu", value: metrics.cpu.usage, detail: `${metrics.cpu.cores} 个逻辑核心` },
    { name: "内存", tone: "memory", value: memoryPercent(metrics), detail: memorySize(metrics) },
  ].map(({ name, tone, value, detail }) => <div className="computer-meter" data-tone={tone} key={tone} title={tone === "memory" ? memoryDescription(metrics) : metrics.cpu.model}>
    <div className="computer-meter-reading"><span>{name}</span><strong>{metricPercent(value)}<small>%</small></strong></div>
    <div className="computer-meter-track" aria-hidden="true"><span style={{ transform: `scaleX(${(value ?? 0) / 100})` }} />{[25, 50, 75].map((mark) => <i key={mark} style={{ left: `${mark}%` }} />)}</div>
    <small>{detail}</small>
  </div>)}</div>;
}
function metricReadings(metrics: MachineMetrics) {
  return [
    { name: "CPU", tone: "cpu", value: metrics.cpu.usage, detail: `${metrics.cpu.cores} 个逻辑核心`, title: metrics.cpu.model },
    { name: "内存", tone: "memory", value: memoryPercent(metrics), detail: memorySize(metrics), title: memoryDescription(metrics) },
  ] as const;
}
function Rings({ metrics }: { metrics: MachineMetrics }) {
  return <div className="computer-rings">
    <svg viewBox="0 0 160 160" aria-hidden="true">{metricReadings(metrics).map(({ tone, value }, index) => <g key={tone} data-tone={tone}>
      <circle className="computer-ring-track" cx="80" cy="80" r={65 - index * 18} />
      <circle className="computer-ring-fill" cx="80" cy="80" r={65 - index * 18} pathLength="100" strokeDasharray={`${value ?? 0} 100`} transform="rotate(-90 80 80)" />
    </g>)}<path className="computer-ring-center" d="M74 80h12M80 74v12" /></svg>
    <div className="computer-ring-readings">{metricReadings(metrics).map(({ name, tone, value, detail, title }) => <div key={tone} data-tone={tone} title={title}>
      <span className="computer-metric-label">{name}</span><strong>{metricPercent(value)}<small>%</small></strong><small>{detail}</small>
    </div>)}</div>
  </div>;
}
function Columns({ metrics, history }: { metrics: MachineMetrics; history: MachineMetrics[] }) {
  return <div className="computer-columns" title="最近 2 分钟，从左到右为时间，柱高为 0–100%。未采集的时段留空。">{metricReadings(metrics).map(({ name, tone, value, detail, title }) => <div key={tone} data-tone={tone}>
    <div className="computer-column-reading" title={title}><span>{name}</span><strong>{metricPercent(value)}<small>%</small></strong><small>{detail}</small></div>
    <svg viewBox="0 0 240 54" preserveAspectRatio="none" aria-hidden="true">
      <line className="computer-column-guide" x1="0" x2="240" y1="2" y2="2" />
      <line className="computer-column-guide" x1="0" x2="240" y1="52" y2="52" />
      {historySamples(history).map((sample, index) => {
        const percent = sample && (tone === "cpu" ? sample.cpu.usage : memoryPercent(sample));
        return percent == null ? null : <rect key={index} x={index * 10 + 1} y={52 - percent / 2} width="6" height={Math.max(.5, percent / 2)} opacity={.35 + index / 23 * .65} />;
      })}
    </svg>
  </div>)}</div>;
}
function Towers({ metrics }: { metrics: MachineMetrics }) {
  return <div className="computer-towers">{metricReadings(metrics).map(({ name, tone, value, detail, title }) => <div className="computer-tower" key={tone} data-tone={tone} title={title}>
    <div className="computer-tower-track" aria-hidden="true"><div className="computer-tower-fill" style={{ height: `${value ?? 0}%` }} />{[25, 50, 75].map((mark) => <i key={mark} style={{ bottom: `${mark}%` }} />)}</div>
    <div className="computer-tower-reading"><span className="computer-metric-label">{name}</span><strong>{metricPercent(value)}<small>%</small></strong></div>
    <small>{detail}</small>
  </div>)}</div>;
}
function Blocks({ metrics }: { metrics: MachineMetrics }) {
  return <div className="computer-blocks">{metricReadings(metrics).map(({ name, tone, value, detail, title }) => <div key={tone} data-tone={tone} title={title}>
    <div className="computer-block-reading"><span>{name}</span><strong>{metricPercent(value)}<small>%</small></strong></div>
    <div className="computer-block-grid" aria-hidden="true">{Array.from({ length: 20 }, (_, index) => <i key={index} style={{ gridRow: 4 - Math.floor(index / 5), gridColumn: index % 5 + 1 }}><span style={{ transform: `scaleY(${Math.max(0, Math.min(1, (value ?? 0) / 5 - index))})` }} /></i>)}</div>
    <small>{detail}</small>
  </div>)}</div>;
}
export function ComputerMetricsVisual({ visual, metrics, history }: { visual: ComputerVisual; metrics: MachineMetrics; history: MachineMetrics[] }) {
  if (visual === "meters") return <Meters metrics={metrics} />;
  if (visual === "dial") return <DialReadings metrics={metrics} />;
  if (visual === "rings") return <Rings metrics={metrics} />;
  if (visual === "columns") return <Columns metrics={metrics} history={history} />;
  if (visual === "towers") return <Towers metrics={metrics} />;
  if (visual === "blocks") return <Blocks metrics={metrics} />;
  return <><Readings metrics={metrics} /><div className="computer-history-frame" title="最近 2 分钟，从左到右为时间，从下到上为 0–100%。未采集的时段留空。">
    {visual === "wave" ? <WaveHistory history={history} /> : <PixelHistory history={history} />}
  </div></>;
}
