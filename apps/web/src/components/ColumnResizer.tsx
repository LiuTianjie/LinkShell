import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

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
  column,
  variable,
  resize,
  initial,
  className,
  collapse,
}: {
  label: string;
  width: number;
  clamp: (width: number) => number;
  /** The column's edge this is: at its start, dragging toward the start widens it. */
  side: "start" | "end";
  /** A selector for the ancestor that carries the width. */
  target: string;
  /** A column constrained by CSS may be narrower than its saved preference. */
  column?: string;
  variable: string;
  resize: (width: number) => void;
  initial: number;
  className?: string;
  /** An optional inward drag can tuck away navigation while preserving its expanded width. */
  collapse?: { threshold: number; onCollapse: () => void };
}) {
  const widen = side === "start" ? -1 : 1;
  const cancelDrag = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancelDrag.current?.(), []);
  const renderedWidth = (handle: HTMLElement) => {
    const measured = column && handle.closest(target)?.querySelector<HTMLElement>(column)?.getBoundingClientRect().width;
    return measured || width;
  };
  return (
    <div
      className={cn("column-resizer", className)}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={typeof window === "undefined" ? width : clamp(width)}
      aria-valuemin={typeof window === "undefined" ? undefined : clamp(-Infinity)}
      aria-valuemax={typeof window === "undefined" ? undefined : clamp(Infinity)}
      title="拖动调整宽度，双击恢复默认"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          resize(clamp(event.key === "Home" ? -Infinity : Infinity));
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const change = (event.key === "ArrowRight" ? 24 : -24) * widen;
        const current = renderedWidth(event.currentTarget);
        if (collapse && change < 0 && current <= clamp(-Infinity)) collapse.onCollapse();
        else resize(clamp(current + change));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        cancelDrag.current?.();
        const startX = event.clientX;
        const handle = event.currentTarget;
        const startWidth = renderedWidth(handle);
        handle.setPointerCapture(event.pointerId);
        handle.dataset.dragging = "true";
        document.documentElement.dataset.resizing = "true";
        const layout = handle.closest<HTMLElement>(target);
        let latest = startWidth;
        let collapsed = false;
        let frame = 0;
        const move = (next: PointerEvent) => {
          const requested = startWidth + (next.clientX - startX) * widen;
          collapsed = !!collapse && requested <= collapse.threshold;
          latest = collapsed ? 0 : collapse ? Math.min(requested, clamp(requested)) : clamp(requested);
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            layout?.style.setProperty(variable, `${latest}px`);
          });
        };
        const finish = (commit: boolean) => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", cancel);
          handle.removeEventListener("lostpointercapture", cancel);
          window.removeEventListener("blur", cancel);
          window.removeEventListener("keydown", key, true);
          cancelAnimationFrame(frame);
          delete handle.dataset.dragging;
          delete document.documentElement.dataset.resizing;
          cancelDrag.current = undefined;
          if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
          // Flush the last pointer position even when pointerup arrives before the next frame.
          layout?.style.setProperty(variable, `${commit && !collapsed ? clamp(latest) : width}px`);
          if (commit) {
            if (collapsed) collapse?.onCollapse();
            else resize(clamp(latest));
          }
        };
        const end = () => finish(true);
        const cancel = () => finish(false);
        const key = (next: KeyboardEvent) => {
          if (next.key !== "Escape") return;
          next.preventDefault();
          next.stopPropagation();
          cancel();
        };
        cancelDrag.current = cancel;
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", cancel);
        handle.addEventListener("lostpointercapture", cancel);
        window.addEventListener("blur", cancel);
        window.addEventListener("keydown", key, true);
      }}
      onDoubleClick={() => resize(clamp(initial))}
    />
  );
}
