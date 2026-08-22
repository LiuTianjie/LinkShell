import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export type FloatPlacement = "bottom-end" | "bottom-start" | "top-start" | "top-end";

/**
 * Menu/popover that portals to document.body with position:fixed.
 * Absolute menus inside overflow-hidden / overflow-x-auto ancestors
 * (header, composer toolbar) are clipped or instantly dismissed on touch.
 */
export function FloatingPanel({
  open,
  anchorRef,
  placement = "bottom-end",
  onClose,
  children,
  className,
  minWidth = 176,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  placement?: FloatPlacement;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  minWidth?: number;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<CSSProperties>({});

  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 6;
    const style: CSSProperties = { position: "fixed", zIndex: 80, maxWidth: "calc(100vw - 16px)", minWidth };
    const opensUp = placement.startsWith("top");
    const alignEnd = placement.endsWith("end");
    if (opensUp) style.bottom = Math.max(8, window.innerHeight - r.top + gap);
    else style.top = Math.min(window.innerHeight - 8, r.bottom + gap);
    if (alignEnd) style.right = Math.max(8, window.innerWidth - r.right);
    else style.left = Math.max(8, Math.min(r.left, window.innerWidth - minWidth - 8));
    setPos(style);
  }, [anchorRef, placement, minWidth]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onViewport = () => place();
    // Opening tap's pointerdown must not close the panel immediately.
    const timer = window.setTimeout(() => document.addEventListener("pointerdown", onPointer), 0);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onViewport);
    window.addEventListener("scroll", onViewport, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
    };
  }, [open, onClose, place]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div ref={panelRef} style={pos} className={className} role="menu">
      {children}
    </div>,
    document.body,
  );
}
