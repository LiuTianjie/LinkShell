import * as Linking from "expo-linking";
import { router, useGlobalSearchParams, useRootNavigationState } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { useActions, useClient } from "@/lib/client";
import { parseShortcutUrl, type ShortcutActionKind } from "@/lib/coding-ux";
import { haptics } from "@/lib/haptics";
import { useLocale } from "@/lib/locale";
import { mergeLiveViewsIntoSessions } from "@/lib/session-attention";

/**
 * Handles iOS Siri Shortcuts / Action Button / URL scheme deep links:
 * - `linkshell:///quick-voice`
 * - `linkshell:///approve-latest`
 */
export function ShortcutUrlHandler() {
  const navigation = useRootNavigationState();
  const params = useGlobalSearchParams<{ shortcut?: string }>();
  const sessions = useClient((state) => state.sessions);
  const views = useClient((state) => state.views);
  const sessionsLoaded = useClient((state) => state.sessionsLoaded);
  const online = useClient((state) => state.status === "online");
  const actions = useActions();
  const { pick } = useLocale();

  const [pendingAction, setPendingAction] = useState<ShortcutActionKind | null>(null);
  const lastHandledToken = useRef<string | null>(null);

  useEffect(() => {
    const fromParam = parseShortcutUrl(params.shortcut ? `/?shortcut=${params.shortcut}` : null);
    if (fromParam) {
      const token = `param:${fromParam}`;
      if (lastHandledToken.current !== token) {
        lastHandledToken.current = token;
        setPendingAction(fromParam);
      }
    }
  }, [params.shortcut]);

  useEffect(() => {
    void Linking.getInitialURL()
      .then((initial) => {
        const parsed = parseShortcutUrl(initial);
        if (parsed) {
          const token = `init:${initial}`;
          if (lastHandledToken.current !== token) {
            lastHandledToken.current = token;
            setPendingAction(parsed);
          }
        }
      })
      .catch(() => {});

    const sub = Linking.addEventListener("url", ({ url }) => {
      const parsed = parseShortcutUrl(url);
      if (parsed) {
        setPendingAction(parsed);
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!pendingAction || !navigation?.key) return;
    const allSessions = mergeLiveViewsIntoSessions(Object.values(sessions), views).filter((s) => !s.archived);

    if (pendingAction === "quick-voice") {
      if (!sessionsLoaded && allSessions.length === 0) return;
      setPendingAction(null);
      const sorted = [...allSessions].sort((a, b) => b.updatedAt - a.updatedAt);
      const target = sorted[0];
      if (target) {
        router.push({ pathname: "/session/[id]", params: { id: target.id, quickVoice: "1" } });
      } else {
        router.push("/new");
      }
      return;
    }

    if (pendingAction === "approve-latest") {
      if (!online) return;
      setPendingAction(null);
      const waiting = [...allSessions]
        .filter((s) => Boolean(s.permission))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const target = waiting[0];
      if (!target?.permission) {
        router.push({ pathname: "/activity", params: { filter: "attention" } });
        return;
      }
      const perm = target.permission;
      if (perm.questions && perm.questions.length > 0) {
        router.push({ pathname: "/session/[id]", params: { id: target.id } });
        return;
      }
      const allowOpt =
        perm.options.find((opt) => opt.kind === "allow_once") ??
        perm.options.find((opt) => opt.kind === "allow_always");
      if (!allowOpt) {
        router.push({ pathname: "/session/[id]", params: { id: target.id } });
        return;
      }
      void actions
        .respond(target.id, perm.requestId, allowOpt.optionId)
        .then(() => {
          haptics.success();
          router.push({ pathname: "/session/[id]", params: { id: target.id } });
        })
        .catch((reason: unknown) => {
          haptics.error();
          Alert.alert(
            pick({ zh: "审批失败", en: "Approval failed", ja: "承認に失敗しました" }),
            reason instanceof Error ? reason.message : String(reason),
          );
          router.push({ pathname: "/session/[id]", params: { id: target.id } });
        });
    }
  }, [pendingAction, navigation?.key, sessions, views, sessionsLoaded, online, actions, pick]);

  return null;
}
