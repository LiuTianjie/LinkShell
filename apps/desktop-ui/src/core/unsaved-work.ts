import { useSyncExternalStore } from "react";

const unsavedEntries = new Map<symbol, string>();
const listeners = new Set<() => void>();
let beforeUnloadAttached = false;

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (unsavedEntries.size === 0) return;
  event.preventDefault();
  event.returnValue = "";
}

function syncBeforeUnloadListener(): void {
  if (typeof window === "undefined") return;
  if (unsavedEntries.size > 0 && !beforeUnloadAttached) {
    window.addEventListener("beforeunload", handleBeforeUnload);
    beforeUnloadAttached = true;
  } else if (unsavedEntries.size === 0 && beforeUnloadAttached) {
    window.removeEventListener("beforeunload", handleBeforeUnload);
    beforeUnloadAttached = false;
  }
}

function emit(): void {
  syncBeforeUnloadListener();
  for (const listener of listeners) listener();
}

/**
 * Registers an independent dirty editor or form so closing one never clears another's guard.
 * Returns a cleanup callback to release the guard when saved or discarded.
 */
export function registerUnsavedWork(label = "editor"): () => void {
  const token = Symbol(label);
  unsavedEntries.set(token, label);
  emit();
  return () => {
    if (!unsavedEntries.delete(token)) return;
    emit();
  };
}

export function hasUnsavedWork(): boolean {
  return unsavedEntries.size > 0;
}

export function unsavedWorkCount(): number {
  return unsavedEntries.size;
}

export function subscribeUnsavedWork(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHasUnsavedWork(): boolean {
  return useSyncExternalStore(subscribeUnsavedWork, hasUnsavedWork, () => false);
}

export function clearUnsavedWorkForTests(): void {
  unsavedEntries.clear();
  emit();
}
