import type { ClientState } from "@linkshell/client-core";
import { permissionChoices } from "@linkshell/wire";
import { router, useRootNavigationState } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  cancelNativeLocalApprovalNotification,
  consumeNativeNotificationAction,
  pendingNativeNotificationActionId,
  subscribeNativeNotificationActions,
  type NativeNotificationAction,
} from "../../modules/link-layout";
import { useActions, useClient, useConnection, useConnectionStatus } from "@/lib/client";
import { listComputers, useComputers } from "@/lib/computers";
import {
  createNotificationActionCoordinator,
  resolveNotificationRoute,
} from "@/lib/session-attention";

const ACTION_WAIT_TIMEOUT_MS = 15_000;

interface QueuedNotificationAction {
  action: NativeNotificationAction;
  expiresAt: number;
}

/**
 * Listens for Android status notification buttons & iOS local approval notification actions,
 * draining pending actions on mount and foreground resume with strict id deduplication.
 */
export function NotificationActionSync() {
  const navigation = useRootNavigationState();
  const { computer } = useConnection();
  const status = useConnectionStatus();
  const actions = useActions();
  const sessions = useClient((s) => s.sessions);
  const views = useClient((s) => s.views);
  const [queue, setQueue] = useState<QueuedNotificationAction[]>([]);

  const stateRef = useRef({
    computerKey: computer.key,
    online: status === "online",
    actions,
    sessions,
    views,
  });
  stateRef.current = {
    computerKey: computer.key,
    online: status === "online",
    actions,
    sessions,
    views,
  };

  useEffect(() => {
    if (!navigation?.key) return;

    const coordinator = createNotificationActionCoordinator({
      pendingId: pendingNativeNotificationActionId,
      consume: consumeNativeNotificationAction,
      subscribe: subscribeNativeNotificationActions,
      onExecute: (action) => {
        if (action.kind === "open") {
          if (action.computerKey && action.computerKey !== stateRef.current.computerKey) {
            const { saved, live } = useComputers.getState();
            if (listComputers({ saved, live }).some((c) => c.key === action.computerKey)) {
              useComputers.getState().select(action.computerKey);
            }
          }
          router.push(resolveNotificationRoute(action));
          return;
        }
        if (action.computerKey && action.computerKey !== stateRef.current.computerKey) {
          const { saved, live } = useComputers.getState();
          if (listComputers({ saved, live }).some((c) => c.key === action.computerKey)) {
            useComputers.getState().select(action.computerKey);
          }
        }
        setQueue((prev) => [...prev, { action, expiresAt: Date.now() + ACTION_WAIT_TIMEOUT_MS }]);
      },
    });

    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void coordinator.drain();
    });
    void coordinator.drain();

    return () => {
      sub.remove();
      coordinator.dispose();
    };
  }, [navigation?.key]);

  useEffect(() => {
    if (queue.length === 0) return;

    const now = Date.now();
    const expired = queue.filter((entry) => entry.expiresAt <= now);
    if (expired.length > 0) {
      setQueue((prev) => prev.filter((entry) => entry.expiresAt > now));
      const fallback = expired[expired.length - 1]!;
      router.push(resolveNotificationRoute(fallback.action));
      return;
    }

    const soonestExpiry = Math.min(...queue.map((entry) => entry.expiresAt));
    const timer = setTimeout(() => {
      setQueue((prev) => [...prev]);
    }, Math.max(50, soonestExpiry - now));

    if (status === "online") {
      const ready: QueuedNotificationAction[] = [];
      const waiting: QueuedNotificationAction[] = [];
      for (const entry of queue) {
        if (!entry.action.computerKey || entry.action.computerKey === computer.key) {
          ready.push(entry);
        } else {
          waiting.push(entry);
        }
      }
      if (ready.length > 0) {
        setQueue(waiting);
        for (const { action } of ready) {
          void dispatchNotificationAction(action, stateRef.current);
        }
      }
    }

    return () => clearTimeout(timer);
  }, [queue, status, computer.key]);

  return null;
}

async function dispatchNotificationAction(
  action: NativeNotificationAction,
  current: {
    computerKey: string;
    actions: ReturnType<typeof useActions>;
    sessions: ClientState["sessions"];
    views: ClientState["views"];
  },
): Promise<void> {
  const sessionId = action.sessionId;
  if (!sessionId) {
    router.push(resolveNotificationRoute(action));
    return;
  }

  if (action.kind === "cancel") {
    try {
      await current.actions.cancel(sessionId);
    } catch {
      router.push(resolveNotificationRoute(action));
    }
    return;
  }

  if (action.kind === "approve" || action.kind === "deny") {
    const session = current.sessions[sessionId];
    const viewPerm = current.views[sessionId]?.permissions?.[0];
    const perm = session?.permission ?? viewPerm;
    const requestId = action.requestId ?? perm?.requestId;
    let optionId = action.optionId;
    if (!optionId && perm?.options?.length) {
      const choices = permissionChoices(perm.options);
      const preferred =
        action.kind === "approve"
          ? choices.find((c) => c.role === "allow") ?? choices.find((c) => c.role === "always")
          : choices.find((c) => c.role === "reject") ?? choices.find((c) => c.role === "stop");
      optionId = preferred?.option.optionId;
    }
    if (!requestId || !optionId) {
      router.push(resolveNotificationRoute(action));
      return;
    }
    try {
      await current.actions.respond(sessionId, requestId, optionId);
      const targetComputer = action.computerKey || current.computerKey;
      void cancelNativeLocalApprovalNotification(`approval:${targetComputer}:${sessionId}:${requestId}`);
    } catch {
      router.push(resolveNotificationRoute(action));
    }
  }
}
