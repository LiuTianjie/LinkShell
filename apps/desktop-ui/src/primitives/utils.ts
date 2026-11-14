import type { Ref, RefCallback } from "react";

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
