/** Only reserve a navigation bar when the parent has not already placed the chat beneath it. */
export function computerUseTopInset(platform: string, headerHeight: number, scrollInset: number | null, headerConsumed = false): number {
  if (headerConsumed) return 0;
  return Math.max(scrollInset ?? 0, platform === "ios" ? headerHeight : 0);
}
