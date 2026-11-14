import { useEffect, useRef } from "react";
import { cn } from "./utils";
import { usePrimitiveLabels } from "./labels";

export interface SplitResizerProps {
  label: string;
  /** Current size in px. */
  size: number;
  min: number;
  max: number;
  defaultSize: number;
  /**
   * `"vertical"` separates left/right columns (`col-resize`);
   * `"horizontal"` separates top/bottom panes such as the docked terminal (`row-resize`).
   */
  orientation?: "vertical" | "horizontal";
  /**
   * `"end"` means dragging right/down grows the pane (e.g. Left Sidebar);
   * `"start"` means dragging left/up grows the pane (e.g. Right Inspector or Bottom Terminal).
   */
  side?: "start" | "end";
  /** Optional CSS variable updated once per animation frame on the nearest `targetSelector` ancestor. */
  cssVariable?: `--${string}`;
  targetSelector?: string;
  paneSelector?: string;
  collapse?: {
    threshold: number;
    onCollapse: () => void;
  };
  onResize: (nextSize: number) => void;
  className?: string;
}

export function SplitResizer({
  label,
  size,
  min,
  max,
  defaultSize,
  orientation = "vertical",
  side = "end",
  cssVariable,
  targetSelector,
  paneSelector,
  collapse,
  onResize,
  className,
}: SplitResizerProps) {
  const labels = usePrimitiveLabels();
  const directionMultiplier = side === "start" ? -1 : 1;
  const cancelDragRef = useRef<(() => void) | null>(null);
  const clamp = (value: number): number =>
    Math.min(max, Math.max(min, Math.round(value)));

  const livePropsRef = useRef({
    min,
    max,
    clamp,
    collapse,
    onResize,
  });
  livePropsRef.current = {
    min,
    max,
    clamp,
    collapse,
    onResize,
  };

  useEffect(() => {
    return () => {
      cancelDragRef.current?.();
    };
  }, []);

  const resolveTargetElement = (handle: HTMLElement): HTMLElement | null => {
    if (targetSelector) {
      return (
        handle.closest<HTMLElement>(targetSelector) ??
        document.querySelector<HTMLElement>(targetSelector)
      );
    }
    return handle.parentElement;
  };

  const measureCurrent = (handle: HTMLElement): number => {
    const targetEl = resolveTargetElement(handle);
    if (cssVariable && targetEl) {
      const rawVar = targetEl.style.getPropertyValue(cssVariable).trim();
      const parsed = Number.parseFloat(rawVar);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    if (paneSelector) {
      const scope = targetSelector
        ? handle.closest<HTMLElement>(targetSelector)
        : handle.parentElement;
      const pane = scope?.matches(paneSelector)
        ? scope
        : (scope?.querySelector<HTMLElement>(paneSelector) ??
          document.querySelector<HTMLElement>(paneSelector));
      if (pane) {
        const rect = pane.getBoundingClientRect();
        const measured = orientation === "vertical" ? rect.width : rect.height;
        if (measured > 0) return measured;
      }
    }
    return size;
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={clamp(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={labels.resizeHint}
      data-orientation={orientation}
      className={cn("ls-split-resizer", className)}
      onDoubleClick={() => {
        const next = clamp(defaultSize);
        const targetEl = targetSelector
          ? document.querySelector<HTMLElement>(targetSelector)
          : null;
        if (cssVariable && targetEl) {
          targetEl.style.setProperty(cssVariable, `${next}px`);
        }
        onResize(next);
      }}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "Home") {
          event.preventDefault();
          onResize(min);
          return;
        }
        if (event.key === "End") {
          event.preventDefault();
          onResize(max);
          return;
        }

        const decKey = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
        const incKey = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
        if (event.key !== decKey && event.key !== incKey) return;

        event.preventDefault();
        const step = (event.key === incKey ? 24 : -24) * directionMultiplier;
        const current = measureCurrent(event.currentTarget);
        if (collapse && step < 0 && current <= min) {
          collapse.onCollapse();
          return;
        }
        const next = clamp(current + step);
        const targetEl = resolveTargetElement(event.currentTarget);
        if (cssVariable && targetEl) {
          targetEl.style.setProperty(cssVariable, `${next}px`);
        }
        onResize(next);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        cancelDragRef.current?.();

        const handle = event.currentTarget;
        const startCoord =
          orientation === "vertical" ? event.clientX : event.clientY;
        const startSize = clamp(measureCurrent(handle));
        const targetEl = resolveTargetElement(handle);

        if (typeof handle.setPointerCapture === "function") {
          try {
            handle.setPointerCapture(event.pointerId);
          } catch {
            // Ignore in synthetic pointer tests.
          }
        }

        handle.dataset.dragging = "true";
        document.documentElement.dataset.resizing = orientation;
        if (targetEl) {
          targetEl.dataset.resizing = "true";
        }

        let latest = startSize;
        let isCollapsed = false;
        let rafId = 0;
        let hasPendingRaf = false;
        let finished = false;
        let lastMoveEvent: Event | null = null;

        const applyFrame = (px: number) => {
          if (cssVariable && targetEl) {
            targetEl.style.setProperty(cssVariable, `${px}px`);
          }
        };

        const onPointerMove = (moveEvent: PointerEvent) => {
          if (finished || moveEvent === lastMoveEvent) return;
          lastMoveEvent = moveEvent;

          const {
            min: liveMin,
            clamp: liveClamp,
            collapse: liveCollapse,
          } = livePropsRef.current;

          const coord =
            orientation === "vertical" ? moveEvent.clientX : moveEvent.clientY;
          const requested =
            startSize + (coord - startCoord) * directionMultiplier;
          isCollapsed = Boolean(
            liveCollapse && requested <= liveCollapse.threshold,
          );
          const previewSize = isCollapsed ? liveMin : liveClamp(requested);
          latest = previewSize;
          handle.dataset.collapseArmed = isCollapsed ? "true" : "false";

          // Update CSS custom property synchronously at 0ms input latency.
          applyFrame(previewSize);

          // Leading-edge + rAF trailing-edge live pane resize:
          // Frame start commits immediately so both CSS-var and React-state panes move pixel-by-pixel;
          // high-frequency (>120Hz) pointer bursts within the same frame coalesce cleanly.
          if (typeof requestAnimationFrame !== "function") {
            livePropsRef.current.onResize(previewSize);
          } else if (rafId === 0) {
            livePropsRef.current.onResize(previewSize);
            hasPendingRaf = false;
            rafId = requestAnimationFrame(() => {
              rafId = 0;
              if (!finished && hasPendingRaf) {
                hasPendingRaf = false;
                applyFrame(latest);
                livePropsRef.current.onResize(latest);
              }
            });
          } else {
            hasPendingRaf = true;
          }
        };

        const finish = (commit: boolean) => {
          if (finished) return;
          finished = true;
          handle.removeEventListener("pointermove", onPointerMove);
          handle.removeEventListener("pointerup", onPointerUp);
          handle.removeEventListener("pointercancel", onCancel);
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
          window.removeEventListener("pointercancel", onCancel);
          window.removeEventListener("blur", onCancel);
          window.removeEventListener("keydown", onEscapeKey, true);
          if (rafId !== 0 && typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(rafId);
            rafId = 0;
          }
          hasPendingRaf = false;
          cancelDragRef.current = null;

          if (
            typeof handle.hasPointerCapture === "function" &&
            handle.hasPointerCapture(event.pointerId)
          ) {
            try {
              handle.releasePointerCapture(event.pointerId);
            } catch {
              // Ignore synthetic release failure.
            }
          }

          const {
            clamp: liveClamp,
            collapse: liveCollapse,
            onResize: liveOnResize,
          } = livePropsRef.current;

          // Commit or revert size BEFORE removing `[data-resizing]` so CSS grid/panel
          // transitions stay suppressed while snapping back (`Escape` / collapse / release).
          if (commit) {
            if (isCollapsed && liveCollapse) {
              applyFrame(startSize);
              liveOnResize(startSize);
              liveCollapse.onCollapse();
            } else {
              const finalSize = liveClamp(latest);
              applyFrame(finalSize);
              liveOnResize(finalSize);
            }
          } else {
            applyFrame(startSize);
            liveOnResize(startSize);
          }

          // Force synchronous style & layout flush before re-enabling transitions.
          void targetEl?.offsetWidth;
          void document.documentElement.offsetWidth;

          delete handle.dataset.dragging;
          delete handle.dataset.collapseArmed;
          delete document.documentElement.dataset.resizing;
          if (targetEl) {
            delete targetEl.dataset.resizing;
          }
        };

        const onPointerUp = () => finish(true);
        const onCancel = () => finish(false);
        const onEscapeKey = (keyEvent: KeyboardEvent) => {
          if (keyEvent.key !== "Escape") return;
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          onCancel();
        };

        cancelDragRef.current = onCancel;
        handle.addEventListener("pointermove", onPointerMove);
        handle.addEventListener("pointerup", onPointerUp);
        handle.addEventListener("pointercancel", onCancel);
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onCancel);
        window.addEventListener("blur", onCancel);
        window.addEventListener("keydown", onEscapeKey, true);
      }}
    />
  );
}
