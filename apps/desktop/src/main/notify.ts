export interface NotificationRequest {
  id: string;
  title: string;
  body: string;
  computerKey: string;
  sessionId: string;
}

const TITLE_LIMIT = 120;
const BODY_LIMIT = 300;

function text(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  // Control characters would let a page break the notification's layout.
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** The page's `{ action: "notify" }` message, bounded; undefined when it can't be shown. */
export function parseNotification(message: Record<string, unknown>): NotificationRequest | undefined {
  const id = text(message.id, 200);
  const title = text(message.title, TITLE_LIMIT);
  const body = text(message.body, BODY_LIMIT);
  const computerKey = text(message.computerKey, 512);
  const sessionId = text(message.sessionId, 512);
  if (!id || !title || !computerKey || !sessionId) return undefined;
  return { id, title, body, computerKey, sessionId };
}

/**
 * A notification is for someone who isn't looking: never while the window is focused and on
 * screen, never when they turned notifications off, never where the system has none.
 */
export function shouldNotify(state: { supported: boolean; enabled: boolean; focused: boolean; visible: boolean }): boolean {
  return state.supported && state.enabled && !(state.focused && state.visible);
}

export function badgeCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(9999, Math.floor(value)));
}
