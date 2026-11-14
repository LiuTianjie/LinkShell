import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import {
  ELAPSED_FROM,
  cardsAtTurnEnd,
  cleanAgentHeartbeatText,
  describeFailures,
  describeSteps,
  exitNote,
  foldStepRuns,
  isQuietTool,
  liveActivity,
  openWrapUp,
  presentError,
  proposedPlan,
  questionReplies,
  reconnectLabel,
  reconnectOf,
  startedSession,
  t as translateCore,
  tallySteps,
  toolAction,
  toolCommand,
  toolLabel,
  toolLabelParts,
  toolOutcome,
  toolOutput,
  toolPath,
  userEventLabel,
  userMessageText,
  userMessageView,
  wrapUpOf,
  type SessionView,
  type Step,
  type TimelineItem,
  type ToolItem,
} from "@linkshell/client-core";
import type { ContentBlock, SessionSummary } from "@linkshell/wire";
import {
  changeStat,
  reportDesktopError,
  routerStore,
  sessionTitle,
  useI18n,
  useT,
  type Connection,
} from "@/core";
import { DesktopIcon, SubagentGlyph } from "@/icons";
import {
  Badge,
  Button,
  CollapsibleLog,
  CopyButton,
  Dialog,
  DialogBody,
  DialogHeader,
  DialogTitle,
  IconButton,
  StatusDot,
  Tooltip,
} from "@/primitives";
import { ApprovalCard, AsyncQuestionsBar } from "./ApprovalQuestionCards";
import { DiffBlock, DiffStatBadge } from "./DiffBlock";
import { MarkdownView } from "./MarkdownView";
import { openSubagentInInspector, useInspectorTabs } from "../inspector";
import {
  describeActionError,
  openFileInInspector,
  reportOnFailure,
  sessionKeyOf,
  timelineItemSearchText,
  useClientSelector,
  useSessionCopy,
  useSessionUi,
} from "./session-helpers";

function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

export interface TimelineViewProps {
  connection: Connection;
  session: SessionSummary;
  view: SessionView;
  systemNote?: string;
}

const FOLLOW_DISTANCE_PX = 72;

