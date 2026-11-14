import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
  changeLines,
  changeStat,
  diffLines,
  diffStat,
  hunks,
  parsePatch,
  type DiffHunk,
  type DiffLine,
} from "@linkshell/client-core";

export { changeLines, changeStat, diffLines, diffStat, hunks, parsePatch };
export type { DiffHunk, DiffLine };

export interface DiffReviewComment {
  id: string;
  sessionKey: string;
  path: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  excerpt: string;
  comment: string;
  createdAt: number;
}

export interface DiffReviewState {
  bySession: Record<string, DiffReviewComment[]>;
  addComment(input: Omit<DiffReviewComment, "id" | "createdAt">): DiffReviewComment;
  updateComment(sessionKey: string, id: string, comment: string): void;
  removeComment(sessionKey: string, id: string): void;
  clearSession(sessionKey: string): void;
}

export function createDiffReviewStore() {
  return createStore<DiffReviewState>((set) => ({
    bySession: {},
    addComment: (input) => {
      const entry: DiffReviewComment = {
        ...input,
        id: crypto.randomUUID(),
        startLine: Math.min(input.startLine, input.endLine),
        endLine: Math.max(input.startLine, input.endLine),
        comment: input.comment.trim(),
        createdAt: Date.now(),
      };
      set((state) => ({
        bySession: {
          ...state.bySession,
          [input.sessionKey]: [...(state.bySession[input.sessionKey] ?? []), entry],
        },
      }));
      return entry;
    },
    updateComment: (sessionKey, id, comment) => {
      set((state) => {
        const list = state.bySession[sessionKey];
        if (!list) return state;
        return {
          bySession: {
            ...state.bySession,
            [sessionKey]: list.map((item) =>
              item.id === id ? { ...item, comment: comment.trim() } : item,
            ),
          },
        };
      });
    },
    removeComment: (sessionKey, id) => {
      set((state) => {
        const list = state.bySession[sessionKey];
        if (!list) return state;
        return {
          bySession: {
            ...state.bySession,
            [sessionKey]: list.filter((item) => item.id !== id),
          },
        };
      });
    },
    clearSession: (sessionKey) => {
      set((state) => {
        if (!(sessionKey in state.bySession)) return state;
        const next = { ...state.bySession };
        delete next[sessionKey];
        return { bySession: next };
      });
    },
  }));
}

export const diffReviewStore = createDiffReviewStore();

const EMPTY_COMMENTS: DiffReviewComment[] = [];

export function useDiffReviews(sessionKey: string | undefined): DiffReviewComment[] {
  return useStore(diffReviewStore, (state) =>
    sessionKey ? (state.bySession[sessionKey] ?? EMPTY_COMMENTS) : EMPTY_COMMENTS,
  );
}

/** Formats queued line-level diff review comments into an explicit structured prompt for the Agent. */
export function formatDiffReviewPrompt(comments: readonly DiffReviewComment[]): string {
  if (comments.length === 0) return "";
  const sections = comments.map((entry, idx) => {
    const range =
      entry.startLine === entry.endLine
        ? `L${entry.startLine}`
        : `L${entry.startLine}-L${entry.endLine}`;
    const sideLabel = entry.side === "old" ? "removed" : "updated";
    const snippet = entry.excerpt.trim()
      ? `\n\`\`\`\n${entry.excerpt.replace(/\n$/, "")}\n\`\`\``
      : "";
    return `### ${idx + 1}. \`${entry.path}\` (${range}, ${sideLabel})${snippet}\n${entry.comment}`;
  });
  return `Please address the following code review comments:\n\n${sections.join("\n\n")}`;
}
