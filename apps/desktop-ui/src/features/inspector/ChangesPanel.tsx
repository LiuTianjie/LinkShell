import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SessionView } from "@linkshell/client-core";
import type { GitDiffFile, GitDiffFileStatus, ToolCallContent } from "@linkshell/wire";
import { DesktopIcon } from "../../icons";
import {
  AutoGrowTextarea,
  Badge,
  Button,
  CopyButton,
  Disclosure,
  EmptyState,
  IconButton,
  Input,
  useDialogs,
} from "../../primitives";
import type { Connection } from "../../core/connections";
import {
  changeLines,
  changeStat,
  diffLines,
  diffReviewStore,
  diffStat,
  formatDiffReviewPrompt,
  hunks,
  useDiffReviews,
  type DiffLine,
  type DiffReviewComment,
} from "../../core/line-diff";
import {
  grammarForPath,
  useHighlight,
  type HighlightToken,
} from "../../core/markdown-shiki";
import {
  buildCompactChangeTree,
  FileExtBadge,
  formatCompactStat,
  type CompactTreeNode,
} from "./file-ext-badge";
import { useInspectorI18n } from "./i18n-inspector";
import type { InspectorSessionActions } from "./use-inspector-connection";

export type ChangesSourceMode = "session" | "git";
export type DiffLayoutMode = "unified" | "split";

export interface ChangesStatsSummary {
  files: number;
  added: number;
  removed: number;
}

interface UnifiedChangeEntry {
  key: string;
  /** Raw path as reported by session tool call or git.diff (preserved for git.revertFile / open-file RPCs). */
  rawPath: string;
  /** Repo-relative display path normalized against session `cwd`. */
  path: string;
  rawOldPath?: string;
  oldPath?: string;
  status: GitDiffFileStatus;
  lines: DiffLine[];
  added: number;
  removed: number;
  binary?: boolean;
  canRevert: boolean;
}

/**
 * Strips the session `cwd` prefix (POSIX `/` or Windows `\`) so diff trees and card headers
 * show clean repo-relative paths while preserving raw paths for host RPCs.
 */
export function toRepoRelativePath(filePath: string, cwd?: string): string {
  if (!filePath) return filePath;
  const normPath = filePath.replace(/\\/g, "/");
  if (!cwd) return normPath;
  const normCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normCwd) return normPath;
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
  return normPath;
}

function splitDisplayPath(displayPath: string): {
  basename: string;
  parentDir: string;
} {
  const normalized = displayPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const slashIdx = normalized.lastIndexOf("/");
  if (slashIdx < 0) {
    return { basename: normalized || displayPath, parentDir: "" };
  }
  return {
    basename: normalized.slice(slashIdx + 1) || normalized,
    parentDir: normalized.slice(0, slashIdx),
  };
}

type DiffChangeContent = Extract<ToolCallContent, { type: "diff" | "patch" }>;

function extractSessionChanges(
  view: SessionView | undefined,
  cwd?: string,
): UnifiedChangeEntry[] {
  if (!view) return [];
  const byPath = new Map<
    string,
    { path: string; chunks: DiffChangeContent[] }
  >();

  for (const item of view.items) {
    if (item.kind !== "tool") continue;
    const contents = item.content ?? [];
    for (const part of contents) {
      if (part.type !== "diff" && part.type !== "patch") continue;
      const filePath = part.path || "patch";
      const existing = byPath.get(filePath);
      if (existing) {
        existing.chunks.push(part);
      } else {
        byPath.set(filePath, { path: filePath, chunks: [part] });
      }
    }
  }

  const out: UnifiedChangeEntry[] = [];
  for (const [rawPath, group] of byPath) {
    const mergedLines: DiffLine[] = [];
    let added = 0;
    let removed = 0;
    for (const chunk of group.chunks) {
      const chunkLines = changeLines(chunk);
      const stat = changeStat(chunk);
      mergedLines.push(...chunkLines);
      added += stat.added;
      removed += stat.removed;
    }
    const status: GitDiffFileStatus =
      removed === 0 && added > 0
        ? "added"
        : added === 0 && removed > 0
          ? "deleted"
          : "modified";
    out.push({
      key: `session:${rawPath}`,
      rawPath,
      path: toRepoRelativePath(rawPath, cwd),
      status,
      lines: mergedLines,
      added,
      removed,
      canRevert: false,
    });
  }
  return out;
}

export function useSessionChangesSummary(
  view: SessionView | undefined,
): ChangesStatsSummary {
  return useMemo(() => {
    const entries = extractSessionChanges(view);
    let added = 0;
    let removed = 0;
    for (const entry of entries) {
      added += entry.added;
      removed += entry.removed;
    }
    return { files: entries.length, added, removed };
  }, [view]);
}

