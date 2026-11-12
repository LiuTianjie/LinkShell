import { t as translateKey, type Locale, type TimelineItem } from "@linkshell/client-core";
import { plainPreview, type GitDiffFile, type PortInfo } from "@linkshell/wire";
import Storage from "expo-sqlite/kv-store";
import { fileChanges, type FileChange } from "./describe";

// ── 1. `@file` fuzzy autocomplete ─────────────────────────────────────

export interface AtMentionMatch {
  query: string;
  start: number;
  end: number;
}

/**
 * Extracts an active `@<query>` mention token at the cursor (or end of `text`).
 * Triggers only when `@` is at the start of input or preceded by whitespace, avoiding emails.
 */
export function extractAtMention(text: string, selectionEnd?: number): AtMentionMatch | undefined {
  const cursor = selectionEnd !== undefined && selectionEnd >= 0 && selectionEnd <= text.length ? selectionEnd : text.length;
  const prefix = text.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(prefix);
  if (!match) return undefined;
  const query = match[1] ?? "";
  const atIndex = cursor - query.length - 1;
  return { query, start: atIndex, end: cursor };
}

export function applyAtMention(text: string, relativePath: string, selectionEnd?: number): string {
  const mention = extractAtMention(text, selectionEnd);
  const normalizedPath = relativePath.trim().replace(/^\.\//, "");
  if (!mention) {
    const sep = text.length > 0 && !/\s$/.test(text) ? " " : "";
    return `${text}${sep}@${normalizedPath} `;
  }
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.end);
  const trailingSpace = after.startsWith(" ") ? "" : " ";
  return `${before}@${normalizedPath}${trailingSpace}${after}`;
}

// ── 2. Quick Prompt chips (localized defaults + persisted custom chips) ──

export interface QuickPromptItem {
  id: string;
  label: string;
  prompt: string;
  custom?: boolean;
}

const CUSTOM_QUICK_PROMPTS_KEY = "linkshell.quick-prompts.v1";

export function defaultQuickPrompts(locale: Locale): QuickPromptItem[] {
  return [
    {
      id: "run-tests",
      label: translateKey(locale, "composer.quickRunTests"),
      prompt: translateKey(locale, "composer.quickRunTestsPrompt"),
    },
    {
      id: "summarize",
      label: translateKey(locale, "composer.quickSummarize"),
      prompt: translateKey(locale, "composer.quickSummarizePrompt"),
    },
    {
      id: "continue",
      label: translateKey(locale, "composer.quickContinue"),
      prompt: translateKey(locale, "composer.quickContinuePrompt"),
    },
    {
      id: "commit-pr",
      label: translateKey(locale, "composer.quickCommitPr"),
      prompt: translateKey(locale, "composer.quickCommitPrPrompt"),
    },
  ];
}

export function loadCustomQuickPrompts(): QuickPromptItem[] {
  try {
    const raw = Storage.getItemSync(CUSTOM_QUICK_PROMPTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is { id: string; label: string; prompt: string } =>
          Boolean(
            item &&
              typeof item === "object" &&
              typeof (item as { id?: unknown }).id === "string" &&
              typeof (item as { label?: unknown }).label === "string" &&
              typeof (item as { prompt?: unknown }).prompt === "string",
          ),
      )
      .map((item) => ({ ...item, custom: true }));
  } catch {
    return [];
  }
}

export function saveCustomQuickPrompts(items: QuickPromptItem[]): void {
  try {
    const clean = items
      .filter((item) => item.label.trim() && item.prompt.trim())
      .slice(0, 12)
      .map((item) => ({ id: item.id, label: item.label.trim(), prompt: item.prompt.trim() }));
    Storage.setItemSync(CUSTOM_QUICK_PROMPTS_KEY, JSON.stringify(clean));
  } catch {
    // Ignore storage write errors.
  }
}

// ── 3. Git working-tree diff -> FileChange adapter ────────────────────

export function gitDiffFileToChange(file: GitDiffFile): FileChange {
  const kind: FileChange["kind"] =
    file.status === "added" || file.status === "untracked"
      ? "add"
      : file.status === "deleted"
        ? "delete"
        : "update";
  if (file.binary) {
    return {
      path: file.path,
      kind,
      added: file.additions,
      removed: file.deletions,
      lines: [],
    };
  }
  const computed = fileChanges([
    {
      type: "diff",
      path: file.path,
      oldText: kind === "add" ? undefined : file.oldText,
      newText: file.newText,
    },
  ])[0];
  if (computed) {
    return {
      ...computed,
      kind,
      added: file.additions || computed.added,
      removed: file.deletions || computed.removed,
    };
  }
  return {
    path: file.path,
    kind,
    added: file.additions,
    removed: file.deletions,
    lines: [],
  };
}

// ── 4. In-session search & Turn Outline ───────────────────────────────

export type OutlineCategory = "all" | "prompts" | "approvals" | "errors";

export interface SessionOutlineEntry {
  id: string;
  timelineIndex: number;
  category: Exclude<OutlineCategory, "all"> | "agent";
  title: string;
  subtitle?: string;
}

