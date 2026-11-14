import Storage from "expo-sqlite/kv-store";
import { useCallback, type SetStateAction } from "react";
import { useStore } from "zustand";
import { useConnection } from "./client";
import { composerDraftKey, createComposerDrafts, EMPTY_DRAFT, type DraftAttachment } from "./composer-drafts";

const DRAFTS_KEY = "composer.drafts.v1";

const drafts = createComposerDrafts({
  load() {
    const raw = Storage.getItemSync(DRAFTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  },
  save(texts) {
    if (Object.keys(texts).length) Storage.setItemSync(DRAFTS_KEY, JSON.stringify(texts));
    else Storage.removeItemSync(DRAFTS_KEY);
  },
});

/** The welcome view only needs presence, not a re-render for every keystroke. */
export function useHasComposerDraft(sessionId: string) {
  const { computer } = useConnection();
  const key = composerDraftKey(computer.key, sessionId);
  return useStore(drafts, (state) => {
    const draft = state.entries[key];
    return !!(draft?.text.trim() || draft?.attachments.length);
  });
}

export function useComposerDraft(sessionId: string) {
  const { computer } = useConnection();
  const key = composerDraftKey(computer.key, sessionId);
  const draft = useStore(drafts, (state) => state.entries[key] ?? EMPTY_DRAFT);
  const setText = useCallback((next: SetStateAction<string>) => {
    drafts.getState().update(key, (current) => ({ ...current, text: typeof next === "function" ? next(current.text) : next }));
  }, [key]);
  const setAttachments = useCallback((next: SetStateAction<DraftAttachment[]>) => {
    drafts.getState().update(key, (current) => ({ ...current, attachments: typeof next === "function" ? next(current.attachments) : next }));
  }, [key]);
  return { ...draft, setText, setAttachments };
}
