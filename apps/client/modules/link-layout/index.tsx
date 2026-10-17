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
import { Platform, type NativeSyntheticEvent, type ViewProps } from "react-native";

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

export interface NativeWatchStatus {
  supported: boolean;
  activated?: boolean;
  paired: boolean;
  installed: boolean;
  reachable: boolean;
}

interface NativeLayoutModuleType {
  requestLandscape?: () => Promise<void>;
  clearOrientationRequest?: () => Promise<void>;
  startSpeech?: (localeId?: string | null) => Promise<{ ok: boolean; reason?: string }>;
  stopSpeech?: () => Promise<void>;
  cancelSpeech?: () => Promise<void>;
  setShortcutItems?: (items: ShortcutItemInput[]) => Promise<void>;
  isLiveActivityAvailable?: () => Promise<boolean>;
  syncLiveActivity?: (payload: LiveActivityPayload) => Promise<boolean>;
  endLiveActivity?: () => Promise<void>;
  consumeLiveActivityAction?: (id: string) => Promise<LiveActivityAction | null>;
  pendingLiveActivityActionId?: () => Promise<string | null>;
  liveActivityPushURL?: string;
  getLiveActivityPushRegistration?: () => Promise<NativeLiveActivityRegistration | null>;
  getLiveActivityPushRegistrations?: () => Promise<NativeLiveActivityRegistration[]>;
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

export function stopNativeSpeech(): Promise<void> {
  return nativeLayout?.stopSpeech?.() ?? Promise.resolve();
}

export function cancelNativeSpeech(): Promise<void> {
  return nativeLayout?.cancelSpeech?.() ?? Promise.resolve();
}

export function hasNativeSpeechSupport(): boolean {
  return typeof nativeLayout?.startSpeech === "function";
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

export function syncNativeLiveActivity(payload: LiveActivityPayload): Promise<boolean> {
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

let watchWork: Promise<unknown> = Promise.resolve();
function serializeWatchWork<T>(work: () => Promise<T>): Promise<T> {
  const result = watchWork.then(work);
  watchWork = result.catch(() => {});
  return result;
}

export function syncNativeWatchSnapshot(snapshot: WatchSnapshot): Promise<boolean> {
  const bounded = watchSnapshotContent(snapshot);
  return serializeWatchWork(async () => {
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
  return parsed.success ? parsed.data : null;
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

export function LayoutProbe({ onMetrics, revision = "" }: { onMetrics: (metrics: LayoutMetrics) => void; revision?: string }) {
  return NativeProbe ? <NativeProbe revision={revision} pointerEvents="none" style={{ position: "absolute", inset: 0 }} onMetrics={(event) => onMetrics(event.nativeEvent)} /> : null;
}
