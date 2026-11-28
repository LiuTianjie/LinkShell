import {
  liveActivityContent,
  watchCommandSchema,
  watchSnapshotContent,
  type LiveActivityAction,
  type LiveActivityPayload,
  type WatchCommand,
  type WatchSnapshot,
} from "@linkshell/wire";
import { requireNativeView, requireOptionalNativeModule } from "expo";
import { useEffect, useRef } from "react";
import { Platform, View, type LayoutChangeEvent, type NativeSyntheticEvent, type ViewProps } from "react-native";

export interface DivisionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  active: boolean;
}

export interface LayoutMetrics {
  revision?: string;
  width: number;
  height: number;
  insets: { top: number; right: number; bottom: number; left: number };
  divisions: DivisionRegion[];
  occlusions: DivisionRegion[];
}

interface Props extends ViewProps {
  revision: string;
  onMetrics: (event: NativeSyntheticEvent<LayoutMetrics>) => void;
}

export interface ShortcutItemInput {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  href: string;
}

export type { LiveActivityPayload, LiveActivityAction, WatchSnapshot, WatchCommand } from "@linkshell/wire";

export interface NativeLiveActivityRegistration { activityId: string; computerKey: string; token: string }

export interface AndroidNotificationActionInput {
  id: string;
  label: string;
  kind: "approve" | "deny" | "cancel" | "open";
  computerKey?: string;
  sessionId?: string;
  requestId?: string;
  optionId?: string;
  deepLink?: string;
}

export interface NativeNotificationAction {
  id: string;
  actionId: string;
  kind: "approve" | "deny" | "cancel" | "open";
  computerKey?: string;
  sessionId?: string;
  requestId?: string;
  optionId?: string;
  deepLink?: string;
  createdAt: number;
}

export interface LocalApprovalNotificationPayload {
  id: string;
  title: string;
  body: string;
  computerKey: string;
  sessionId: string;
  requestId: string;
  approveOptionId?: string;
  denyOptionId?: string;
  deepLink?: string;
}

export interface DiscoveredLanHost {
  name: string;
  host: string;
  port: number;
  machineId?: string;
  fingerprint?: string;
  displayName?: string;
}

export interface AndroidStatusNotificationPayload {
  active: boolean;
  title?: string;
  subtitle?: string;
  computerName?: string;
  deepLink?: string;
  urgent?: boolean;
  ongoing?: boolean;
  actions?: AndroidNotificationActionInput[];
  foregroundService?: boolean;
}

export interface NativeWatchStatus {
  supported: boolean;
  activated?: boolean;
  paired: boolean;
  installed: boolean;
  reachable: boolean;
  /** True when the Apple Watch is running in standalone independent mode (no companion streaming needed). */
  independent?: boolean;
}

export interface NativeNetworkPathEvent {
  status: "satisfied" | "unsatisfied" | "requiresConnection" | string;
  interface: "wifi" | "cellular" | "wired" | "other" | "none" | string;
  isExpensive?: boolean;
  isConstrained?: boolean;
}