/** The first row whose bottom is below the top of the view (rows stack, so a binary search finds it). */
function firstVisibleRow(track: HTMLElement, viewTop: number): Element | null {
  const rows = track.children;
  let low = 0;
  let high = rows.length - 1;
  let found: Element | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const row = rows[middle]!;
    if (row.getBoundingClientRect().bottom > viewTop) {
      found = row;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return found;
}

export function TimelineView({
  connection,
  session,
  view,
  systemNote,
}: TimelineViewProps) {
  const t = useT();
  const copy = useSessionCopy();
  const computerKey = connection.computer.key;
  const sessionKey = sessionKeyOf(computerKey, session.id);
  const ui = useSessionUi(computerKey, session.id);
  const searchQuery = ui.searchOpen ? ui.searchQuery.trim() : "";

  const loadingEarlier = useClientSelector(
    connection,
    (s) => Boolean(s.loadingEarlier[session.id]),
    false,
  );
  const online = useClientSelector(connection, (s) => s.status === "online", false);
  const ready = useClientSelector(connection, (s) => Boolean(s.ready[session.id]), false);
  const promptPhase = useClientSelector(
    connection,
    (s) => s.promptProgress?.[session.id]?.phase,
    undefined,
  );

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  // Whether the newest message stays in view: only the person's own scrolling changes it.
  const followRef = useRef(true);
  // The scrollTop this component last wrote, so its own scroll events aren't read as the person's.
  const expectedTopRef = useRef<number | null>(null);
  // Reading back, the row at the top keeps its place when anything above it changes height
  // (a page of earlier history, an image loading, steps opening). Ported from the web client.
  const anchorRef = useRef<{ node: Element; offset: number; fromBottom: number } | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const pendingJumpRef = useRef<string | null>(null);

  const [openStepKeys, setOpenStepKeys] = useState<Set<string>>(() => new Set());
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(
    null,
  );

  const markAtBottom = useCallback((value: boolean) => {
    if (isAtBottomRef.current === value) return;
    isAtBottomRef.current = value;
    setIsAtBottom(value);
  }, []);

  const toggleStepRun = useCallback((key: string) => {
    setOpenStepKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const openImage = useCallback((src: string, alt: string) => setLightboxImage({ src, alt }), []);

  const orderedItems = useMemo(
    () => cardsAtTurnEnd(view.items, view.turnBreaks),
    [view.items, view.turnBreaks],
  );

  // A search opens the folded step runs that hold a match, as the web client does.
  const effectiveOpenSteps = useMemo(() => {
    const needle = searchQuery.toLowerCase();
    if (!needle) return openStepKeys;
    let expanded: Set<string> | undefined;
    for (const row of foldStepRuns(orderedItems, openStepKeys)) {
      if (
        row.type === "steps" &&
        !openStepKeys.has(row.key) &&
        row.steps.some((step) => timelineItemSearchText(step).toLowerCase().includes(needle))
      ) {
        expanded ??= new Set(openStepKeys);
        expanded.add(row.key);
      }
    }
    return expanded ?? openStepKeys;
  }, [openStepKeys, orderedItems, searchQuery]);

  const rows = useMemo(
    () => foldStepRuns(orderedItems, effectiveOpenSteps),
    [effectiveOpenSteps, orderedItems],
  );

  const openWrapUpId = useMemo(() => openWrapUp(view.items), [view.items]);
  const showItemQuestions = session.asyncQuestions === undefined;
  const turnActive = view.turnActive || session.state === "running";

  const noteAnchor = useCallback(() => {
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (!scroller || !track) return;
    const viewTop = scroller.getBoundingClientRect().top;
    const node = firstVisibleRow(track, viewTop);
    anchorRef.current = node
      ? {
          node,
          offset: node.getBoundingClientRect().top - viewTop,
          fromBottom: scroller.scrollHeight - scroller.scrollTop,
        }
      : null;
  }, []);

  const writeScrollTop = useCallback((scroller: HTMLDivElement, top: number) => {
    scroller.scrollTop = top;
    expectedTopRef.current = scroller.scrollTop;
  }, []);

  /** After any change of height: back to the newest message, or the top row where it was. */
  const settle = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (followRef.current) {
      writeScrollTop(scroller, scroller.scrollHeight);
    } else {
      const anchor = anchorRef.current;
      if (anchor) {
        const viewTop = scroller.getBoundingClientRect().top;
        const moved = anchor.node.isConnected
          ? anchor.node.getBoundingClientRect().top - viewTop - anchor.offset
          : // The row was replaced (a folded run regrouped): hold the distance from the end.
            scroller.scrollHeight - scroller.scrollTop - anchor.fromBottom;
        if (Math.abs(moved) >= 0.5) writeScrollTop(scroller, scroller.scrollTop + moved);
      }
    }
    noteAnchor();
  }, [noteAnchor, writeScrollTop]);

  // Text released by the streaming smoother, images and highlighting all change height without a
  // new render here; the observer sees every one of them before paint.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => settle());
    observer.observe(track);
    return () => observer.disconnect();
  }, [settle]);

  useLayoutEffect(() => {
    settle();
  }, [rows, view.permissions.length, turnActive, promptPhase, ready, settle]);

  // Sending goes back to the newest message even after reading back (the web client's `sentId`).
  useLayoutEffect(() => {
    if (!ui.followNonce) return;
    followRef.current = true;
    markAtBottom(true);
    settle();
  }, [markAtBottom, settle, ui.followNonce]);

  const triggerLoadEarlier = useCallback(async () => {
    if (loadingEarlier || view.startSeq <= 0 || !online) return;
    try {
      // The anchor keeps the reader's place when the page lands; nothing to restore on failure.
      await connection.store.getState().loadEarlier(session.id);
    } catch (error) {
      reportDesktopError(error);
    }
  }, [connection.store, loadingEarlier, online, session.id, view.startSeq]);

  // Turn Outline and Find jumps: a target folded into a step run is opened first.
  useEffect(() => {
    if (ui.scrollToItemId) pendingJumpRef.current = ui.scrollToItemId;
  }, [ui.scrollNonce, ui.scrollToItemId]);

  useEffect(() => {
    const itemId = pendingJumpRef.current;
    const scroller = scrollerRef.current;
    if (!itemId || !scroller) return;
    const folded = rows.find(
      (row) => row.type === "steps" && row.steps.some((step) => step.id === itemId),
    );
    if (folded?.type === "steps" && !effectiveOpenSteps.has(folded.key)) {
      setOpenStepKeys((prev) => new Set(prev).add(folded.key));
      return;
    }
    const target = scroller.querySelector<HTMLElement>(
      `[data-turn-item-id="${CSS.escape(itemId)}"]`,
    );
    if (!target) return;
    pendingJumpRef.current = null;
    followRef.current = false;
    markAtBottom(false);
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "center" });
    }
    noteAnchor();
  }, [effectiveOpenSteps, markAtBottom, noteAnchor, rows, ui.scrollNonce]);

  const handleScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const expected = expectedTopRef.current;
    expectedTopRef.current = null;
    if (expected !== null && Math.abs(scroller.scrollTop - expected) <= 1) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const nearBottom = distance < FOLLOW_DISTANCE_PX;
    followRef.current = nearBottom;
    markAtBottom(nearBottom);
    noteAnchor();
    if (scroller.scrollTop < 64 && view.startSeq > 0 && !loadingEarlier) {
      void triggerLoadEarlier();
    }
  };

  // Reading back starts with the wheel, a key or the scrollbar, before the scroll event lands;
  // stop following right away or a streamed chunk would pull the view back down first.
  const stopFollowing = () => {
    followRef.current = false;
  };

  const scrollToBottom = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    followRef.current = true;
    markAtBottom(true);
    // Instant: a smooth scroll's own intermediate events would read as reading back.
    writeScrollTop(scroller, scroller.scrollHeight);
    noteAnchor();
  };

  const historicalCutoff = Math.max(0, rows.length - 12);
  const showLiveRow = turnActive || promptPhase !== undefined;

  return (
    <>
      <div
        ref={scrollerRef}
        className="ls-timeline-scroller"
        onScroll={handleScroll}
        onWheel={(event) => {
          if (event.deltaY < 0) stopFollowing();
        }}
        onKeyDown={(event) => {
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stopFollowing();
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) stopFollowing();
        }}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        <div ref={trackRef} className="ls-timeline-track">
          {/* Top pagination control */}
          {view.startSeq > 0 && (
            <div className="ls-timeline-earlier">
              <Button
                variant="secondary"
                size="sm"
                loading={loadingEarlier}
                disabled={!online || loadingEarlier}
                onClick={() => void triggerLoadEarlier()}
              >
                {loadingEarlier ? copy.loadingEarlier : copy.loadEarlier}
              </Button>
            </div>
          )}

          {rows.length === 0 && view.permissions.length === 0 && (
            <div className="ls-timeline-empty" role="status">
              {ready ? (
                copy.emptyTimeline
              ) : (
                <>
                  <DesktopIcon name="spinner" size="sm" />
                  <span>{copy.loadingHistory}</span>
                </>
              )}
            </div>
          )}

          {rows.map((row, idx) => {
            const isHistorical = !searchQuery && idx < historicalCutoff;
            if (row.type === "steps") {
              return (
                <StepSummaryRow
                  key={row.key}
                  stepKey={row.key}
                  steps={row.steps}
                  open={effectiveOpenSteps.has(row.key)}
                  historical={isHistorical}
                  onToggle={toggleStepRun}
                />
              );
            }
            return (
              <TimelineItemRow
                key={row.item.id}
                item={row.item}
                historical={isHistorical}
                connection={connection}
                sessionId={session.id}
                cwd={session.cwd}
                sessionKey={sessionKey}
                searchQuery={searchQuery}
                isTurnActive={turnActive}
                showItemQuestions={showItemQuestions}
                wrapUpOpen={row.item.id === openWrapUpId}
                onOpenImage={openImage}
              />
            );
          })}

          {/* Pending Session Approvals & Questions */}
          {view.permissions.map((perm) => (
            <div key={perm.requestId} data-turn-item-id={perm.requestId}>
              <ApprovalCard
                permission={perm}
                connection={connection}
                sessionId={session.id}
                cwd={session.cwd}
                sessionKey={sessionKey}
              />
            </div>
          ))}

          {/* Session-level non-blocking async questions (newer hosts; older ones carry them on the agent's message) */}
          {session.asyncQuestions && session.asyncQuestions.length > 0 && (
            <AsyncQuestionsBar
              questions={session.asyncQuestions}
              connection={connection}
              sessionId={session.id}
            />
          )}

          {/* Live running turn indicator & elapsed clock; before the turn starts, what this send is doing */}
          {showLiveRow && (
            <LiveTurnRow
              view={view}
              asking={Boolean(session.asyncQuestions?.length)}
              pendingLabel={
                turnActive
                  ? undefined
                  : promptPhase === "sending"
                    ? copy.sendingPrompt
                    : copy.startingTurn
              }
              onCancel={
                online && turnActive
                  ? () => reportOnFailure(connection.store.getState().cancel(session.id))
                  : undefined
              }
            />
          )}

          {systemNote && (
            <div className="ls-notice-card">
              <DesktopIcon name="info" size="sm" />
              <span>{systemNote}</span>
            </div>
          )}
        </div>

        {/* Sticky inside the scroller: it sits just above the composer whatever its height. */}
        <div className="ls-jump-bottom-anchor">
          <button
            type="button"
            className="ls-jump-bottom-btn"
            data-visible={!isAtBottom}
            tabIndex={isAtBottom ? -1 : undefined}
            onClick={scrollToBottom}
          >
            <DesktopIcon name="arrow-down" size="xs" />
            <span>{t("desktop.timeline.jumpToBottom")}</span>
          </button>
        </div>
      </div>

      {/* Lightbox dialog for message / tool images */}
      <Dialog
        open={Boolean(lightboxImage)}
        onOpenChange={(open) => {
          if (!open) setLightboxImage(null);
        }}
        size="lg"
      >
        <DialogHeader>
          <DialogTitle>{lightboxImage?.alt || copy.imageLabel}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {lightboxImage && (
            <div className="ls-lightbox-frame">
              <img src={lightboxImage.src} alt={lightboxImage.alt} />
            </div>
          )}
        </DialogBody>
      </Dialog>
    </>
  );
}

