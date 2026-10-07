import type { PortInfo } from "@linkshell/wire";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { useConnection } from "@/lib/client";

/** How often an open list re-checks what's running (dev servers come and go). */
const POLL_MS = 10_000;

/** The computer's listening servers, refreshed while the screen is in view. */
export function usePorts(enabled = true) {
  const { link } = useConnection();
  const [ports, setPorts] = useState<PortInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await link.call("ports.list", {}, 15_000);
      setPorts(result.ports);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [link]);

  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      void refresh();
      const timer = setInterval(() => void refresh(), POLL_MS);
      return () => clearInterval(timer);
    }, [refresh, enabled]),
  );

  return { ports, error, refresh };
}
