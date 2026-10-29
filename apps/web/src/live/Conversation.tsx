import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { ArrowDown, LoaderCircle } from "lucide-react";
import { foldStepRuns, cardsAtTurnEnd, openWrapUp, type SessionView, type Step } from "@linkshell/client-core";
import { Button } from "@/components/ui/button";
import { OpenWrapUp, StepsSummary, TimelineEntry, answeredMap } from "./Timeline";
import { isDesktop } from "./desktop";

/** A folded-steps row with a stable toggle, so it is memoizable like the message entries. */
const StepsRow = memo(function StepsRow({
  stepKey,
  steps,
  open,
  toggle,
}: {
  stepKey: string;
  steps: Step[];
  open: boolean;
  toggle: (key: string) => void;
}) {
  return <StepsSummary steps={steps} open={open} onToggle={() => toggle(stepKey)} />;
}, (before, after) =>
  // Every streamed chunk folds the runs again into new arrays of the same steps: only a run whose
  // steps changed is summed up again.
  before.stepKey === after.stepKey && before.open === after.open && before.toggle === after.toggle &&
  before.steps.length === after.steps.length && before.steps.every((step, index) => step === after.steps[index]));

/**
 * The first row element whose bottom is at or below the top of the view — the
 * one the reader is looking at. Rows are in document order, so a binary search
 * reads only ~log₂(n) rects instead of every row's.
 */
function topRow(rows: HTMLElement, viewTop: number): Element | undefined {
  const children = rows.children;
  let low = 0;
  let high = children.length - 1;
  let found: Element | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const child = children[middle]!;
    if (child.getBoundingClientRect().bottom > viewTop) {
      found = child;
      high = middle - 1;
    } else low = middle + 1;
  }
  return found;
}

/**
 * The scrolling conversation. Every row is laid out by the browser, so the
 * scrollbar always has the real height. A virtual list had to guess the height
 * of each row it hadn't measured (markdown, images, folded steps, text still
 * streaming); the guesses left the end out of reach and made the scrollbar jump
 * while it was dragged. use-stick-to-bottom keeps the newest message in view
 * while the reader is at the bottom and lets go as soon as they scroll up.
 * Entries are memoized, so a streaming reply re-renders only itself.
 */