/* ============================================================================
 * Folded Steps Summary Row (Neutral ink for tool failures; danger ONLY for failed subagents)
 * ============================================================================ */

const StepSummaryRow = memo(
  function StepSummaryRow({
    stepKey,
    steps,
    open,
    historical,
    onToggle,
  }: {
    stepKey: string;
    steps: Step[];
    open: boolean;
    historical: boolean;
    onToggle: (key: string) => void;
  }) {
    const tally = useMemo(() => tallySteps(steps), [steps]);
    const summaryText = useMemo(() => describeSteps(tally), [tally]);
    const failureNote = useMemo(() => describeFailures(tally), [tally]);
    const hasAgentFailure = tally.failedAgents > 0;

    return (
      <div className="ls-timeline-item" data-historical={historical ? "true" : undefined}>
        <button
          type="button"
          className="ls-step-summary-btn"
          aria-expanded={open}
          onClick={() => onToggle(stepKey)}
        >
          <span className="ls-step-summary-chevron">
            <DesktopIcon name="chevron-right" size="xs" />
          </span>
          <span>{summaryText}</span>
          {failureNote && (
            <span
              className="ls-step-failure-note"
              data-agent-failed={hasAgentFailure ? "true" : undefined}
            >
              {failureNote}
            </span>
          )}
          <DiffStatBadge added={tally.added} removed={tally.removed} />
        </button>
      </div>
    );
  },
  (prev, next) =>
    prev.stepKey === next.stepKey &&
    prev.open === next.open &&
    prev.historical === next.historical &&
    prev.onToggle === next.onToggle &&
    prev.steps.length === next.steps.length &&
    prev.steps.every((s, idx) => s === next.steps[idx]),
);

/* ============================================================================
 * Individual Timeline Item Dispatcher
 * ============================================================================ */

interface TimelineItemRowProps {
  item: TimelineItem;
  historical: boolean;
  connection: Connection;
  sessionId: string;
  cwd: string;
  sessionKey: string;
  searchQuery: string;
  isTurnActive: boolean;
  /** Older hosts carry async questions only on the agent's message; newer ones on the session. */
  showItemQuestions: boolean;
  /** Only the newest wrap-up, with nothing said since, still takes a reply. */
  wrapUpOpen: boolean;
  onOpenImage: (src: string, alt: string) => void;
}

