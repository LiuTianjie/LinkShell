/**
 * A column's draggable edge (the inspector's, the file list's): drag it or use the arrow keys,
 * double-click for the column's usual width.
 *
 * While dragging, the width goes straight onto `target` as `variable`, once a frame: rendering the
 * page again for every pointer move is what made a drag trail the pointer. The width is handed to
 * `resize` (to keep and save) once, when the drag ends.
 */
export function ColumnResizer({
  label,
  width,
  clamp,
  side,
  target,
  variable,
  resize,
  initial,
  className,
}: {
  label: string;
  width: number;
  clamp: (width: number) => number;
  /** The column's edge this is: at its start, dragging toward the start widens it. */
  side: "start" | "end";
  /** A selector for the ancestor that carries the width. */
  target: string;
  variable: string;
  resize: (width: number) => void;
  initial: number;
  className?: string;
}) {
  const widen = side === "start" ? -1 : 1;
  return (
    <div
      className={className ? `column-resizer ${className}` : "column-resizer"}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        resize(clamp(width + (event.key === "ArrowRight" ? 24 : -24) * widen));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        document.documentElement.dataset.resizing = "true";
        const layout = handle.closest<HTMLElement>(target);
        let latest = width;
        let frame = 0;
        const move = (next: PointerEvent) => {
          latest = clamp(width + (next.clientX - startX) * widen);
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            layout?.style.setProperty(variable, `${latest}px`);
          });
        };
        const end = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          cancelAnimationFrame(frame);
          delete document.documentElement.dataset.resizing;
          resize(latest);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      }}
      onDoubleClick={() => resize(initial)}
    />
  );
}
