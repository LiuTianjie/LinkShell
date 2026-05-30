// React binding for a WorkspaceStore. Creates one store per (gateway, session,
// jwt), drives connect/destroy with the component lifecycle, and exposes the
// immutable snapshot via useSyncExternalStore so components re-render only when
// the snapshot identity changes.

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { WorkspaceStore } from "../store/workspace-store";
import type { WorkspaceSnapshot } from "../store/workspace-store";
import type { GatewayConfig } from "../lib/types";
import { getValidSession } from "../lib/supabase";

export interface UseWorkspaceResult {
  store: WorkspaceStore;
  snapshot: WorkspaceSnapshot;
}

export function useWorkspace(
  config: GatewayConfig,
  sessionId: string,
): UseWorkspaceResult {
  // Recreate the store only when the connection identity changes.
  const key = `${config.httpUrl}|${sessionId}`;
  const storeRef = useRef<{ key: string; store: WorkspaceStore } | null>(null);

  const store = useMemo(() => {
    if (storeRef.current && storeRef.current.key === key) {
      return storeRef.current.store;
    }
    storeRef.current?.store.destroy();
    // Pass a getter so every (re)connect uses a FRESH token (single-flight
    // refresh handled inside getValidSession). Logged-out users get null →
    // device-token-only connect.
    const next = new WorkspaceStore(config, sessionId, async () => {
      const s = await getValidSession();
      return s?.accessToken ?? null;
    });
    storeRef.current = { key, store: next };
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    store.connect();
    return () => {
      store.destroy();
      storeRef.current = null;
    };
  }, [store]);

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return { store, snapshot };
}
