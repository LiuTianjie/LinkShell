/**
 * The desktop composer floats over the end of the conversation; the conversation leaves room
 * for it. This keeps `--composer-height` on the column equal to the composer's real height
 * (attachments, a growing draft, errors above it), measured before paint.
 */
export function composerHeightRef(wrap: HTMLElement | null): (() => void) | void {
  if (!wrap) return;
  const column = wrap.parentElement;
  if (!column) return;
  const observer = new ResizeObserver(([entry]) => {
    const height = entry?.borderBoxSize?.[0]?.blockSize ?? wrap.offsetHeight;
    column.style.setProperty("--composer-height", `${Math.round(height)}px`);
  });
  observer.observe(wrap);
  return () => {
    observer.disconnect();
    column.style.removeProperty("--composer-height");
  };
}
