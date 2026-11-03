/** What the remote picture should be now. `paused`: the screen page is not the one shown. */
export interface ScreenTarget { display: number; width: string; maxFps: string; paused: boolean }

/** Transient failures are retried quietly this many times before the user sees them. */
export const AUTO_RETRIES = 2;
/** A session that has shown a picture this long has earned its retries back. */
export const RETRIES_EARNED_MS = 10_000;
/** How long a pause may go unacknowledged before the hidden session is released (as on the phone). */
export const PAUSE_ACK_MS = 2_000;
/** Older hosts never say what they support: after this the session is one that can't reconfigure. */
export const CAPABILITIES_WAIT_MS = 10_000;

/**
 * The rate the stream is asked for: the user's ceiling, and no more than this Mac's display shows,
 * as the phone holds its own request to its screen. Frames beyond it would be encoded and sent only
 * to be dropped here, with bits taken from every frame that is shown. The host knows 30/60/120.
 */
export function screenRate(preferred: string, displayFps: number | undefined): string {
  const shown = displayFps === undefined || !Number.isFinite(displayFps) ? 120 : displayFps >= 120 ? 120 : displayFps >= 60 ? 60 : 30;
  const wanted = [30, 60, 120].includes(Number(preferred)) ? Number(preferred) : 60;
  return String(Math.min(wanted, shown));
}

/** What a failed native session leads to. */
export type FailureAction = "dormant" | "retry" | "fallback" | "show";

/**
 * - A hidden session that ends is let go, and made again when its page is back.
 * - What can't work on this Mac (no hardware decoder, no native component, no permission) is shown.
 * - Anything else is retried quietly, a couple of times.
 * - Then a network that won't carry the native video falls back to the page's receiver (when there
 *   is one), which can also use the encrypted relay; any other failure is shown, with a retry.
 */
export function nativeSessionPolicy(message: string, state: { paused: boolean; retries: number; canFallBack: boolean }): FailureAction {
  if (state.paused) return "dormant";
  if (/不支持|不可用|权限|更新 LinkShell/.test(message)) return "show";
  if (state.retries < AUTO_RETRIES) return "retry";
  if (state.canFallBack && /直连|超时|网络|无法建立|中断|断开/.test(message)) return "fallback";
  return "show";
}

/** Whether a new target needs a configuration sent (anything but a change that is already applied). */
export function targetChanged(applied: ScreenTarget, next: ScreenTarget): { picture: boolean; any: boolean } {
  const picture = applied.display !== next.display || applied.width !== next.width || applied.maxFps !== next.maxFps;
  return { picture, any: picture || applied.paused !== next.paused };
}
