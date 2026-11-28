import type { PromptProgress, SessionView } from "@linkshell/client-core";
import {
  buildLiveActivitySnapshot,
  liveActivityContent,
  liveActivityDetailLink,
  permissionChoices,
  type AttentionPhase,
  type SessionSummary,
  type TerminalInfo,
} from "@linkshell/wire";
export { classifySessionPhase, phasePriority, type AttentionPhase } from "@linkshell/wire";
import Storage from "expo-sqlite/kv-store";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import * as linkLayout from "../../modules/link-layout";
import {
  setNativeShortcutItems,
  syncNativeLiveActivity,
  type AndroidNotificationActionInput,
  type AndroidStatusNotificationPayload,
  type LiveActivityPayload,
  type LocalApprovalNotificationPayload,
  type NativeNotificationAction,
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
      return "等你确认";
    case "waiting_for_input":
      return "等你回答";
    case "failed":
      return "出错";
    case "running":
      return "运行中";
    case "starting":
      return "正在启动";
    case "completed":
      return "空闲";
    case "stale":
      return "离线";
  }
}

export function mergeLiveViewsIntoSessions(
  sessions: SessionSummary[],
  views?: Record<string, SessionView>,
  promptProgress?: Record<string, PromptProgress>,
): SessionSummary[] {
  if (!views && !promptProgress) return sessions;
  return sessions.map((session) => {
    // A view only follows its session while that session is open; after it is closed it keeps
    // what it last saw (a running turn, a pending approval). The summary is newer once the
    // computer has logged events the view never got, and then the summary alone is right.
    const cached = views?.[session.id];
    const view = cached && cached.lastSeq >= session.lastSeq ? cached : undefined;
    const viewAhead = Boolean(view && view.lastSeq > session.lastSeq);
    const progress = promptProgress?.[session.id];
    if (!view && !progress) return session;
    const isTurnActive = Boolean(
      progress ||
      (view && view.turnActive && view.state !== "idle" && view.state !== "error" && (viewAhead || session.state !== "idle")),
    );
    // Discovery updates (e.g. an answered desktop question) can clear waiting state without
    // advancing lastSeq; only let cached view permissions win when the view is strictly ahead.
    const activeViewPerms =
      view?.permissions?.length &&
      (viewAhead || session.state === "waiting" || session.pendingPermissions > 0 || Boolean(session.permission))
        ? view.permissions
        : undefined;
    const hasPerm = Boolean(activeViewPerms?.length) || session.state === "waiting" || session.pendingPermissions > 0;
    const nextState = hasPerm
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

    const firstPerm = activeViewPerms?.[0];
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
      ...(permission ? { permission, pendingPermissions: Math.max(session.pendingPermissions, activeViewPerms?.length ?? 1) } : {}),
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

  const items: ShortcutItemInput[] = [
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
      const statusPrefix = waiting ? "等你处理 · " : running ? "运行中 · " : "";
      return {
        id: `linkshell.session.${session.id}`,
        title: sessionTitle(session),
        subtitle: `${statusPrefix}${project} · ${agent}`,
        icon: waiting ? "hand.raised.fill" : running ? "bolt.horizontal.circle.fill" : "bubble.left.and.text.bubble.right",
        href: `/session/${session.id}`,
      };
    }),
  ];

  const hasWaitingApproval = sessions.some((s) => !s.archived && needsAttention(s));
  if (items.length < 4 && hasWaitingApproval) {
    items.push({
      id: "linkshell.approve-latest",
      title: "一键批准最新请求",
      subtitle: "Siri / 操作按钮快捷审批",
      icon: "checkmark.shield.fill",
      href: "/approve-latest",
    });
  }
  if (items.length < 4) {
    items.push({
      id: "linkshell.quick-voice",
      title: "语音指令",
      subtitle: "直接对最近会话说话",
      icon: "waveform",
      href: "/quick-voice",
    });
  }
  return items.slice(0, 4);
}

export const ATTENTION_STREAM_THROTTLE_MS = 600;

export function shortcutItemsFingerprint(items: ShortcutItemInput[]): string {
  return JSON.stringify(items);
}

export function liveActivityPayloadFingerprint(payload: LiveActivityPayload): string {
  return JSON.stringify(payload);
}

