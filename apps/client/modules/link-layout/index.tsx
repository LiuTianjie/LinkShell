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

export interface LiveActivityPayload {
  active: boolean;
  computerName?: string;
  phase?: "waiting_for_approval" | "waiting_for_input" | "failed" | "running" | "starting" | "completed" | "stale";
  title?: string;
  subtitle?: string;
  project?: string;
  agent?: string;
  waitingCount?: number;
  runningCount?: number;
  failedCount?: number;
  deepLink?: string;
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
  addListener?: (eventName: string, listener: (event: any) => void) => { remove: () => void };
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

export function syncNativeLiveActivity(payload: LiveActivityPayload): Promise<boolean> {
  return nativeLayout?.syncLiveActivity?.(payload) ?? Promise.resolve(false);
}

export function endNativeLiveActivity(): Promise<void> {
  return nativeLayout?.endLiveActivity?.() ?? Promise.resolve();
}

export function LayoutProbe({ onMetrics, revision = "" }: { onMetrics: (metrics: LayoutMetrics) => void; revision?: string }) {
  return NativeProbe ? <NativeProbe revision={revision} pointerEvents="none" style={{ position: "absolute", inset: 0 }} onMetrics={(event) => onMetrics(event.nativeEvent)} /> : null;
}
