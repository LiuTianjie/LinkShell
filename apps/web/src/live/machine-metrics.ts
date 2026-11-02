import { MACHINE_METRICS_HISTORY_LIMIT, MACHINE_METRICS_INTERVAL_MS, RpcError, RPC_METHOD_NOT_FOUND, type MachineMetrics, type MachineMetricsSnapshot } from "@linkshell/wire";

export interface MachineMetricsState {
  metrics?: MachineMetrics;
  history: MachineMetrics[];
  error?: string;
  unsupported?: boolean;
  hostHistory?: boolean;
}

/** One in-flight request per card. Disposal prevents both late updates and another poll. */
export function observeMachineMetrics(read: () => Promise<MachineMetricsSnapshot>, changed: (state: MachineMetricsState) => void) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let history: MachineMetrics[] = [];
  async function poll() {
    try {
      const { history: hostHistory, ...metrics } = await read();
      if (disposed) return;
      // A host snapshot is authoritative, including after a host restart. Older hosts still accumulate locally.
      history = [...(hostHistory ?? history).filter((entry) => entry.sampledAt < metrics.sampledAt && entry.sampledAt > metrics.sampledAt - MACHINE_METRICS_INTERVAL_MS * MACHINE_METRICS_HISTORY_LIMIT), metrics].slice(-MACHINE_METRICS_HISTORY_LIMIT);
      changed({ metrics, history, hostHistory: hostHistory !== undefined });
    } catch (reason) {
      if (disposed) return;
      const unsupported = reason instanceof RpcError && (reason.code === RPC_METHOD_NOT_FOUND || reason.appCode === "not_supported" || reason.appCode === "host_outdated");
      changed({ history, unsupported, error: reason instanceof Error ? reason.message : String(reason) });
      if (unsupported) return;
    }
    if (!disposed) timer = setTimeout(() => void poll(), MACHINE_METRICS_INTERVAL_MS);
  }
  void poll();
  return () => { disposed = true; clearTimeout(timer); };
}

/** Keep sleep/disconnection gaps on the time axis instead of packing samples together. */
export function historySamples(history: MachineMetrics[]): (MachineMetrics | undefined)[] {
  const samples = Array<MachineMetrics | undefined>(MACHINE_METRICS_HISTORY_LIMIT).fill(undefined);
  const latest = history.at(-1)?.sampledAt;
  if (latest === undefined) return samples;
  for (const entry of history) {
    const index = MACHINE_METRICS_HISTORY_LIMIT - 1 - Math.round((latest - entry.sampledAt) / MACHINE_METRICS_INTERVAL_MS);
    if (index >= 0 && index < samples.length) samples[index] = entry;
  }
  return samples;
}

export function memoryPercent(metrics: MachineMetrics): number | null {
  return metrics.memory.totalBytes > 0 ? Math.min(100, Math.max(0, metrics.memory.usedBytes / metrics.memory.totalBytes * 100)) : null;
}
