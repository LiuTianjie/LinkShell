import { liveActivityContent, type LiveActivityPayload, type LiveActivityAction } from "@linkshell/wire";
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

export type { LiveActivityPayload, LiveActivityAction } from "@linkshell/wire";

export interface NativeLiveActivityRegistration { activityId: string; computerKey: string; token: string }

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

export function LayoutProbe({ onMetrics, revision = "" }: { onMetrics: (metrics: LayoutMetrics) => void; revision?: string }) {
  return NativeProbe ? <NativeProbe revision={revision} pointerEvents="none" style={{ position: "absolute", inset: 0 }} onMetrics={(event) => onMetrics(event.nativeEvent)} /> : null;
}
