import { useSyncExternalStore } from "react";

/**
 * Root Top-Layer overlay registry (`#8` §4.2, `#9` §3.2, `#73` §3B).
 *
 * On macOS, `LinkShellNative.node` attaches an AppKit `ScreenClip` (`CAMetalLayer`) above
 * Electron's `WebContents` view. Tracking open `<dialog>`, `[popover="auto" | "manual"]`,
 * and customizable `<select>` pickers lets `DesktopScreenSurface` punch rounded `CAShapeLayer`
 * cutout holes (`getOpenOverlayRects()`) in the Metal view while keeping the live desktop
 * stream visible underneath, and restore full uncut geometry immediately on close.
 *
 * Note: `[popover="hint"]` tooltips are intentionally excluded so hover hints never punch holes.
 */

export interface OverlayCutoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
}

const explicitTokens = new Set<symbol>();
const trackedElements = new Set<Element>();
const openSelectSide = new WeakMap<HTMLSelectElement, "above" | "below">();
const subscribers = new Set<() => void>();
let domListenersAttached = false;
let lastSnapshot = false;
let selectMicrotaskQueued = false;
let selectFrameQueued = false;
let selectSettleTimer: ReturnType<typeof setTimeout> | undefined;

function queryOpenSelects(): HTMLSelectElement[] {
  if (typeof document === "undefined") return [];
  try {
    return Array.from(document.querySelectorAll<HTMLSelectElement>("select:open"));
  } catch {
    const open: HTMLSelectElement[] = [];
    for (const el of document.querySelectorAll<HTMLSelectElement>("select")) {
      try {
        if (el.matches(":open")) open.push(el);
      } catch {
        // Ignore unsupported pseudo-class in older test engines.
      }
    }
    return open;
  }
}

function hasTrackedSelect(): boolean {
  for (const el of trackedElements) {
    if (el.tagName.toUpperCase() === "SELECT") return true;
  }
  return false;
}

/**
 * Measures the rendered `::picker(select)` top-layer box of an open customizable `<select>`
 * (`appearance: base-select`). Returns `null` when the picker has no measurable CSS box (e.g.
 * native OS popups or test environments without `base-select`), signaling the caller to collapse
 * the native Metal surface instead of risking partial occlusion.
 */
export function measureSelectPickerRect(
  select: HTMLSelectElement,
): OverlayCutoutRect | null {
  if (!isElementStillOpen(select)) return null;
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
    return null;
  }
  let ps: CSSStyleDeclaration;
  try {
    ps = window.getComputedStyle(select, "::picker(select)");
  } catch {
    return null;
  }
  if (!ps || ps.display === "none") return null;

  const rawWidth = Number.parseFloat(ps.width);
  const rawHeight = Number.parseFloat(ps.height);
  if (!(Number.isFinite(rawWidth) && rawWidth > 0 && Number.isFinite(rawHeight) && rawHeight > 0)) {
    return null;
  }

  const pt = Number.parseFloat(ps.paddingTop) || 0;
  const pb = Number.parseFloat(ps.paddingBottom) || 0;
  const pl = Number.parseFloat(ps.paddingLeft) || 0;
  const pr = Number.parseFloat(ps.paddingRight) || 0;
  const bt = Number.parseFloat(ps.borderTopWidth) || 0;
  const bb = Number.parseFloat(ps.borderBottomWidth) || 0;
  const bl = Number.parseFloat(ps.borderLeftWidth) || 0;
  const br = Number.parseFloat(ps.borderRightWidth) || 0;
  const mt = Number.parseFloat(ps.marginTop) || 0;
  const mb = Number.parseFloat(ps.marginBottom) || 0;

  const width = ps.boxSizing === "border-box" ? rawWidth : rawWidth + pl + pr + bl + br;
  const height = ps.boxSizing === "border-box" ? rawHeight : rawHeight + pt + pb + bt + bb;

  const selRect = select.getBoundingClientRect();
  if (!(selRect.width > 0 && selRect.height > 0)) return null;

  // Options only have non-zero viewport rects when Chromium renders a `base-select` picker in DOM.
  const options = Array.from(select.options);
  const preferred = select.selectedOptions?.[0] ?? options[0];
  let optRect: DOMRect | null = preferred ? preferred.getBoundingClientRect() : null;
  if (!optRect || !(optRect.width > 0 && optRect.height > 0)) {
    optRect =
      options
        .map((opt) => opt.getBoundingClientRect())
        .find((rect) => rect.width > 0 && rect.height > 0) ?? null;
  }
  if (!optRect) return null;

  // Cache above/below on initial open while the selected option is guaranteed in view, so later
  // scrolling inside a tall picker never flips the measured side.
  let side = openSelectSide.get(select);
  if (!side) {
    if (optRect.bottom <= selRect.top + 4) {
      side = "above";
    } else if (optRect.top >= selRect.bottom - 4) {
      side = "below";
    } else {
      return null;
    }
    openSelectSide.set(select, side);
  }

  let y = side === "above" ? selRect.top - mb - height : selRect.bottom + mt;

  // Snap to anchor edges when aligned to avoid 1–3 px drift during the 140 ms `scale(0.98)` entry.
  const optDerivedLeft = optRect.left - pl - bl;
  const optDerivedRight = optRect.right + pr + br;
  let x: number;
  if (Math.abs(optDerivedLeft - selRect.left) <= 12) {
    x = selRect.left;
  } else if (Math.abs(optDerivedRight - selRect.right) <= 24) {
    x = selRect.right - width;
  } else {
    x = optDerivedLeft;
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (Number.isFinite(vw) && vw > 0) {
    x = Math.max(0, Math.min(x, Math.max(0, vw - width)));
  }
  if (Number.isFinite(vh) && vh > 0) {
    y = Math.max(0, Math.min(y, Math.max(0, vh - height)));
  }

  const parsedRadius = Number.parseFloat(ps.borderTopLeftRadius);
  const radius =
    Number.isFinite(parsedRadius) && parsedRadius > 0
      ? Math.round(parsedRadius)
      : undefined;

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    ...(radius !== undefined ? { radius } : {}),
  };
}