function mapGitDiffFiles(
  files: readonly GitDiffFile[],
  cwd?: string,
): UnifiedChangeEntry[] {
  return files.map((file) => {
    const lines = file.binary ? [] : diffLines(file.oldText, file.newText);
    const computed = file.binary
      ? { added: file.additions, removed: file.deletions }
      : diffStat(lines);
    return {
      key: `git:${file.path}`,
      rawPath: file.path,
      path: toRepoRelativePath(file.path, cwd),
      rawOldPath: file.oldPath,
      oldPath: file.oldPath ? toRepoRelativePath(file.oldPath, cwd) : undefined,
      status: file.status,
      lines,
      added: file.additions || computed.added,
      removed: file.deletions || computed.removed,
      binary: file.binary,
      canRevert: true,
    };
  });
}

interface SplitDiffPair {
  left?: DiffLine;
  right?: DiffLine;
}

function pairDiffLinesForSplit(lines: readonly DiffLine[]): SplitDiffPair[] {
  const pairs: SplitDiffPair[] = [];
  let idx = 0;
  while (idx < lines.length) {
    const cur = lines[idx]!;
    if (cur.kind === "same") {
      pairs.push({ left: cur, right: cur });
      idx++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (idx < lines.length && lines[idx]!.kind === "del") {
      dels.push(lines[idx]!);
      idx++;
    }
    while (idx < lines.length && lines[idx]!.kind === "add") {
      adds.push(lines[idx]!);
      idx++;
    }
    const span = Math.max(dels.length, adds.length);
    for (let k = 0; k < span; k++) {
      pairs.push({ left: dels[k], right: adds[k] });
    }
  }
  return pairs;
}

function renderTokenLine(
  tokens: HighlightToken[] | undefined,
  fallbackText: string,
): ReactNode {
  if (!tokens || tokens.length === 0) return fallbackText || " ";
  return tokens.map((tok, i) =>
    tok.color ? (
      <span key={i} data-syntax-token="" style={{ color: tok.color }}>
        {tok.content}
      </span>
    ) : (
      tok.content
    ),
  );
}

interface ActiveCommentDraft {
  path: string;
  side: "old" | "new";
  line: number;
  excerpt: string;
  text: string;
}

interface ChangesDirectoryTreeProps {
  nodes: readonly CompactTreeNode<UnifiedChangeEntry>[];
  selectedKey: string | null;
  onSelectFile: (entry: UnifiedChangeEntry) => void;
  onRevertFile?: (path: string) => void;
}

function ChangesDirectoryTree({
  nodes,
  selectedKey,
  onSelectFile,
  onRevertFile,
}: ChangesDirectoryTreeProps) {
  const { t, ti } = useInspectorI18n();
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>(
    {},
  );

  const toggleDir = useCallback((dirId: string) => {
    setCollapsedDirs((prev) => ({ ...prev, [dirId]: !prev[dirId] }));
  }, []);

  const renderNodes = (
    list: readonly CompactTreeNode<UnifiedChangeEntry>[],
    depth: number,
  ): ReactNode =>
    list.map((node) => {
      if (node.kind === "folder") {
        const isCollapsed = Boolean(collapsedDirs[node.id]);
        return (
          <div key={node.id} className="inspector-change-tree-group">
            <button
              type="button"
              role="treeitem"
              aria-expanded={!isCollapsed}
              className="inspector-change-tree-folder"
              style={{ paddingInlineStart: `${8 + depth * 14}px` }}
              onClick={() => toggleDir(node.id)}
            >
              <DesktopIcon
                name={isCollapsed ? "chevron-right" : "chevron-down"}
                size="xs"
                className="inspector-change-tree-chevron"
              />
              <span className="inspector-change-tree-label">{node.label}</span>
              <span className="inspector-change-tree-stat" data-tabular="">
                <span className="inspector-diff-stat-add">
                  +{formatCompactStat(node.added)}
                </span>
                <span className="inspector-diff-stat-del">
                  -{formatCompactStat(node.removed)}
                </span>
              </span>
            </button>
            {!isCollapsed ? renderNodes(node.children, depth + 1) : null}
          </div>
        );
      }

      const isSelected = selectedKey === node.id;
      const entry = node.item;
      return (
        <div
          key={node.id}
          role="treeitem"
          aria-selected={isSelected}
          data-selected={isSelected ? "true" : undefined}
          className="inspector-change-tree-file-row"
          style={{ paddingInlineStart: `${8 + depth * 14}px` }}
        >
          <button
            type="button"
            className="inspector-change-tree-file"
            title={entry.path}
            onClick={() => onSelectFile(entry)}
          >
            <FileExtBadge path={entry.path} />
            <span className="inspector-change-tree-label">{node.name}</span>
          </button>

          <span className="inspector-change-tree-meta">
            <span className="inspector-change-tree-stat" data-tabular="">
              <span className="inspector-diff-stat-add">
                +{formatCompactStat(node.added)}
              </span>
              <span className="inspector-diff-stat-del">
                -{formatCompactStat(node.removed)}
              </span>
            </span>

            {entry.canRevert && onRevertFile ? (
              <IconButton
                icon="archive-restore"
                size="icon-sm"
                variant="danger-ghost"
                className="inspector-change-tree-action"
                label={t("desktop.inspector.revertFile")}
                onClick={() => onRevertFile(entry.rawPath)}
              />
            ) : null}
          </span>
        </div>
      );
    });

  return (
    <div
      role="tree"
      aria-label={ti("changesTreeLabel")}
      className="inspector-change-tree"
    >
      {renderNodes(nodes, 0)}
    </div>
  );
}

interface DiffFileCardProps {
  entry: UnifiedChangeEntry;
  layout: DiffLayoutMode;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  cardRef?: (el: HTMLDivElement | null) => void;
  sessionKey: string;
  comments: readonly DiffReviewComment[];
  activeDraft: ActiveCommentDraft | null;
  onOpenDraft: (draft: ActiveCommentDraft) => void;
  onChangeDraft: (text: string) => void;
  onCancelDraft: () => void;
  onSaveDraft: (sendImmediately: boolean) => void;
  onRemoveComment: (id: string) => void;
  onRevertFile?: (path: string) => void;
  onOpenFile?: (specOrPath: string) => void;
  canSendToAgent: boolean;
}

function DiffFileCard({
  entry,
  layout,
  isOpen,
  onOpenChange,
  cardRef,
  comments,
  activeDraft,
  onOpenDraft,
  onChangeDraft,
  onCancelDraft,
  onSaveDraft,
  onRemoveComment,
  onRevertFile,
  onOpenFile,
  canSendToAgent,
}: DiffFileCardProps) {
  const { t, ti } = useInspectorI18n();

  const visibleHunks = useMemo(() => hunks(entry.lines, 3), [entry.lines]);
  const flattenedLines = useMemo(() => {
    const out: Array<DiffLine | { kind: "skip"; count: number }> = [];
    for (const hunk of visibleHunks) {
      if (hunk.skipped > 0) {
        out.push({ kind: "skip", count: hunk.skipped });
      }
      out.push(...hunk.lines);
    }
    return out;
  }, [visibleHunks]);

  const codeForShiki = useMemo(() => {
    if (!isOpen || entry.binary || flattenedLines.length === 0) return "";
    return flattenedLines
      .map((row) => (row.kind === "skip" ? "" : row.text))
      .join("\n");
  }, [isOpen, entry.binary, flattenedLines]);

  const language = useMemo(() => grammarForPath(entry.path), [entry.path]);
  const highlightedLines = useHighlight(
    codeForShiki,
    language,
    isOpen && !entry.binary && codeForShiki.length > 0,
  );

  const fileComments = useMemo(
    () => comments.filter((c) => c.path === entry.path),
    [comments, entry.path],
  );

  const statusTone =
    entry.status === "added" || entry.status === "untracked"
      ? "ok"
      : entry.status === "deleted"
        ? "danger"
        : "neutral";

  const statusText =
    entry.status === "untracked"
      ? ti("untrackedBadge")
      : entry.status === "added"
        ? ti("addedBadge")
        : entry.status === "deleted"
          ? ti("deletedBadge")
          : ti("modifiedBadge");

  const renderSavedAndDraft = (
    side: "old" | "new",
    lineNo: number | undefined,
  ) => {
    if (lineNo === undefined) return null;
    const matchingSaved = fileComments.filter(
      (c) => c.side === side && c.startLine === lineNo,
    );
    const isDraftHere =
      activeDraft !== null &&
      activeDraft.path === entry.path &&
      activeDraft.side === side &&
      activeDraft.line === lineNo;

    if (matchingSaved.length === 0 && !isDraftHere) return null;

    return (
      <>
        {matchingSaved.map((saved) => (
          <div key={saved.id} className="inspector-review-saved">
            <div>
              <strong>L{saved.startLine} · </strong>
              <span>{saved.comment}</span>
            </div>
            <IconButton
              icon="trash"
              size="icon-sm"
              variant="ghost"
              label={ti("deleteComment")}
              onClick={() => onRemoveComment(saved.id)}
            />
          </div>
        ))}
        {isDraftHere ? (
          <div className="inspector-review-box">
            <AutoGrowTextarea
              autoFocus
              rows={2}
              value={activeDraft.text}
              placeholder={ti("lineCommentPlaceholder", { line: lineNo })}
              onChange={(e) => onChangeDraft(e.target.value)}
              onEnterSubmit={(e) => {
                e.preventDefault();
                if (activeDraft.text.trim()) {
                  onSaveDraft(false);
                }
              }}
            />
            <div className="inspector-item-row">
              <Button size="xs" variant="ghost" onClick={onCancelDraft}>
                {ti("cancel")}
              </Button>
              <div className="inspector-subbar-group">
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={!activeDraft.text.trim()}
                  onClick={() => onSaveDraft(false)}
                >
                  {ti("saveComment")}
                </Button>
                {canSendToAgent ? (
                  <Button
                    size="xs"
                    variant="primary"
                    className="inspector-keycap-btn"
                    leadingIcon="send-to-agent"
                    disabled={!activeDraft.text.trim()}
                    onClick={() => onSaveDraft(true)}
                  >
                    {ti("sendCommentsNow")}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </>
    );
  };

  const { basename, parentDir } = useMemo(
    () => splitDisplayPath(entry.path),
    [entry.path],
  );

  return (
    <div ref={cardRef} data-diff-key={entry.key}>
      <Disclosure
        open={isOpen}
        onOpenChange={onOpenChange}
        className="inspector-diff-card"
        title={
          <span className="inspector-diff-card__title">
            <FileExtBadge path={entry.path} />
            <span
              className="inspector-diff-card__path"
              title={
                entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path
              }
              style={{
                display: "inline-flex",
                alignItems: "baseline",
                gap: "6px",
              }}
            >
              <span
                className="inspector-diff-card__basename"
                style={{
                  flexShrink: 0,
                  fontWeight: 600,
                  color: "var(--ls-fg)",
                }}
              >
                {basename}
              </span>
              {parentDir || entry.oldPath ? (
                <span
                  className="inspector-diff-card__dir ls-truncate"
                  style={{
                    color: "var(--ls-fg-3)",
                    fontSize: "var(--ls-text-xs)",
                  }}
                >
                  {entry.oldPath && parentDir
                    ? `${entry.oldPath} → ${parentDir}`
                    : entry.oldPath
                      ? `← ${entry.oldPath}`
                      : parentDir}
                </span>
              ) : null}
            </span>
            <Badge variant="tag" tone={statusTone}>
              {statusText}
            </Badge>
          </span>
        }
        meta={
          <span
            className="inspector-diff-card__meta"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="inspector-diff-stat-pill" data-tabular="">
              <span className="inspector-diff-stat-add">+{entry.added}</span>
              <span className="inspector-diff-stat-del">-{entry.removed}</span>
            </span>
            <span className="inspector-diff-card__actions">
              {onOpenFile && entry.status !== "deleted" ? (
                <IconButton
                  icon="file-code"
                  size="icon-sm"
                  label={ti("openFileTab")}
                  onClick={() => onOpenFile(entry.rawPath)}
                />
              ) : null}
              <CopyButton
                value={entry.rawPath}
                label={t("desktop.menu.copyPath")}
                size="sm"
              />
              {entry.canRevert && onRevertFile ? (
                <IconButton
                  icon="archive-restore"
                  size="icon-sm"
                  variant="danger-ghost"
                  label={t("desktop.inspector.revertFile")}
                  onClick={() => onRevertFile(entry.rawPath)}
                />
              ) : null}
            </span>
          </span>
        }
      >
        {entry.binary ? (
          <div className="inspector-panel-scroll">
            <span className="ls-truncate">{ti("binaryFileTitle")}</span>
          </div>
        ) : layout === "unified" ? (
          <div tabIndex={0} className="inspector-diff-scroll">
            <div className="inspector-diff-table">
              {flattenedLines.map((row, idx) => {
                if (row.kind === "skip") {
                  return (
                    <div key={`skip-${idx}`} className="inspector-diff-row">
                      <span />
                      <span className="inspector-diff-ln">…</span>
                      <span className="inspector-diff-ln">…</span>
                      <span className="inspector-diff-sign">⋮</span>
                      <span className="inspector-diff-code">
                        {`@@ +${row.count} unchanged lines @@`}
                      </span>
                    </div>
                  );
                }
                const side: "old" | "new" = row.kind === "del" ? "old" : "new";
                const targetLine = side === "old" ? row.old : row.new;
                const sign =
                  row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
                return (
                  <div key={`u-${idx}`}>
                    <div className="inspector-diff-row" data-kind={row.kind}>
                      <span>
                        {targetLine !== undefined ? (
                          <button
                            type="button"
                            className="inspector-diff-comment-btn"
                            aria-label={t("desktop.timeline.addLineComment")}
                            title={t("desktop.timeline.addLineComment")}
                            onClick={() =>
                              onOpenDraft({
                                path: entry.path,
                                side,
                                line: targetLine,
                                excerpt: row.text,
                                text: "",
                              })
                            }
                          >
                            <DesktopIcon name="plus" size="xs" />
                          </button>
                        ) : null}
                      </span>
                      <span className="inspector-diff-ln">{row.old ?? ""}</span>
                      <span className="inspector-diff-ln">{row.new ?? ""}</span>
                      <span className="inspector-diff-sign">{sign}</span>
                      <span className="inspector-diff-code">
                        {renderTokenLine(highlightedLines?.[idx], row.text)}
                      </span>
                    </div>
                    {renderSavedAndDraft(side, targetLine)}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div tabIndex={0} className="inspector-diff-scroll">
            <div className="inspector-diff-table">
              {visibleHunks.map((hunk, hIdx) => {
                const pairs = pairDiffLinesForSplit(hunk.lines);
                return (
                  <div key={`hunk-${hIdx}`}>
                    {hunk.skipped > 0 ? (
                      <div className="inspector-diff-row">
                        <span />
                        <span className="inspector-diff-ln">…</span>
                        <span className="inspector-diff-ln">…</span>
                        <span className="inspector-diff-sign">⋮</span>
                        <span className="inspector-diff-code">
                          {`@@ +${hunk.skipped} unchanged lines @@`}
                        </span>
                      </div>
                    ) : null}
                    {pairs.map((pair, pIdx) => (
                      <div key={`sp-${hIdx}-${pIdx}`}>
                        <div className="inspector-diff-split-row">
                          <div
                            className="inspector-diff-split-cell"
                            data-kind={pair.left ? pair.left.kind : "empty"}
                          >
                            <span>
                              {pair.left?.old !== undefined ? (
                                <button
                                  type="button"
                                  className="inspector-diff-comment-btn"
                                  aria-label={t(
                                    "desktop.timeline.addLineComment",
                                  )}
                                  onClick={() =>
                                    onOpenDraft({
                                      path: entry.path,
                                      side: "old",
                                      line: pair.left!.old!,
                                      excerpt: pair.left!.text,
                                      text: "",
                                    })
                                  }
                                >
                                  <DesktopIcon name="plus" size="xs" />
                                </button>
                              ) : null}
                            </span>
                            <span className="inspector-diff-ln">
                              {pair.left?.old ?? ""}
                            </span>
                            <span className="inspector-diff-sign">
                              {pair.left
                                ? pair.left.kind === "del"
                                  ? "-"
                                  : " "
                                : ""}
                            </span>
                            <span className="inspector-diff-code">
                              {pair.left?.text ?? ""}
                            </span>
                          </div>
                          <div
                            className="inspector-diff-split-cell"
                            data-kind={pair.right ? pair.right.kind : "empty"}
                          >
                            <span>
                              {pair.right?.new !== undefined ? (
                                <button
                                  type="button"
                                  className="inspector-diff-comment-btn"
                                  aria-label={t(
                                    "desktop.timeline.addLineComment",
                                  )}
                                  onClick={() =>
                                    onOpenDraft({
                                      path: entry.path,
                                      side: "new",
                                      line: pair.right!.new!,
                                      excerpt: pair.right!.text,
                                      text: "",
                                    })
                                  }
                                >
                                  <DesktopIcon name="plus" size="xs" />
                                </button>
                              ) : null}
                            </span>
                            <span className="inspector-diff-ln">
                              {pair.right?.new ?? ""}
                            </span>
                            <span className="inspector-diff-sign">
                              {pair.right
                                ? pair.right.kind === "add"
                                  ? "+"
                                  : " "
                                : ""}
                            </span>
                            <span className="inspector-diff-code">
                              {pair.right?.text ?? ""}
                            </span>
                          </div>
                        </div>
                        {pair.left?.old !== undefined
                          ? renderSavedAndDraft("old", pair.left.old)
                          : null}
                        {pair.right?.new !== undefined &&
                        pair.right.kind !== "same"
                          ? renderSavedAndDraft("new", pair.right.new)
                          : null}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Disclosure>
    </div>
  );
}

export interface ChangesPanelProps {
  connection?: Connection;
  online: boolean;
  sessionId?: string;
  cwd?: string;
  view?: SessionView;
  actions?: InspectorSessionActions;
  onStatsChange?: (stats: ChangesStatsSummary) => void;
  onBranchChange?: (branch: string | undefined) => void;
  onOpenFile?: (specOrPath: string) => void;
}

export function ChangesPanel({
  connection,
  online,
  sessionId,
  cwd,
  view,
  actions,
  onStatsChange,
  onBranchChange,
  onOpenFile,
}: ChangesPanelProps) {
  const { t, ti } = useInspectorI18n();
  const dialogs = useDialogs();

  const sessionEntries = useMemo(
    () => extractSessionChanges(view, cwd),
    [view, cwd],
  );
  const [sourceMode, setSourceMode] = useState<ChangesSourceMode>(() =>
    sessionId ? "session" : "git",
  );
  const [layoutMode, setLayoutMode] = useState<DiffLayoutMode>("unified");
  const [gitFiles, setGitFiles] = useState<GitDiffFile[]>([]);
  const [gitBranch, setGitBranch] = useState<string | undefined>(undefined);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitTrayOpen, setCommitTrayOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitFeedback, setCommitFeedback] = useState<string | null>(null);
  const [activeDraft, setActiveDraft] = useState<ActiveCommentDraft | null>(
    null,
  );
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>(
    {},
  );
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const autoSwitchedRef = useRef<string | undefined>(undefined);

  const reviewKey = sessionId ?? (cwd ? `cwd:${cwd}` : "inspector");
  const comments = useDiffReviews(reviewKey);

  const loadGitDiff = useCallback(async () => {
    if (!connection || !online || !cwd) return;
    setGitLoading(true);
    setGitError(null);
    try {
      const res = await connection.link.call("git.diff", {
        cwd,
        includeUntracked: true,
      });
      const nextFiles = Array.isArray(res?.files) ? res.files : [];
      setGitFiles(nextFiles);
      setGitBranch(res?.branch);
      onBranchChange?.(res?.branch);
      if (
        sessionEntries.length === 0 &&
        nextFiles.length > 0 &&
        autoSwitchedRef.current !== cwd
      ) {
        autoSwitchedRef.current = cwd;
        setSourceMode("git");
      }
    } catch (err) {
      setGitFiles([]);
      setGitError(err instanceof Error ? err.message : ti("notGitRepo"));
    } finally {
      setGitLoading(false);
    }
  }, [connection, online, cwd, sessionEntries.length, ti, onBranchChange]);

  useEffect(() => {
    void loadGitDiff();
  }, [loadGitDiff]);

  const gitEntries = useMemo(
    () => mapGitDiffFiles(gitFiles, cwd),
    [gitFiles, cwd],
  );
  const activeEntries =
    sourceMode === "git" || !sessionId ? gitEntries : sessionEntries;

  const compactTree = useMemo(
    () => buildCompactChangeTree(activeEntries),
    [activeEntries],
  );

  const activeStats = useMemo<ChangesStatsSummary>(() => {
    let added = 0;
    let removed = 0;
    for (const item of activeEntries) {
      added += item.added;
      removed += item.removed;
    }
    return { files: activeEntries.length, added, removed };
  }, [activeEntries]);

  useEffect(() => {
    onStatsChange?.(activeStats);
  }, [activeStats, onStatsChange]);

  const handleSelectTreeFile = useCallback((entry: UnifiedChangeEntry) => {
    setSelectedFileKey(entry.key);
    setOpenOverrides((prev) => ({ ...prev, [entry.key]: true }));
    const targetEl = cardRefs.current.get(entry.key);
    if (targetEl && typeof targetEl.scrollIntoView === "function") {
      targetEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, []);

  const handleCommit = useCallback(async () => {
    const trimmed = commitMessage.trim();
    if (!trimmed || !connection || !cwd || committing) return;
    setCommitting(true);
    setCommitFeedback(null);
    try {
      const res = await connection.link.call("git.commit", {
        cwd,
        message: trimmed,
        stageAll: true,
      });
      setCommitMessage("");
      setCommitTrayOpen(false);
      setCommitFeedback(ti("commitSuccess", { hash: res.sha.slice(0, 7) }));
      await loadGitDiff();
    } catch (err) {
      await dialogs.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, connection, cwd, committing, ti, loadGitDiff, dialogs]);

  const handleRevertFile = useCallback(
    async (filePath: string) => {
      if (!connection || !cwd) return;
      const confirmed = await dialogs.confirm(
        ti("revertConfirmBody", { path: toRepoRelativePath(filePath, cwd) }),
        {
          title: ti("revertConfirmTitle"),
          confirmLabel: t("desktop.inspector.revertFile"),
          cancelLabel: ti("cancel"),
          destructive: true,
        },
      );
      if (!confirmed) return;
      try {
        await connection.link.call("git.revertFile", { cwd, path: filePath });
        await loadGitDiff();
      } catch (err) {
        await dialogs.alert(err instanceof Error ? err.message : String(err));
      }
    },
    [connection, cwd, dialogs, ti, t, loadGitDiff],
  );

  const handleSendAllComments = useCallback(async () => {
    if (!actions || comments.length === 0) return;
    const prompt = formatDiffReviewPrompt(comments);
    if (!prompt) return;
    try {
      await actions.send(prompt);
      diffReviewStore.getState().clearSession(reviewKey);
    } catch (err) {
      await dialogs.alert(err instanceof Error ? err.message : String(err));
    }
  }, [actions, comments, reviewKey, dialogs]);

  const handleSaveDraft = useCallback(
    async (sendImmediately: boolean) => {
      if (!activeDraft || !activeDraft.text.trim()) return;
      const created = diffReviewStore.getState().addComment({
        sessionKey: reviewKey,
        path: activeDraft.path,
        side: activeDraft.side,
        startLine: activeDraft.line,
        endLine: activeDraft.line,
        excerpt: activeDraft.excerpt,
        comment: activeDraft.text.trim(),
      });
      setActiveDraft(null);
      if (sendImmediately && actions) {
        const allForPrompt = [...comments, created];
        const prompt = formatDiffReviewPrompt(allForPrompt);
        try {
          await actions.send(prompt);
          diffReviewStore.getState().clearSession(reviewKey);
        } catch (err) {
          await dialogs.alert(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [activeDraft, reviewKey, actions, comments, dialogs],
  );

  return (
    <div className="inspector-panel-fill">
      {/* Single Clean Changes Header Row: branch + uncommitted +X -Y + scope/view + refresh/commit */}
      <div className="inspector-paseo-branchbar">
        <div className="inspector-subbar-group" style={{ minInlineSize: 0 }}>
          {gitBranch ? (
            <span className="inspector-branch-pill">
              <DesktopIcon name="git-branch" size="xs" />
              <span className="ls-truncate">{gitBranch}</span>
            </span>
          ) : null}

          <span className="inspector-change-tree-stat" data-tabular="">
            <span className="inspector-diff-stat-add">
              +{formatCompactStat(activeStats.added)}
            </span>
            <span className="inspector-diff-stat-del">
              -{formatCompactStat(activeStats.removed)}
            </span>
          </span>

          {sessionId ? (
            <div
              className="inspector-segmented"
              role="group"
              aria-label={t("desktop.inspector.changes")}
            >
              <button
                type="button"
                className="inspector-segmented-btn"
                aria-pressed={sourceMode === "session"}
                aria-label={t("desktop.inspector.sessionChanges")}
                title={t("desktop.inspector.sessionChanges")}
                onClick={() => setSourceMode("session")}
              >
                <span>{ti("scopeSessionShort")}</span>
              </button>
              <button
                type="button"
                className="inspector-segmented-btn"
                aria-pressed={sourceMode === "git"}
                aria-label={t("desktop.inspector.gitWorkspace")}
                title={t("desktop.inspector.gitWorkspace")}
                onClick={() => setSourceMode("git")}
              >
                <span>{ti("scopeGitShort")}</span>
              </button>
            </div>
          ) : null}
        </div>

        <div className="inspector-subbar-group" style={{ flexShrink: 0 }}>
          <div
            className="inspector-segmented"
            role="group"
            aria-label={t("desktop.timeline.unifiedDiff")}
          >
            <button
              type="button"
              className="inspector-segmented-btn"
              aria-pressed={layoutMode === "unified"}
              aria-label={t("desktop.timeline.unifiedDiff")}
              title={t("desktop.timeline.unifiedDiff")}
              onClick={() => setLayoutMode("unified")}
            >
              <DesktopIcon name="unified-diff" size="xs" />
            </button>
            <button
              type="button"
              className="inspector-segmented-btn"
              aria-pressed={layoutMode === "split"}
              aria-label={t("desktop.timeline.splitDiff")}
              title={t("desktop.timeline.splitDiff")}
              onClick={() => setLayoutMode("split")}
            >
              <DesktopIcon name="split-columns" size="xs" />
            </button>
          </div>

          <IconButton
            icon="refresh"
            size="icon-sm"
            label={ti("refresh")}
            loading={gitLoading}
            disabled={!online || !cwd}
            disabledReason={!online ? ti("offlineTitle") : undefined}
            onClick={() => {
              void loadGitDiff();
            }}
          />

          {cwd &&
          (sourceMode === "git" || gitEntries.length > 0 || Boolean(actions)) ? (
            <Button
              size="xs"
              variant={commitTrayOpen ? "secondary" : "ghost"}
              leadingIcon="git-commit"
              aria-expanded={commitTrayOpen}
              data-commit-toggle="true"
              onClick={() => setCommitTrayOpen((prev) => !prev)}
            >
              {ti("commitShort")}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Collapsible Commit & Quick Agent Actions Tray */}
      {cwd && commitTrayOpen ? (
        <div className="inspector-commit-tray">
          <div className="inspector-commit-bar">
            <Input
              size="sm"
              className="inspector-commit-input"
              value={commitMessage}
              placeholder={ti("commitPlaceholder")}
              aria-label={t("desktop.inspector.commit")}
              disabled={!online || gitEntries.length === 0 || committing}
              onChange={(e) => setCommitMessage(e.target.value)}
              onEnterSubmit={() => {
                void handleCommit();
              }}
            />
            <Button
              size="sm"
              variant="primary"
              className="inspector-keycap-btn"
              leadingIcon="git-commit"
              loading={committing}
              disabled={
                !online || !commitMessage.trim() || gitEntries.length === 0
              }
              disabledReason={
                !online
                  ? ti("offlineTitle")
                  : gitEntries.length === 0
                    ? ti("noGitChangesTitle")
                    : undefined
              }
              onClick={() => {
                void handleCommit();
              }}
            >
              {t("desktop.inspector.commit")}
            </Button>
          </div>

          {actions ? (
            <div className="inspector-commit-agent-row">
              <Button
                size="xs"
                variant="ghost"
                leadingIcon="git-pull-request"
                disabled={!online}
                disabledReason={!online ? ti("offlineTitle") : undefined}
                onClick={() => {
                  void actions.send(ti("askCommitPrompt"));
                  setCommitTrayOpen(false);
                }}
              >
                {t("desktop.inspector.askAgentCommit")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                leadingIcon="play"
                disabled={!online}
                disabledReason={!online ? ti("offlineTitle") : undefined}
                onClick={() => {
                  void actions.send(ti("askTestPrompt"));
                  setCommitTrayOpen(false);
                }}
              >
                {t("desktop.inspector.askAgentTest")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="inspector-panel-scroll">
        {commitFeedback ? (
          <div className="inspector-banner" data-tone="accent" role="status">
            <span>{commitFeedback}</span>
            <IconButton
              icon="close"
              size="icon-sm"
              label={ti("cancel")}
              onClick={() => setCommitFeedback(null)}
            />
          </div>
        ) : null}

        {comments.length > 0 ? (
          <div className="inspector-banner" data-tone="accent">
            <span data-tabular="">
              {t("desktop.timeline.submitReview", { count: comments.length })}
            </span>
            <div className="inspector-subbar-group">
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  diffReviewStore.getState().clearSession(reviewKey)
                }
              >
                {ti("clearComments")}
              </Button>
              {actions ? (
                <Button
                  size="xs"
                  variant="primary"
                  className="inspector-keycap-btn"
                  leadingIcon="send-to-agent"
                  onClick={() => {
                    void handleSendAllComments();
                  }}
                >
                  {ti("sendCommentsNow")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {gitError && sourceMode === "git" ? (
          <EmptyState
            compact
            icon="git-branch"
            title={ti("notGitRepo")}
            description={gitError}
          />
        ) : activeEntries.length === 0 ? (
          <EmptyState
            compact
            icon="diff-changes"
            title={
              sourceMode === "git"
                ? ti("noGitChangesTitle")
                : ti("noSessionChangesTitle")
            }
            description={
              sourceMode === "git"
                ? ti("noGitChangesDesc")
                : ti("noSessionChangesDesc")
            }
            actions={
              sourceMode === "session" && cwd ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon="git-branch"
                  onClick={() => setSourceMode("git")}
                >
                  {t("desktop.inspector.gitWorkspace")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Paseo Hierarchical Indented Directory & File Tree */}
            <ChangesDirectoryTree
              nodes={compactTree}
              selectedKey={selectedFileKey}
              onSelectFile={handleSelectTreeFile}
              onRevertFile={
                sourceMode === "git"
                  ? (p) => {
                      void handleRevertFile(p);
                    }
                  : undefined
              }
            />

            {/* Crisp Shiki Diff Cards */}
            {activeEntries.map((entry, idx) => {
              const isOpen = openOverrides[entry.key] ?? idx < 8;
              return (
                <DiffFileCard
                  key={entry.key}
                  entry={entry}
                  layout={layoutMode}
                  isOpen={isOpen}
                  onOpenChange={(nextOpen) =>
                    setOpenOverrides((prev) => ({
                      ...prev,
                      [entry.key]: nextOpen,
                    }))
                  }
                  cardRef={(el) => {
                    if (el) {
                      cardRefs.current.set(entry.key, el);
                    } else {
                      cardRefs.current.delete(entry.key);
                    }
                  }}
                  sessionKey={reviewKey}
                  comments={comments}
                  activeDraft={activeDraft}
                  onOpenDraft={setActiveDraft}
                  onChangeDraft={(text) =>
                    setActiveDraft((prev) => (prev ? { ...prev, text } : null))
                  }
                  onCancelDraft={() => setActiveDraft(null)}
                  onSaveDraft={(sendNow) => {
                    void handleSaveDraft(sendNow);
                  }}
                  onRemoveComment={(id) =>
                    diffReviewStore.getState().removeComment(reviewKey, id)
                  }
                  onRevertFile={
                    entry.canRevert
                      ? (p) => {
                          void handleRevertFile(p);
                        }
                      : undefined
                  }
                  onOpenFile={onOpenFile}
                  canSendToAgent={Boolean(actions)}
                />
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
