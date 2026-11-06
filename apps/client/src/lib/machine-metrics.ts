import { MACHINE_METRICS_HISTORY_LIMIT, MACHINE_METRICS_INTERVAL_MS, RpcError, RPC_METHOD_NOT_FOUND, type MachineMetrics } from "@linkshell/wire";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useClient, useConnection } from "./client";

interface MetricsState {
  computer: string;
  metrics?: MachineMetrics;
  history: MachineMetrics[];
  error?: string;
  unsupported?: boolean;
}

/** The computer tab can stay mounted; only its visible, foreground instance polls. */
export function useMachineMetrics() {
  const { link, computer } = useConnection();
  const status = useClient((state) => state.status);
  const protocol = useClient((state) => state.machine?.protocol);
  const [focused, setFocused] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<MetricsState>({ computer: computer.key, history: [] });
  const supported = (protocol ?? 0) >= 3;
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => setForeground(next === "active"));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    setState({ computer: computer.key, history: [] });
    if (!focused || !foreground || status !== "online" || !supported) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let history: MachineMetrics[] = [];
    async function poll() {
      try {
        const { history: hostHistory, ...metrics } = await link.call("machine.metrics", {}, 10_000);
        if (disposed) return;
        history = [...(hostHistory ?? history).filter((entry) => entry.sampledAt < metrics.sampledAt && entry.sampledAt > metrics.sampledAt - MACHINE_METRICS_INTERVAL_MS * MACHINE_METRICS_HISTORY_LIMIT), metrics].slice(-MACHINE_METRICS_HISTORY_LIMIT);
        setState({ computer: computer.key, metrics, history });
      } catch (reason) {
        if (disposed) return;
        const unsupported = reason instanceof RpcError && (reason.code === RPC_METHOD_NOT_FOUND || reason.appCode === "not_supported" || reason.appCode === "host_outdated");
        setState({ computer: computer.key, history: [], unsupported, error: reason instanceof Error ? reason.message : String(reason) });
        if (unsupported) return;
      }
      if (!disposed) timer = setTimeout(() => void poll(), MACHINE_METRICS_INTERVAL_MS);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [link, computer.key, status, supported, focused, foreground, revision]);
  const current = state.computer === computer.key && status === "online";
  return {
    metrics: current && supported ? state.metrics : undefined,
    history: current && supported ? state.history : [],
    error: current ? state.error : undefined,
    unavailable: status === "online" && (!supported || (current && state.unsupported)),
    online: status === "online",
    locked: status === "locked",
    retry: () => setRevision((value) => value + 1),
  };
}

export function metricPercent(used: number, total: number): number | null {
  return total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : null;
}
