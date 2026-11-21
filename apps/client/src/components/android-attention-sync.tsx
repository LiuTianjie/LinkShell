import { useEffect, useMemo, useRef } from "react";
import { Platform } from "react-native";
import { wakeupNoticeSchema, type WakeupNotice } from "@linkshell/wire";
import { liveActivityDetailLink } from "@linkshell/wire";
import {
  cancelNativeAndroidStatusNotification,
  syncNativeAndroidStatusNotification,
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
  const views = useClient((s) => s.views);
  const progress = useClient((s) => s.promptProgress);
  const { terminals } = useTerminals();

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
      if (lastSignatureRef.current !== "off") {
        lastSignatureRef.current = "off";
        void cancelNativeAndroidStatusNotification();
      }
      return;
    }

    const signature = JSON.stringify(payload);
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;
    void syncNativeAndroidStatusNotification(payload);
  }, [computer, goals, hasAnyComputer, pick, sessions, status, terminals]);

  // Zero-plaintext wakeup notices over the live tunnel also surface an urgent local alert on Android.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (typeof link.on !== "function") return;
    return link.on("liveActivities.wakeup", (raw: unknown) => {
      const parsed = wakeupNoticeSchema.safeParse(raw);
      if (!parsed.success) return;
      const notice: WakeupNotice = parsed.data;
      const computerName = displayComputerName(
        computer,
        pick({ zh: "电脑", en: "Computer", ja: "コンピュータ" }),
      );
      const subtitle =
        notice.eventType === "approval"
          ? pick({ zh: "有操作等你确认", en: "A session is waiting for approval", ja: "承認待ちの操作があります" })
          : notice.eventType === "question"
            ? pick({ zh: "Agent 等你回答", en: "Agent is waiting for your answer", ja: "エージェントが回答を待っています" })
            : notice.eventType === "error"
              ? pick({ zh: "会话执行遇到错误", en: "A session encountered an error", ja: "セッションでエラーが発生しました" })
              : pick({ zh: "本轮任务已完成", en: "Agent turn completed", ja: "タスクが完了しました" });
      const deepLink = liveActivityDetailLink(computer.key, "session", notice.sessionId);
      const needsFollowUp = notice.eventType === "approval" || notice.eventType === "question";
      void syncNativeAndroidStatusNotification({
        active: true,
        title: computerName,
        subtitle,
        computerName,
        // Through the computer it came from: tapped after switching computers, a bare session
        // link would look the id up on whichever one is selected now.
        deepLink,
        urgent: notice.eventType !== "completed",
        ongoing: needsFollowUp,
        foregroundService: needsFollowUp,
        actions: [
          {
            id: `open:${notice.sessionId}`,
            label: "查看",
            kind: "open",
            computerKey: computer.key,
            sessionId: notice.sessionId,
            deepLink,
          },
        ],
      });
    });
  }, [computer, link, pick]);

  return null;
}
