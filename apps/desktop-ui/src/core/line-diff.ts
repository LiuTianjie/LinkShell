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

/**
 * Canonical key for diff review comments shared by ChangesPanel, DiffBlock, and SessionComposer.
 */
export function diffReviewSessionKey(
  computerKey?: string,
  sessionId?: string,
  cwd?: string,
): string | undefined {
  if (computerKey && sessionId) return `${computerKey}:${sessionId}`;
  if (sessionId) return sessionId;
  if (cwd) return `cwd:${cwd}`;
  return undefined;
}

/**
 * Normalizes legacy `\n`-delimited session keys (`sessionKeyOf`) to the canonical `:` form
 * so every producer and consumer reads from the exact same review bucket.
 */
export function normalizeDiffReviewSessionKey(sessionKey: string): string {
  const newlineIdx = sessionKey.indexOf("\n");
  if (newlineIdx >= 0) {
    return `${sessionKey.slice(0, newlineIdx)}:${sessionKey.slice(newlineIdx + 1)}`;
  }
  return sessionKey;
}

/**
 * Strips the session `cwd` prefix (POSIX `/` or Windows `\`) so diff trees, card headers,
 * and line review comments share one canonical repo-relative POSIX path key.
 */
export function normalizeReviewPath(filePath: string, cwd?: string): string {
  if (!filePath) return filePath;
  const normPath = filePath.replace(/\\/g, "/");
  if (!cwd) return normPath.replace(/^\.\//, "");
  const normCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normCwd) return normPath.replace(/^\.\//, "");
  if (normPath === normCwd) {
    const idx = normPath.lastIndexOf("/");
    return idx >= 0 ? normPath.slice(idx + 1) : normPath;
  }
  const prefix = `${normCwd}/`;
  if (normPath.startsWith(prefix)) {
    return normPath.slice(prefix.length).replace(/^\/+/, "");
  }
  if (
    /^[a-zA-Z]:\//.test(normPath) &&
    /^[a-zA-Z]:\//.test(normCwd) &&
    normPath.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
  ) {
    return normPath.slice(prefix.length).replace(/^\/+/, "");
  }
  return normPath.replace(/^\.\//, "");
}

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
      const canonicalKey = normalizeDiffReviewSessionKey(input.sessionKey);
      const entry: DiffReviewComment = {
        ...input,
        sessionKey: canonicalKey,
        path: normalizeReviewPath(input.path),
        id: crypto.randomUUID(),
        startLine: Math.min(input.startLine, input.endLine),
        endLine: Math.max(input.startLine, input.endLine),
        comment: input.comment.trim(),
        createdAt: Date.now(),
      };
      set((state) => ({
        bySession: {
          ...state.bySession,
          [canonicalKey]: [...(state.bySession[canonicalKey] ?? []), entry],
        },
      }));
      return entry;
    },
    updateComment: (sessionKey, id, comment) => {
      const canonicalKey = normalizeDiffReviewSessionKey(sessionKey);
      set((state) => {
        const list = state.bySession[canonicalKey];
        if (!list) return state;
        return {
          bySession: {
            ...state.bySession,
            [canonicalKey]: list.map((item) =>
              item.id === id ? { ...item, comment: comment.trim() } : item,
            ),
          },
        };
      });
    },
    removeComment: (sessionKey, id) => {
      const canonicalKey = normalizeDiffReviewSessionKey(sessionKey);
      set((state) => {
        const list = state.bySession[canonicalKey];
        if (!list) return state;
        return {
          bySession: {
            ...state.bySession,
            [canonicalKey]: list.filter((item) => item.id !== id),
          },
        };
      });
    },
    clearSession: (sessionKey) => {
      const canonicalKey = normalizeDiffReviewSessionKey(sessionKey);
      set((state) => {
        if (!(canonicalKey in state.bySession)) return state;
        const next = { ...state.bySession };
        delete next[canonicalKey];
        return { bySession: next };
      });
    },
  }));
}

export const diffReviewStore = createDiffReviewStore();

const EMPTY_COMMENTS: DiffReviewComment[] = [];

export function useDiffReviews(sessionKey: string | undefined): DiffReviewComment[] {
  const canonicalKey = sessionKey ? normalizeDiffReviewSessionKey(sessionKey) : undefined;
  return useStore(diffReviewStore, (state) =>
    canonicalKey ? (state.bySession[canonicalKey] ?? EMPTY_COMMENTS) : EMPTY_COMMENTS,
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
