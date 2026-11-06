import { useCallback } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { readLocal, saveLocal } from "./storage";

type DraftChange = string | ((current: string) => string);

export async function finishComposerSend(delivery: Promise<string>, clearSubmitted: () => void): Promise<void> {
  // The outbox is only in memory; keep the persisted draft until the host accepts it.
  if (await delivery === "failed")
    throw new Error("发送失败，输入和附件已保留；也可在会话中的消息上重试");
  clearSubmitted();
}

export function createTextDrafts(storage: { read: (key: string) => string; write: (key: string, text: string) => void }) {
  return createStore<{
    entries: Record<string, string>;
    read: (key: string) => string;
    update: (key: string, change: DraftChange) => void;
    clearSubmitted: (key: string, submitted: string) => void;
  }>((set, get) => ({
    entries: {},
    read: (key) => get().entries[key] ?? storage.read(key),
    update: (key, change) => {
      const current = get().read(key);
      const text = typeof change === "function" ? change(current) : change;
      if (text === current) return;
      set((state) => ({ entries: { ...state.entries, [key]: text } }));
      // A send or command can navigate away before React commits an effect.
      // Persist here, and let any later callback see the newest draft too.
      try { storage.write(key, text); }
      catch { /* A full store must never prevent writing or sending. */ }
    },
    clearSubmitted: (key, submitted) => get().update(key, (current) => current === submitted ? "" : current),
  }));
}

const drafts = createTextDrafts({
  read: (key) => {
    const text = readLocal<unknown>(key, "");
    return typeof text === "string" ? text : "";
  },
  write: saveLocal,
});

export function useComposerDraft(key: string) {
  const text = useStore(drafts, (state) => state.read(key));
  const setText = useCallback((change: DraftChange) => drafts.getState().update(key, change), [key]);
  const readText = useCallback(() => drafts.getState().read(key), [key]);
  const clearSubmitted = useCallback((submitted: string) => drafts.getState().clearSubmitted(key, submitted), [key]);
  return { text, setText, readText, clearSubmitted };
}
