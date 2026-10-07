import type { DivisionRegion } from "../../modules/link-layout";

/** Keep controls in one usable region when the device is partially folded. */
export function workspaceLayout(width: number, fontScale = 1, divisions: DivisionRegion[] = [], height = 0) {
  const fold = divisions.find((region) => region.active);
  if (fold) {
    const vertical = fold.height > fold.width;
    const before = vertical ? fold.x : fold.y;
    const gap = vertical ? fold.width : fold.height;
    const after = (vertical ? width : height) - before - gap;
    const minimum = vertical ? Math.max(280, 240 * fontScale) : 190;
    if (before >= minimum && after >= minimum) {
      return { split: true, folded: true, gap, paneWidth: vertical ? before : width, axis: vertical ? "row" as const : "column" as const, before, after };
    }
  }
  const gap = 24;
  const minimum = Math.max(340, 300 * fontScale);
  const split = width >= minimum * 2 + gap;
  const paneWidth = split ? (width - gap) / 2 : width;
  return { split, folded: false, gap: split ? gap : 0, paneWidth, axis: "row" as const, before: paneWidth, after: paneWidth };
}
