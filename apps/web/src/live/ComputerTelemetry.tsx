import { useEffect, useState } from "react";
import type { MachineMetrics } from "@linkshell/wire";
import { Button } from "@/components/ui/button";
import { useClient, useConnection } from "./common";
import { observeMachineMetrics, type MachineMetricsState } from "./machine-metrics";

import { ComputerMetricsVisual } from "./ComputerMetricsVisuals";
import { computerVisualHasHistory, type ComputerVisual } from "./computer-visuals";

export function ComputerMetrics({ metrics, history = [], status, detail, retry, visual = "pixels" }: {
  visual?: ComputerVisual;
  metrics?: MachineMetrics;
  history?: MachineMetrics[];
  status: string;
  detail?: string;
  retry?: () => void;
}) {
  if (!metrics) return (
    <div className="computer-telemetry computer-telemetry-empty" data-visual={visual} title={detail}>
      <div className="computer-visual-body"><div className="computer-empty-readings"><span>CPU <b>—</b></span><span>内存 <b>—</b></span></div></div>
      <div className="computer-telemetry-caption"><span>{status}</span>{retry && <Button variant="ghost" size="plain" onClick={retry}>重试</Button>}</div>
    </div>
  );
  return (
    <div className="computer-telemetry" data-visual={visual}>
      <div className="computer-visual-body"><ComputerMetricsVisual visual={visual} metrics={metrics} history={history} /></div>
      <div className="computer-telemetry-caption" title={detail}>
        <span>{computerVisualHasHistory(visual) ? "最近 2 分钟" : "整机负载"}</span><span title={status}>{computerVisualHasHistory(visual) ? "现在" : status}</span>
      </div>
    </div>
  );
}

export function ComputerTelemetry({ visual = "pixels" }: { visual?: ComputerVisual }) {
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
    visual={visual}
    metrics={metrics}
    history={metrics ? state.history : []}
    status={status === "locked" ? "解锁后查看负载" : status !== "online" ? "等待连接" : unavailable ? "更新电脑端后可查看负载" : state.error ? "负载读取失败" : metrics ? "每 5 秒更新" : "正在采样…"}
    detail={state.error ?? "CPU 和内存趋势从打开本页时开始采集"}
    retry={state.error && !unavailable ? () => setRevision((value) => value + 1) : undefined}
  />;
}