interface NativeLayoutModuleType {
  requestLandscape?: () => Promise<void>;
  clearOrientationRequest?: () => Promise<void>;
  requestAndroidLayoutMetrics?: () => Promise<LayoutMetrics | null>;
  startSpeech?: (localeId?: string | null) => Promise<{ ok: boolean; reason?: string }>;
  stopSpeech?: () => Promise<{ text: string } | void>;
  cancelSpeech?: () => Promise<void>;
  speakText?: (text: string, localeId?: string | null) => Promise<void>;
  stopSpeaking?: () => Promise<void>;
  areNotificationsEnabled?: () => Promise<boolean>;
  ensureNotificationPermission?: () => Promise<boolean>;
  syncStatusNotification?: (payload: AndroidStatusNotificationPayload) => Promise<boolean>;
  cancelStatusNotification?: () => Promise<void>;
  pendingNotificationActionId?: () => Promise<string | null>;
  consumeNotificationAction?: (id: string) => Promise<NativeNotificationAction | null>;
  syncLocalApprovalNotification?: (payload: LocalApprovalNotificationPayload) => Promise<boolean>;
  cancelLocalApprovalNotification?: (id: string) => Promise<void>;
  startLanDiscovery?: () => Promise<boolean>;
  stopLanDiscovery?: () => Promise<void>;
  getLanHosts?: () => Promise<DiscoveredLanHost[]>;
  setShortcutItems?: (items: ShortcutItemInput[]) => Promise<void>;
  isLiveActivityAvailable?: () => Promise<boolean>;
  syncLiveActivity?: (payload: LiveActivityPayload) => Promise<boolean>;
  endLiveActivity?: () => Promise<void>;
  consumeLiveActivityAction?: (id: string) => Promise<LiveActivityAction | null>;
  pendingLiveActivityActionId?: () => Promise<string | null>;
  liveActivityPushURL?: string;
  getLiveActivityPushRegistration?: () => Promise<NativeLiveActivityRegistration | null>;
  getLiveActivityPushRegistrations?: () => Promise<NativeLiveActivityRegistration[]>;
  getLiveActivityPushToStartToken?: () => Promise<string | null>;
  setLiveActivityPushReady?: (id: string) => Promise<void>;
  getWatchStatus?: () => Promise<NativeWatchStatus>;
  syncWatchSnapshot?: (payload: WatchSnapshot) => Promise<boolean>;
  pendingWatchCommandId?: () => Promise<string | null>;
  consumeWatchCommand?: (id: string) => Promise<unknown>;
  completeWatchCommand?: (id: string, ok: boolean, message?: string) => Promise<void>;
  addListener?: <T = unknown>(eventName: string, listener: (event: T) => void) => { remove: () => void };
}

const nativeLayout = requireOptionalNativeModule<NativeLayoutModuleType>("LinkLayout");
const NativeProbe = Platform.OS === "ios" && nativeLayout ? requireNativeView<Props>("LinkLayout") : null;

/** Enter wide once; subsequent physical rotations remain available. */
export function requestLandscape(): Promise<void> {
  return nativeLayout?.requestLandscape?.() ?? Promise.resolve();
}

/** Restore the presentation from before fullscreen, without locking future rotations. */
export function clearOrientationRequest(): Promise<void> {
  return nativeLayout?.clearOrientationRequest?.() ?? Promise.resolve();
}

export function startNativeSpeech(localeId?: string): Promise<{ ok: boolean; reason?: string }> {
  if (!nativeLayout?.startSpeech) return Promise.resolve({ ok: false, reason: "当前平台暂不支持原生语音识别" });
  return nativeLayout.startSpeech(localeId ?? null);
}

export function stopNativeSpeech(): Promise<{ text: string } | void> {
  return nativeLayout?.stopSpeech?.() ?? Promise.resolve();
}

export function cancelNativeSpeech(): Promise<void> {
  return nativeLayout?.cancelSpeech?.() ?? Promise.resolve();
}

export function hasNativeSpeechSupport(): boolean {
  return typeof nativeLayout?.startSpeech === "function";
}

export function hasNativeTtsSupport(): boolean {
  return typeof nativeLayout?.speakText === "function";
}

export function speakNativeText(text: string, localeId?: string): Promise<void> {
  if (!text.trim()) return Promise.resolve();
  return nativeLayout?.speakText?.(text, localeId ?? null) ?? Promise.resolve();
}

export function stopNativeSpeaking(): Promise<void> {
  return nativeLayout?.stopSpeaking?.() ?? Promise.resolve();
}

export function areNativeNotificationsEnabled(): Promise<boolean> {
  if (Platform.OS !== "android") return Promise.resolve(true);
  return nativeLayout?.areNotificationsEnabled?.() ?? Promise.resolve(true);
}

export function ensureNativeNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return Promise.resolve(true);
  return nativeLayout?.ensureNotificationPermission?.() ?? Promise.resolve(true);
}

export function syncNativeAndroidStatusNotification(payload: AndroidStatusNotificationPayload): Promise<boolean> {
  if (Platform.OS !== "android") return Promise.resolve(false);
  return nativeLayout?.syncStatusNotification?.(payload) ?? Promise.resolve(false);
}

export function cancelNativeAndroidStatusNotification(): Promise<void> {
  if (Platform.OS !== "android") return Promise.resolve();
  return nativeLayout?.cancelStatusNotification?.() ?? Promise.resolve();
}

