import { useEffect, useState } from "react";
import type { MachineMetrics } from "@linkshell/wire";
import { Button } from "@/components/ui/button";
import { useClient, useConnection } from "./common";
import { memoryPercent, observeMachineMetrics, type MachineMetricsState } from "./machine-metrics";

function gib(bytes: number) { return (bytes / 1024 ** 3).toLocaleString("zh-CN", { maximumFractionDigits: 1 }); }
function percent(value: number | null | undefined) { return value == null ? "—" : Math.round(value); }

function MetricHistory({ history }: { history: MachineMetrics[] }) {
  const columns = 24, rows = 12;
  const samples = Array.from({ length: columns }, (_, index) => history[index - (columns - history.length)]);
  return (
    <svg className="computer-history" viewBox="0 0 192 96" aria-hidden="true">
      {samples.map((sample, column) => {
        const cpu = sample?.cpu.usage;
        const memory = sample && memoryPercent(sample);
        return Array.from({ length: rows }, (_, row) => {
          const memoryRow = memory == null ? -1 : Math.round(memory / 100 * (rows - 1));
          const tone = row === memoryRow ? "memory" : cpu != null && row < Math.ceil(cpu / 100 * rows) ? "cpu" : row < memoryRow ? "memory-fill" : "empty";
          return <rect key={`${column}-${row}`} x={column * 8 + 1} y={89 - row * 8} width="6" height="6" data-tone={tone} data-pending={!sample || undefined} />;
        });
      })}
    </svg>
  );
}

export function ComputerMetrics({ metrics, history = [], status, detail, retry }: {
  metrics?: MachineMetrics;
  history?: MachineMetrics[];
  status: string;
  detail?: string;
  retry?: () => void;
}) {
  const memory = metrics && memoryPercent(metrics);
  if (!metrics) return (
    <div className="computer-telemetry computer-telemetry-empty" title={detail}>
      <div className="computer-empty-readings"><span>CPU <b>—</b></span><span>内存 <b>—</b></span></div>
      <div className="computer-telemetry-caption"><span>{status}</span>{retry && <Button variant="ghost" size="plain" onClick={retry}>重试</Button>}</div>
    </div>
  );
  return (
    <div className="computer-telemetry">
      <div className="computer-readings">
        <div className="computer-cpu" title={metrics ? `${metrics.cpu.model} · ${metrics.cpu.cores} 个逻辑核心；采样间隔 ${(metrics.sampleIntervalMs / 1000).toFixed(1)} 秒` : undefined}>
          <strong>{percent(metrics.cpu.usage)}</strong><div><span>%</span><span className="computer-metric-label">CPU</span></div>
        </div>
        <div className="computer-memory" title="整机物理内存使用量，包含系统和缓存；不等同于应用内存或内存压力。">
          <span className="computer-metric-label">内存</span>
          <div><strong>{percent(memory)}</strong><span>%</span></div>
          <small>{metrics ? `${gib(metrics.memory.usedBytes)} / ${gib(metrics.memory.totalBytes)} GB` : "等待主机数据"}</small>
        </div>
      </div>
      <div className="computer-history-frame" title="从左到右为最近 2 分钟，每列一次采样；从下到上为 0–100%。黄色柱表示 CPU，紫色线表示内存。未采集的时段留空。"><MetricHistory history={history} /></div>
      <div className="computer-telemetry-caption" title={detail}>
        <span>最近 2 分钟</span><span title={status}>现在</span>
      </div>
    </div>
  );
}

export function ComputerTelemetry() {
  const { link } = useConnection();
  const status = useClient((state) => state.status);
  const machine = useClient((state) => state.machine);
  const [state, setState] = useState<MachineMetricsState>({ history: [] });
  const [revision, setRevision] = useState(0);
  const supported = !!machine && (machine.protocol ?? 0) >= 3;
  useEffect(() => {
    setState({ history: [] });
    if (status !== "online" || !supported) return;
    return observeMachineMetrics(() => link.call("machine.metrics", {}, 10_000), setState);
  }, [link, status, supported, revision]);
  const unavailable = (!!machine && !supported) || state.unsupported;
  const metrics = status === "online" && supported && !state.error ? state.metrics : undefined;
  return <ComputerMetrics
    metrics={metrics}
    history={metrics ? state.history : []}
    status={status === "locked" ? "解锁后查看负载" : status !== "online" ? "等待连接" : unavailable ? "更新电脑端后可查看负载" : state.error ? "负载读取失败" : metrics ? "每 5 秒更新" : "正在采样…"}
    detail={state.error ?? "CPU 和内存趋势从打开本页时开始采集"}
    retry={state.error && !unavailable ? () => setRevision((value) => value + 1) : undefined}
  />;
}
