import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ArrowDown, LoaderCircle } from "lucide-react";
import {
  answeredQuestions,
  foldStepRuns,
  type SessionView,
} from "@linkshell/client-core";
import { Button } from "@/components/ui/button";
import { StepsSummary, Timeline } from "./Timeline";

/**
 * The scrolling conversation. react-virtuoso owns the scroll container so long
 * sessions stay light and — the part a hand-rolled scroller kept getting wrong
 * — `firstItemIndex` keeps the reader pinned in place when earlier history is
 * prepended, instead of jumping. New messages at the bottom auto-follow only
 * when the reader is already there.
 */
type Row = ReturnType<typeof foldStepRuns>[number];
const rowKey = (row: Row) => (row.type === "steps" ? row.key : row.item.id);

interface ListContext {
  earlier: boolean;
  loading: boolean;
  failed: boolean;
  online: boolean;
  retry: () => void;
  /** The top of the list: while it is in view, earlier history loads by itself. */
  top: (node: HTMLDivElement | null) => void;
  footer: React.ReactNode;
}

// Stable component types (inline ones remount on every render), fed through Virtuoso's context.
function HistoryTop({ context }: { context: ListContext }) {
  return (
    <div ref={context.top} className="conversation-history-top">
      {context.earlier &&
        (context.loading ? (
          <span className="conversation-history-status" role="status">
            <LoaderCircle aria-hidden="true" />
            正在加载更早的历史…
          </span>
        ) : context.failed ? (
          <Button variant="link" size="sm" disabled={!context.online} onClick={context.retry}>
            没有加载成功，重试
          </Button>
        ) : null)}
    </div>
  );
}

function ListFooter({ context }: { context: ListContext }) {
  return <div className="conversation-footer">{context.footer}</div>;
}

const LIST_COMPONENTS = { Header: HistoryTop, Footer: ListFooter };

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
  const handle = useRef<VirtuosoHandle>(null);
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(new Set());
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
  const [atBottom, setAtBottom] = useState(true);

  const rows = useMemo(
    () => foldStepRuns(view.items, openSteps),
    [view.items, openSteps],
  );
  // Whole-conversation answered-question map, computed once and shared so each
  // virtualized single-item slice still dedups Codex async questions.
  const answered = useMemo(
    () =>
      new Map(
        view.items.flatMap((item) =>
          item.kind === "user" && !item.failed && !item.pending
            ? item.blocks.flatMap((block) =>
                block.type === "text" ? answeredQuestions(block.text) : [],
              )
            : [],
        ),
      ),
    [view.items],
  );

  // Virtuoso needs a stable, descending index for the first row so prepended
  // history keeps the viewport steady. We seed it high and subtract however many
  // rows got added to the front on each change.
  const START = 1_000_000;
  const firstIndex = useRef(START);
  const prevFirstId = useRef<string | undefined>(
    rows[0] ? rowKey(rows[0]) : undefined,
  );
  const prevCount = useRef(rows.length);
  const [firstItemIndex, setFirstItemIndex] = useState(START);
  useEffect(() => {
    const firstKey = rows[0] ? rowKey(rows[0]) : undefined;
    if (firstKey !== prevFirstId.current && rows.length > prevCount.current) {
      // Rows were prepended (history page) — shift the base index down so
      // existing rows keep their absolute index and Virtuoso holds position.
      firstIndex.current -= rows.length - prevCount.current;
      setFirstItemIndex(firstIndex.current);
    }
    prevFirstId.current = firstKey;
    prevCount.current = rows.length;
  }, [rows]);

  // Earlier history loads by itself when the top of the list comes into view. Virtuoso's
  // startReached alone missed it (a list already at its top, a page that didn't fill the view),
  // which left only a button to click; the top's visibility is watched as well.
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
  startSeq.current = view.startSeq;
  const inFlight = useRef(false);
  const watcher = useRef<IntersectionObserver | undefined>(undefined);
  const top = useCallback((node: HTMLDivElement | null) => {
    watcher.current?.disconnect();
    watcher.current = undefined;
    if (!node) return setTopVisible(false);
    // The viewport as root: the conversation's scroller clips it, so this is "on screen".
    const observer = new IntersectionObserver(([entry]) => setTopVisible(entry?.isIntersecting ?? false));
    observer.observe(node);
    watcher.current = observer;
  }, []);
  useEffect(() => () => watcher.current?.disconnect(), []);

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
    }
  }, [online, loadingEarlier, loadEarlier]);

  useEffect(() => {
    // Each page arrives above the reader, who stays where they were; the top then leaves the
    // view. A page too short to push it out is followed by the next.
    if (settled && topVisible && view.startSeq > 0 && failedAt !== view.startSeq) void load();
  }, [settled, topVisible, view.startSeq, failedAt, load]);

  const context = useMemo<ListContext>(
    () => ({
      earlier: view.startSeq > 0,
      loading: loadingEarlier,
      failed: failedAt === view.startSeq,
      online,
      retry: () => {
        setFailedAt(undefined);
        void load();
      },
      top,
      footer,
    }),
    [view.startSeq, loadingEarlier, failedAt, online, load, top, footer],
  );

  return (
    <div className="conversation-column">
      <Virtuoso<Row, ListContext>
        ref={handle}
        context={context}
        className="conversation"
        data={rows}
        computeItemKey={(_, row) => rowKey(row)}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={Math.max(0, rows.length - 1)}
        followOutput={(bottom) => (bottom ? "smooth" : false)}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={120}
        startReached={() => settled && void load()}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        components={LIST_COMPONENTS}
        itemContent={(_, row) =>
          row.type === "steps" ? (
            <div className="live-timeline">
              <StepsSummary
                steps={row.steps}
                open={openSteps.has(row.key)}
                onToggle={() => toggleSteps(row.key)}
              />
            </div>
          ) : (
            <Timeline
              items={[row.item]}
              sessionId={sessionId}
              agent={agent}
              showAsyncQuestions={showAsyncQuestions}
              answeredOverride={answered}
              onFile={onFile}
              onFork={onFork}
              onTerminal={onTerminal}
            />
          )
        }
      />
      {!atBottom && (
        <div className="conversation-jump">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              handle.current?.scrollToIndex({
                index: rows.length - 1,
                align: "end",
                behavior: "auto",
              })
            }
          >
            <ArrowDown data-icon="inline-start" />
            回到最新消息
          </Button>
        </div>
      )}
    </div>
  );
}
