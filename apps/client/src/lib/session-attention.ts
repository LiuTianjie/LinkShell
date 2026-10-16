import type { PromptProgress, SessionView } from "@linkshell/client-core";
import { buildLiveActivitySnapshot, liveActivityContent, type AttentionPhase, type SessionSummary, type TerminalInfo } from "@linkshell/wire";
export { classifySessionPhase, phasePriority, type AttentionPhase } from "@linkshell/wire";
import Storage from "expo-sqlite/kv-store";
import { useEffect, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import {
  setNativeShortcutItems,
  syncNativeLiveActivity,
  type LiveActivityPayload,
  type ShortcutItemInput,
} from "../../modules/link-layout";
import { agentLook } from "@/theme/agents";
import { needsAttention, sessionTitle } from "./describe";
import { baseName } from "./format";

export type HomeFilterMode = "all" | "attention" | "running" | "pinned" | "terminals" | "snoozed";

const PINNED_KEY = "sessions.pinned.v1";
const SNOOZED_KEY = "sessions.snoozed.v1";

const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let pinnedIds: string[] = [];
let snoozedUntilById: Record<string, number> = {};

try {
  const rawPinned = Storage.getItemSync(PINNED_KEY);
  if (rawPinned) {
    const parsed = JSON.parse(rawPinned);
    if (Array.isArray(parsed)) pinnedIds = parsed.filter((id): id is string => typeof id === "string");
  }
  const rawSnoozed = Storage.getItemSync(SNOOZED_KEY);
  if (rawSnoozed) {
    const parsed = JSON.parse(rawSnoozed);
    if (parsed && typeof parsed === "object") snoozedUntilById = parsed as Record<string, number>;
  }
} catch {
  // Missing storage must never break the home list.
}

function savePinned(next: string[]) {
  pinnedIds = next;
  try {
    Storage.setItemSync(PINNED_KEY, JSON.stringify(next));
  } catch {
    // Keep in memory for this run.
  }
  notify();
}

function saveSnoozed(next: Record<string, number>) {
  snoozedUntilById = next;
  try {
    Storage.setItemSync(SNOOZED_KEY, JSON.stringify(next));
  } catch {
    // Keep in memory for this run.
  }
  notify();
}

export function isSessionPinned(sessionId: string): boolean {
  return pinnedIds.includes(sessionId);
}

export function toggleSessionPinned(sessionId: string): boolean {
  const exists = pinnedIds.includes(sessionId);
  const next = exists ? pinnedIds.filter((id) => id !== sessionId) : [sessionId, ...pinnedIds];
  savePinned(next);
  return !exists;
}

export function snoozeSession(sessionId: string, durationMs: number, now = Date.now()): void {
  saveSnoozed({
    ...snoozedUntilById,
    [sessionId]: now + Math.max(60_000, durationMs),
  });
}

export function clearSessionSnooze(sessionId: string): void {
  if (!(sessionId in snoozedUntilById)) return;
  const next = { ...snoozedUntilById };
  delete next[sessionId];
  saveSnoozed(next);
}

/**
 * A snoozed session stays hidden until its timer expires, UNLESS it needs user
 * attention, fails, or starts running again — urgent events wake it immediately.
 */
export function isSessionSnoozed(
  session: SessionSummary,
  now = Date.now(),
  snoozedMap: Record<string, number> = snoozedUntilById,
): boolean {
  const until = snoozedMap[session.id];
  if (!until || until <= now) return false;
  if (needsAttention(session) || session.state === "running" || session.state === "error") return false;
  return true;
}

const getPinnedSnapshot = () => pinnedIds;
const getSnoozedSnapshot = () => snoozedUntilById;

export function usePinnedSessionIds(): string[] {
  return useSyncExternalStore(subscribe, getPinnedSnapshot, getPinnedSnapshot);
}

export function useSnoozedSessions(): Record<string, number> {
  return useSyncExternalStore(subscribe, getSnoozedSnapshot, getSnoozedSnapshot);
}

export function phaseLabel(phase: AttentionPhase): string {
  switch (phase) {
    case "waiting_for_approval":
      return "等待确认";
    case "waiting_for_input":
      return "等待回答";
    case "failed":
      return "执行出错";
    case "running":
      return "正在运行";
    case "starting":
      return "正在启动";
    case "completed":
      return "已完成";
    case "stale":
      return "状态已过期";
  }
}

export function mergeLiveViewsIntoSessions(
  sessions: SessionSummary[],
  views?: Record<string, SessionView>,
  promptProgress?: Record<string, PromptProgress>,
): SessionSummary[] {
  if (!views && !promptProgress) return sessions;
  return sessions.map((session) => {
    const view = views?.[session.id];
    const progress = promptProgress?.[session.id];
    if (!view && !progress) return session;
    const isTurnActive = Boolean(
      progress ||
      (view ? view.turnActive && view.state !== "idle" && view.state !== "error" : false),
    );
    const hasViewPerm = Boolean(view?.permissions?.length);
    const nextState = hasViewPerm
      ? "waiting"
      : isTurnActive
        ? "running"
        : session.state;

    let activity = session.activity;
    if (!activity && isTurnActive && view?.items?.length) {
      for (let i = view.items.length - 1; i >= 0; i--) {
        const item = view.items[i]!;
        if (item.kind === "tool") {
          activity = { kind: "tool", title: item.title, toolKind: item.toolKind };
          break;
        }
        if (item.kind === "thought") {
          activity = { kind: "thinking" };
          break;
        }
        if (item.kind === "agent") {
          activity = { kind: "responding" };
          break;
        }
      }
    }
    if (!activity && isTurnActive && view?.goal?.status === "active") {
      activity = { kind: "tool", title: `目标 · ${view.goal.objective}` };
    }

    const firstPerm = view?.permissions?.[0];
    const permission =
      session.permission ??
      (firstPerm
        ? {
            requestId: firstPerm.requestId,
            childSessionId: firstPerm.childSessionId,
            toolCallId: firstPerm.toolCallId,
            title: firstPerm.title,
            detail: firstPerm.detail,
            tool: firstPerm.tool,
            url: firstPerm.url,
            options: firstPerm.options,
            questions: firstPerm.questions,
          }
        : undefined);

    return {
      ...session,
      ...(view?.title ? { title: view.title } : {}),
      state: nextState,
      ...(activity ? { activity } : {}),
      ...(permission ? { permission, pendingPermissions: Math.max(session.pendingPermissions, view?.permissions?.length ?? 1) } : {}),
    };
  });
}

/** Uses the same projection as the background host sender. */
export function buildLiveActivityPayload(
  computerName: string, sessions: SessionSummary[], terminals: TerminalInfo[], online: boolean,
  views?: Record<string, SessionView>, promptProgress?: Record<string, PromptProgress>, computerKey = "",
): LiveActivityPayload {
  const goals = Object.fromEntries(Object.entries(views ?? {}).flatMap(([id, view]) => view.goal ? [[id, view.goal]] : []));
  const snapshot = buildLiveActivitySnapshot(computerName, mergeLiveViewsIntoSessions(sessions, views, promptProgress), terminals, online, computerKey, goals);
  return { ...snapshot, ...(snapshot.active ? liveActivityContent(snapshot) : {}), computerKey };
}

/**
 * Builds up to 4 iOS Home Screen Quick Actions:
 * 1 static "新建会话" + up to 3 top attention/pinned/recent sessions.
 */
export function buildIOSShortcutItems(
  sessions: SessionSummary[],
  pinned: string[] = pinnedIds,
): ShortcutItemInput[] {
  const pinnedSet = new Set(pinned);
  const topSessions = sessions
    .filter((s) => !s.archived)
    .sort((a, b) => {
      const attA = Number(needsAttention(a));
      const attB = Number(needsAttention(b));
      if (attA !== attB) return attB - attA;
      const runA = Number(a.state === "running");
      const runB = Number(b.state === "running");
      if (runA !== runB) return runB - runA;
      const pinA = Number(pinnedSet.has(a.id));
      const pinB = Number(pinnedSet.has(b.id));
      if (pinA !== pinB) return pinB - pinA;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, 3);

  return [
    {
      id: "linkshell.new-session",
      title: "新建会话",
      subtitle: "在当前电脑上启动 Agent",
      icon: "square.and.pencil",
      href: "/new",
    },
    ...topSessions.map((session): ShortcutItemInput => {
      const waiting = needsAttention(session);
      const running = session.state === "running";
      const project = baseName(session.worktree?.source ?? session.cwd);
      const agent = agentLook(session.agent).short;
      const statusPrefix = waiting ? "⚠️ 待确认 · " : running ? "⚡️ 运行中 · " : "";
      return {
        id: `linkshell.session.${session.id}`,
        title: sessionTitle(session),
        subtitle: `${statusPrefix}${project} · ${agent}`,
        icon: waiting ? "hand.raised.fill" : running ? "bolt.horizontal.circle.fill" : "bubble.left.and.text.bubble.right",
        href: `/session/${session.id}`,
      };
    }),
  ];
}

/**
 * Hook that keeps iOS Home Screen Quick Actions and ActivityKit Live Activities
 * automatically synchronized with the current computer's sessions and terminals.
 */
export function useIOSAttentionSync(
  computerName: string,
  sessions: SessionSummary[],
  terminals: TerminalInfo[],
  online: boolean,
  views?: Record<string, SessionView>,
  promptProgress?: Record<string, PromptProgress>,
  computerKey = "",
  enabled = true,
) {
  const pinned = usePinnedSessionIds();

  useEffect(() => {
    if (Platform.OS !== "ios" || !enabled) return;
    const shortcuts = buildIOSShortcutItems(mergeLiveViewsIntoSessions(sessions, views, promptProgress), pinned);
    void setNativeShortcutItems(shortcuts);
  }, [sessions, views, promptProgress, pinned, enabled]);

  useEffect(() => {
    if (Platform.OS !== "ios" || !enabled) return;
    const sync = () => {
      const payload = buildLiveActivityPayload(computerName, sessions, terminals, online, views, promptProgress, computerKey);
      void syncNativeLiveActivity(payload);
    };
    sync();
    // Refresh while the runtime is executing; iOS can still suspend background JS.
    const heartbeat = setInterval(() => {
      if (online) sync();
    }, 60_000);
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "inactive" || nextState === "background" || nextState === "active") {
        sync();
      }
    });
    return () => {
      clearInterval(heartbeat);
      sub.remove();
    };
  }, [computerName, sessions, terminals, online, views, promptProgress, computerKey, enabled]);
}

