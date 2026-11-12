import { useEffect, useId, useState } from "react";
import type { MachineKeepAwake, MachineMetrics } from "@linkshell/wire";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useClient, useConnection } from "./common";
import { observeMachineMetrics, type MachineMetricsState } from "./machine-metrics";

import { ComputerMetricsVisual, ComputerResourceReadings } from "./ComputerMetricsVisuals";

export function ComputerMetrics({ metrics, history = [], status, detail, retry, onKeepAwakeChange, keepAwakeBusy }: {
  metrics?: MachineMetrics;
  history?: MachineMetrics[];
  status: string;
  detail?: string;
  retry?: () => void;
  onKeepAwakeChange?: (mode: MachineKeepAwake["mode"]) => void;
  keepAwakeBusy?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return (
    <div className="computer-telemetry">
      <div className="computer-telemetry-summary">
        <div className="computer-telemetry-readings">
          <ComputerResourceReadings metrics={metrics} />
          {!metrics && <div className="computer-telemetry-status" title={detail}>{status}{retry && <Button variant="ghost" size="plain" onClick={retry}>重试</Button>}</div>}
        </div>
        {metrics && <Button variant="toolbar" size="icon" className="computer-resource-toggle" title={expanded ? "收起资源详情" : "展开资源详情"} aria-label={expanded ? "收起资源详情" : "展开资源详情"} aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((value) => !value)}><ChevronDown /></Button>}
      </div>
      {metrics && expanded && <div id={detailsId} className="computer-telemetry-details" role="region" aria-label="资源使用详情">
        <ComputerMetricsVisual metrics={metrics} history={history} onKeepAwakeChange={onKeepAwakeChange} keepAwakeBusy={keepAwakeBusy} />
        <p className="computer-telemetry-note">{status}。{detail}</p>
      </div>}
    </div>
  );
}

export function ComputerTelemetry() {
  const { link } = useConnection();
  const status = useClient((state) => state.status);
  const machine = useClient((state) => state.machine);
  const [state, setState] = useState<MachineMetricsState>({ history: [] });
  const [revision, setRevision] = useState(0);
  const [keepAwakeBusy, setKeepAwakeBusy] = useState(false);
  const supported = !!machine && (machine.protocol ?? 0) >= 3;
  const keepAwakeSupported = !!machine && (machine.protocol ?? 0) >= 4;
  useEffect(() => {
    setState({ history: [] });
    if (status !== "online" || !supported) return;
    return observeMachineMetrics(() => link.call("machine.metrics", {}, 10_000), setState);
  }, [link, status, supported, revision]);
  const unavailable = (!!machine && !supported) || state.unsupported;
  const metrics = status === "online" && supported && !state.error ? state.metrics : undefined;
  const handleKeepAwakeChange = keepAwakeSupported && status === "online"
    ? (mode: MachineKeepAwake["mode"]) => {
        setKeepAwakeBusy(true);
        void link
          .call("machine.keepAwake", { mode })
          .then((keepAwake) => {
            setState((current) =>
              current.metrics
                ? { ...current, metrics: { ...current.metrics, keepAwake } }
                : current,
            );
          })
          .catch(() => setRevision((value) => value + 1))
          .finally(() => setKeepAwakeBusy(false));
      }
    : undefined;
  return <ComputerMetrics
    metrics={metrics}
    history={metrics ? state.history : []}
    status={status === "locked" ? "解锁后查看负载" : status !== "online" ? "等待连接" : unavailable ? "更新电脑端后可查看负载" : state.error ? "负载读取失败" : metrics ? "每 5 秒更新" : "正在采样…"}
    detail={state.error ?? (state.hostHistory ? "电脑端持续采集最近 2 分钟的 CPU 和内存，休眠或服务重启期间留空" : "此电脑端仅支持打开页面后采集趋势，更新电脑端可读取历史")}
    retry={state.error && !unavailable ? () => setRevision((value) => value + 1) : undefined}
    onKeepAwakeChange={handleKeepAwakeChange}
    keepAwakeBusy={keepAwakeBusy}
  />;
}