export function Conversation({
  view,
  sessionId,
  agent,
  showAsyncQuestions,
  online,
  loadingEarlier,
  loadEarlier,
  onFile,
  onFork,
  onTerminal,
  footer,
}: {
  view: SessionView;
  sessionId: string;
  agent: string;
  showAsyncQuestions: boolean;
  online: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => Promise<boolean>;
  onFile: (path: string, line?: number) => void;
  onFork: (id: string) => void;
  onTerminal: (id: string) => void;
  footer: React.ReactNode;
}) {
  // Opening a session lands on its newest message at once; later growth follows smoothly.
  const { scrollRef, contentRef, scrollToBottom, isAtBottom, state } = useStickToBottom({
    initial: "instant",
    resize: "smooth",
  });

  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(new Set());
  // Stable, so a folded-steps row re-renders only when its own open state flips, not every chunk.
  const toggleSteps = useCallback(
    (key: string) =>
      setOpenSteps((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  const rows = useMemo(() => foldStepRuns(cardsAtTurnEnd(view.items, view.turnBreaks), openSteps), [view.items, view.turnBreaks, openSteps]);
  const openBox = useMemo(() => openWrapUp(view.items), [view.items]);
  // Every entry gets this map; it keeps its identity until its content changes, or each streamed
  // chunk (a new items array) would re-render the whole conversation.
  const answeredRef = useRef<Map<string, string>>(new Map());
  const answered = useMemo(() => {
    const next = answeredMap(view.items);
    const previous = answeredRef.current;
    const same =
      next.size === previous.size && [...next].every(([question, answer]) => previous.get(question) === answer);
    return same ? previous : next;
  }, [view.items]);
  useLayoutEffect(() => {
    answeredRef.current = answered;
  }, [answered]);

  // A message the reader just sent brings them to it, wherever they were reading.
  const lastItem = view.items[view.items.length - 1];
  const lastId = lastItem?.id;
  const sentId = lastItem?.kind === "user" && lastItem.pending ? lastItem.id : undefined;
  useEffect(() => {
    if (sentId) void scrollToBottom("instant");
  }, [sentId, scrollToBottom]);

  // The session page passes fresh closures on every render; entries get stable ones that call
  // the latest, or every memoized entry would re-render with each streamed chunk.
  const handlers = useRef({ onFile, onFork, onTerminal });
  useLayoutEffect(() => {
    handlers.current = { onFile, onFork, onTerminal };
  });
  const openFile = useCallback((path: string, line?: number) => handlers.current.onFile(path, line), []);
  const fork = useCallback((id: string) => handlers.current.onFork(id), []);
  const terminal = useCallback((id: string) => handlers.current.onTerminal(id), []);

  // Reading back, the row at the top of the view stays put when anything above it changes height:
  // a page of earlier history, an image that finished loading, steps opened above. WebKit (the
  // Mac app's WKWebView, Safari before 27) has no scroll anchoring, so it is done here, the same
  // in every engine (`overflow-anchor: none` on the scroller keeps Chrome's out of the way).
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    const rows = list.current;
    if (!scroller || !rows) return;
    // The row the reader has at the top of the view, where it sits, and the scrollTop that was
    // measured at — so a correction can tell its own writes from the reader's and from a resize.
    let anchor: { node: Element; offset: number; fromBottom: number; scrollTop: number } | undefined;
    const note = () => {
      const viewTop = scroller.getBoundingClientRect().top;
      const node = topRow(rows, viewTop);
      anchor = node
        ? {
            node,
            offset: node.getBoundingClientRect().top - viewTop,
            fromBottom: scroller.scrollHeight - scroller.scrollTop,
            scrollTop: scroller.scrollTop,
          }
        : undefined;
    };
    const keep = () => {
      // At the bottom the newest message stays in view; use-stick-to-bottom owns that.
      if (state.isAtBottom) return note();
      // The reader scrolled since the anchor was taken (events can lag a resize): re-take it first,
      // or the correction would undo their scroll by that much.
      if (!anchor || Math.abs(scroller.scrollTop - anchor.scrollTop) > 1) note();
      if (!anchor) return;
      const moved = anchor.node.isConnected
        ? anchor.node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset
        : // The row was replaced (a folded run regrouped at a page boundary): hold the distance from the end.
          scroller.scrollHeight - scroller.scrollTop - anchor.fromBottom;
      // Through the hook's state, so its own scroll handler doesn't read this as the reader scrolling.
      if (Math.abs(moved) >= 0.5) state.scrollTop = scroller.scrollTop + moved;
      note();
    };
    note();
    scroller.addEventListener("scroll", note, { passive: true });
    // Fires after layout, before paint, so the correction is never seen. The content box is
    // watched, not the rows: the history loader above the rows changes height too.
    const observer = new ResizeObserver(keep);
    observer.observe(scroller.firstElementChild ?? rows);
    return () => {
      scroller.removeEventListener("scroll", note);
      observer.disconnect();
    };
  }, [scrollRef, state]);

  // Earlier history loads by itself as the top of the list comes near.
  const [topVisible, setTopVisible] = useState(false);
  // The list opens at its newest messages; before it is placed there its top shows for a frame,
  // which mustn't count as the reader scrolling up.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), 400);
    return () => clearTimeout(timer);
  }, []);
  const [failedAt, setFailedAt] = useState<number>();
  const startSeq = useRef(view.startSeq);
  useLayoutEffect(() => {
    startSeq.current = view.startSeq;
  });
  const inFlight = useRef(false);
  // Counts finished calls. A page shows (and the effect below sees it) before the call that asked
  // for it returns, while it still counts as in flight: the next page is asked for when it does.
  const [finished, setFinished] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = top.current;
    const root = scrollRef.current;
    if (!node || !root) return;
    // Half a screen ahead, so the next page is usually there before the reader reaches the top.
    const observer = new IntersectionObserver(([entry]) => setTopVisible(entry?.isIntersecting ?? false), {
      root,
      rootMargin: "400px 0px 0px 0px",
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollRef]);

  const load = useCallback(async () => {
    const from = startSeq.current;
    if (from === 0 || !online || loadingEarlier || inFlight.current) return;
    inFlight.current = true;
    try {
      const loaded = await loadEarlier();
      // A page that didn't come is offered as a retry, not asked for again in a loop.
      if (!loaded && startSeq.current === from) setFailedAt(from);
    } finally {
      inFlight.current = false;
      setFinished((count) => count + 1);
    }
  }, [online, loadingEarlier, loadEarlier]);
  useEffect(() => {
    // Each page arrives above the reader, who stays where they were; the top then leaves the
    // view. A page too short to push it out is followed by the next.
    if (settled && topVisible && view.startSeq > 0 && failedAt !== view.startSeq) void load();
  }, [settled, topVisible, view.startSeq, failedAt, load, finished]);

  return (
    <div className="conversation-column">
      <div ref={scrollRef} className="conversation" data-testid="conversation-scroller">
        <div ref={contentRef} className="conversation-content">
          <div ref={top} className="conversation-history-top">
            {view.startSeq > 0 &&
              (loadingEarlier ? (
                <span className="conversation-history-status" role="status">
                  <LoaderCircle aria-hidden="true" />
                  正在加载更早的历史…
                </span>
              ) : failedAt === view.startSeq ? (
                <Button
                  variant="link"
                  size="sm"
                  disabled={!online}
                  onClick={() => {
                    setFailedAt(undefined);
                    void load();
                  }}
                >
                  没有加载成功，重试
                </Button>
              ) : null)}
          </div>
          <div ref={list} className="live-timeline">
            <OpenWrapUp.Provider value={openBox}>
            {rows.map((row) =>
              row.type === "steps" ? (
                <StepsRow
                  key={row.key}
                  stepKey={row.key}
                  steps={row.steps}
                  open={openSteps.has(row.key)}
                  toggle={toggleSteps}
                />
              ) : (
                <TimelineEntry
                  key={row.item.id}
                  item={row.item}
                  sessionId={sessionId}
                  agent={agent}
                  showAsyncQuestions={showAsyncQuestions}
                  answered={answered}
                  onFile={openFile}
                  onFork={fork}
                  onTerminal={terminal}
                  live={view.turnActive && row.item.id === lastId}
                />
              ),
            )}
            </OpenWrapUp.Provider>
          </div>
          <div className="conversation-footer">{footer}</div>
        </div>
      </div>
      {/* Always mounted, so it fades in and out instead of popping. */}
      <div className="conversation-jump" data-hidden={isAtBottom || undefined} aria-hidden={isAtBottom || undefined}>
        <Button
          variant="outline"
          size={isDesktop ? "icon" : "sm"}
          tabIndex={isAtBottom ? -1 : undefined}
          aria-label="回到最新消息"
          title="回到最新消息"
          onClick={() => void scrollToBottom("smooth")}
        >
          <ArrowDown data-icon="inline-start" />
          {!isDesktop && "回到最新消息"}
        </Button>
      </div>
    </div>
  );
}
