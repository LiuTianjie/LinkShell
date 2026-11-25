import { useEffect, useMemo, useRef } from "react";
import { Platform } from "react-native";
import { liveActivityDetailLink, permissionChoices, wakeupNoticeSchema, type WakeupNotice } from "@linkshell/wire";
import {
  cancelNativeAndroidStatusNotification,
  ensureNativeNotificationPermission,
  syncNativeAndroidStatusNotification,
  type AndroidNotificationActionInput,
} from "../../modules/link-layout";
import { useClient, useConnection, useConnectionStatus } from "@/lib/client";
import { useComputers } from "@/lib/computers";
import { useLocale } from "@/lib/locale";
import { buildAndroidStatusPayload, mergeLiveViewsIntoSessions } from "@/lib/session-attention";
import { useTerminals } from "@/lib/terminals";

function displayComputerName(computer: ReturnType<typeof useConnection>["computer"], fallback: string): string {
  if (!computer) return fallback;
  return computer.kind === "relay" ? computer.machine.name : computer.name;
}

/**
 * Android background status notification helper.
 * Mirrors session attention & background running state to a system notification channel
 * on Android without requiring external push SDKs. Never active on iOS.
 */
export function AndroidAttentionSync() {
  const { computer, link } = useConnection();
  const status = useConnectionStatus();
  const { pick } = useLocale();
  const sessionsById = useClient((s) => s.sessions);
  const sessionsLoaded = useClient((s) => s.sessionsLoaded);
  const views = useClient((s) => s.views);
  const progress = useClient((s) => s.promptProgress);
  const { terminals, loaded: terminalsLoaded } = useTerminals();

  const sessions = useMemo(
    () => mergeLiveViewsIntoSessions(Object.values(sessionsById), views, progress),
    [sessionsById, views, progress],
  );
  const goals = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(views).flatMap(([sessionId, view]) =>
          view.goal ? [[sessionId, view.goal]] : [],
        ),
      ),
    [views],
  );
  const hasAnyComputer = useComputers(
    (s) => s.saved.relay.length > 0 || s.saved.direct.length > 0 || Object.values(s.live).some((list) => list.length > 0),
  );
  const lastSignatureRef = useRef("");
  const permissionRequestedRef = useRef(false);
  const latestRef = useRef({ computer, sessions, terminals, goals, status });
  latestRef.current = { computer, sessions, terminals, goals, status };

  const requestPermissionOnce = () => {
    if (permissionRequestedRef.current) return;
    permissionRequestedRef.current = true;
    void ensureNativeNotificationPermission().catch(() => {});
  };

  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (!hasAnyComputer || computer.key === "none") {
      if (lastSignatureRef.current !== "off") {
        lastSignatureRef.current = "off";
        void cancelNativeAndroidStatusNotification();
      }
      return;
    }

    const computerName = displayComputerName(
      computer,
      pick({ zh: "电脑", en: "Computer", ja: "コンピュータ" }),
    );
    const payload = buildAndroidStatusPayload({
      computerName,
      computerKey: computer.key,
      sessions,
      terminals,
      online: status === "online",
      goals,
    });

    if (!payload.active) {
      // Wait for initial sessions & terminals hydration before cancelling an existing FGS/status
      // notification so reconnects or cold starts never drop an active approval prematurely.
      if (!sessionsLoaded || !terminalsLoaded) return;
      if (lastSignatureRef.current !== "off") {
        lastSignatureRef.current = "off";
        void cancelNativeAndroidStatusNotification();
      }
      return;
    }

    const signature = JSON.stringify(payload);
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;
    requestPermissionOnce();
    void syncNativeAndroidStatusNotification(payload);
  }, [computer, goals, hasAnyComputer, pick, sessions, sessionsLoaded, status, terminals, terminalsLoaded]);

  // Zero-plaintext wakeup notices over the live tunnel also surface an urgent local alert on Android.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (typeof link.on !== "function") return;
    return link.on("liveActivities.wakeup", (raw: unknown) => {
      const parsed = wakeupNoticeSchema.safeParse(raw);
      if (!parsed.success) return;
      const notice: WakeupNotice = parsed.data;
      const current = latestRef.current;
      const computerName = displayComputerName(
        current.computer,
        pick({ zh: "电脑", en: "Computer", ja: "コンピュータ" }),
      );
      const deepLink = liveActivityDetailLink(current.computer.key, "session", notice.sessionId);
      const needsFollowUp = notice.eventType === "approval" || notice.eventType === "question";

      // Preserve Approve/Deny actions whenever the session's pending permission is already known
      // so a wakeup notice never overwrites interactive buttons with a bare "查看" notification.
      let actions: AndroidNotificationActionInput[] = [];
      let title = computerName;
      let subtitle =
        notice.eventType === "approval"
          ? pick({ zh: "有操作等你确认", en: "A session is waiting for approval", ja: "承認待ちの操作があります" })
          : notice.eventType === "question"
            ? pick({ zh: "Agent 等你回答", en: "Agent is waiting for your answer", ja: "エージェントが回答を待っています" })
            : notice.eventType === "error"
              ? pick({ zh: "会话执行遇到错误", en: "A session encountered an error", ja: "セッションでエラーが発生しました" })
              : pick({ zh: "本轮任务已完成", en: "Agent turn completed", ja: "タスクが完了しました" });

      if (notice.eventType === "approval") {
        const targetSession = current.sessions.find((s) => s.id === notice.sessionId);
        const perm = targetSession?.permission;
        if (perm && !perm.url && !perm.questions?.length && perm.options?.length) {
          const choices = permissionChoices(perm.options);
          const allow = choices.find((c) => c.role === "allow") ?? choices.find((c) => c.role === "always");
          const deny = choices.find((c) => c.role === "reject") ?? choices.find((c) => c.role === "stop");
          if (allow) {
            actions.push({
              id: `approve:${notice.sessionId}:${perm.requestId}`,
              label: allow.label || "允许",
              kind: "approve",
              computerKey: current.computer.key,
              sessionId: notice.sessionId,
              requestId: perm.requestId,
              optionId: allow.option.optionId,
              deepLink,
            });
          }
          if (deny) {
            actions.push({
              id: `deny:${notice.sessionId}:${perm.requestId}`,
              label: deny.label || "拒绝",
              kind: "deny",
              computerKey: current.computer.key,
              sessionId: notice.sessionId,
              requestId: perm.requestId,
              optionId: deny.option.optionId,
              deepLink,
            });
          }
          if (perm.title?.trim()) subtitle = perm.title.trim();
        } else {
          const rich = buildAndroidStatusPayload({
            computerName,
            computerKey: current.computer.key,
            sessions: current.sessions,
            terminals: current.terminals,
            online: current.status === "online",
            goals: current.goals,
          });
          if (rich.active && rich.actions?.some((a) => a.kind === "approve" || a.kind === "deny")) {
            actions = rich.actions;
            if (rich.title) title = rich.title;
            if (rich.subtitle) subtitle = rich.subtitle;
          }
        }
      }

      if (actions.length === 0) {
        actions = [
          {
            id: `open:${notice.sessionId}`,
            label: "查看",
            kind: "open",
            computerKey: current.computer.key,
            sessionId: notice.sessionId,
            deepLink,
          },
        ];
        // Allow the next state sync to upgrade this placeholder to full Approve/Deny buttons once summary arrives.
        lastSignatureRef.current = "";
      }

      requestPermissionOnce();
      void syncNativeAndroidStatusNotification({
        active: true,
        title,
        subtitle,
        computerName,
        // Through the computer it came from: tapped after switching computers, a bare session
        // link would look the id up on whichever one is selected now.
        deepLink,
        urgent: notice.eventType !== "completed",
        ongoing: needsFollowUp,
        foregroundService: needsFollowUp,
        actions,
      });
    });
  }, [link, pick]);

  return null;
}
