import type { LayoutMetrics } from "../../modules/link-layout";

export interface ContentInsets { top: number; right: number; bottom: number; left: number }

export interface LayoutFrame { width: number; height: number }

/** A former orientation's regions must never be applied to the current frame. */
export function matchingLayoutMetrics(metrics: LayoutMetrics | null, frame: LayoutFrame, revision?: string): LayoutMetrics | null {
  if (!metrics || frame.width <= 0 || frame.height <= 0) return null;
  if (Math.abs(metrics.width - frame.width) >= 1 || Math.abs(metrics.height - frame.height) >= 1) return null;
  if (revision !== undefined && metrics.revision !== revision) return null;
  return metrics;
}

/** Inset from the closest edge so a camera or vertical system bar never covers controls. */
export function safeContentInsets(metrics: LayoutMetrics | null, fallback: ContentInsets): ContentInsets {
  if (!metrics) return fallback;
  const result = { ...metrics.insets };
  for (const region of metrics.occlusions ?? []) {
    if (!region.active || region.width <= 0 || region.height <= 0) continue;
    const left = Math.max(0, region.x);
    const top = Math.max(0, region.y);
    const right = Math.min(metrics.width, region.x + region.width);
    const bottom = Math.min(metrics.height, region.y + region.height);
    if (right <= left || bottom <= top) continue;
    const candidates: [keyof ContentInsets, number][] = [["left", right], ["right", metrics.width - left], ["top", bottom], ["bottom", metrics.height - top]];
    const [edge, inset] = candidates.sort((a, b) => a[1] - b[1])[0]!;
    result[edge] = Math.max(result[edge], inset);
  }
  return result;
}
