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

const EMPTY_PASTED_BLOCKS: PastedTextBlock[] = [];
const storedPastedCache = new Map<string, PastedTextBlock[]>();

function pastedStorageKey(key: string): string {
  return `${key}:pasted`;
}

function readStoredPastedBlocks(key: string): PastedTextBlock[] {
  const cached = storedPastedCache.get(key);
  if (cached) return cached;
  const raw = readLocal<unknown>(pastedStorageKey(key), EMPTY_PASTED_BLOCKS);
  if (!Array.isArray(raw) || raw.length === 0) {
    storedPastedCache.set(key, EMPTY_PASTED_BLOCKS);
    return EMPTY_PASTED_BLOCKS;
  }
  const valid = raw.filter(
    (item): item is PastedTextBlock =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as PastedTextBlock).id === "string" &&
      typeof (item as PastedTextBlock).text === "string" &&
      typeof (item as PastedTextBlock).lines === "number" &&
      typeof (item as PastedTextBlock).byteLength === "number",
  );
  const result = valid.length > 0 ? valid : EMPTY_PASTED_BLOCKS;
  storedPastedCache.set(key, result);
  return result;
}

export type PastedBlocksChange =
  | PastedTextBlock[]
  | ((current: PastedTextBlock[]) => PastedTextBlock[]);

export const composerPastedDrafts = createStore<{
  entries: Record<string, PastedTextBlock[]>;
  read: (key: string) => PastedTextBlock[];
  update: (key: string, change: PastedBlocksChange) => void;
  clear: (key: string) => void;
  resetCache: () => void;
}>((set, get) => ({
  entries: {},
  read: (key) => get().entries[key] ?? readStoredPastedBlocks(key),
  update: (key, change) => {
    const current = get().read(key);
    const nextRaw = typeof change === "function" ? change(current) : change;
    const next = nextRaw.length > 0 ? nextRaw : EMPTY_PASTED_BLOCKS;
    if (next === current) return;
    storedPastedCache.set(key, next);
    set((state) => ({ entries: { ...state.entries, [key]: next } }));
    try {
      saveLocal(pastedStorageKey(key), next.length > 0 ? next : undefined);
    } catch {
      // Large pastes remain preserved in memory across session switches even if localStorage is full.
    }
  },
  clear: (key) => get().update(key, EMPTY_PASTED_BLOCKS),
  resetCache: () => {
    storedPastedCache.clear();
    set({ entries: {} });
  },
}));

subscribeStorageReady(() => {
  composerDrafts.getState().resetCache();
  composerPastedDrafts.getState().resetCache();
});

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
  const pastedBlocks = useStore(composerPastedDrafts, (state) => state.read(key));
  const setPastedBlocks = useCallback(
    (change: PastedBlocksChange) => composerPastedDrafts.getState().update(key, change),
    [key],
  );
  const clearPastedBlocks = useCallback(
    () => composerPastedDrafts.getState().clear(key),
    [key],
  );
  return {
    text,
    setText,
    readText,
    clearSubmitted,
    pastedBlocks,
    setPastedBlocks,
    clearPastedBlocks,
  };
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
