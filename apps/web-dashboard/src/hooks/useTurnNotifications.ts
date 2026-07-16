// Turn-completion notifications: watch the workspace conversations and, when a
// running turn finishes (running → idle) or blocks on a permission prompt
// (→ waiting_permission) while the tab is hidden/unfocused, fire a Web
// Notification plus a "●" document.title badge so the user notices from
// another tab/window. Permission is requested lazily on the first composer
// send (see requestTurnNotificationPermission), never on page load. The
// Notification API is absent inside the mobile WebView — every entry point
// guards for that and quietly no-ops.

import { useEffect, useRef } from "react";
import type { AgentConversation } from "../lib/types";

const hasNotificationApi = () =>
  typeof window !== "undefined" && "Notification" in window;

// Lazily ask for notification permission. Called on the first composer send so
// the browser prompt appears in response to a user gesture, not on load.
export function requestTurnNotificationPermission(): void {
  if (!hasNotificationApi()) return;
  if (Notification.permission === "default") {
    // Fire-and-forget; result is re-read from Notification.permission later.
    void Notification.requestPermission().catch(() => undefined);
  }
}

const BADGE_TITLE = "● LinkShell";

// Is the tab currently in the background (hidden or unfocused)?
function tabInBackground(): boolean {
  return document.hidden || !document.hasFocus();
}

export function useTurnNotifications(conversations: AgentConversation[]): void {
  // Last seen status per conversation id, to detect transitions (not states).
  const prevStatusRef = useRef<Map<string, AgentConversation["status"]>>(new Map());
  // The pre-badge title, restored when the user comes back to the tab.
  const baseTitleRef = useRef<string | null>(null);

  // Clear the title badge as soon as the tab regains focus/visibility.
  useEffect(() => {
    const clearBadge = () => {
      if (baseTitleRef.current != null && !document.hidden) {
        document.title = baseTitleRef.current;
        baseTitleRef.current = null;
      }
    };
    window.addEventListener("focus", clearBadge);
    document.addEventListener("visibilitychange", clearBadge);
    return () => {
      window.removeEventListener("focus", clearBadge);
      document.removeEventListener("visibilitychange", clearBadge);
    };
  }, []);

  useEffect(() => {
    const prev = prevStatusRef.current;
    const next = new Map<string, AgentConversation["status"]>();
    for (const c of conversations) {
      next.set(c.id, c.status);
      const before = prev.get(c.id);
      // Only announce transitions out of "running" — a turn we watched start.
      if (before !== "running" || c.status === "running") continue;
      const finished = c.status === "idle";
      const blocked = c.status === "waiting_permission";
      if ((!finished && !blocked) || !tabInBackground()) continue;

      const title = finished ? "任务完成" : "等待授权";
      const name =
        (c.title && c.title.trim()) ||
        (c.lastMessagePreview && c.lastMessagePreview.trim().slice(0, 60)) ||
        `对话 ${c.id.slice(-6)}`;

      // Title badge (works even without Notification permission).
      if (baseTitleRef.current == null) baseTitleRef.current = document.title;
      document.title = BADGE_TITLE;

      if (hasNotificationApi() && Notification.permission === "granted") {
        try {
          const n = new Notification(title, { body: name, tag: `linkshell-turn-${c.id}` });
          n.onclick = () => {
            window.focus();
            n.close();
          };
        } catch {
          // Some WebViews expose the constructor but throw — ignore.
        }
      }
    }
    prevStatusRef.current = next;
  }, [conversations]);
}
