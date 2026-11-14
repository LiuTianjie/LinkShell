import { useCallback } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ContentBlock } from "@linkshell/wire";
import { getDesktopLocale, translateDesktop } from "./i18n";
import { STORAGE_KEYS, readLocal, saveLocal, subscribeStorageReady } from "./storage";

export type DraftChange = string | ((current: string) => string);

/** Pasted text >= 32 KiB collapses into a removable chip with inline expand option. */
export const LARGE_PASTE_BYTES = 32 * 1024;

export interface PastedTextBlock {
  id: string;
  text: string;
  lines: number;
  byteLength: number;
}

export function isLargePaste(text: string): boolean {
  return new TextEncoder().encode(text).byteLength >= LARGE_PASTE_BYTES;
}

export function createPastedBlock(text: string): PastedTextBlock {
  return {
    id: crypto.randomUUID(),
    text,
    lines: text.split("\n").length,
    byteLength: new TextEncoder().encode(text).byteLength,
  };
}

export function draftKeyFor(computerKey: string, sessionId = "new"): string {
  return STORAGE_KEYS.composerDraft(computerKey, sessionId);
}

/**
 * Clears the persisted composer draft ONLY after the Host confirms delivery.
 * On `"failed"`, preserves the draft and attachments so zero user work is lost.
 */
export async function finishComposerSend(
  delivery: Promise<string>,
  clearSubmitted: () => void,
): Promise<void> {
  if ((await delivery) === "failed") {
    throw new Error(translateDesktop(getDesktopLocale(), "desktop.composer.sendFailed"));
  }
  clearSubmitted();
}

export function createTextDrafts(storage: {
  read: (key: string) => string;
  write: (key: string, text: string | undefined) => void;
}) {
  return createStore<{
    entries: Record<string, string>;
    read: (key: string) => string;
    update: (key: string, change: DraftChange) => void;
    clearSubmitted: (key: string, submitted: string) => void;
    resetCache: () => void;
  }>((set, get) => ({
    entries: {},
    read: (key) => get().entries[key] ?? storage.read(key),
    update: (key, change) => {
      const current = get().read(key);
      const text = typeof change === "function" ? change(current) : change;
      if (text === current) return;
      set((state) => ({ entries: { ...state.entries, [key]: text } }));
      try {
        storage.write(key, text || undefined);
      } catch {
        // Storage quota must never block typing or sending.
      }
    },
    clearSubmitted: (key, submitted) =>
      get().update(key, (current) => (current === submitted ? "" : current)),
    resetCache: () => set({ entries: {} }),
  }));
}

export const composerDrafts = createTextDrafts({
  read: (key) => {
    const text = readLocal<unknown>(key, "");
    return typeof text === "string" ? text : "";
  },
  write: (key, text) => saveLocal(key, text),
});

subscribeStorageReady(() => composerDrafts.getState().resetCache());

export function useComposerDraft(key: string) {
  const text = useStore(composerDrafts, (state) => state.read(key));
  const setText = useCallback(
    (change: DraftChange) => composerDrafts.getState().update(key, change),
    [key],
  );
  const readText = useCallback(() => composerDrafts.getState().read(key), [key]);
  const clearSubmitted = useCallback(
    (submitted: string) => composerDrafts.getState().clearSubmitted(key, submitted),
    [key],
  );
  return { text, setText, readText, clearSubmitted };
}

export interface PersistedOutboxItem {
  id: string;
  sessionId: string;
  blocks: ContentBlock[];
  createdAt: number;
  error?: string;
}

export function readPersistedOutbox(computerKey: string): PersistedOutboxItem[] {
  const raw = readLocal<unknown>(STORAGE_KEYS.outbox(computerKey), []);
  return Array.isArray(raw) ? (raw as PersistedOutboxItem[]) : [];
}

export function savePersistedOutbox(computerKey: string, items: PersistedOutboxItem[]): void {
  saveLocal(STORAGE_KEYS.outbox(computerKey), items.length > 0 ? items : undefined);
}
