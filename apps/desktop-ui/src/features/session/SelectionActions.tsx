import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { requestComposerFocus } from "@/bridge";
import { composerDrafts, draftKeyFor } from "@/core/composer-draft";
import { DesktopIcon } from "@/icons";
import { askInSideChat, quoteMarkdown } from "../inspector/side-chat-store";
import { useSessionCopy } from "./session-helpers";

/** Long enough for a passage worth asking about; a whole transcript belongs in a file. */
const MAX_QUOTE_CHARS = 6000;
const GAP_PX = 8;
const EDGE_PX = 8;

interface Placement {
  text: string;
  x: number;
  y: number;
  below: boolean;
}

/** The selected timeline text, or undefined when the selection isn't a passage of it. */
export function selectedTimelineText(selection: Selection | null, track: HTMLElement): { text: string; range: Range } | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  if (!element || !track.contains(element)) return undefined;
  // Typing in an answer box or a code editor isn't quoting the conversation.
  if (element.closest("input, textarea, [contenteditable=''], [contenteditable='true'], button")) return undefined;
  const text = selection.toString().trim();
  if (!text) return undefined;
  return { text: text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS - 1)}…` : text, range };
}

/**
 * Actions on selected timeline text: ask about it in a new side conversation (agents
 * that have one), or quote it into the reply.
 */
export function SelectionActions({
  scrollerRef,
  trackRef,
  computerKey,
  sessionId,
  sideSupported,
}: {
  scrollerRef: RefObject<HTMLElement | null>;
  trackRef: RefObject<HTMLElement | null>;
  computerKey: string;
  sessionId: string;
  sideSupported: boolean;
}) {
  const copy = useSessionCopy();
  const [placement, setPlacement] = useState<Placement | null>(null);
  const rangeRef = useRef<Range | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const placementTextRef = useRef<string | undefined>(undefined);
  placementTextRef.current = placement?.text;

  const hide = useCallback(() => {
    rangeRef.current = null;
    setPlacement(null);
  }, []);

  const place = useCallback((text: string, range: Range) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const bounds = scroller.getBoundingClientRect();
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    const first = rects[0] ?? range.getBoundingClientRect();
    const last = rects[rects.length - 1] ?? first;
    // Out of view (scrolled away): nothing to point at.
    if (last.bottom < bounds.top || first.top > bounds.bottom) {
      setPlacement(null);
      return;
    }
    const all = range.getBoundingClientRect();
    const below = first.top - 40 < bounds.top;
    setPlacement({
      text,
      x: all.left + all.width / 2,
      y: below ? Math.min(last.bottom, bounds.bottom - 40) + GAP_PX : Math.max(first.top, bounds.top) - GAP_PX,
      below,
    });
  }, [scrollerRef]);

  const readSelection = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const hit = selectedTimelineText(window.getSelection(), track);
    if (!hit) {
      hide();
      return;
    }
    rangeRef.current = hit.range;
    place(hit.text, hit.range);
  }, [hide, place, trackRef]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    let frame = 0;
    // After the click that ends a drag has updated the selection.
    const onPointerUp = () => setTimeout(readSelection, 0);
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.shiftKey) readSelection();
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const range = rangeRef.current;
        const text = placementTextRef.current;
        if (range && text) place(text, range);
      });
    };
    const onSelectionChange = () => {
      const track = trackRef.current;
      if (rangeRef.current && track && !selectedTimelineText(window.getSelection(), track)) hide();
    };
    scroller.addEventListener("pointerup", onPointerUp);
    scroller.addEventListener("keyup", onKeyUp);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("pointerup", onPointerUp);
      scroller.removeEventListener("keyup", onKeyUp);
      scroller.removeEventListener("scroll", onScroll);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [hide, place, readSelection, scrollerRef, trackRef]);

  // A different session is a different conversation.
  useEffect(() => hide, [computerKey, sessionId, hide]);

  useEffect(() => {
    if (!placement) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", hide);
    };
  }, [hide, placement]);

  useLayoutEffect(() => {
    if (placement && toolbarRef.current) setWidth(toolbarRef.current.offsetWidth);
  }, [placement, sideSupported, copy]);

  if (!placement) return null;

  const viewport = document.documentElement.clientWidth;
  const half = width / 2;
  const x = Math.min(Math.max(placement.x, half + EDGE_PX), viewport - half - EDGE_PX);

  const finish = () => {
    window.getSelection()?.removeAllRanges();
    hide();
  };

  return createPortal(
    <div
      ref={toolbarRef}
      className="ls-selection-actions"
      role="toolbar"
      aria-label={copy.selectionActions}
      data-below={placement.below ? "true" : undefined}
      style={{ left: x, top: placement.y }}
      // Keeps the selection while a button is pressed.
      onPointerDown={(event) => event.preventDefault()}
    >
      {sideSupported ? (
        <button
          type="button"
          className="ls-selection-actions__btn"
          onClick={() => {
            askInSideChat(computerKey, sessionId, placement.text);
            finish();
          }}
        >
          <DesktopIcon name="sparkles" size="xs" />
          <span>{copy.selectionAskSide}</span>
        </button>
      ) : null}
      <button
        type="button"
        className="ls-selection-actions__btn"
        onClick={() => {
          const quoted = quoteMarkdown(placement.text);
          composerDrafts.getState().update(draftKeyFor(computerKey, sessionId), (current) => {
            const before = current.trimEnd();
            return before ? `${before}\n\n${quoted}\n\n` : `${quoted}\n\n`;
          });
          finish();
          requestComposerFocus();
          requestAnimationFrame(() => {
            const area = document.querySelector<HTMLTextAreaElement>(".ls-composer-box textarea");
            if (!area) return;
            const end = area.value.length;
            area.setSelectionRange(end, end);
            area.scrollTop = area.scrollHeight;
          });
        }}
      >
        <DesktopIcon name="quote" size="xs" />
        <span>{copy.selectionQuote}</span>
      </button>
    </div>,
    document.body,
  );
}
