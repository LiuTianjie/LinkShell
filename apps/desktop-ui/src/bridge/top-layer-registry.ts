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
const subscribers = new Set<() => void>();
let domListenersAttached = false;
let lastSnapshot = false;

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
    }
  }
}

function computeOpenState(): boolean {
  if (explicitTokens.size > 0) return true;
  pruneStaleElements();
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
    } else if (isElementStillOpen(target)) {
      trackedElements.add(target);
    } else {
      trackedElements.delete(target);
    }
    notifySubscribers(true);
  };

  const handleClose = (event: Event) => {
    const target = event.target;
    if (target instanceof Element && trackedElements.delete(target)) {
      notifySubscribers(true);
    }
  };

  const handleViewportChange = () => {
    if (computeOpenState()) {
      notifySubscribers(true);
    }
  };

  document.addEventListener("toggle", handleToggle, true);
  document.addEventListener("close", handleClose, true);
  document.addEventListener("cancel", handleClose, true);
  if (typeof window !== "undefined") {
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
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
    'dialog[open], [popover], .ls-popover[data-state="open"], .ls-menu-popover[data-state="open"], select',
  );
  for (const el of queried) {
    if (isElementStillOpen(el)) {
      candidates.add(el);
    }
  }

  const holes: OverlayCutoutRect[] = [];
  for (const el of candidates) {
    if (!isElementStillOpen(el)) continue;
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

export function hasOpenOverlay(): boolean {
  ensureDomListeners();
  const current = computeOpenState();
  lastSnapshot = current;
  return current;
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
