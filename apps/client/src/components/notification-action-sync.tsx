import type { ClientState } from "@linkshell/client-core";
import { isLiveActivityActionCurrent, permissionChoices, type LiveActivityAction } from "@linkshell/wire";
import { router, usePathname, useRootNavigationState } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import {
  cancelNativeLocalApprovalNotification,
  consumeNativeNotificationAction,
  pendingNativeNotificationActionId,
  restartNativeLanDiscovery,
  subscribeNativeNetworkPathChange,
  subscribeNativeNotificationActions,
  type NativeNotificationAction,
} from "../../modules/link-layout";
import { useActions, useClient, useConnection, useConnectionStatus } from "@/lib/client";
import { listComputers, reconnectRelays, useComputers } from "@/lib/computers";
import { bindNetworkPathSupport } from "@/lib/socket";
import {
  createNotificationActionCoordinator,
  resolveNotificationRoute,
} from "@/lib/session-attention";

// Wire Android network-path monitoring & native mDNS restart into the shared transport layer.
bindNetworkPathSupport({
  subscribeAndroid: Platform.OS === "android" ? subscribeNativeNetworkPathChange : undefined,
  restartLanDiscovery: restartNativeLanDiscovery,
});

const ACTION_WAIT_TIMEOUT_MS = 15_000;

interface QueuedNotificationAction {
  action: NativeNotificationAction;
  expiresAt: number;
}

function extractViewedSessionId(pathname: string | undefined): string | undefined {
  if (!pathname) return undefined;
  const match = pathname.match(/^\/session\/([^/?#]+)/);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Listens for Android status notification buttons & iOS local approval notification actions,
 * draining pending actions on mount and foreground resume with strict id deduplication.
 */
export function NotificationActionSync() {
  const navigation = useRootNavigationState();
  const pathname = usePathname();
  const { computer, link } = useConnection();
  const status = useConnectionStatus();
  const actions = useActions();
  const sessions = useClient((s) => s.sessions);
  const sessionsLoaded = useClient((s) => s.sessionsLoaded);
  const views = useClient((s) => s.views);
  const [queue, setQueue] = useState<QueuedNotificationAction[]>([]);

  // Tell iOS LocalApprovalNotifications which session is currently onscreen so it suppresses
  // redundant foreground banners while the user is already viewing that session.
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const viewedSessionId = extractViewedSessionId(pathname);
    const token = viewedSessionId && computer.key !== "none" ? `${computer.key}:${viewedSessionId}` : "";
    void cancelNativeLocalApprovalNotification(`__active_session__:${token}`);
    return () => {
      if (viewedSessionId) {
        void cancelNativeLocalApprovalNotification("__active_session__:");
      }
    };
  }, [pathname, computer.key]);

  const stateRef = useRef({
    computerKey: computer.key,
    online: status === "online",
    sessionsLoaded,
    link,
    actions,
    sessions,
    views,
  });
  stateRef.current = {
    computerKey: computer.key,
    online: status === "online",
    sessionsLoaded,
    link,
    actions,
    sessions,
    views,
  };

  useEffect(() => {
    if (!navigation?.key) return;

    const selectTargetComputer = (targetKey: string | undefined) => {
      if (!targetKey || targetKey === stateRef.current.computerKey) return;
      const { saved, live, lanHosts } = useComputers.getState();
      if (listComputers({ saved, live, lanHosts }).some((c) => c.key === targetKey)) {
        useComputers.getState().select(targetKey);
      }
    };

    const coordinator = createNotificationActionCoordinator({
      pendingId: pendingNativeNotificationActionId,
      consume: consumeNativeNotificationAction,
      subscribe: subscribeNativeNotificationActions,
      onExecute: (action) => {
        if (action.kind === "open") {
          selectTargetComputer(action.computerKey);
          router.push(resolveNotificationRoute(action));
          return;
        }
        selectTargetComputer(action.computerKey);
        // Woken from the background or lock screen: wake relays and the host link immediately
        // instead of waiting out reconnect backoff.
        if (!stateRef.current.online) {
          reconnectRelays();
          stateRef.current.link.reconnectNow();
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

    if (status === "online" && sessionsLoaded) {
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
    } else if (status !== "online") {
      reconnectRelays();
      link.reconnectNow();
    }

    return () => clearTimeout(timer);
  }, [queue, status, sessionsLoaded, computer.key, link]);

  return null;
}

export async function dispatchNotificationAction(
  action: NativeNotificationAction,
  current: {
    computerKey: string;
    actions: Pick<ReturnType<typeof useActions>, "cancel" | "respond">;
    sessions: ClientState["sessions"];
    views: ClientState["views"];
  },
  onNavigate: (target: ReturnType<typeof resolveNotificationRoute>) => void = (target) => router.push(target),
): Promise<boolean> {
  const sessionId = action.sessionId;
  if (!sessionId) {
    onNavigate(resolveNotificationRoute(action));
    return false;
  }

  const session = current.sessions[sessionId];
  const view = current.views[sessionId];

  if (action.kind === "cancel") {
    const canCancel =
      session &&
      !session.archived &&
      (session.state === "running" ||
        session.state === "waiting" ||
        session.state === "unknown" ||
        Boolean(view?.turnActive));
    if (!canCancel) {
      onNavigate(resolveNotificationRoute(action));
      return false;
    }
    try {
      await current.actions.cancel(sessionId);
      return true;
    } catch {
      onNavigate(resolveNotificationRoute(action));
      return false;
    }
  }

  if (action.kind === "approve" || action.kind === "deny") {
    const permissions = view?.permissions ?? [];
    const perm = session?.permission ?? permissions[0];
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
    const targetComputer = action.computerKey || current.computerKey;
    if (!requestId || !optionId) {
      onNavigate(resolveNotificationRoute(action));
      return false;
    }
    // Validate against live host state before authorizing so a stale notification button can
    // never approve/deny an expired or replaced request.
    const candidate: LiveActivityAction = {
      id: action.actionId,
      computerKey: targetComputer,
      sessionId,
      requestId,
      optionId,
      label: action.kind === "approve" ? "允许" : "拒绝",
      kind: "permission",
      role: action.kind === "approve" ? "allow" : "reject",
    };
    if (!isLiveActivityActionCurrent(candidate, current.computerKey, session, permissions)) {
      void cancelNativeLocalApprovalNotification(`approval:${targetComputer}:${sessionId}:${requestId}`);
      onNavigate(resolveNotificationRoute(action));
      return false;
    }
    try {
      await current.actions.respond(sessionId, requestId, optionId);
      void cancelNativeLocalApprovalNotification(`approval:${targetComputer}:${sessionId}:${requestId}`);
      return true;
    } catch {
      onNavigate(resolveNotificationRoute(action));
      return false;
    }
  }

  return false;
}
