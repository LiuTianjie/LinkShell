export const NATIVE_SCREEN_EVENT = "linkshell-native-screen";
export interface ScreenRect { x: number; y: number; width: number; height: number }
export interface NativeScreenStatus { live?: boolean; hardware?: boolean; codec?: string; decoder?: string; control?: boolean; controlRequested?: boolean; controlError?: string }
export interface NativeScreenEvent {
  id: string;
  type: "signal" | "status" | "error";
  message?: Record<string, unknown>;
  status?: NativeScreenStatus;
  error?: string;
}
export function postNativeScreen(id: string, type: string, payload: Record<string, unknown> = {}): boolean {
  const handler = (window as Window & {
    webkit?: { messageHandlers?: { linkshellDesktop?: { postMessage(value: unknown): void } } };
  }).webkit?.messageHandlers?.linkshellDesktop;
  if (!handler) return false;
  handler.postMessage({ action: "screen", id, type, ...payload });
  return true;
}

/** Native receives bounded signalling only. Encoded video never enters this bridge. */
export function screenSignal(data: string | ArrayBuffer): Record<string, unknown> {
  if (typeof data !== "string") throw new Error("此电脑未能建立原生视频直连，请重试或检查网络");
  if (data.length > 262_144) throw new Error("屏幕协商信息过大");
  const parsed: unknown = JSON.parse(data);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("屏幕协商信息无效");
  const message = parsed as Record<string, unknown>;
  if (typeof message.error === "string") throw new Error(message.error.slice(0, 2048));
  const state = message.session as { t?: string; message?: string } | undefined;
  if (state?.t === "error") throw new Error(typeof state.message === "string" ? state.message.slice(0, 2048) : "屏幕设置未能应用，请重新连接");
  return message;
}

export function nativeScreenQuery(token: string, display: number, width: string, maxFps: string, hevc = false): string {
  // HEVC is offered first and H.264 after, as the phone does; the native decoder accepts either in hardware.
  const query = new URLSearchParams({ token, display: String(display), width, maxFps, video: "1" });
  if (hevc) query.set("codec", "hevc");
  return "/stream?" + query;
}

/** A screen's part in the window's full screen: whether it asked for it, and whether it shows only the picture. */
export interface ScreenFullscreen { owns: boolean; fullscreen: boolean }

/**
 * The screen stops wanting full screen (its button, Esc, hidden, left the page). It shows its
 * toolbar again at once: the window's answer can come later, or not at all.
 */
export function leaveScreenFullscreen(state: ScreenFullscreen): ScreenFullscreen | undefined {
  return state.owns ? { owns: false, fullscreen: false } : undefined;
}

/**
 * The window says whether it is full screen. Entering only concerns the screen that asked;
 * leaving (green button, ⌃⌘F, Esc) gives any screen still showing only the picture its toolbar back,
 * even one that already stopped owning the full screen. `focused` is what the page should then fill.
 */
export function windowFullscreenChanged(state: ScreenFullscreen, fullscreen: boolean): (ScreenFullscreen & { focused: boolean }) | undefined {
  if (fullscreen) return state.owns ? { owns: true, fullscreen: true, focused: true } : undefined;
  return state.owns || state.fullscreen ? { owns: false, fullscreen: false, focused: false } : undefined;
}
