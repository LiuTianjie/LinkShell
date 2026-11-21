import { useEffect, useState } from "react";
import { AppState } from "react-native";
import {
  getNativeLanHosts,
  hasNativeLanDiscovery,
  startNativeLanDiscovery,
  stopNativeLanDiscovery,
  subscribeNativeLanHosts,
} from "../../modules/link-layout";
import { bindLanDiscoveryBridge, useLanDiscovery } from "./lan-discovery";

let bridgeBound = false;

export function ensureNativeLanBridgeBound(): void {
  if (bridgeBound) return;
  bridgeBound = true;
  bindLanDiscoveryBridge({
    hasDiscovery: hasNativeLanDiscovery,
    start: startNativeLanDiscovery,
    stop: stopNativeLanDiscovery,
    getHosts: getNativeLanHosts,
    subscribe: subscribeNativeLanHosts,
  });
}

export function useNativeLanDiscovery(enabled = true): void {
  ensureNativeLanBridgeBound();
  useLanDiscovery(enabled);
}

/** Keeps native LAN mDNS discovery active while the app stays in the foreground. */
export function useForegroundLanDiscovery(): void {
  const [active, setActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    setActive(AppState.currentState === "active");
    const sub = AppState.addEventListener("change", (next) => {
      setActive(next === "active");
    });
    return () => sub.remove();
  }, []);
  useNativeLanDiscovery(active);
}
