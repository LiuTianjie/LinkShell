import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "zustand/vanilla";
import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@linkshell/client-core";
import type { Connection } from "../src/live/engine";
import { Runtime } from "../src/live/common";
import {
  Fold,
  StepsSummary,
  TimelineEntry,
  TimelineSearch,
  consumeDirectFoldSummaryClick,
} from "../src/live/Timeline";

function render(item: TimelineItem, options?: { searchQuery?: string; historical?: boolean }) {
  const connection = { store: createStore(() => ({ status: "online" })), link: {} } as unknown as Connection;
  const entry = createElement(TimelineEntry, {
    item,
    sessionId: "s",
    agent: "claude",
    showAsyncQuestions: false,
    answered: new Map(),
    historical: options?.historical,
    onFile: () => {},
    onFork: () => {},
    onTerminal: () => {},
  });
  return renderToStaticMarkup(
    createElement(
      Runtime.Provider,
      { value: connection },
      options?.searchQuery
        ? createElement(TimelineSearch.Provider, { value: options.searchQuery.toLowerCase() }, entry)
        : entry,
    ),
  );
}

describe("folded rows", () => {
  it("build a tool call's body only once it's opened, and still say what the call was", () => {
    const html = render({ kind: "tool", id: "t1", ts: 1, title: "Run tests", toolKind: "execute", status: "completed", content: [], output: "OUTPUT-MARKER", rawInput: { command: "npm test", description: "Run tests", marker: "INPUT-MARKER" }, rawOutput: { exitCode: 0 } } as unknown as TimelineItem);
    expect(html).toContain("<details");
    expect(html).toContain("Run tests");
    expect(html).not.toContain("OUTPUT-MARKER");
    expect(html).not.toContain("INPUT-MARKER");
    expect(html).not.toContain("timeline-search-hit");
  });

  it("build a thought's text only once it's opened", () => {
    const html = render({ kind: "thought", id: "th1", ts: 1, text: "THOUGHT-MARKER", streaming: false } as unknown as TimelineItem);
    expect(html).toContain("思考过程");
    expect(html).not.toContain("THOUGHT-MARKER");
  });

  it("auto-expands matching Fold blocks and wraps inline search hits in <mark> during ⌘F search", () => {
    const toolItem = {
      kind: "tool",
      id: "t-search",
      ts: 1,
      title: "Run tests",
      toolKind: "execute",
      status: "completed",
      content: [],
      output: "FAIL output-needle-42 in suite",
      rawInput: { command: "vitest run", description: "Run tests" },
      rawOutput: { exitCode: 1 },
    } as unknown as TimelineItem;

    const matchedHtml = render(toolItem, { searchQuery: "output-needle-42" });
    expect(matchedHtml).toContain(" open=\"\"");
    expect(matchedHtml).toContain('<mark class="timeline-search-hit">output-needle-42</mark>');

    const unmatchedHtml = render(toolItem, { searchQuery: "something-else" });
    expect(unmatchedHtml).not.toContain("output-needle-42");
  });

  it("marks only historical timeline entries and step summaries with data-historical", () => {
    const msg = {
      kind: "agent",
      id: "m1",
      ts: 1,
      text: "Hello world",
      streaming: false,
    } as unknown as TimelineItem;

    expect(render(msg, { historical: true })).toContain('data-historical=""');
    expect(render(msg, { historical: false })).not.toContain("data-historical");

    const stepHtml = renderToStaticMarkup(
      createElement(StepsSummary, {
        steps: [{ kind: "thought", id: "s1", ts: 1, text: "thinking", streaming: false } as never],
        open: false,
        historical: true,
        onToggle: () => {},
      }),
    );
    expect(stepHtml).toContain('data-historical=""');
  });

  it("toggles Fold cleanly on direct summary click without native double-toggle or inner-button hijack", () => {
    const detailsNode = {};
    const directSummary = { parentElement: detailsNode };
    const nestedSummary = { parentElement: {} };

    let userOpen = false;
    let searchQuery = "";
    const renderFold = () =>
      renderToStaticMarkup(
        createElement(
          TimelineSearch.Provider,
          { value: searchQuery },
          createElement(
            Fold,
            {
              open: userOpen,
              searchText: "run tests needle-99",
              summary: createElement("summary", null, "Run tests"),
            },
            createElement("pre", null, "HEAVY-DIFF-BODY"),
          ),
        ),
      );

    const simulateClick = (opts: {
      summary: { parentElement: unknown } | null;
      defaultPrevented?: boolean;
    }) => {
      let prevented = Boolean(opts.defaultPrevented);
      const consumed = consumeDirectFoldSummaryClick({
        defaultPrevented: prevented,
        currentTarget: detailsNode,
        target: { closest: (sel: string) => (sel === "summary" ? opts.summary : null) },
        preventDefault() {
          prevented = true;
        },
      });
      const searchMatched = Boolean(
        searchQuery && "run tests needle-99".includes(searchQuery),
      );
      if (consumed && !searchMatched) {
        userOpen = !userOpen;
      }
      return { consumed, prevented };
    };

    // Initially closed: heavy children unmounted
    expect(renderFold()).not.toContain("HEAVY-DIFF-BODY");
    expect(renderFold()).not.toContain(' open=""');

    // Inner button inside <summary> that already called preventDefault() must NOT toggle Fold
    expect(simulateClick({ summary: directSummary, defaultPrevented: true })).toEqual({
      consumed: false,
      prevented: true,
    });
    expect(userOpen).toBe(false);

    // Nested <details><summary> inside children must NOT toggle outer Fold
    expect(simulateClick({ summary: nestedSummary })).toEqual({
      consumed: false,
      prevented: false,
    });
    expect(userOpen).toBe(false);

    // Direct summary click calls preventDefault() synchronously and opens Fold
    expect(simulateClick({ summary: directSummary })).toEqual({
      consumed: true,
      prevented: true,
    });
    expect(userOpen).toBe(true);
    expect(renderFold()).toContain(' open=""');
    expect(renderFold()).toContain("HEAVY-DIFF-BODY");

    // Second summary click closes Fold and unmounts heavy children
    expect(simulateClick({ summary: directSummary })).toEqual({
      consumed: true,
      prevented: true,
    });
    expect(userOpen).toBe(false);
    expect(renderFold()).not.toContain("HEAVY-DIFF-BODY");

    // ⌘F search match opens closed Fold; clearing searchQuery unmounts it again (no sticky latch)
    searchQuery = "needle-99";
    expect(renderFold()).toContain(' open=""');
    expect(renderFold()).toContain("HEAVY-DIFF-BODY");

    searchQuery = "";
    expect(renderFold()).not.toContain(' open=""');
    expect(renderFold()).not.toContain("HEAVY-DIFF-BODY");

    // User-opened Fold stays open across searchQuery match -> clear
    simulateClick({ summary: directSummary });
    expect(userOpen).toBe(true);
    searchQuery = "needle-99";
    expect(renderFold()).toContain(' open=""');
    // Clicking summary while searchMatched prevents native toggle without mutating userOpen
    expect(simulateClick({ summary: directSummary })).toEqual({
      consumed: true,
      prevented: true,
    });
    expect(userOpen).toBe(true);
    searchQuery = "";
    expect(renderFold()).toContain(' open=""');
    expect(renderFold()).toContain("HEAVY-DIFF-BODY");
  });
});