const TimelineItemRow = memo(function TimelineItemRow({
  item,
  historical,
  connection,
  sessionId,
  cwd,
  sessionKey,
  searchQuery,
  isTurnActive,
  showItemQuestions,
  wrapUpOpen,
  onOpenImage,
}: TimelineItemRowProps) {
  return (
    <div
      className="ls-timeline-item"
      data-turn-item-id={item.id}
      data-historical={historical ? "true" : undefined}
    >
      {item.kind === "user" && (
        <UserTurnRow
          item={item}
          connection={connection}
          sessionId={sessionId}
          cwd={cwd}
          searchQuery={searchQuery}
          onOpenImage={onOpenImage}
        />
      )}
      {item.kind === "agent" && (
        <AgentTurnRow
          item={item}
          connection={connection}
          sessionId={sessionId}
          cwd={cwd}
          searchQuery={searchQuery}
          showQuestions={showItemQuestions}
          onOpenImage={onOpenImage}
        />
      )}
      {item.kind === "thought" && (
        <ThoughtTurnRow item={item} searchQuery={searchQuery} />
      )}
      {item.kind === "tool" && (
        <ToolCallRow
          item={item}
          connection={connection}
          sessionId={sessionId}
          cwd={cwd}
          sessionKey={sessionKey}
          searchQuery={searchQuery}
          wrapUpOpen={wrapUpOpen}
          onOpenImage={onOpenImage}
        />
      )}
      {item.kind === "plan" && (
        <PlanTurnCard
          item={item}
          connection={connection}
          sessionId={sessionId}
          cwd={cwd}
          searchQuery={searchQuery}
        />
      )}
      {item.kind === "notice" && (
        <NoticeTurnRow item={item} isTurnActive={isTurnActive} />
      )}
      {item.kind === "error" && <ErrorTurnCard item={item} />}
      {item.kind === "permission-result" && <PermissionResultRow item={item} />}
      {item.kind === "driver" && <DriverChangeRow item={item} />}
    </div>
  );
});

/* ============================================================================
 * User Turn
 * ============================================================================ */

