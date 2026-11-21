import type { HostLink } from "@linkshell/client-core";
import type { PortInfo } from "@linkshell/wire";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { useClient, useConnection } from "@/lib/client";
import { describeActionError } from "@/lib/locale";

/** A slow reply from the previous computer must never become a link on the new one. */
export function usePorts(enabled = true) {
  const { link } = useConnection();
  const online = useClient((state) => state.status === "online");
  const [result, setResult] = useState<{ link: HostLink; ports: PortInfo[] | null; error: string | null } | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!enabled || !online) return;
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      async function poll() {
        try {
          const { ports } = await link.call("ports.list", {}, 15_000);
          if (!done) setResult({ link, ports, error: null });
        } catch (reason) {
          if (!done) setResult({ link, ports: null, error: describeActionError(reason) });
        }
        if (!done) timer = setTimeout(() => void poll(), 10_000);
      }
      void poll();
      return () => {
        done = true;
        clearTimeout(timer);
      };
    }, [link, enabled, online]),
  );
  const current = enabled && online && result?.link === link ? result : null;
  return { ports: current?.ports ?? null, error: current?.error ?? null };
}