function isTrackedPopover(el: Element): boolean {
  const attr = el.getAttribute("popover");
  if (attr !== null) {
    const normalized = attr.trim().toLowerCase();
    // Bare `popover` or `popover=""` defaults to `"auto"` per HTML spec; exclude `"hint"`.
    return normalized === "" || normalized === "auto" || normalized === "manual";
  }
  // Fallback Popover/Menu primitives when native Popover API is unavailable (e.g. jsdom).
  return (
    el.classList.contains("ls-popover") ||
    el.classList.contains("ls-menu-popover")
  );
}

function isElementStillOpen(el: Element): boolean {
  if (!el.isConnected) return false;
  // An overlay that isn't top-layer HTML (the sidebar's hover drawer) marks itself so the native
  // screen cuts a hole for it too, instead of covering it while it takes the clicks.
  if (el.hasAttribute("data-native-overlay")) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === "DIALOG") {
    return (el as HTMLDialogElement).open === true;
  }
  if (isTrackedPopover(el)) {
    if (el.getAttribute("data-state") === "open") return true;
    if (el.getAttribute("data-state") === "closed") return false;
    try {
      return el.matches(":popover-open");
    } catch {
      return false;
    }
  }
  if (tag === "SELECT") {
    try {
      return el.matches(":open");
    } catch {
      return false;
    }
  }
  return false;
}

function pruneStaleElements(): void {
  for (const el of trackedElements) {
    if (!isElementStillOpen(el)) {
      trackedElements.delete(el);
      if (el.tagName.toUpperCase() === "SELECT") {
        openSelectSide.delete(el as HTMLSelectElement);
      }
    }
  }
}

function computeOpenState(): boolean {
  pruneStaleElements();
  if (explicitTokens.size > 0) return true;
  return trackedElements.size > 0;
}

function notifySubscribers(force = false): void {
  const next = computeOpenState();
  if (!force && next === lastSnapshot) return;
  lastSnapshot = next;
  for (const listener of [...subscribers]) {
    listener();
  }
}

function syncSelectPickerState(): void {
  const openSelects = queryOpenSelects();
  const openSet = new Set<Element>(openSelects);
  let openedAny = false;
  let changed = false;

  for (const el of [...trackedElements]) {
    if (el.tagName.toUpperCase() === "SELECT" && !openSet.has(el)) {
      trackedElements.delete(el);
      openSelectSide.delete(el as HTMLSelectElement);
      changed = true;
    }
  }
  for (const sel of openSelects) {
    if (!trackedElements.has(sel)) {
      trackedElements.add(sel);
      openedAny = true;
      changed = true;
    }
  }

  if (openSelects.length === 0) {
    clearTimeout(selectSettleTimer);
    selectSettleTimer = undefined;
  } else if (openedAny) {
    clearTimeout(selectSettleTimer);
    // Re-sync once after the 140 ms `::picker(select)` entry transition settles so any
    // viewport-clamped horizontal offset locks cleanly to the resting picker box.
    selectSettleTimer = setTimeout(() => {
      selectSettleTimer = undefined;
      if (queryOpenSelects().length > 0) {
        notifySubscribers(true);
      }
    }, 170);
  }

  if (changed) {
    notifySubscribers(true);
  }
}

function scheduleSelectPickerSync(): void {
  syncSelectPickerState();
  if (!selectMicrotaskQueued) {
    selectMicrotaskQueued = true;
    queueMicrotask(() => {
      selectMicrotaskQueued = false;
      syncSelectPickerState();
    });
  }
  if (!selectFrameQueued) {
    selectFrameQueued = true;
    const run = () => {
      selectFrameQueued = false;
      syncSelectPickerState();
    };
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }
}

