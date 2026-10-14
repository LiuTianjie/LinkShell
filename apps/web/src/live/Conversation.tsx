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

  const startReached = useCallback(() => {
    if (view.startSeq > 0 && online && !loadingEarlier) void loadEarlier();
  }, [view.startSeq, online, loadingEarlier, loadEarlier]);

  return (
    <div className="conversation-column">
      <Virtuoso
        ref={handle}
        className="conversation"
        data={rows}
        computeItemKey={(_, row) => rowKey(row)}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={Math.max(0, rows.length - 1)}
        followOutput={(bottom) => (bottom ? "smooth" : false)}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={120}
        startReached={startReached}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        components={{
          Header: () => (
            <div className="conversation-history-top">
              {view.startSeq > 0 &&
                (loadingEarlier ? (
                  <span className="conversation-history-status" role="status">
                    <LoaderCircle aria-hidden="true" />
                    正在加载更早的历史…
                  </span>
                ) : (
                  <Button
                    variant="link"
                    size="sm"
                    disabled={!online}
                    onClick={() => void loadEarlier()}
                  >
                    加载更早的历史
                  </Button>
                ))}
            </div>
          ),
          Footer: () => <div className="conversation-footer">{footer}</div>,
        }}
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