function timelineItemText(item: TimelineItem): { category: SessionOutlineEntry["category"] | null; title: string; subtitle?: string } {
  if (item.kind === "user") {
    const text = item.blocks
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(" ")
      .trim();
    const clean = plainPreview(text);
    return { category: "prompts", title: clean || "User prompt" };
  }
  if (item.kind === "agent") {
    const clean = plainPreview(item.text);
    if (!clean) return { category: null, title: "" };
    return { category: "agent", title: clean };
  }
  if (item.kind === "permission-result") {
    return {
      category: "approvals",
      title: item.title || "Approval request",
      subtitle: item.optionName ?? (item.allowed === false ? "Declined" : item.allowed === true ? "Approved" : undefined),
    };
  }
  if (item.kind === "error") {
    return { category: "errors", title: plainPreview(item.message) || "Error" };
  }
  if (item.kind === "tool" && item.status === "failed") {
    return { category: "errors", title: item.title || "Failed tool call" };
  }
  return { category: null, title: "" };
}

export function extractSessionOutline(
  items: readonly TimelineItem[],
  filter: OutlineCategory = "all",
  searchQuery = "",
): SessionOutlineEntry[] {
  const needle = searchQuery.trim().toLowerCase();
  const entries: SessionOutlineEntry[] = [];
  items.forEach((item, index) => {
    const extracted = timelineItemText(item);
    if (!extracted.category || !extracted.title) return;
    if (filter !== "all" && extracted.category !== filter) return;
    // Without a search query, "all" acts as a crisp Turn Outline (prompts + approvals + errors + concise agent milestones).
    if (needle) {
      const hay = `${extracted.title} ${extracted.subtitle ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return;
    }
    entries.push({
      id: item.id,
      timelineIndex: index,
      category: extracted.category,
      title: extracted.title.slice(0, 140),
      subtitle: extracted.subtitle,
    });
  });
  return entries;
}

// ── 5. Session Port Matching (`ports.list` <-> `session.cwd`) ─────────

function normalizeDir(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const trimmed = dir.trim().replace(/[\\/]+$/, "");
  return trimmed || undefined;
}

export function matchSessionPorts(
  ports: readonly PortInfo[],
  sessionCwd?: string,
  worktreeSource?: string,
): PortInfo[] {
  const roots = [normalizeDir(sessionCwd), normalizeDir(worktreeSource)].filter((v): v is string => Boolean(v));
  if (roots.length === 0) return [];
  return ports.filter((entry) => {
    if (!entry.http) return false;
    const portDir = normalizeDir(entry.cwd);
    if (!portDir) return false;
    return roots.some(
      (root) =>
        portDir === root ||
        portDir.startsWith(`${root}/`) ||
        root.startsWith(`${portDir}/`),
    );
  });
}

// ── 6. Commuter Audio Summary (TTS) ───────────────────────────────────

const COMMUTER_TTS_KEY = "linkshell.commuter-tts.v1";

export function isCommuterTtsEnabled(): boolean {
  try {
    return Storage.getItemSync(COMMUTER_TTS_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCommuterTtsEnabled(enabled: boolean): void {
  try {
    Storage.setItemSync(COMMUTER_TTS_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage write errors.
  }
}

export function summarizeTurnForSpeech(items: readonly TimelineItem[], locale: Locale, sessionName?: string): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "error") {
      const msg = plainPreview(item.message).slice(0, 160);
      return locale === "zh"
        ? `任务执行出错：${msg}`
        : locale === "ja"
          ? `エラーが発生しました: ${msg}`
          : `Session error: ${msg}`;
    }
    if (item.kind === "agent") {
      const cleaned = plainPreview(item.text);
      if (cleaned) {
        const snippet = cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
        return sessionName ? `${sessionName}. ${snippet}` : snippet;
      }
    }
    if (item.kind === "user") break;
  }
  return locale === "zh"
    ? `${sessionName ? `${sessionName}：` : ""}本轮任务已完成`
    : locale === "ja"
      ? `${sessionName ? `${sessionName}: ` : ""}現在のターンが完了しました`
      : `${sessionName ? `${sessionName}: ` : ""}Turn completed`;
}

// ── 7. Siri / Action Button URL scheme parser ─────────────────────────

export type ShortcutActionKind = "quick-voice" | "approve-latest";

export function parseShortcutUrl(rawUrl: string | null | undefined): ShortcutActionKind | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.startsWith("/")) {
      const path = trimmed.replace(/^\/+/, "").split(/[?#]/)[0];
      if (path === "quick-voice" || path === "approve-latest") return path;
      return null;
    }
    const parsed = new URL(trimmed);
    const hostOrPath = (parsed.hostname || parsed.pathname.replace(/^\/+/, "")).split("/")[0];
    if (hostOrPath === "quick-voice" || hostOrPath === "approve-latest") return hostOrPath;
    const param = parsed.searchParams.get("shortcut");
    if (param === "quick-voice" || param === "approve-latest") return param;
  } catch {
    if (/quick-voice/i.test(trimmed)) return "quick-voice";
    if (/approve-latest/i.test(trimmed)) return "approve-latest";
  }
  return null;
}