function ensureDomListeners(): void {
  if (domListenersAttached || typeof document === "undefined") return;
  domListenersAttached = true;

  const handleToggle = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const newState = (event as Event & { newState?: string }).newState;
    const tag = target.tagName.toUpperCase();
    if (
      tag !== "DIALOG" &&
      tag !== "SELECT" &&
      !isTrackedPopover(target)
    ) {
      return;
    }
    if (newState === "open") {
      trackedElements.add(target);
    } else if (newState === "closed") {
      trackedElements.delete(target);
      if (tag === "SELECT") openSelectSide.delete(target as HTMLSelectElement);
    } else if (isElementStillOpen(target)) {
      trackedElements.add(target);
    } else {
      trackedElements.delete(target);
      if (tag === "SELECT") openSelectSide.delete(target as HTMLSelectElement);
    }
    notifySubscribers(true);
  };

  const handleClose = (event: Event) => {
    const target = event.target;
    if (target instanceof Element && trackedElements.delete(target)) {
      if (target.tagName.toUpperCase() === "SELECT") {
        openSelectSide.delete(target as HTMLSelectElement);
      }
      notifySubscribers(true);
    }
  };

  const handleViewportChange = (event: Event) => {
    if (event.type === "resize") {
      for (const sel of queryOpenSelects()) {
        openSelectSide.delete(sel);
      }
    }
    if (computeOpenState()) {
      notifySubscribers(true);
    }
  };

  // Chromium's customizable `<select>` (`appearance: base-select`) does not fire `toggle`
  // events on the light-DOM `<select>` when `::picker(select)` opens or closes, so track
  // `:open` across user input and focus transitions.
  const handleSelectInteraction = (event: Event) => {
    const target = event.target;
    const nearSelect =
      target instanceof Element && target.closest("select, label") !== null;
    if (!hasTrackedSelect() && !nearSelect && queryOpenSelects().length === 0) {
      return;
    }
    scheduleSelectPickerSync();
  };

  document.addEventListener("toggle", handleToggle, true);
  document.addEventListener("close", handleClose, true);
  document.addEventListener("cancel", handleClose, true);
  document.addEventListener("pointerdown", handleSelectInteraction, true);
  document.addEventListener("pointerup", handleSelectInteraction, true);
  document.addEventListener("click", handleSelectInteraction, true);
  document.addEventListener("keydown", handleSelectInteraction, true);
  document.addEventListener("keyup", handleSelectInteraction, true);
  document.addEventListener("change", handleSelectInteraction, true);
  document.addEventListener("focusout", handleSelectInteraction, true);
  if (typeof window !== "undefined") {
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("blur", handleSelectInteraction);
  }
}

export function registerOverlayOpen(id = "overlay"): () => void {
  ensureDomListeners();
  const token = Symbol(id);
  explicitTokens.add(token);
  notifySubscribers();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    explicitTokens.delete(token);
    notifySubscribers();
  };
}

export function getOpenOverlayRects(): OverlayCutoutRect[] {
  ensureDomListeners();
  if (typeof document === "undefined") return [];
  pruneStaleElements();

  const candidates = new Set<Element>(trackedElements);
  const queried = document.querySelectorAll(
    'dialog[open], [popover], .ls-popover[data-state="open"], .ls-menu-popover[data-state="open"], [data-native-overlay]',
  );
  for (const el of queried) {
    if (isElementStillOpen(el)) {
      candidates.add(el);
    }
  }
  for (const sel of queryOpenSelects()) {
    candidates.add(sel);
  }

  const holes: OverlayCutoutRect[] = [];
  for (const el of candidates) {
    if (!isElementStillOpen(el)) continue;
    if (el.tagName.toUpperCase() === "SELECT") {
      const pickerRect = measureSelectPickerRect(el as HTMLSelectElement);
      if (pickerRect) {
        holes.push(pickerRect);
      }
      continue;
    }
    const bounds = el.getBoundingClientRect();
    if (!(bounds.width > 0 && bounds.height > 0)) continue;
    let radius: number | undefined;
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const parsed = Number.parseFloat(window.getComputedStyle(el).borderTopLeftRadius);
      if (Number.isFinite(parsed) && parsed > 0) {
        radius = Math.round(parsed);
      }
    }
    holes.push({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      ...(radius !== undefined ? { radius } : {}),
    });
  }
  return holes;
}

/** True when any `<select>` currently has an open picker (`select:open`). */
export function hasOpenSelectPicker(): boolean {
  return queryOpenSelects().length > 0;
}

/**
 * True when an open `<select>` picker cannot be measured as a DOM cutout hole (e.g. native OS
 * popup or fallback environment), so the native screen must collapse to `0×0` until it closes.
 */
export function hasUnmeasuredOpenSelectPicker(): boolean {
  const openSelects = queryOpenSelects();
  if (openSelects.length === 0) return false;
  return openSelects.some((sel) => measureSelectPickerRect(sel) === null);
}

export function hasOpenOverlay(): boolean {
  ensureDomListeners();
  const current = computeOpenState();
  lastSnapshot = current;
  return current;
}

/** A `[data-native-overlay]` element appeared or went: the native screen re-cuts its holes. */
export function notifyOverlayLayout(): void {
  notifySubscribers(true);
}

export function subscribeOpenOverlay(fn: () => void): () => void {
  ensureDomListeners();
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function useHasOpenOverlay(): boolean {
  return useSyncExternalStore(
    subscribeOpenOverlay,
    hasOpenOverlay,
    () => false,
  );
}
