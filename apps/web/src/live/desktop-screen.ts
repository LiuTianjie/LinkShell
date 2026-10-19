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

export function nativeScreenQuery(token: string, display: number, width: string, maxFps: string): string {
  // H.264 is supported by all supported Macs; the native decoder still requires and verifies hardware.
  return "/stream?" + new URLSearchParams({ token, display: String(display), width, maxFps, video: "1" });
}
