import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "zustand/vanilla";
import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@linkshell/client-core";
import type { Connection } from "../src/live/engine";
import { Runtime } from "../src/live/common";
import { TimelineEntry } from "../src/live/Timeline";

function render(item: TimelineItem) {
  const connection = { store: createStore(() => ({ status: "online" })), link: {} } as unknown as Connection;
  return renderToStaticMarkup(createElement(Runtime.Provider, { value: connection },
    createElement(TimelineEntry, { item, sessionId: "s", agent: "claude", showAsyncQuestions: false, answered: new Map(), onFile: () => {}, onFork: () => {}, onTerminal: () => {} })));
}

describe("folded rows", () => {
  it("build a tool call's body only once it's opened, and still say what the call was", () => {
    const html = render({ kind: "tool", id: "t1", ts: 1, title: "Run tests", toolKind: "execute", status: "completed", content: [], output: "OUTPUT-MARKER", rawInput: { command: "npm test", description: "Run tests", marker: "INPUT-MARKER" }, rawOutput: { exitCode: 0 } } as unknown as TimelineItem);
    expect(html).toContain("<details");
    expect(html).toContain("Run tests");
    expect(html).not.toContain("OUTPUT-MARKER");
    expect(html).not.toContain("INPUT-MARKER");
  });

  it("build a thought's text only once it's opened", () => {
    const html = render({ kind: "thought", id: "th1", ts: 1, text: "THOUGHT-MARKER", streaming: false } as unknown as TimelineItem);
    expect(html).toContain("思考过程");
    expect(html).not.toContain("THOUGHT-MARKER");
  });
});