/**
 * Captures structural and state transitions that must flush immediately rather than waiting
 * for the 600ms streaming throttle: session state, pending permissions / questions count,
 * turn start/end, online status, computer identity, pinned list, and terminal lifecycle.
 */
export function sessionTransitionSignature(
  sessions: SessionSummary[],
  terminals: TerminalInfo[],
  online: boolean,
  views?: Record<string, SessionView>,
  promptProgress?: Record<string, PromptProgress>,
  computerKey = "",
  computerName = "",
  pinned: string[] = [],
): string {
  const sessionParts: string[] = [];
  const seenIds = new Set<string>();
  for (const s of sessions) {
    seenIds.add(s.id);
    const view = views?.[s.id];
    const progress = promptProgress?.[s.id];
    const turnActive = Boolean(
      progress || (view ? view.turnActive && view.state !== "idle" && view.state !== "error" : false),
    );
    const viewPermCount = view?.permissions?.length ?? 0;
    const permCount = Math.max(s.pendingPermissions, viewPermCount);
    const permId = s.permission?.requestId ?? view?.permissions?.[0]?.requestId ?? "";
    const asyncCount = s.asyncQuestions?.length ?? 0;
    const effectiveState = permCount > 0 || s.state === "waiting" ? "waiting" : turnActive ? "running" : s.state;
    sessionParts.push(
      `${s.id}:${s.archived ? 1 : 0}:${s.title ?? ""}:${s.state}:${view?.state ?? ""}:${effectiveState}:${turnActive ? 1 : 0}:${permCount}:${permId}:${asyncCount}`,
    );
  }
  if (promptProgress) {
    for (const id of Object.keys(promptProgress)) {
      if (!seenIds.has(id)) sessionParts.push(`+p:${id}`);
    }
  }
  if (views) {
    for (const [id, view] of Object.entries(views)) {
      if (seenIds.has(id)) continue;
      const turnActive = view.turnActive && view.state !== "idle" && view.state !== "error";
      const permCount = view.permissions?.length ?? 0;
      if (turnActive || permCount > 0) {
        sessionParts.push(`+v:${id}:${view.state}:${turnActive ? 1 : 0}:${permCount}`);
      }
    }
  }
  const termParts = terminals.map(
    (t) => `${t.id}:${t.title}:${t.command ?? ""}:${t.exitCode ?? ""}:${t.interrupted ? 1 : 0}`,
  );
  return `${computerKey}\n${computerName}\n${online ? 1 : 0}\n${pinned.join(",")}\n${sessionParts.join("|")}\n${termParts.join("|")}`;
}

export interface AttentionSyncInput {
  computerName: string;
  sessions: SessionSummary[];
  terminals: TerminalInfo[];
  online: boolean;
  views?: Record<string, SessionView>;
  promptProgress?: Record<string, PromptProgress>;
  computerKey: string;
  pinned: string[];
  enabled: boolean;
}

export interface AttentionSyncScheduler {
  schedule(readLatest: () => AttentionSyncInput, options?: { immediate?: boolean }): void;
  flush(options?: { foregroundReturn?: boolean }): void;
  cancelPending(): void;
  dispose(): void;
}

export function shouldUseLocalApprovalFallback(params: {
  liveActivityAvailable: boolean;
  liveActivitySynced: boolean;
}): boolean {
  return !params.liveActivityAvailable || !params.liveActivitySynced;
}

/**
 * Extracts pending approval requests that can be surfaced as interactive iOS local
 * notifications whenever ActivityKit Live Activities are unavailable or disabled/rejected.
 */
export function buildLocalApprovalNotifications(
  computerName: string,
  computerKey: string,
  sessions: SessionSummary[],
  online: boolean,
): LocalApprovalNotificationPayload[] {
  if (!online || !computerKey) return [];
  const out: LocalApprovalNotificationPayload[] = [];
  for (const session of sessions) {
    if (session.archived) continue;
    const perm = session.permission;
    if (!perm || perm.url || perm.questions?.length) continue;
    const choices = permissionChoices(perm.options);
    const approveChoice = choices.find((c) => c.role === "allow") ?? choices.find((c) => c.role === "always");
    const denyChoice = choices.find((c) => c.role === "reject") ?? choices.find((c) => c.role === "stop");
    out.push({
      id: `approval:${computerKey}:${session.id}:${perm.requestId}`,
      title: `${sessionTitle(session)} · 需要你批准`,
      body: perm.title?.trim() || `${computerName} 等待确认继续执行`,
      computerKey,
      sessionId: session.id,
      requestId: perm.requestId,
      ...(approveChoice ? { approveOptionId: approveChoice.option.optionId } : {}),
      ...(denyChoice ? { denyOptionId: denyChoice.option.optionId } : {}),
      deepLink: liveActivityDetailLink(computerKey, "session", session.id),
    });
  }
  return out;
}