export function subscribeNativeNetworkPathChange(listener: (event: NativeNetworkPathEvent) => void): () => void {
  if (Platform.OS !== "android" || !nativeLayout?.addListener) return () => {};
  try {
    const sub = nativeLayout.addListener("onNetworkPathChange", listener);
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

export function pendingNativeNotificationActionId(): Promise<string | null> {
  return nativeLayout?.pendingNotificationActionId?.() ?? Promise.resolve(null);
}

export function consumeNativeNotificationAction(id: string): Promise<NativeNotificationAction | null> {
  return nativeLayout?.consumeNotificationAction?.(id) ?? Promise.resolve(null);
}

export function subscribeNativeNotificationActions(listener: (event: { id: string }) => void): () => void {
  if (!nativeLayout?.pendingNotificationActionId || !nativeLayout.addListener) return () => {};
  try {
    const sub = nativeLayout.addListener("onNotificationAction", listener);
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

export function syncNativeLocalApprovalNotification(payload: LocalApprovalNotificationPayload): Promise<boolean> {
  return nativeLayout?.syncLocalApprovalNotification?.(payload) ?? Promise.resolve(false);
}

export function cancelNativeLocalApprovalNotification(id: string): Promise<void> {
  return nativeLayout?.cancelLocalApprovalNotification?.(id) ?? Promise.resolve();
}

let lanDiscoveryDesired = false;

export function hasNativeLanDiscovery(): boolean {
  return typeof nativeLayout?.startLanDiscovery === "function";
}

export function startNativeLanDiscovery(): Promise<boolean> {
  lanDiscoveryDesired = true;
  return nativeLayout?.startLanDiscovery?.() ?? Promise.resolve(false);
}

export function stopNativeLanDiscovery(): Promise<void> {
  lanDiscoveryDesired = false;
  return nativeLayout?.stopLanDiscovery?.() ?? Promise.resolve();
}

/** Restarts active mDNS browsing cleanly after Wi-Fi / 5G network path transitions. */
export async function restartNativeLanDiscovery(): Promise<boolean> {
  if (!lanDiscoveryDesired || !nativeLayout?.startLanDiscovery) return false;
  try {
    await nativeLayout.stopLanDiscovery?.();
  } catch {
    // Continue restart even if stopping an already-failed browser threw.
  }
  if (!lanDiscoveryDesired) return false;
  return nativeLayout.startLanDiscovery().catch(() => false);
}

export function getNativeLanHosts(): Promise<DiscoveredLanHost[]> {
  return nativeLayout?.getLanHosts?.() ?? Promise.resolve([]);
}

export function subscribeNativeLanHosts(listener: (event: { hosts: DiscoveredLanHost[] }) => void): () => void {
  if (!nativeLayout?.startLanDiscovery || !nativeLayout.addListener) return () => {};
  try {
    const sub = nativeLayout.addListener("onLanHosts", listener);
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

export function subscribeNativeSpeech(handlers: {
  onResult?: (event: { text: string; isFinal: boolean }) => void;
  onLevel?: (event: { db: number; level: number }) => void;
  onError?: (event: { message: string }) => void;
}): () => void {
  if (!nativeLayout?.addListener || typeof nativeLayout?.startSpeech !== "function") return () => {};
  const subs: { remove: () => void }[] = [];
  try {
    if (handlers.onResult) subs.push(nativeLayout.addListener("onSpeechResult", handlers.onResult));
    if (handlers.onLevel) subs.push(nativeLayout.addListener("onSpeechLevel", handlers.onLevel));
    if (handlers.onError) subs.push(nativeLayout.addListener("onSpeechError", handlers.onError));
  } catch {
    // Older native binary without speech events.
  }
  return () => {
    for (const sub of subs) sub.remove();
  };
}

export function setNativeShortcutItems(items: ShortcutItemInput[]): Promise<void> {
  return nativeLayout?.setShortcutItems?.(items) ?? Promise.resolve();
}

export function isNativeLiveActivityAvailable(): Promise<boolean> {
  return nativeLayout?.isLiveActivityAvailable?.() ?? Promise.resolve(false);
}

let activityWork: Promise<unknown> = Promise.resolve();
function serializeActivityWork<T>(work: () => Promise<T>): Promise<T> {
  const result = activityWork.then(work);
  activityWork = result.catch(() => {});
  return result;
}

export function syncNativeLiveActivity(payload: LiveActivityPayload & { online?: boolean }): Promise<boolean> {
  const bounded = payload.active ? { ...payload, ...liveActivityContent(payload) } : payload;
  // ActivityKit methods suspend. Serialize creation/end across rapid snapshots
  // so a late update cannot recreate an activity after logout or computer switch.
  return serializeActivityWork(() => nativeLayout?.syncLiveActivity?.(bounded) ?? Promise.resolve(false));
}

export const liveActivityPushURL = nativeLayout?.liveActivityPushURL || "";
export function getNativeLiveActivityRegistration(): Promise<NativeLiveActivityRegistration | null> {
  return nativeLayout?.getLiveActivityPushRegistration?.() ?? Promise.resolve(null);
}
export async function getNativeLiveActivityRegistrations(): Promise<NativeLiveActivityRegistration[]> {
  if (nativeLayout?.getLiveActivityPushRegistrations) return nativeLayout.getLiveActivityPushRegistrations();
  const registration = await getNativeLiveActivityRegistration();
  return registration ? [registration] : [];
}
export function setNativeLiveActivityPushReady(id: string): Promise<void> {
  return nativeLayout?.setLiveActivityPushReady?.(id) ?? Promise.resolve();
}
export function subscribeNativeLiveActivityTokens(listener: (event: { activityId?: string; ended?: boolean }) => void): () => void {
  if (!nativeLayout?.getLiveActivityPushRegistration || !nativeLayout.addListener) return () => {};
  const sub = nativeLayout.addListener("onLiveActivityPushToken", listener);
  return () => sub.remove();
}

export function getNativeLiveActivityPushToStartToken(): Promise<string | null> {
  return nativeLayout?.getLiveActivityPushToStartToken?.() ?? Promise.resolve(null);
}

export function subscribeNativeLiveActivityPushToStartToken(listener: (event: { token?: string }) => void): () => void {
  if (!nativeLayout?.getLiveActivityPushToStartToken || !nativeLayout.addListener) return () => {};
  try {
    const sub = nativeLayout.addListener("onLiveActivityPushToStartToken", listener);
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

export function endNativeLiveActivity(): Promise<void> {
  return serializeActivityWork(() => nativeLayout?.endLiveActivity?.() ?? Promise.resolve());
}

export function consumeNativeLiveActivityAction(id: string): Promise<LiveActivityAction | null> {
  return nativeLayout?.consumeLiveActivityAction?.(id) ?? Promise.resolve(null);
}

export function pendingNativeLiveActivityActionId(): Promise<string | null> {
  return nativeLayout?.pendingLiveActivityActionId?.() ?? Promise.resolve(null);
}

export function subscribeNativeLiveActivityActions(listener: (event: { id: string }) => void): () => void {
  if (!nativeLayout?.pendingLiveActivityActionId || !nativeLayout.addListener) return () => {};
  const sub = nativeLayout.addListener("onLiveActivityAction", listener);
  return () => sub.remove();
}

const DEFAULT_WATCH_STATUS: NativeWatchStatus = {
  supported: false,
  paired: false,
  installed: false,
  reachable: false,
};

const SIM_WATCH_BRIDGE_URL =
  typeof __DEV__ !== "undefined" &&
  __DEV__ &&
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "undefined"
    ? "http://127.0.0.1:7879"
    : "";

export async function getNativeWatchStatus(): Promise<NativeWatchStatus> {
  if (nativeLayout?.getWatchStatus) {
    return nativeLayout.getWatchStatus();
  }
  if (SIM_WATCH_BRIDGE_URL) {
    try {
      const res = await fetch(`${SIM_WATCH_BRIDGE_URL}/status`);
      if (res.ok) return (await res.json()) as NativeWatchStatus;
    } catch {
      // Ignore when simulator bridge is not running
    }
  }
  return DEFAULT_WATCH_STATUS;
}

async function pushWatchSnapshot(bounded: WatchSnapshot): Promise<boolean> {
  const nativeOk = await (nativeLayout?.syncWatchSnapshot?.(bounded) ?? Promise.resolve(false));
  if (SIM_WATCH_BRIDGE_URL) {
    try {
      await fetch(`${SIM_WATCH_BRIDGE_URL}/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bounded),
      });
      return true;
    } catch {
      // Ignore when simulator bridge is not running
    }
  }
  return nativeOk;
}

// One transfer in flight; snapshots arriving meanwhile replace each other, since only the
// newest is worth sending. Every caller learns how the send that covered it went.
let watchNext: { snapshot: WatchSnapshot; waiters: ((ok: boolean) => void)[] } | null = null;
let watchDraining = false;

async function drainWatchSnapshots(): Promise<void> {
  watchDraining = true;
  try {
    while (watchNext) {
      const job = watchNext;
      watchNext = null;
      let ok = false;
      try {
        ok = await pushWatchSnapshot(job.snapshot);
      } catch {
        ok = false;
      }
      for (const resolve of job.waiters) resolve(ok);
    }
  } finally {
    watchDraining = false;
  }
}

export function syncNativeWatchSnapshot(snapshot: WatchSnapshot): Promise<boolean> {
  const bounded = watchSnapshotContent(snapshot);
  return new Promise((resolve) => {
    if (watchNext) {
      watchNext.snapshot = bounded;
      watchNext.waiters.push(resolve);
    } else {
      watchNext = { snapshot: bounded, waiters: [resolve] };
    }
    if (!watchDraining) void drainWatchSnapshots();
  });
}

export async function pendingNativeWatchCommandId(): Promise<string | null> {
  const nativeId = await (nativeLayout?.pendingWatchCommandId?.() ?? Promise.resolve(null));
  if (nativeId) return nativeId;
  if (SIM_WATCH_BRIDGE_URL) {
    try {
      const res = await fetch(`${SIM_WATCH_BRIDGE_URL}/commands/pending`);
      if (res.ok) {
        const data = (await res.json()) as { id?: string | null };
        return data.id ?? null;
      }
    } catch {
      // Ignore
    }
  }
  return null;
}

/** A command that arrived but isn't valid; its message is the reply the watch shows. */
export class WatchCommandRejected extends Error {}

/** Null when the command is gone or expired (the native queue has replied); throws WatchCommandRejected when invalid. */
export async function consumeNativeWatchCommand(id: string): Promise<WatchCommand | null> {
  let raw = await (nativeLayout?.consumeWatchCommand?.(id) ?? Promise.resolve(null));
  if (!raw && SIM_WATCH_BRIDGE_URL) {
    try {
      const res = await fetch(`${SIM_WATCH_BRIDGE_URL}/commands/consume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        const data = (await res.json()) as { command?: unknown };
        raw = data.command ?? null;
      }
    } catch {
      // Ignore
    }
  }
  if (!raw) return null;
  const parsed = watchCommandSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new WatchCommandRejected(
    parsed.error.issues.some((issue) => issue.code === "too_big")
      ? "内容过长，请缩短后重试"
      : "手表指令无法识别，请更新 iPhone 和手表上的 LinkShell",
  );
}

export async function completeNativeWatchCommand(id: string, ok: boolean, message?: string): Promise<void> {
  await (nativeLayout?.completeWatchCommand?.(id, ok, message) ?? Promise.resolve());
  if (SIM_WATCH_BRIDGE_URL) {
    try {
      await fetch(`${SIM_WATCH_BRIDGE_URL}/commands/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ok, message }),
      });
    } catch {
      // Ignore
    }
  }
}

export function subscribeNativeWatchCommands(listener: (event: { id: string }) => void): () => void {
  const cleanups: (() => void)[] = [];
  if (nativeLayout?.pendingWatchCommandId && nativeLayout.addListener) {
    try {
      const sub = nativeLayout.addListener("onWatchCommand", listener);
      cleanups.push(() => sub.remove());
    } catch {
      // Ignore
    }
  }
  if (SIM_WATCH_BRIDGE_URL) {
    const timer = setInterval(async () => {
      const id = await pendingNativeWatchCommandId();
      if (id) listener({ id });
    }, 800);
    cleanups.push(() => clearInterval(timer));
  }
  return () => {
    for (const fn of cleanups) fn();
  };
}

export function subscribeNativeWatchStatus(listener: (status: NativeWatchStatus) => void): () => void {
  if (!nativeLayout?.getWatchStatus || !nativeLayout.addListener) return () => {};
  try {
    const sub = nativeLayout.addListener("onWatchStatus", listener);
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

function adaptAndroidWindowMetrics(
  windowMetrics: LayoutMetrics,
  bounds: { x: number; y: number; width: number; height: number } | null,
  revision: string,
): LayoutMetrics {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return { ...windowMetrics, revision };
  }
  const winW = windowMetrics.width > 0 ? windowMetrics.width : bounds.width;
  const winH = windowMetrics.height > 0 ? windowMetrics.height : bounds.height;
  const { x, y, width, height } = bounds;
  const insets = {
    top: Math.max(0, windowMetrics.insets.top - Math.max(0, y)),
    left: Math.max(0, windowMetrics.insets.left - Math.max(0, x)),
    right: Math.max(0, windowMetrics.insets.right - Math.max(0, winW - (x + width))),
    bottom: Math.max(0, windowMetrics.insets.bottom - Math.max(0, winH - (y + height))),
  };
  const divisions: DivisionRegion[] = [];
  for (const region of windowMetrics.divisions ?? []) {
    const left = Math.max(0, region.x - x);
    const top = Math.max(0, region.y - y);
    const right = Math.min(width, region.x + region.width - x);
    const bottom = Math.min(height, region.y + region.height - y);
    if (right > left || bottom > top) {
      divisions.push({
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
        active: region.active,
      });
    }
  }
  return {
    revision,
    width,
    height,
    insets,
    divisions,
    occlusions: windowMetrics.occlusions ?? [],
  };
}

function AndroidLayoutProbe({ onMetrics, revision }: { onMetrics: (metrics: LayoutMetrics) => void; revision: string }) {
  const viewRef = useRef<View>(null);
  const onMetricsRef = useRef(onMetrics);
  onMetricsRef.current = onMetrics;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const lastWindowMetricsRef = useRef<LayoutMetrics | null>(null);
  const lastLayoutRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const emitAdapted = (windowMetrics: LayoutMetrics | null) => {
    if (!windowMetrics) return;
    lastWindowMetricsRef.current = windowMetrics;
    const node = viewRef.current;
    if (node && typeof node.measureInWindow === "function") {
      node.measureInWindow((wx, wy, width, height) => {
        if (width > 0 && height > 0) {
          lastLayoutRef.current = { x: wx, y: wy, width, height };
        }
        onMetricsRef.current(adaptAndroidWindowMetrics(windowMetrics, lastLayoutRef.current, revisionRef.current));
      });
      return;
    }
    onMetricsRef.current(adaptAndroidWindowMetrics(windowMetrics, lastLayoutRef.current, revisionRef.current));
  };

  useEffect(() => {
    if (!nativeLayout?.addListener) return;
    let disposed = false;
    let sub: { remove: () => void } | undefined;
    try {
      sub = nativeLayout.addListener("onAndroidLayoutMetrics", (metrics: LayoutMetrics) => {
        if (!disposed) emitAdapted(metrics);
      });
    } catch {
      // Older Android binary without WindowInfoTracker events.
    }
    void nativeLayout.requestAndroidLayoutMetrics?.()
      .then((metrics) => {
        if (!disposed && metrics) emitAdapted(metrics);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      sub?.remove();
    };
  }, []);

  useEffect(() => {
    if (lastWindowMetricsRef.current) {
      emitAdapted(lastWindowMetricsRef.current);
    } else {
      void nativeLayout?.requestAndroidLayoutMetrics?.()
        .then((metrics) => {
          if (metrics) emitAdapted(metrics);
        })
        .catch(() => {});
    }
  }, [revision]);

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    lastLayoutRef.current = {
      x: lastLayoutRef.current?.x ?? 0,
      y: lastLayoutRef.current?.y ?? 0,
      width,
      height,
    };
    if (lastWindowMetricsRef.current) {
      emitAdapted(lastWindowMetricsRef.current);
    }
  };

  return (
    <View
      ref={viewRef}
      collapsable={false}
      pointerEvents="none"
      style={{ position: "absolute", inset: 0 }}
      onLayout={handleLayout}
    />
  );
}

export function LayoutProbe({ onMetrics, revision = "" }: { onMetrics: (metrics: LayoutMetrics) => void; revision?: string }) {
  if (NativeProbe) {
    return (
      <NativeProbe
        revision={revision}
        pointerEvents="none"
        style={{ position: "absolute", inset: 0 }}
        onMetrics={(event) => onMetrics(event.nativeEvent)}
      />
    );
  }
  if (Platform.OS === "android" && nativeLayout) {
    return <AndroidLayoutProbe onMetrics={onMetrics} revision={revision} />;
  }
  return null;
}
