import { useMemo, useState, type ReactNode } from "react";
import {
  changeLines,
  changeStat,
  hunks,
  type DiffHunk,
  type DiffLine,
} from "@linkshell/client-core";
import type { ToolCallContent } from "@linkshell/wire";
import {
  diffReviewSessionKey,
  diffReviewStore,
  grammarForPath,
  normalizeReviewPath,
  useDiffReviews,
  useHighlight,
  useT,
  type DiffReviewComment,
  type HighlightToken,
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

export interface DiffBlockProps {
  change: DiffOrPatchContent;
  computerKey: string;
  sessionId?: string;
  sessionKey?: string;
  cwd?: string;
}

export function DiffBlock({
  change,
  computerKey,
  sessionId,
  sessionKey,
  cwd,
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
  const reviewPath = useMemo(() => normalizeReviewPath(filePath, cwd), [filePath, cwd]);
  const reviewKey = diffReviewSessionKey(computerKey, sessionId) ?? sessionKey;
  const stat = useMemo(() => changeStat(change), [change]);
  const parsedHunks = useMemo(() => buildHunksForChange(change), [change]);
  const splitHunks = useMemo(
    () =>
      parsedHunks.map((hunk) => ({
        hunk,
        pairs: pairHunkLinesForSplit(hunk.lines),
      })),
    [parsedHunks],
  );

  // Highlight old and new sides in separate buffers so deleted syntax constructs cannot
  // corrupt tokenization for added/context lines in either unified or split view.
  const { oldCode, newCode, lineTokenIndex } = useMemo(() => {
    const indexMap = new Map<DiffLine, { oldIdx?: number; newIdx?: number }>();
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const hunk of parsedHunks) {
      for (const line of hunk.lines) {
        let oldIdx: number | undefined;
        let newIdx: number | undefined;
        if (line.kind !== "add") {
          oldIdx = oldLines.length;
          oldLines.push(line.text);
        }
        if (line.kind !== "del") {
          newIdx = newLines.length;
          newLines.push(line.text);
        }
        indexMap.set(line, { oldIdx, newIdx });
      }
    }
    return {
      oldCode: oldLines.join("\n"),
      newCode: newLines.join("\n"),
      lineTokenIndex: indexMap,
    };
  }, [parsedHunks]);

  const language = useMemo(() => grammarForPath(reviewPath), [reviewPath]);
  const oldTokens = useHighlight(oldCode, language, oldCode.length > 0);
  const newTokens = useHighlight(newCode, language, newCode.length > 0);
  const tokensForLine = (line: DiffLine, side: "old" | "new") => {
    const slot = lineTokenIndex.get(line);
    if (!slot) return undefined;
    if (side === "old") {
      return slot.oldIdx !== undefined ? oldTokens?.[slot.oldIdx] : undefined;
    }
    return slot.newIdx !== undefined ? newTokens?.[slot.newIdx] : undefined;
  };

  const allReviews = useDiffReviews(reviewKey);
  const fileReviews = useMemo(
    () => allReviews.filter((entry) => entry.path === reviewPath),
    [allReviews, reviewPath],
  );

  const openEditorForLine = (side: "old" | "new", lineNumber: number | undefined, text: string) => {
    if (!reviewKey || lineNumber === undefined) return;
    setDraftAnchor({ side, line: lineNumber, excerpt: text });
    setDraftComment("");
  };

  const submitLineComment = () => {
    if (!reviewKey || !draftAnchor || !draftComment.trim()) return;
    diffReviewStore.getState().addComment({
      sessionKey: reviewKey,
      path: reviewPath,
      side: draftAnchor.side,
      startLine: draftAnchor.line,
      endLine: draftAnchor.line,
      excerpt: draftAnchor.excerpt,
      comment: draftComment.trim(),
    });
    setDraftAnchor(null);
    setDraftComment("");
  };

  const removeReview = (id: string) => {
    if (reviewKey) diffReviewStore.getState().removeComment(reviewKey, id);
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
          <span>{reviewPath}</span>
        </button>

        <div className="ls-diff-controls">
          <DiffStatBadge added={stat.added} removed={stat.removed} />
          <div className="ls-diff-mode-toggle" role="group" aria-label={copy.diffViewMode}>
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
                  canComment={Boolean(reviewKey)}
                  commentLabel={t("desktop.timeline.addLineComment")}
                  reviews={fileReviews}
                  draftAnchor={draftAnchor}
                  draftComment={draftComment}
                  onDraftCommentChange={setDraftComment}
                  onOpenComment={openEditorForLine}
                  onSubmitComment={submitLineComment}
                  onCancelComment={() => setDraftAnchor(null)}
                  onDeleteReview={removeReview}
                  tokensForLine={tokensForLine}
                  copy={copy}
                />
              ))}
            </tbody>
          </table>
        ) : (
          <div className="ls-diff-split-hunks">
            {splitHunks.map(({ pairs }, hunkIdx) => (
              <div key={hunkIdx}>
                {hunkIdx > 0 && <div className="ls-diff-hunk-sep">⋯</div>}
                <table className="ls-diff-table ls-diff-split-table">
                  <colgroup>
                    <col className="ls-diff-col-ln" />
                    <col className="ls-diff-col-code" />
                    <col className="ls-diff-col-ln" />
                    <col className="ls-diff-col-code" />
                  </colgroup>
                  <tbody>
                    {pairs.map((pair, pairIdx) => (
                      <SplitPairRows
                        key={pairIdx}
                        pair={pair}
                        canComment={Boolean(reviewKey)}
                        commentLabel={t("desktop.timeline.addLineComment")}
                        reviews={fileReviews}
                        draftAnchor={draftAnchor}
                        draftComment={draftComment}
                        onDraftCommentChange={setDraftComment}
                        onOpenComment={openEditorForLine}
                        onSubmitComment={submitLineComment}
                        onCancelComment={() => setDraftAnchor(null)}
                        onDeleteReview={removeReview}
                        tokensForLine={tokensForLine}
                        copy={copy}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>
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
  tokensForLine: (line: DiffLine, side: "old" | "new") => HighlightToken[] | undefined;
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
  tokensForLine,
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
            tokens={tokensForLine(line, side)}
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
  tokens,
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
  tokens: HighlightToken[] | undefined;
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
          {renderTokenLine(tokens, line.text)}
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

function SplitPairRows({
  pair,
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
  tokensForLine,
  copy,
}: {
  pair: SplitPair;
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
  tokensForLine: (line: DiffLine, side: "old" | "new") => HighlightToken[] | undefined;
  copy: ReturnType<typeof useSessionCopy>;
}) {
  const leftLine = pair.oldLine;
  const rightLine = pair.newLine;
  const leftNum = leftLine?.old;
  const rightNum = rightLine?.new;
  const leftKind = !leftLine ? "empty" : leftLine.kind === "del" ? "del" : "same";
  const rightKind = !rightLine ? "empty" : rightLine.kind === "add" ? "add" : "same";

  const leftReviews =
    leftNum !== undefined
      ? reviews.filter((item) => item.side === "old" && item.startLine === leftNum)
      : [];
  const rightReviews =
    rightNum !== undefined
      ? reviews.filter((item) => item.side === "new" && item.startLine === rightNum)
      : [];
  const editingLeft =
    draftAnchor !== null && draftAnchor.side === "old" && leftNum !== undefined && draftAnchor.line === leftNum;
  const editingRight =
    draftAnchor !== null && draftAnchor.side === "new" && rightNum !== undefined && draftAnchor.line === rightNum;

  return (
    <>
      <tr className="ls-diff-row ls-diff-split-tr">
        <td className="ls-diff-ln ls-diff-split-cell" data-kind={leftKind}>
          {leftNum ?? ""}
        </td>
        <td className="ls-diff-code ls-diff-split-cell ls-diff-split-divider" data-kind={leftKind}>
          {leftLine ? (
            <>
              {canComment && leftNum !== undefined && (
                <button
                  type="button"
                  className="ls-diff-comment-btn"
                  aria-label={commentLabel}
                  title={commentLabel}
                  onClick={() => onOpenComment("old", leftNum, leftLine.text)}
                >
                  +
                </button>
              )}
              {renderTokenLine(tokensForLine(leftLine, "old"), leftLine.text)}
            </>
          ) : (
            " "
          )}
        </td>
        <td className="ls-diff-ln ls-diff-split-cell" data-kind={rightKind}>
          {rightNum ?? ""}
        </td>
        <td className="ls-diff-code ls-diff-split-cell" data-kind={rightKind}>
          {rightLine ? (
            <>
              {canComment && rightNum !== undefined && (
                <button
                  type="button"
                  className="ls-diff-comment-btn"
                  aria-label={commentLabel}
                  title={commentLabel}
                  onClick={() => onOpenComment("new", rightNum, rightLine.text)}
                >
                  +
                </button>
              )}
              {renderTokenLine(tokensForLine(rightLine, "new"), rightLine.text)}
            </>
          ) : (
            " "
          )}
        </td>
      </tr>
      {leftReviews.map((review) => (
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
      {editingLeft && (
        <tr>
          <td colSpan={4}>
            <InlineCommentComposer
              lineLabel={`L${leftNum}`}
              value={draftComment}
              onChange={onDraftCommentChange}
              onSave={onSubmitComment}
              onCancel={onCancelComment}
              copy={copy}
            />
          </td>
        </tr>
      )}
      {rightReviews.map((review) => (
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
      {editingRight && (
        <tr>
          <td colSpan={4}>
            <InlineCommentComposer
              lineLabel={`L${rightNum}`}
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
