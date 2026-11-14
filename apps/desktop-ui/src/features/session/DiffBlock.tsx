import { useMemo, useState } from "react";
import {
  changeLines,
  changeStat,
  hunks,
  type DiffHunk,
  type DiffLine,
} from "@linkshell/client-core";
import type { ToolCallContent } from "@linkshell/wire";
import {
  diffReviewStore,
  useDiffReviews,
  useT,
  type DiffReviewComment,
} from "@/core";
import { DesktopIcon } from "@/icons";
import { Button, IconButton, Tooltip } from "@/primitives";
import { openFileInInspector, useSessionCopy } from "./session-helpers";

export type DiffOrPatchContent = Extract<ToolCallContent, { type: "diff" | "patch" }>;

export interface DiffStatBadgeProps {
  added: number;
  removed: number;
}

/** Strict visual-system invariant: `+added −removed` with `tabular-nums`, omitting zero sides (never `-0`). */
export function DiffStatBadge({ added, removed }: DiffStatBadgeProps) {
  if (added <= 0 && removed <= 0) return null;
  return (
    <span className="ls-diff-stat">
      {added > 0 && <span className="ls-diff-stat-add">+{added}</span>}
      {removed > 0 && <span className="ls-diff-stat-del">−{removed}</span>}
    </span>
  );
}

interface SplitPair {
  oldLine?: DiffLine;
  newLine?: DiffLine;
}

function pairHunkLinesForSplit(lines: readonly DiffLine[]): SplitPair[] {
  const pairs: SplitPair[] = [];
  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx]!;
    if (line.kind === "same") {
      pairs.push({ oldLine: line, newLine: line });
      idx++;
      continue;
    }
    const removedRun: DiffLine[] = [];
    while (idx < lines.length && lines[idx]!.kind === "del") {
      removedRun.push(lines[idx]!);
      idx++;
    }
    const addedRun: DiffLine[] = [];
    while (idx < lines.length && lines[idx]!.kind === "add") {
      addedRun.push(lines[idx]!);
      idx++;
    }
    const span = Math.max(removedRun.length, addedRun.length);
    for (let k = 0; k < span; k++) {
      pairs.push({
        oldLine: removedRun[k],
        newLine: addedRun[k],
      });
    }
  }
  return pairs;
}

function buildHunksForChange(change: DiffOrPatchContent): DiffHunk[] {
  return hunks(changeLines(change));
}

export interface DiffBlockProps {
  change: DiffOrPatchContent;
  computerKey: string;
  sessionId?: string;
  sessionKey?: string;
}