/**
 * Builds the Android foreground/status notification payload including interactive
 * Approve/Deny/Cancel/Open buttons and `foregroundService` continuity guard.
 */
export function buildAndroidStatusPayload(params: {
  computerName: string;
  computerKey: string;
  sessions: SessionSummary[];
  terminals: TerminalInfo[];
  online: boolean;
  goals?: Record<string, { status: string; objective: string }>;
}): AndroidStatusNotificationPayload {
  const { computerName, computerKey, sessions, terminals, online, goals } = params;
  const snapshot = buildLiveActivitySnapshot(computerName, sessions, terminals, online, computerKey, goals);
  if (!snapshot.active) {
    return { active: false, foregroundService: false, actions: [] };
  }
  const content = liveActivityContent(snapshot);
  const urgent =
    snapshot.phase === "waiting_for_approval" ||
    snapshot.phase === "waiting_for_input" ||
    snapshot.phase === "failed";
  const ongoing = snapshot.phase === "running" || snapshot.phase === "starting";
  const foregroundService =
    ongoing || snapshot.phase === "waiting_for_approval" || snapshot.phase === "waiting_for_input";
  const deepLink = content.deepLink || snapshot.deepLink || "linkshell:///";
  const actions: AndroidNotificationActionInput[] = [];

  if (snapshot.phase === "waiting_for_approval" && content.actions?.length) {
    const permActions = content.actions.filter((action) => action.kind === "permission");
    const allow = permActions.find((action) => action.role === "allow") ?? permActions.find((action) => action.role === "always");
    const deny = permActions.find((action) => action.role === "reject") ?? permActions.find((action) => action.role === "stop");
    if (allow) {
      actions.push({
        id: `approve:${allow.sessionId}:${allow.requestId}`,
        label: allow.label || "允许",
        kind: "approve",
        computerKey: allow.computerKey,
        sessionId: allow.sessionId,
        requestId: allow.requestId,
        optionId: allow.optionId,
        deepLink,
      });
    }
    if (deny) {
      actions.push({
        id: `deny:${deny.sessionId}:${deny.requestId}`,
        label: deny.label || "拒绝",
        kind: "deny",
        computerKey: deny.computerKey,
        sessionId: deny.sessionId,
        requestId: deny.requestId,
        optionId: deny.optionId,
        deepLink,
      });
    }
  } else if (ongoing) {
    const heroSession = snapshot.tasks?.find((task) => task.kind === "session");
    if (heroSession) {
      actions.push({
        id: `cancel:${heroSession.id}`,
        label: "停止",
        kind: "cancel",
        computerKey,
        sessionId: heroSession.id,
        deepLink,
      });
    }
    actions.push({
      id: `open:${heroSession?.id ?? "home"}`,
      label: "查看",
      kind: "open",
      computerKey,
      ...(heroSession ? { sessionId: heroSession.id } : {}),
      deepLink,
    });
  } else {
    const heroSession = snapshot.tasks?.find((task) => task.kind === "session");
    actions.push({
      id: `open:${heroSession?.id ?? "home"}`,
      label: "查看",
      kind: "open",
      computerKey,
      ...(heroSession ? { sessionId: heroSession.id } : {}),
      deepLink,
    });
  }

  return {
    active: true,
    title: content.title || computerName,
    subtitle: content.subtitle || "",
    computerName,
    deepLink,
    urgent,
    ongoing,
    foregroundService,
    actions,
  };
}

export type NotificationRouteTarget =
  | { pathname: "/session/[id]"; params: { id: string } }
  | { pathname: "/terminal/[id]"; params: { id: string } }
  | { pathname: "/activity"; params: Record<string, string> }
  | { pathname: "/" };

