import { createStore } from "zustand/vanilla";

export interface DraftAttachment {
  kind?: "image" | "audio" | "resource";
  name?: string;
  text?: string;
  uri: string;
  mimeType: string;
  data: string;
}

export interface ComposerDraft {
  text: string;
  attachments: DraftAttachment[];
}

export const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [] };

/** Where the words of unsent drafts are kept between launches. */
export interface DraftStorage {
  load(): Record<string, string>;
  save(texts: Record<string, string>): void;
}

/** Drafts kept on disk: the newest few, each short enough to be something a person typed. */
const KEPT_DRAFTS = 40;
const KEPT_CHARS = 20_000;

/**
 * Unsent messages per conversation: switching panes or sessions must not discard them. With a
 * `storage`, the words also survive the app being closed in the background (the phone does that
 * whenever it needs memory); photos and files stay in memory only.
 */
export function createComposerDrafts(storage?: DraftStorage, saveDelayMs = 400) {
  const kept: Record<string, ComposerDraft> = {};
  try {
    for (const [key, text] of Object.entries(storage?.load() ?? {})) {
      if (typeof text === "string" && text) kept[key] = { text, attachments: [] };
    }
  } catch {
    // A draft store that can't be read starts empty.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = (entries: Record<string, ComposerDraft>) => {
    if (!storage) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const texts = Object.entries(entries).filter(([, draft]) => draft.text && draft.text.length <= KEPT_CHARS).slice(-KEPT_DRAFTS);
      try {
        storage.save(Object.fromEntries(texts.map(([key, draft]) => [key, draft.text])));
      } catch {
        // Kept in memory regardless.
      }
    }, saveDelayMs);
  };
  return createStore<{
    entries: Record<string, ComposerDraft>;
    update: (key: string, change: (draft: ComposerDraft) => ComposerDraft) => void;
  }>((set) => ({
    entries: kept,
    update: (key, change) => set((state) => {
      const before = state.entries[key] ?? EMPTY_DRAFT;
      const draft = change(before);
      const entries = { ...state.entries };
      // Last touched, last in line: the oldest drafts are the ones that fall off the disk copy.
      delete entries[key];
      if (draft.text || draft.attachments.length) entries[key] = draft;
      if (draft.text !== before.text) persist(entries);
      return { entries };
    }),
  }));
}

export function composerDraftKey(computer: string, session: string) {
  return JSON.stringify([computer, session]);
}
