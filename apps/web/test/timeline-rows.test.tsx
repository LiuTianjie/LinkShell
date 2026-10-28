import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";
import type { TimelineItem } from "@linkshell/client-core";
import type { Connection } from "../src/live/engine";
import { Runtime } from "../src/live/common";
import { Timeline, TimelineNavigation } from "../src/live/Timeline";

vi.mock("../src/live/engine", async () => ({ engine: { state: (await import("zustand/vanilla")).createStore(() => ({})) } }));

type Tool = Extract<TimelineItem, { kind: "tool" }>;
let next = 0;
const tool = (patch: Partial<Tool>): Tool => ({ kind: "tool", id: `t${next++}`, title: "Tool", toolKind: "other", status: "completed", content: [], output: "", ts: 0, ...patch });
const agent = (text: string): TimelineItem => ({ kind: "agent", id: `a${next++}`, text, streaming: false, ts: 0 });

function render(items: TimelineItem[], findSession?: (appId: string) => { title: string; open: () => void } | undefined) {
  const connection = { store: createStore(() => ({ status: "online" })), link: {} } as unknown as Connection;
  const timeline = createElement(Timeline, { items, sessionId: "s", agent: "claude", onFile: () => {} });
  const navigation = createElement(TimelineNavigation.Provider, { value: { cwd: "/w", open: () => {}, findSession } }, timeline);
  return renderToStaticMarkup(createElement(Runtime.Provider, { value: connection }, navigation));
}

describe("conversation rows as the Claude app words them", () => {
  it("reads a file on one line that opens the file, and runs a command that opens to its run", () => {
    const markup = render([
      agent("开始"),
      tool({ toolKind: "read", title: "Read a.ts", rawInput: { file_path: "/w/a.ts" } }),
      agent("然后"),
      tool({ toolKind: "execute", title: "Run tests", rawInput: { command: "npm test", description: "Run tests" }, output: "ok", rawOutput: { exitCode: 0 } }),
    ]);
    expect(markup).toMatch(/class="tool-record tool-line completed"[^>]*><div class="tool-summary">/);
    expect(markup).toContain('<span class="tool-verb">已读取 </span><button type="button" class="tool-file">a.ts</button>');
    expect(markup).toContain('<span class="tool-verb">已运行 </span><span class="tool-subject">Run tests</span>');
    expect(markup).toContain('<span class="tool-terminal-prompt" aria-hidden="true">$ </span>npm test');
    expect(markup).toContain(">成功</small>");
  });

  it("folds two steps into a sentence and leaves thinking out", () => {
    const markup = render([
      tool({ toolKind: "execute", title: "ls", rawInput: { command: "ls" } }),
      { kind: "thought", id: "th", text: "**Looking**", streaming: false, ts: 0 },
      tool({ toolKind: "execute", title: "pwd", rawInput: { command: "pwd" }, status: "failed" }),
    ]);
    expect(markup).toContain('<span class="steps-summary-label">已运行 2 个命令</span><span class="steps-summary-failed">（1 项失败）</span>');
    expect(markup).not.toContain("thought-block");
  });

  it("classifies errors and shows the raw words under 查看详情", () => {
    const markup = render([{ kind: "error", id: "e", code: "rate_limit", message: "You've hit your session limit", ts: 0 }]);
    expect(markup).toContain("请求过于频繁");
    expect(markup).toContain("稍后重试，或换一个模型。");
    expect(markup).toContain("<summary>查看详情</summary>");
  });

  it("draws the Claude app's own tools as cards and dividers", () => {
    const markup = render([
      tool({ detail: { type: "mcp", server: "ccd_session", tool: "mark_chapter" }, rawInput: { title: "Survey" } }),
      tool({ detail: { type: "mcp", server: "ccd_turn", tool: "update_plan" }, rawInput: { advance: true } }),
      tool({ detail: { type: "mcp", server: "ccd_session", tool: "start_session" }, rawInput: { title: "Fix it" }, output: "Started session \"Fix it\" (session_id: local_1)." }),
      tool({ detail: { type: "mcp", server: "ccd_turn", tool: "wrap_up" }, rawInput: { recap: "Done.", ask: "Ship?", actions: [{ label: "Ship" }] } }),
      tool({ toolKind: "think", detail: { type: "compaction" }, rawInput: { trigger: "auto" } }),
    ]);
    expect(markup).toContain('<p class="timeline-divider timeline-chapter">Survey</p>');
    expect(markup).not.toContain("Update plan");
    expect(markup).toContain("<strong>Fix it</strong><small>已启动</small>");
    expect(markup).toContain('<span class="wrap-up-chip">Ship</span>');
    expect(markup).toContain(">上下文已自动压缩</p>");
  });

  it("opens the started session when this computer has it", () => {
    const started = tool({ detail: { type: "mcp", server: "ccd_session", tool: "start_session" }, rawInput: { title: "Fix it" }, output: "Started session \"Fix it\" (session_id: local_1)." });
    expect(render([started], (appId) => (appId === "local_1" ? { title: "Fix it", open: () => {} } : undefined))).toContain('<button type="button" class="session-card" data-state="started"');
    expect(render([started], () => undefined)).toContain('<div class="session-card" data-state="started">');
  });

  it("words an agent's retries as reconnecting, one line for consecutive ones", () => {
    const markup = render([{ kind: "notice", id: "n", level: "warning", title: "Reconnecting... 2/5", ts: 0 }]);
    // Not the live end of a running turn here: the retry is in the past.
    expect(markup).toContain('<p class="timeline-divider timeline-reconnect">已重新连接（重试 2 次）</p>');
  });
});
