import { RpcError, RPC_METHOD_NOT_FOUND, type MachineMetrics } from "@linkshell/wire";

export interface MachineMetricsState {
  metrics?: MachineMetrics;
  history: MachineMetrics[];
  error?: string;
  unsupported?: boolean;
}

/** One in-flight request per card. Disposal prevents both late updates and another poll. */
export function observeMachineMetrics(read: () => Promise<MachineMetrics>, changed: (state: MachineMetricsState) => void) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let history: MachineMetrics[] = [];
  async function poll() {
    try {
      const metrics = await read();
      if (disposed) return;
      history = [...history.filter((entry) => entry.sampledAt < metrics.sampledAt && entry.sampledAt >= metrics.sampledAt - 120_000), metrics].slice(-24);
      changed({ metrics, history });
    } catch (reason) {
      if (disposed) return;
      history = [];
      const unsupported = reason instanceof RpcError && (reason.code === RPC_METHOD_NOT_FOUND || reason.appCode === "not_supported" || reason.appCode === "host_outdated");
      changed({ history, unsupported, error: reason instanceof Error ? reason.message : String(reason) });
      if (unsupported) return;
    }
    if (!disposed) timer = setTimeout(() => void poll(), 5000);
  }
  void poll();
  return () => { disposed = true; clearTimeout(timer); };
}

export function memoryPercent(metrics: MachineMetrics): number | null {
  return metrics.memory.totalBytes > 0 ? Math.min(100, Math.max(0, metrics.memory.usedBytes / metrics.memory.totalBytes * 100)) : null;
}