/** Resolves a `NativeNotificationAction`'s `deepLink` / `sessionId` into an Expo Router target. */
export function resolveNotificationRoute(
  action: Pick<NativeNotificationAction, "deepLink" | "sessionId" | "computerKey">,
): NotificationRouteTarget {
  const raw = action.deepLink?.trim();
  if (raw?.startsWith("linkshell:///")) {
    try {
      const parsed = new URL(raw.replace(/^linkshell:\/\/\//, "https://linkshell.local/"));
      if (parsed.pathname.startsWith("/session/")) {
        const id = decodeURIComponent(parsed.pathname.slice("/session/".length));
        if (id) return { pathname: "/session/[id]", params: { id } };
      }
      if (parsed.pathname.startsWith("/terminal/")) {
        const id = decodeURIComponent(parsed.pathname.slice("/terminal/".length));
        if (id) return { pathname: "/terminal/[id]", params: { id } };
      }
      if (parsed.pathname === "/activity") {
        const params: Record<string, string> = {};
        for (const key of ["computer", "session", "terminal", "filter"]) {
          const val = parsed.searchParams.get(key);
          if (val) params[key] = val;
        }
        return { pathname: "/activity", params };
      }
    } catch {
      // Fall through to explicit sessionId.
    }
  }
  if (action.sessionId) {
    return { pathname: "/session/[id]", params: { id: action.sessionId } };
  }
  if (action.computerKey) {
    return { pathname: "/activity", params: { computer: action.computerKey } };
  }
  return { pathname: "/" };
}

export interface NotificationActionCoordinatorDeps {
  pendingId: () => Promise<string | null>;
  consume: (id: string) => Promise<NativeNotificationAction | null>;
  subscribe: (listener: (event: { id: string }) => void) => () => void;
  onExecute: (action: NativeNotificationAction) => Promise<void> | void;
}

/**
 * Drains and subscribes to native notification actions with strict id deduplication
 * so pending actions on cold launch and foreground resume never double-submit.
 */
export function createNotificationActionCoordinator(deps: NotificationActionCoordinatorDeps) {
  const handled = new Set<string>();
  const inFlight = new Set<string>();
  let disposed = false;

  const processId = async (id: string): Promise<boolean> => {
    if (disposed || !id || handled.has(id) || inFlight.has(id)) return false;
    inFlight.add(id);
    try {
      const action = await deps.consume(id).catch(() => null);
      handled.add(id);
      if (disposed || !action) return false;
      await deps.onExecute(action);
      return true;
    } finally {
      inFlight.delete(id);
    }
  };

  let drainChain: Promise<void> = Promise.resolve();
  const drain = () => {
    drainChain = drainChain
      .then(async () => {
        for (let guard = 0; guard < 32; guard += 1) {
          if (disposed) return;
          const nextId = await deps.pendingId().catch(() => null);
          if (!nextId || handled.has(nextId) || inFlight.has(nextId)) break;
          await processId(nextId);
        }
      })
      .catch(() => {});
    return drainChain;
  };

  const unsubscribe = deps.subscribe(({ id }) => {
    void processId(id);
  });

  return {
    drain,
    processId,
    handledCount: () => handled.size,
    dispose() {
      disposed = true;
      unsubscribe();
    },
  };
}

function optionalLinkLayoutFn<K extends keyof typeof linkLayout>(
  key: K,
): (typeof linkLayout)[K] | undefined {
  if (!Object.prototype.hasOwnProperty.call(linkLayout, key)) return undefined;
  const value = linkLayout[key];
  return typeof value === "function" ? value : undefined;
}

export function createAttentionSyncScheduler(
  options: {
    throttleMs?: number;
    setShortcuts?: (items: ShortcutItemInput[]) => Promise<unknown> | unknown;
    syncActivity?: (payload: LiveActivityPayload) => Promise<boolean | unknown> | boolean | unknown;
    isLiveActivityAvailable?: () => Promise<boolean>;
    syncLocalApproval?: (payload: LocalApprovalNotificationPayload) => Promise<boolean>;
    cancelLocalApproval?: (id: string) => Promise<void>;
  } = {},
): AttentionSyncScheduler {
  const throttleMs = options.throttleMs ?? ATTENTION_STREAM_THROTTLE_MS;
  const setShortcuts = options.setShortcuts ?? setNativeShortcutItems;
  const syncActivity = options.syncActivity ?? syncNativeLiveActivity;
  const checkLiveActivityAvailable =
    options.isLiveActivityAvailable ?? optionalLinkLayoutFn("isNativeLiveActivityAvailable");
  const syncLocalApproval =
    options.syncLocalApproval ?? optionalLinkLayoutFn("syncNativeLocalApprovalNotification");
  const cancelLocalApproval =
    options.cancelLocalApproval ?? optionalLinkLayoutFn("cancelNativeLocalApprovalNotification");

  let latestReader: (() => AttentionSyncInput) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSyncAt = 0;
  let lastShortcutKey: string | undefined;
  let lastActivityKey: string | undefined;
  let lastSyncSucceeded: boolean | undefined;
  let lastSyncPromise: Promise<boolean> | undefined;
  let needsForegroundRetry = false;
  let reconcileSeq = 0;
  let sweptStartupDelivered = false;
  const activeLocalApprovals = new Map<string, string>();

  const cancelPending = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const reconcileLocalApprovals = async (
    seq: number,
    expected: LocalApprovalNotificationPayload[],
    online: boolean,
    activityActive: boolean,
    syncPromise: Promise<boolean>,
  ) => {
    if (!syncLocalApproval || !cancelLocalApproval) return;
    const available = checkLiveActivityAvailable
      ? await checkLiveActivityAvailable().catch(() => false)
      : false;
    const syncOk = activityActive ? await syncPromise.catch(() => false) : false;
    if (seq !== reconcileSeq) return;

    const useFallback =
      expected.length > 0 &&
      shouldUseLocalApprovalFallback({
        liveActivityAvailable: available,
        liveActivitySynced: syncOk,
      });

    if (useFallback) {
      sweptStartupDelivered = true;
      const expectedIds = new Set(expected.map((item) => item.id));
      for (const id of [...activeLocalApprovals.keys()]) {
        if (!expectedIds.has(id)) {
          activeLocalApprovals.delete(id);
          void cancelLocalApproval(id).catch(() => {});
        }
      }
      for (const item of expected) {
        const signature = JSON.stringify(item);
        if (activeLocalApprovals.get(item.id) !== signature) {
          activeLocalApprovals.set(item.id, signature);
          void syncLocalApproval(item).catch(() => {});
        }
      }
      return;
    }

    // Cancel local fallback approvals once resolved/cancelled online, or when Live Activity took over.
    const liveTookOver = available && syncOk;
    if (liveTookOver || (online && expected.length === 0)) {
      if (activeLocalApprovals.size > 0) {
        for (const id of [...activeLocalApprovals.keys()]) {
          activeLocalApprovals.delete(id);
          void cancelLocalApproval(id).catch(() => {});
        }
      } else if (!sweptStartupDelivered && !options.cancelLocalApproval) {
        // Clear any leftover delivered notifications from a previous app session once online/resolved.
        sweptStartupDelivered = true;
        void cancelLocalApproval("*").catch(() => {});
      }
    } else if (online) {
      const expectedIds = new Set(expected.map((item) => item.id));
      for (const id of [...activeLocalApprovals.keys()]) {
        if (!expectedIds.has(id)) {
          activeLocalApprovals.delete(id);
          void cancelLocalApproval(id).catch(() => {});
        }
      }
    }
  };

  const flush = (flushOptions?: { foregroundReturn?: boolean }) => {
    cancelPending();
    if (!latestReader) return;
    const current = latestReader();
    if (!current.enabled) return;
    lastSyncAt = Date.now();
    if (flushOptions?.foregroundReturn && needsForegroundRetry) {
      needsForegroundRetry = false;
      lastActivityKey = undefined;
      lastSyncPromise = undefined;
    }

    const merged = mergeLiveViewsIntoSessions(current.sessions, current.views, current.promptProgress);
    const shortcuts = buildIOSShortcutItems(merged, current.pinned);
    const shortcutKey = shortcutItemsFingerprint(shortcuts);
    if (shortcutKey !== lastShortcutKey) {
      lastShortcutKey = shortcutKey;
      void Promise.resolve(setShortcuts(shortcuts)).catch(() => {
        if (lastShortcutKey === shortcutKey) lastShortcutKey = undefined;
      });
    }

    const goals = Object.fromEntries(
      Object.entries(current.views ?? {}).flatMap(([id, view]) => (view.goal ? [[id, view.goal]] : [])),
    );
    const snapshot = buildLiveActivitySnapshot(
      current.computerName,
      merged,
      current.terminals,
      current.online,
      current.computerKey,
      goals,
    );
    const payload: LiveActivityPayload & { online?: boolean } = {
      ...snapshot,
      ...(snapshot.active ? liveActivityContent(snapshot) : {}),
      computerKey: current.computerKey,
      online: current.online,
    };
    const activityKey = liveActivityPayloadFingerprint(payload);
    let syncPromise: Promise<boolean>;
    if (activityKey !== lastActivityKey) {
      lastActivityKey = activityKey;
      const sentInBackground = AppState.currentState !== "active";
      const inFlight = Promise.resolve(syncActivity(payload)).then(
        (ok) => {
          const accepted = ok !== false;
          if (lastSyncPromise === inFlight) lastSyncSucceeded = accepted;
          // Activity.request cannot start while backgrounded (or if disabled in Settings): retry on foreground return.
          if (ok === false && payload.active && (sentInBackground || Boolean(syncLocalApproval))) {
            needsForegroundRetry = true;
          }
          return accepted;
        },
        () => {
          if (lastSyncPromise === inFlight) {
            lastSyncSucceeded = false;
            lastSyncPromise = undefined;
          }
          if (lastActivityKey === activityKey) lastActivityKey = undefined;
          return false;
        },
      );
      lastSyncPromise = inFlight;
      syncPromise = inFlight;
    } else {
      // Await the in-flight Live Activity request for this exact payload instead of reading an
      // unset/stale `lastSyncSucceeded`, preventing simultaneous Live Activity + local fallback delivery.
      syncPromise = lastSyncPromise ?? Promise.resolve(lastSyncSucceeded ?? false);
    }

    if (syncLocalApproval && cancelLocalApproval) {
      reconcileSeq += 1;
      const seq = reconcileSeq;
      const expectedApprovals = buildLocalApprovalNotifications(
        current.computerName,
        current.computerKey,
        merged,
        current.online,
      );
      void reconcileLocalApprovals(seq, expectedApprovals, current.online, payload.active, syncPromise);
    }
  };

  return {
    schedule(readLatest, scheduleOptions) {
      latestReader = readLatest;
      const current = readLatest();
      if (!current.enabled) {
        cancelPending();
        return;
      }
      if (scheduleOptions?.immediate || lastSyncAt === 0) {
        flush();
        return;
      }
      const elapsed = Date.now() - lastSyncAt;
      if (elapsed >= throttleMs) {
        flush();
        return;
      }
      if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          flush();
        }, Math.max(0, throttleMs - elapsed));
      }
    },
    flush,
    cancelPending,
    dispose() {
      cancelPending();
      latestReader = undefined;
    },
  };
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
  const latestRef = useRef<AttentionSyncInput>({
    computerName,
    sessions,
    terminals,
    online,
    views,
    promptProgress,
    computerKey,
    pinned,
    enabled,
  });
  latestRef.current = {
    computerName,
    sessions,
    terminals,
    online,
    views,
    promptProgress,
    computerKey,
    pinned,
    enabled,
  };
  const schedulerRef = useRef<AttentionSyncScheduler | null>(null);
  schedulerRef.current ??= createAttentionSyncScheduler();
  const prevTransitionRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const scheduler = schedulerRef.current!;
    if (!enabled) {
      prevTransitionRef.current = undefined;
      scheduler.cancelPending();
      return;
    }
    const transitionKey = sessionTransitionSignature(
      sessions,
      terminals,
      online,
      views,
      promptProgress,
      computerKey,
      computerName,
      pinned,
    );
    const immediate = prevTransitionRef.current !== transitionKey;
    prevTransitionRef.current = transitionKey;
    scheduler.schedule(() => latestRef.current, { immediate });
  }, [computerName, sessions, terminals, online, views, promptProgress, computerKey, pinned, enabled]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const scheduler = schedulerRef.current!;
    // Reconcile while the runtime is executing; identical payloads never cross the RN bridge.
    const heartbeat = setInterval(() => {
      if (latestRef.current.enabled && latestRef.current.online) {
        scheduler.flush();
      }
    }, 60_000);
    const sub = AppState.addEventListener("change", (nextState) => {
      if (!latestRef.current.enabled) return;
      if (nextState === "inactive" || nextState === "background" || nextState === "active") {
        scheduler.flush({ foregroundReturn: nextState === "active" });
      }
    });
    return () => {
      clearInterval(heartbeat);
      sub.remove();
      scheduler.dispose();
    };
  }, []);
}


