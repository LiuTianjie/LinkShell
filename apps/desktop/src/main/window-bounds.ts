export interface Rect { x: number; y: number; width: number; height: number }

export interface RestoredBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** How much of the title row must land on a display for the window to be grabbable there. */
const GRAB_WIDTH = 120;
const GRAB_HEIGHT = 32;

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

/**
 * The saved window frame, made safe for the displays attached now: a monitor that was
 * unplugged must not leave the window off screen (reachable only from the tray), and a size
 * saved on a larger display is shrunk to fit the one it opens on. Without a usable position
 * the window is centered by the system.
 */
export function restoreWindowBounds(
  saved: unknown,
  workAreas: Rect[],
  minimum: { width: number; height: number },
  fallback: { width: number; height: number },
): RestoredBounds {
  const state = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
  const maximized = state.maximized === true;
  let width = finite(state.width) ? Math.round(state.width) : fallback.width;
  let height = finite(state.height) ? Math.round(state.height) : fallback.height;
  width = Math.max(minimum.width, width);
  height = Math.max(minimum.height, height);

  const largest = workAreas.reduce<Rect | undefined>((best, area) => (!best || area.width * area.height > best.width * best.height ? area : best), undefined);
  if (!finite(state.x) || !finite(state.y) || workAreas.length === 0) {
    if (largest) { width = Math.min(width, Math.max(minimum.width, largest.width)); height = Math.min(height, Math.max(minimum.height, largest.height)); }
    return { width, height, maximized };
  }

  const x = Math.round(state.x);
  const y = Math.round(state.y);
  const titleRow: Rect = { x, y, width, height: GRAB_HEIGHT };
  const home = workAreas.find((area) => {
    const visible = overlap(titleRow, area);
    return visible.width >= Math.min(GRAB_WIDTH, width) && visible.height >= Math.min(GRAB_HEIGHT, area.height);
  });
  if (!home) {
    if (largest) { width = Math.min(width, Math.max(minimum.width, largest.width)); height = Math.min(height, Math.max(minimum.height, largest.height)); }
    return { width, height, maximized };
  }
  width = Math.min(width, Math.max(minimum.width, home.width));
  height = Math.min(height, Math.max(minimum.height, home.height));
  // Keep the whole frame on that display where it fits, so a shrunk window doesn't hang off its edge.
  const clampedX = Math.min(Math.max(x, home.x), home.x + Math.max(0, home.width - width));
  const clampedY = Math.min(Math.max(y, home.y), home.y + Math.max(0, home.height - height));
  return { x: clampedX, y: clampedY, width, height, maximized };
}