export function DiffBlock({
  change,
  computerKey,
  sessionId,
  sessionKey,
}: DiffBlockProps) {
  const t = useT();
  const copy = useSessionCopy();
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const [draftAnchor, setDraftAnchor] = useState<{
    side: "old" | "new";
    line: number;
    excerpt: string;
  } | null>(null);
  const [draftComment, setDraftComment] = useState("");

  const filePath = change.type === "patch" ? change.movePath ?? change.path : change.path;
  const stat = useMemo(() => changeStat(change), [change]);
  const parsedHunks = useMemo(() => buildHunksForChange(change), [change]);
  const allReviews = useDiffReviews(sessionKey);
  const fileReviews = useMemo(
    () => allReviews.filter((entry) => entry.path === filePath),
    [allReviews, filePath],
  );

  const openEditorForLine = (side: "old" | "new", lineNumber: number | undefined, text: string) => {
    if (!sessionKey || lineNumber === undefined) return;
    setDraftAnchor({ side, line: lineNumber, excerpt: text });
    setDraftComment("");
  };

  const submitLineComment = () => {
    if (!sessionKey || !draftAnchor || !draftComment.trim()) return;
    diffReviewStore.getState().addComment({
      sessionKey,
      path: filePath,
      side: draftAnchor.side,
      startLine: draftAnchor.line,
      endLine: draftAnchor.line,
      excerpt: draftAnchor.excerpt,
      comment: draftComment.trim(),
    });
    setDraftAnchor(null);
    setDraftComment("");
  };

  return (
    <div className="ls-diff-block">
      <div className="ls-diff-header">
        <button
          type="button"
          className="ls-diff-path"
          onClick={() => openFileInInspector(computerKey, sessionId, filePath)}
          title={filePath}
        >
          <DesktopIcon name="diff-changes" size="xs" />
          <span>{filePath}</span>
        </button>

        <div className="ls-diff-controls">
          <DiffStatBadge added={stat.added} removed={stat.removed} />
          <div className="ls-diff-mode-toggle" role="group" aria-label="Diff view mode">
            <Tooltip content={t("desktop.timeline.unifiedDiff")}>
              <button
                type="button"
                className="ls-diff-mode-btn"
                data-active={mode === "unified"}
                aria-label={t("desktop.timeline.unifiedDiff")}
                onClick={() => setMode("unified")}
              >
                <DesktopIcon name="unified-diff" size="xs" />
              </button>
            </Tooltip>
            <Tooltip content={t("desktop.timeline.splitDiff")}>
              <button
                type="button"
                className="ls-diff-mode-btn"
                data-active={mode === "split"}
                aria-label={t("desktop.timeline.splitDiff")}
                onClick={() => setMode("split")}
              >
                <DesktopIcon name="split-columns" size="xs" />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      <div className="ls-diff-scroll" tabIndex={0}>
        {mode === "unified" ? (
          <table className="ls-diff-table">
            <tbody>
              {parsedHunks.map((hunk, hunkIdx) => (
                <UnifiedHunkRows
                  key={hunkIdx}
                  hunk={hunk}
                  showSeparator={hunkIdx > 0}
                  canComment={Boolean(sessionKey)}
                  commentLabel={t("desktop.timeline.addLineComment")}
                  reviews={fileReviews}
                  draftAnchor={draftAnchor}
                  draftComment={draftComment}
                  onDraftCommentChange={setDraftComment}
                  onOpenComment={openEditorForLine}
                  onSubmitComment={submitLineComment}
                  onCancelComment={() => setDraftAnchor(null)}
                  onDeleteReview={(id) =>
                    sessionKey && diffReviewStore.getState().removeComment(sessionKey, id)
                  }
                  copy={copy}
                />
              ))}
            </tbody>
          </table>
        ) : (
          <div className="ls-diff-split">
            {parsedHunks.map((hunk, hunkIdx) => {
              const pairs = pairHunkLinesForSplit(hunk.lines);
              return (
                <div key={hunkIdx} style={{ display: "contents" }}>
                  {hunkIdx > 0 && (
                    <>
                      <div className="ls-diff-hunk-sep">⋯</div>
                      <div className="ls-diff-hunk-sep">⋯</div>
                    </>
                  )}
                  {pairs.map((pair, pairIdx) => (
                    <div key={pairIdx} style={{ display: "contents" }}>
                      <SplitCell
                        line={pair.oldLine}
                        side="old"
                        canComment={Boolean(sessionKey)}
                        commentLabel={t("desktop.timeline.addLineComment")}
                        onOpenComment={openEditorForLine}
                      />
                      <SplitCell
                        line={pair.newLine}
                        side="new"
                        canComment={Boolean(sessionKey)}
                        commentLabel={t("desktop.timeline.addLineComment")}
                        onOpenComment={openEditorForLine}
                      />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {mode === "split" && (draftAnchor || fileReviews.length > 0) && (
        <div>
          {fileReviews.map((review) => (
            <SavedCommentRow
              key={review.id}
              review={review}
              deleteLabel={copy.deleteComment}
              onDelete={() =>
                sessionKey && diffReviewStore.getState().removeComment(sessionKey, review.id)
              }
            />
          ))}
          {draftAnchor && (
            <InlineCommentComposer
              lineLabel={`L${draftAnchor.line}`}
              value={draftComment}
              onChange={setDraftComment}
              onSave={submitLineComment}
              onCancel={() => setDraftAnchor(null)}
              copy={copy}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface UnifiedHunkRowsProps {
  hunk: DiffHunk;
  showSeparator: boolean;
  canComment: boolean;
  commentLabel: string;
  reviews: readonly DiffReviewComment[];
  draftAnchor: { side: "old" | "new"; line: number; excerpt: string } | null;
  draftComment: string;
  onDraftCommentChange: (next: string) => void;
  onOpenComment: (side: "old" | "new", line: number | undefined, text: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
  onDeleteReview: (id: string) => void;
  copy: ReturnType<typeof useSessionCopy>;
}

function UnifiedHunkRows({
  hunk,
  showSeparator,
  canComment,
  commentLabel,
  reviews,
  draftAnchor,
  draftComment,
  onDraftCommentChange,
  onOpenComment,
  onSubmitComment,
  onCancelComment,
  onDeleteReview,
  copy,
}: UnifiedHunkRowsProps) {
  return (
    <>
      {showSeparator && (
        <tr>
          <td colSpan={4} className="ls-diff-hunk-sep">
            ⋯
          </td>
        </tr>
      )}
      {hunk.lines.map((line, idx) => {
        const side: "old" | "new" = line.kind === "del" ? "old" : "new";
        const lineNum = side === "old" ? line.old : line.new;
        const matchingReviews = reviews.filter(
          (item) => item.side === side && item.startLine === lineNum,
        );
        const isEditingThis =
          draftAnchor !== null && draftAnchor.side === side && draftAnchor.line === lineNum;
        const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";

        return (
          <UnifiedLineFragment
            key={idx}
            line={line}
            sign={sign}
            canComment={canComment && lineNum !== undefined}
            commentLabel={commentLabel}
            onCommentClick={() => onOpenComment(side, lineNum, line.text)}
            matchingReviews={matchingReviews}
            isEditingThis={isEditingThis}
            draftComment={draftComment}
            onDraftCommentChange={onDraftCommentChange}
            onSubmitComment={onSubmitComment}
            onCancelComment={onCancelComment}
            onDeleteReview={onDeleteReview}
            copy={copy}
          />
        );
      })}
    </>
  );
}

function UnifiedLineFragment({
  line,
  sign,
  canComment,
  commentLabel,
  onCommentClick,
  matchingReviews,
  isEditingThis,
  draftComment,
  onDraftCommentChange,
  onSubmitComment,
  onCancelComment,
  onDeleteReview,
  copy,
}: {
  line: DiffLine;
  sign: string;
  canComment: boolean;
  commentLabel: string;
  onCommentClick: () => void;
  matchingReviews: readonly DiffReviewComment[];
  isEditingThis: boolean;
  draftComment: string;
  onDraftCommentChange: (next: string) => void;
  onSubmitComment: () => void;
  onCancelComment: () => void;
  onDeleteReview: (id: string) => void;
  copy: ReturnType<typeof useSessionCopy>;
}) {
  return (
    <>
      <tr className="ls-diff-row" data-kind={line.kind}>
        <td className="ls-diff-ln">{line.old ?? ""}</td>
        <td className="ls-diff-ln">{line.new ?? ""}</td>
        <td className="ls-diff-sign">{sign}</td>
        <td className="ls-diff-code">
          {canComment && (
            <button
              type="button"
              className="ls-diff-comment-btn"
              aria-label={commentLabel}
              title={commentLabel}
              onClick={onCommentClick}
            >
              +
            </button>
          )}
          {line.text || " "}
        </td>
      </tr>
      {matchingReviews.map((review) => (
        <tr key={review.id}>
          <td colSpan={4}>
            <SavedCommentRow
              review={review}
              deleteLabel={copy.deleteComment}
              onDelete={() => onDeleteReview(review.id)}
            />
          </td>
        </tr>
      ))}
      {isEditingThis && (
        <tr>
          <td colSpan={4}>
            <InlineCommentComposer
              lineLabel={`L${line.kind === "del" ? line.old : line.new}`}
              value={draftComment}
              onChange={onDraftCommentChange}
              onSave={onSubmitComment}
              onCancel={onCancelComment}
              copy={copy}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function SplitCell({
  line,
  side,
  canComment,
  commentLabel,
  onOpenComment,
}: {
  line: DiffLine | undefined;
  side: "old" | "new";
  canComment: boolean;
  commentLabel: string;
  onOpenComment: (side: "old" | "new", line: number | undefined, text: string) => void;
}) {
  if (!line) {
    return (
      <div className="ls-diff-split-pane" data-kind="empty">
        <table className="ls-diff-table">
          <tbody>
            <tr className="ls-diff-row">
              <td className="ls-diff-ln" />
              <td className="ls-diff-code"> </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }
  const lineNumber = side === "old" ? line.old : line.new;
  const kind =
    side === "old"
      ? line.kind === "del"
        ? "del"
        : "same"
      : line.kind === "add"
        ? "add"
        : "same";
  return (
    <div className="ls-diff-split-pane">
      <table className="ls-diff-table">
        <tbody>
          <tr className="ls-diff-row" data-kind={kind}>
            <td className="ls-diff-ln">{lineNumber ?? ""}</td>
            <td className="ls-diff-code">
              {canComment && lineNumber !== undefined && (
                <button
                  type="button"
                  className="ls-diff-comment-btn"
                  aria-label={commentLabel}
                  onClick={() => onOpenComment(side, lineNumber, line.text)}
                >
                  +
                </button>
              )}
              {line.text || " "}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function SavedCommentRow({
  review,
  deleteLabel,
  onDelete,
}: {
  review: DiffReviewComment;
  deleteLabel: string;
  onDelete: () => void;
}) {
  return (
    <div className="ls-diff-saved-comment">
      <div>
        <strong style={{ marginInlineEnd: 6 }}>L{review.startLine}:</strong>
        <span>{review.comment}</span>
      </div>
      <IconButton
        icon="trash"
        size="icon-sm"
        label={deleteLabel}
        onClick={onDelete}
      />
    </div>
  );
}

function InlineCommentComposer({
  lineLabel,
  value,
  onChange,
  onSave,
  onCancel,
  copy,
}: {
  lineLabel: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
  copy: ReturnType<typeof useSessionCopy>;
}) {
  return (
    <div className="ls-diff-comment-box">
      <div className="ls-composer-chip-desc">{lineLabel}</div>
      <textarea
        className="ls-diff-comment-input"
        rows={2}
        value={value}
        placeholder={copy.reviewPlaceholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        autoFocus
      />
      <div className="ls-diff-comment-actions">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {copy.cancelAction}
        </Button>
        <Button size="sm" variant="primary" disabled={!value.trim()} onClick={onSave}>
          {copy.saveComment}
        </Button>
      </div>
    </div>
  );
}
