import { createStore } from "zustand/vanilla";

export interface DraftAttachment {
  uri: string;
  mimeType: string;
  data: string;
}

export interface ComposerDraft {
  text: string;
  attachments: DraftAttachment[];
}

export const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [] };

/** In memory only: switching panes must not discard unsent messages or photos. */
export function createComposerDrafts() {
  return createStore<{
    entries: Record<string, ComposerDraft>;
    update: (key: string, change: (draft: ComposerDraft) => ComposerDraft) => void;
  }>((set) => ({
    entries: {},
    update: (key, change) => set((state) => {
      const draft = change(state.entries[key] ?? EMPTY_DRAFT);
      const entries = { ...state.entries };
      if (draft.text || draft.attachments.length) entries[key] = draft;
      else delete entries[key];
      return { entries };
    }),
  }));
}

export function composerDraftKey(computer: string, session: string) {
  return JSON.stringify([computer, session]);
}