function UserTurnRow({
  item,
  connection,
  sessionId,
  cwd,
  searchQuery,
  onOpenImage,
}: {
  item: Extract<TimelineItem, { kind: "user" }>;
  connection: Connection;
  sessionId: string;
  cwd: string;
  searchQuery: string;
  onOpenImage: (src: string, alt: string) => void;
}) {
  const copy = useSessionCopy();
  const online = useClientSelector(connection, (s) => s.status === "online", false);

  const parsedView = useMemo(() => userMessageView(item.blocks), [item.blocks]);
  const rawText = useMemo(() => userMessageText(item.blocks), [item.blocks]);
  const replies = useMemo(
    () => (rawText ? questionReplies(rawText) : undefined),
    [rawText],
  );
  const imageBlocks = useMemo(
    () => item.blocks.filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image"),
    [item.blocks],
  );

  if (parsedView.hidden && imageBlocks.length === 0 && !item.agentMessages?.length) {
    return null;
  }

  if (parsedView.event) {
    return (
      <div className="ls-notice-card">
        <DesktopIcon name="clock" size="xs" />
        <span>{userEventLabel(parsedView.event)}</span>
      </div>
    );
  }

  const localClientId = item.id.startsWith("local-") ? item.id.slice("local-".length) : undefined;

  const handleForkHere = async () => {
    if (!online) return;
    try {
      const forked = await connection.store.getState().forkSession(sessionId, {
        itemId: item.id,
      });
      routerStore.getState().openSession(connection.computer.key, forked.id);
    } catch (error) {
      reportDesktopError(error);
    }
  };

  return (
    <div className="ls-turn-user">
      <div className="ls-turn-user-bubble">
        {item.agentMessages && item.agentMessages.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: parsedView.text ? 8 : 0 }}>
            {item.agentMessages.map((mail, idx) => (
              <div key={idx} style={{ fontSize: 12, color: "var(--ls-fg-2)" }}>
                <strong style={{ color: "var(--ls-fg)" }}>{mail.sender}: </strong>
                {mail.summary || mail.body}
              </div>
            ))}
          </div>
        )}

        {replies && replies.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {replies.map((r, idx) => (
              <div key={idx} style={{ fontSize: 13 }}>
                <span style={{ color: "var(--ls-fg-3)" }}>{r.question}: </span>
                <strong style={{ fontWeight: 500 }}>{r.answer}</strong>
              </div>
            ))}
          </div>
        ) : (
          parsedView.text && (
            <MarkdownView
              text={parsedView.text}
              computerKey={connection.computer.key}
              sessionId={sessionId}
              cwd={cwd}
              searchQuery={searchQuery}
            />
          )
        )}

        {imageBlocks.length > 0 && (
          <div className="ls-user-images">
            {imageBlocks.map((img, idx) => (
              <SessionImageThumb
                key={idx}
                block={img}
                connection={connection}
                sessionId={sessionId}
                onOpen={onOpenImage}
              />
            ))}
          </div>
        )}
      </div>

      <div className="ls-turn-user-meta">
        {item.pending && <span>{item.accepted ? copy.acceptedDelivery : copy.pendingDelivery}</span>}
        {item.failed && localClientId && (
          <>
            <span style={{ color: "var(--ls-fg-2)" }}>{copy.failedDelivery}</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={!online}
              onClick={() => reportOnFailure(connection.store.getState().retry(localClientId))}
            >
              {copy.retryFailed}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => connection.store.getState().discard(localClientId)}
            >
              {copy.discardFailed}
            </Button>
          </>
        )}
        {!item.pending && !item.failed && (
          <>
            {parsedView.text && <CopyButton value={parsedView.text} />}
            <Tooltip content={copy.forkFromHere}>
              <IconButton
                icon="session-fork"
                size="icon-sm"
                label={copy.forkFromHere}
                disabled={!online}
                onClick={() => void handleForkHere()}
              />
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}

function SessionImageThumb({
  block,
  connection,
  sessionId,
  onOpen,
}: {
  block: Extract<ContentBlock, { type: "image" }>;
  connection: Connection;
  sessionId: string;
  onOpen: (src: string, alt: string) => void;
}) {
  const copy = useSessionCopy();
  const inlineSrc = block.data
    ? `data:${block.mimeType || "image/png"};base64,${block.data}`
    : undefined;
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(inlineSrc);

  useEffect(() => {
    if (inlineSrc) {
      setResolvedSrc(inlineSrc);
      return;
    }
    const uri = (block as { uri?: string }).uri;
    if (!uri) return;
    if (!uri.startsWith("linkshell-event:")) {
      setResolvedSrc(uri);
      return;
    }
    let alive = true;
    void connection.store
      .getState()
      .loadImage(sessionId, uri)
      .then((dataUri) => {
        if (alive) setResolvedSrc(dataUri);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [block, connection.store, inlineSrc, sessionId]);

  if (!resolvedSrc) {
    return (
      <div
        className="ls-user-image-thumb"
        style={{
          width: 72,
          height: 72,
          display: "grid",
          placeItems: "center",
          background: "var(--ls-inset)",
        }}
      >
        <DesktopIcon name="image" size="sm" />
      </div>
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt={copy.attachedImage}
      className="ls-user-image-thumb"
      onClick={() => onOpen(resolvedSrc, copy.attachedImage)}
    />
  );
}

/* ============================================================================
 * Agent Turn
 * ============================================================================ */

function AgentTurnRow({
  item,
  connection,
  sessionId,
  cwd,
  searchQuery,
  showQuestions,
  onOpenImage,
}: {
  item: Extract<TimelineItem, { kind: "agent" }>;
  connection: Connection;
  sessionId: string;
  cwd: string;
  searchQuery: string;
  showQuestions: boolean;
  onOpenImage: (src: string, alt: string) => void;
}) {
  const cleaned = useMemo(() => cleanAgentHeartbeatText(item.text), [item.text]);
  const attachmentImages = useMemo(
    () =>
      (item.attachments ?? []).filter(
        (b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image",
      ),
    [item.attachments],
  );

  return (
    <div className="ls-turn-agent">
      {cleaned.text && (
        <MarkdownView
          text={cleaned.text}
          streaming={item.streaming}
          computerKey={connection.computer.key}
          sessionId={sessionId}
          cwd={cwd}
          searchQuery={searchQuery}
        />
      )}

      {attachmentImages.length > 0 && (
        <div className="ls-user-images">
          {attachmentImages.map((img, idx) => (
            <SessionImageThumb
              key={idx}
              block={img}
              connection={connection}
              sessionId={sessionId}
              onOpen={onOpenImage}
            />
          ))}
        </div>
      )}

      {showQuestions && !item.streaming && item.questions && item.questions.length > 0 && (
        <AsyncQuestionsBar
          questions={item.questions}
          connection={connection}
          sessionId={sessionId}
        />
      )}

      {!item.streaming && cleaned.text && (
        <div className="ls-turn-agent-actions">
          <CopyButton value={cleaned.text} revealOnHover />
        </div>
      )}
    </div>
  );
}

function ThoughtTurnRow({
  item,
  searchQuery,
}: {
  item: Extract<TimelineItem, { kind: "thought" }>;
  searchQuery: string;
}) {
  const copy = useSessionCopy();
  if (!item.text.trim()) return null;
  return (
    <CollapsibleLog
      className="ls-timeline-thought-log"
      defaultOpen={Boolean(searchQuery)}
      title={
        <span className="ls-thought-summary-text">
          {copy.thoughtLabel}
        </span>
      }
    >
      <MarkdownView text={item.text} streaming={item.streaming} searchQuery={searchQuery} />
    </CollapsibleLog>
  );
}

/* ============================================================================
 * Tool Call Row (Neutral ink for tool non-zero exits; SubagentCard for spawned subagents)
 * ============================================================================ */

function ToolCallRow({
  item,
  connection,
  sessionId,
  cwd,
  sessionKey,
  searchQuery,
  wrapUpOpen,
  onOpenImage,
}: {
  item: ToolItem;
  connection: Connection;
  sessionId: string;
  cwd: string;
  sessionKey: string;
  searchQuery: string;
  wrapUpOpen: boolean;
  onOpenImage: (src: string, alt: string) => void;
}) {
  const action = toolAction(item);

  // Wrap-up card at end of turn
  if (action === "wrap_up") {
    return (
      <WrapUpTurnCard
        item={item}
        connection={connection}
        sessionId={sessionId}
        cwd={cwd}
        searchQuery={searchQuery}
        open={wrapUpOpen}
      />
    );
  }

  // A session the Claude app started from this one
  if (action === "start_session") {
    return <StartedSessionCard item={item} connection={connection} />;
  }

  // Subagent spawn card
  if (item.detail?.type === "subagent" && item.detail.action === "spawn") {
    return (
      <SubagentSpawnCard
        item={item}
        connection={connection}
        sessionId={sessionId}
      />
    );
  }

  const label = toolLabel(item);
  const parts = toolLabelParts(label);
  const outcome = toolOutcome(item);
  const cmd = toolCommand(item);
  const output = toolOutput(item);
  const planMarkdown = proposedPlan(item);
  const path = toolPath(item);
  const note = exitNote(item);

  const diffChanges = item.content.filter(
    (c): c is Extract<typeof c, { type: "diff" | "patch" }> =>
      c.type === "diff" || c.type === "patch",
  );
  const imageOutputs = item.content.filter(
    (c): c is Extract<typeof c, { type: "content" }> =>
      c.type === "content" && c.content.type === "image",
  );

  const totalStat = diffChanges.reduce(
    (acc, change) => {
      const s = changeStat(change);
      return { added: acc.added + s.added, removed: acc.removed + s.removed };
    },
    { added: 0, removed: 0 },
  );

  const hasBody =
    !isQuietTool(item) &&
    (Boolean(cmd) ||
      Boolean(output.trim()) ||
      Boolean(planMarkdown) ||
      diffChanges.length > 0 ||
      imageOutputs.length > 0);

  const summaryContent: ReactNode = (
    <span className="ls-tool-row-summary">
      {outcome === "running" ? (
        <DesktopIcon name="spinner" size="xs" />
      ) : (
        <DesktopIcon
          name={
            diffChanges.length > 0
              ? "diff-changes"
              : cmd
                ? "terminal"
                : path
                  ? "file-code"
                  : "code"
          }
          size="xs"
        />
      )}
      <span className="ls-tool-verb">{parts.verb}</span>
      {parts.subject && (
        <span
          className="ls-tool-subject"
          data-code={label.style === "code" ? "true" : undefined}
          onClick={
            path
              ? (e) => {
                  e.stopPropagation();
                  openFileInInspector(connection.computer.key, sessionId, path);
                }
              : undefined
          }
          style={path ? { cursor: "pointer" } : undefined}
        >
          {parts.subject}
        </span>
      )}
      {/* Neutral ink strictly enforced on non-zero tool exit / failure (`--ls-fg-3`, NEVER red) */}
      {parts.suffix && <span className="ls-tool-note">{parts.suffix}</span>}
      {label.note && <span className="ls-tool-note">· {label.note}</span>}
      <DiffStatBadge added={totalStat.added} removed={totalStat.removed} />
    </span>
  );

  if (!hasBody) {
    return <div className="ls-tool-row-inline">{summaryContent}</div>;
  }

  return (
    <CollapsibleLog
      className="ls-timeline-tool-log"
      defaultOpen={diffChanges.length > 0 || Boolean(planMarkdown) || Boolean(searchQuery)}
      title={summaryContent}
    >
      <div className="ls-tool-body">
        {planMarkdown && (
          <MarkdownView
            text={planMarkdown}
            computerKey={connection.computer.key}
            sessionId={sessionId}
            cwd={cwd}
            searchQuery={searchQuery}
          />
        )}

        {diffChanges.map((change, idx) => (
          <DiffBlock
            key={idx}
            change={change}
            computerKey={connection.computer.key}
            sessionId={sessionId}
            sessionKey={sessionKey}
          />
        ))}

        {cmd && (
          <pre className="ls-tool-pre" tabIndex={0}>
            $ {cmd}
          </pre>
        )}

        {output.trim() && diffChanges.length === 0 && (
          <pre className="ls-tool-pre" tabIndex={0}>
            {output}
          </pre>
        )}

        {imageOutputs.map((entry, idx) =>
          entry.content.type === "image" ? (
            <SessionImageThumb
              key={idx}
              block={entry.content}
              connection={connection}
              sessionId={sessionId}
              onOpen={onOpenImage}
            />
          ) : null,
        )}

        {note && <div className="ls-tool-exit-note">{note}</div>}
      </div>
    </CollapsibleLog>
  );
}

/* ============================================================================
 * Subagent Spawn Card (`<SubagentGlyph>` + Cancel + Nested Timeline)
 * ============================================================================ */

function SubagentSpawnCard({
  item,
  connection,
  sessionId,
}: {
  item: ToolItem;
  connection: Connection;
  sessionId: string;
}) {
  const t = useT();
  const copy = useSessionCopy();
  const online = useClientSelector(connection, (s) => s.status === "online", false);
  const inspectorOpen = useStore(routerStore, (s) => s.inspectorOpen);
  const inspectorTabs = useInspectorTabs(connection.computer.key, sessionId);
  const [cancelling, setCancelling] = useState(false);

  const detail = item.detail?.type === "subagent" ? item.detail : undefined;
  const subState = detail?.workflow?.state ?? detail?.state;
  const isRunning =
    subState === "running" ||
    (!subState && (item.status === "in_progress" || item.status === "pending"));
  const isFailed = subState === "failed" || item.status === "failed";
  const canCancel = Boolean(isRunning && detail?.canCancel && detail?.nativeSessionId);
  const subagentTitle = detail?.name || detail?.agentType || copy.subagentFallback;
  const isTabOpen = inspectorOpen && inspectorTabs.activeId === `subagent:${item.id}`;

  const handleOpenSubagentTab = () => {
    openSubagentInInspector(connection.computer.key, sessionId, {
      toolCallId: item.id,
      title: subagentTitle,
      agent: detail?.agentType,
    });
  };

  const handleCancelSubagent = async () => {
    if (!detail?.nativeSessionId || !online || cancelling) return;
    setCancelling(true);
    try {
      await connection.link.call("sessions.cancelSubagent", {
        sessionId: sessionId,
        nativeSessionId: detail.nativeSessionId,
      });
    } catch (error) {
      reportDesktopError(error);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div
      className="ls-subagent-card"
      data-agent-failed={isFailed ? "true" : undefined}
      data-tab-open={isTabOpen ? "true" : undefined}
    >
      <div
        className="ls-subagent-header ls-subagent-card__head"
        role="button"
        tabIndex={0}
        aria-expanded={isTabOpen}
        onClick={handleOpenSubagentTab}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleOpenSubagentTab();
          }
        }}
      >
        <SubagentGlyph
          sessionId={sessionId}
          toolCallId={item.id}
          size="md"
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="ls-subagent-title">{subagentTitle}</span>
            <Badge tone={isFailed ? "danger" : isRunning ? "accent" : "neutral"}>
              {isFailed
                ? t("desktop.timeline.agentFailed")
                : isRunning
                  ? copy.subagentRunning
                  : subState === "stopped"
                    ? copy.subagentStopped
                    : copy.subagentDone}
            </Badge>
          </div>
          {detail?.task && (
            <div
              style={{
                fontSize: 12,
                color: "var(--ls-fg-2)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {detail.task}
            </div>
          )}
        </div>

        {canCancel && (
          <Button
            variant="ghost"
            size="sm"
            loading={cancelling}
            disabled={!online}
            onClick={(e) => {
              e.stopPropagation();
              void handleCancelSubagent();
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {t("desktop.timeline.cancelSubagent")}
          </Button>
        )}

        <DesktopIcon name="chevron-right" size="sm" />
      </div>
    </div>
  );
}

/* ============================================================================
 * Plan Card, WrapUp Card, Notice, Error & Live Activity
 * ============================================================================ */

function PlanTurnCard({
  item,
  connection,
  sessionId,
  cwd,
  searchQuery,
}: {
  item: Extract<TimelineItem, { kind: "plan" }>;
  connection: Connection;
  sessionId: string;
  cwd: string;
  searchQuery: string;
}) {
  const copy = useSessionCopy();
  const completedCount = item.entries.filter((e) => e.status === "completed").length;

  return (
    <div className="ls-plan-card">
      <div className="ls-plan-header">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
          <DesktopIcon name="list-checks" size="sm" />
          <span>{item.title || copy.planLabel}</span>
        </span>
        {item.entries.length > 0 && (
          <Badge tone="neutral">
            {completedCount}/{item.entries.length}
          </Badge>
        )}
      </div>

      {item.entries.length > 0 && (
        <div className="ls-plan-entries">
          {item.entries.map((entry, idx) => (
            <div key={idx} className="ls-plan-entry" data-status={entry.status}>
              <DesktopIcon
                name={
                  entry.status === "completed"
                    ? "check-circle"
                    : entry.status === "in_progress"
                      ? "spinner"
                      : "clock"
                }
                size="xs"
              />
              <span>{entry.content}</span>
            </div>
          ))}
        </div>
      )}

      {item.markdown && (
        <div style={{ padding: "8px 14px 12px" }}>
          <MarkdownView
            text={item.markdown}
            computerKey={connection.computer.key}
            sessionId={sessionId}
            cwd={cwd}
            searchQuery={searchQuery}
          />
        </div>
      )}
    </div>
  );
}

/** The Claude app's end-of-turn box (ported from the web client): a reply sends its message once; the app's own actions are done there. */
function WrapUpTurnCard({
  item,
  connection,
  sessionId,
  cwd,
  searchQuery,
  open,
}: {
  item: ToolItem;
  connection: Connection;
  sessionId: string;
  cwd: string;
  searchQuery: string;
  open: boolean;
}) {
  const copy = useSessionCopy();
  const online = useClientSelector(connection, (s) => s.status === "online", false);
  const wrap = useMemo(() => wrapUpOf(item), [item]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<number>();
  const [error, setError] = useState<string>();

  const reply = async (index: number, message: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const delivery = await connection.store
        .getState()
        .send(sessionId, [{ type: "text", text: message }]);
      if (delivery === "failed") setError(copy.wrapUpSendFailed);
      else setSent(index);
    } catch (failure) {
      setError(describeActionError(failure, copy.wrapUpSendFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ls-plan-card">
      <div className="ls-plan-header">
        <span className="ls-wrap-up-label">{copy.wrapUpLabel}</span>
      </div>
      <div className="ls-wrap-up-body">
        {wrap.recap && (
          <MarkdownView
            text={wrap.recap}
            computerKey={connection.computer.key}
            sessionId={sessionId}
            cwd={cwd}
            searchQuery={searchQuery}
          />
        )}
        {wrap.ask && <div className="ls-wrap-up-ask">{wrap.ask}</div>}
        {wrap.actions.length > 0 && (
          <div className="ls-wrap-up-actions">
            {wrap.actions.map((act, idx) =>
              open && act.message !== undefined ? (
                <Button
                  key={idx}
                  variant={idx === 0 ? "primary" : "secondary"}
                  size="sm"
                  title={act.message}
                  loading={busy && sent === undefined}
                  disabled={!online || busy || sent !== undefined}
                  onClick={() => void reply(idx, act.message!)}
                >
                  {act.label}
                </Button>
              ) : (
                <span
                  key={idx}
                  className="ls-wrap-up-chip"
                  data-sent={sent === idx || undefined}
                  title={act.app ? copy.wrapUpAppHint : undefined}
                >
                  {act.label}
                </span>
              ),
            )}
          </div>
        )}
        {error && (
          <div className="ls-composer-send-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

/** A session the Claude app started from this one: opens it when this computer has it (ported from the web client). */
function StartedSessionCard({ item, connection }: { item: ToolItem; connection: Connection }) {
  const copy = useSessionCopy();
  const started = useMemo(() => startedSession(item), [item]);
  const target = useClientSelector(
    connection,
    (s) => {
      if (!started.appId) return undefined;
      const found = Object.values(s.sessions).find((candidate) => candidate.appId === started.appId);
      return found?.id;
    },
    undefined,
  );
  const targetTitle = useClientSelector(
    connection,
    (s) => (target && s.sessions[target] ? sessionTitle(s.sessions[target]) : undefined),
    undefined,
  );
  const body = (
    <>
      <DesktopIcon name={started.state === "starting" ? "spinner" : "session-fork"} size="sm" />
      <span className="ls-started-session-text">
        <strong>{started.title}</strong>
        <small>{copy.sessionCardStates[started.state]}</small>
      </span>
    </>
  );
  if (!target) {
    return (
      <div className="ls-started-session" data-state={started.state}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="ls-started-session"
      data-state={started.state}
      title={copy.openSessionTitle(targetTitle ?? started.title)}
      onClick={() => routerStore.getState().openSession(connection.computer.key, target)}
    >
      {body}
      <DesktopIcon name="chevron-right" size="sm" />
    </button>
  );
}

function NoticeTurnRow({
  item,
  isTurnActive,
}: {
  item: Extract<TimelineItem, { kind: "notice" }>;
  isTurnActive: boolean;
}) {
  const reconnect = reconnectOf(item.title, item.detail);
  if (reconnect) {
    return (
      <div className="ls-notice-card">
        {isTurnActive ? (
          <DesktopIcon name="spinner" size="xs" />
        ) : (
          <DesktopIcon name="check-circle" size="xs" />
        )}
        <span>{reconnectLabel(reconnect, isTurnActive)}</span>
      </div>
    );
  }
  return (
    <div className="ls-notice-card" data-level={item.level}>
      <DesktopIcon
        name={item.level === "warning" ? "alert-triangle" : "info"}
        size="sm"
      />
      <div>
        <div style={{ fontWeight: 500, color: "var(--ls-fg)" }}>{item.title}</div>
        {item.detail && <div>{item.detail}</div>}
      </div>
    </div>
  );
}

/** True Agent / Session Error Card (`--ls-danger` reserved strictly here and failed subagents). */
function ErrorTurnCard({
  item,
}: {
  item: Extract<TimelineItem, { kind: "error" }>;
}) {
  const copy = useSessionCopy();
  const [detailOpen, setDetailOpen] = useState(false);
  const presented = useMemo(() => presentError(item), [item]);
  return (
    <div className="ls-error-card" role="alert">
      <div className="ls-error-title">
        <DesktopIcon name="alert-circle" size="sm" />
        <span>{presented.title}</span>
      </div>
      {presented.hint && <div className="ls-error-hint">{presented.hint}</div>}
      {presented.detail && presented.detail !== presented.title && (
        <>
          <button
            type="button"
            className="ls-error-card__toggle"
            aria-expanded={detailOpen}
            onClick={() => setDetailOpen((v) => !v)}
          >
            {detailOpen ? copy.hideErrorDetails : copy.viewErrorDetails}
          </button>
          {detailOpen ? (
            <pre className="ls-tool-pre" tabIndex={0}>
              {presented.detail}
            </pre>
          ) : null}
        </>
      )}
    </div>
  );
}

function PermissionResultRow({
  item,
}: {
  item: Extract<TimelineItem, { kind: "permission-result" }>;
}) {
  const t = useT();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--ls-fg-3)",
      }}
    >
      <DesktopIcon
        name={item.allowed === false ? "close" : "check"}
        size="xs"
      />
      <span>{item.title}</span>
      {item.optionName && <span>· {item.optionName}</span>}
      {item.allowed === false && !item.optionName && (
        <span>· {t("desktop.timeline.declined")}</span>
      )}
    </div>
  );
}

function DriverChangeRow({
  item,
}: {
  item: Extract<TimelineItem, { kind: "driver" }>;
}) {
  const t = useT();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--ls-fg-3)",
      }}
    >
      <DesktopIcon name="terminal" size="xs" />
      <span>
        {item.driver === "desktop"
          ? t("desktop.composer.releaseToDesktop")
          : t("desktop.composer.takeover")}
      </span>
    </div>
  );
}

function LiveTurnRow({
  view,
  pendingLabel,
  asking = false,
  onCancel,
}: {
  view: SessionView;
  /** Before the turn starts: what this device's send is doing (`promptProgress`). */
  pendingLabel?: string;
  /** The agent asked something it does not wait for: the person's answer is what is pending. */
  asking?: boolean;
  onCancel?: () => void;
}) {
  const { locale, t } = useI18n();
  const copy = useSessionCopy();
  const activity = useMemo(() => liveActivity(view), [view]);
  const [now, setNow] = useState(() => Date.now());
  // The shared activity model words its three fixed states in Chinese; a tool's own running
  // text passes through as the agent reported it.
  const waiting = !pendingLabel && (activity.waiting || asking);
  // The running call, the reply or the thought already shows itself as live in the timeline
  // above: saying it again here reads as two things running, so only the turn's time is left.
  const quiet = !pendingLabel && Boolean(activity.echo) && !waiting;
  const activityLabel = activity.waiting
    ? t("desktop.timeline.waitingConfirm")
    : asking
      ? t("desktop.timeline.waitingAnswer")
      : quiet
        ? copy.turnElapsed
        : activity.label === "思考中…"
          ? translateCore(locale, "session.thinking")
          : activity.label;

  useEffect(() => {
    if (!activity.startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activity.startedAt]);

  const elapsedMs = activity.startedAt ? Math.max(0, now - activity.startedAt) : 0;

  return (
    <div className="ls-live-row" role="status" data-quiet={quiet ? "true" : undefined}>
      {quiet ? null : <StatusDot tone={waiting ? "waiting" : "running"} />}
      <span className="ls-live-label">{pendingLabel ?? activityLabel}</span>
      {!pendingLabel && elapsedMs >= ELAPSED_FROM && (
        <span className="ls-live-elapsed">{formatDurationMs(elapsedMs)}</span>
      )}
      {onCancel && (
        <button
          type="button"
          className="ls-live-stop-btn"
          onClick={onCancel}
        >
          {t("desktop.composer.stop")}
        </button>
      )}
    </div>
  );
}
