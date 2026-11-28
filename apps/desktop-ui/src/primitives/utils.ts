import { useLayoutEffect, useState, type CSSProperties, type Ref, type RefCallback, type RefObject } from "react";

export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  let result = "";
  for (let i = 0; i < classes.length; i += 1) {
    const item = classes[i];
    if (item) {
      result = result ? `${result} ${item}` : item;
    }
  }
  return result;
}

/**
 * Sanitizes a React `useId()` output into a valid CSS `<dashed-ident>` for `anchor-name` / `position-anchor`.
 */
export function toCssAnchorName(
  reactId: string,
  prefix = "ls-anchor",
): `--${string}` {
  const clean = reactId.replace(/[^a-zA-Z0-9_-]/g, "");
  return `--${prefix}-${clean || "node"}`;
}

/**
 * Blocks Enter submission / arrow hijacking while CJK / Pinyin IME composition is active (`ime-safe-enter-submit`).
 */
export function isImeComposing(event: {
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return Boolean(
    event.nativeEvent?.isComposing ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.nativeEvent?.keyCode === 229,
  );
}

/**
 * Runs a DOM update inside an element-scoped View Transition (`scoped-component-transitions`)
 * when supported and `prefers-reduced-motion: no-preference` is active.
 */
export async function startScopedViewTransition(
  element: Element | null | undefined,
  update: () => void | Promise<void>,
): Promise<void> {
  const allowsMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: no-preference)").matches;

  if (
    allowsMotion &&
    element &&
    typeof element.startViewTransition === "function"
  ) {
    const transition = element.startViewTransition(() => update());
    await transition.updateCallbackDone;
    return;
  }

  await update();
}

/**
 * Reparents a live DOM node (e.g. xterm surface, preview iframe, or open top-layer element)
 * without resetting browser state (`persistent-top-layer-ui`).
 *
 * Chromium 152's `Element.prototype.moveBefore` throws `DOMException` (`HierarchyRequestError` /
 * `NotFoundError`) if `node` or `parent` is not already connected to the same live `Document`
 * (for example, on initial mount of a detached stage element). Guard connectivity strictly and
 * fall back to `insertBefore` on initial mount or any browser exception.
 */
export function moveNodeAtomic<T extends Node>(
  parent: Element,
  node: T,
  referenceNode: Node | null = null,
): T {
  const refNode = referenceNode ?? null;
  if (node.parentNode === parent && node.nextSibling === refNode) {
    return node;
  }
  if (
    typeof parent.moveBefore === "function" &&
    node.isConnected &&
    parent.isConnected &&
    node.parentNode !== null &&
    node.ownerDocument === parent.ownerDocument
  ) {
    try {
      return parent.moveBefore(node, refNode);
    } catch {
      return parent.insertBefore(node, refNode);
    }
  }
  return parent.insertBefore(node, refNode);
}

/**
 * Yields back to the browser main thread with front-of-queue continuation (`performance`).
 */
export function yieldToMain(): Promise<void> {
  if (
    typeof globalThis.scheduler !== "undefined" &&
    typeof globalThis.scheduler.yield === "function"
  ) {
    return globalThis.scheduler.yield();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function mergeRefs<T>(
  ...refs: Array<Ref<T> | undefined>
): RefCallback<T> {
  return (value: T | null) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") {
        ref(value);
      } else {
        (ref as { current: T | null }).current = value;
      }
    }
  };
}

export function supportsCssAnchorPositioning(): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    return true;
  }
  return CSS.supports("anchor-name", "--ls-anchor");
}

export type AnchorFallbackPlacement =
  | "bottom-start"
  | "bottom"
  | "bottom-end"
  | "top-start"
  | "top"
  | "top-end"
  | "right-start"
  | "right"
  | "left-start"
  | "left";

/**
 * Computes fixed viewport coordinates when CSS Anchor Positioning (`anchor-name` / `position-area`)
 * is unsupported (e.g., Firefox or older Safari), while staying a zero-cost no-op in Chromium and `jsdom`.
 */
export function useAnchorPositionFallback(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  placement: AnchorFallbackPlacement,
  options?: { matchTriggerWidth?: boolean; gap?: number; triggerSeq?: number },
): CSSProperties | undefined {
  const [fallbackStyle, setFallbackStyle] = useState<CSSProperties | undefined>(
    undefined,
  );
  const matchTriggerWidth = options?.matchTriggerWidth ?? false;
  const gap = options?.gap ?? 6;
  const triggerSeq = options?.triggerSeq ?? 0;

  useLayoutEffect(() => {
    if (!open || supportsCssAnchorPositioning() || typeof window === "undefined") {
      setFallbackStyle(undefined);
      return undefined;
    }

    const update = () => {
      const anchor = anchorRef.current;
      const floating = floatingRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth || 1024;
      const vh = window.innerHeight || 768;
      const fw = floating?.offsetWidth || (matchTriggerWidth ? rect.width : 220);
      const fh = floating?.offsetHeight || 180;

      let left = rect.left;
      let top = rect.bottom + gap;

      if (placement === "bottom") {
        left = rect.left + (rect.width - fw) / 2;
        top = rect.bottom + gap;
      } else if (placement === "bottom-end") {
        left = rect.right - fw;
        top = rect.bottom + gap;
      } else if (placement === "top-start") {
        left = rect.left;
        top = rect.top - fh - gap;
      } else if (placement === "top") {
        left = rect.left + (rect.width - fw) / 2;
        top = rect.top - fh - gap;
      } else if (placement === "top-end") {
        left = rect.right - fw;
        top = rect.top - fh - gap;
      } else if (placement === "right-start" || placement === "right") {
        left = rect.right + gap;
        top = placement === "right" ? rect.top + (rect.height - fh) / 2 : rect.top;
      } else if (placement === "left-start" || placement === "left") {
        left = rect.left - fw - gap;
        top = placement === "left" ? rect.top + (rect.height - fh) / 2 : rect.top;
      }

      if (top + fh > vh - 8 && rect.top - fh - gap >= 8) {
        top = rect.top - fh - gap;
      }
      if (top < 8 && rect.bottom + gap + fh <= vh - 8) {
        top = rect.bottom + gap;
      }

      const clampedLeft = Math.max(8, Math.min(vw - fw - 8, Math.round(left)));
      const clampedTop = Math.max(8, Math.min(vh - fh - 8, Math.round(top)));

      setFallbackStyle({
        position: "fixed",
        inset: "auto",
        margin: 0,
        left: `${clampedLeft}px`,
        top: `${clampedTop}px`,
        ...(matchTriggerWidth ? { inlineSize: `${Math.round(rect.width)}px` } : {}),
      });
    };

    update();
    const raf = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, floatingRef, gap, matchTriggerWidth, open, placement, triggerSeq]);

  return fallbackStyle;
}
