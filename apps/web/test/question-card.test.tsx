import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";
import type { Connection } from "../src/live/engine";
import { Runtime } from "../src/live/common";
import { AsyncQuestions } from "../src/live/AsyncQuestions";
import { Permission } from "../src/live/Permission";

vi.mock("../src/live/Timeline", () => ({ Diff: () => null, Blocks: () => null }));

// A Claude AskUserQuestion with two questions, as the host passes it on.
const asked = {
  requestId: "ask-a",
  title: "Please answer the following questions.",
  options: [
    { optionId: "skip", name: "Skip", kind: "reject_once" as const },
    { optionId: "cancel", name: "Stop", kind: "reject_once" as const },
  ],
  questions: [
    {
      id: "question_0",
      header: "框选调整",
      text: "结果窗口的大小应该怎么调整？",
      kind: "choice" as const,
      other: true,
      options: [
        { value: "结果窗口边缘可拖动 (Recommended)", label: "结果窗口边缘可拖动 (Recommended)", description: "拖动四边和四角改变大小" },
        { value: "固定三档大小", label: "固定三档大小" },
      ],
    },
    {
      id: "question_1",
      text: "Which checks should run?",
      kind: "choices" as const,
      options: [{ value: "tests (Recommended)", label: "tests (Recommended)" }, { value: "lint", label: "lint" }],
    },
  ],
};

function render(element: ReactElement) {
  const connection = { store: createStore(() => ({ status: "online" })), link: {} } as unknown as Connection;
  return renderToStaticMarkup(createElement(Runtime.Provider, { value: connection }, element));
}
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const buttons = (markup: string) => [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(([, inner]) => text(inner!).trim()).filter(Boolean);

describe("agent question card", () => {
  const markup = render(createElement(Permission, { permission: asked, sessionId: "session-a" }));

  it("shows the host's known English in Chinese and the agent's own words as written", () => {
    expect(text(markup)).toContain("请回答以下问题");
    expect(markup).not.toContain("Please answer the following questions.");
    expect(text(markup)).toContain("Which checks should run?");
    // The ways out, then the answer: one row, the answer last.
    expect(buttons(markup).slice(-3)).toEqual(["跳过", "停止", "提交回答"]);
  });

  it("shows an agent's (Recommended) as a 推荐 badge and still answers with the agent's label", () => {
    expect(text(markup)).not.toContain("(Recommended)");
    expect(markup.match(/<span class="choice-badge">推荐<\/span>/g)).toHaveLength(2);
    expect(markup).toContain('<span class="choice-label">结果窗口边缘可拖动<span class="choice-badge">推荐</span></span>');
    expect(markup).toContain('value="结果窗口边缘可拖动 (Recommended)"');
  });

  it("keeps a question header apart from the question and marks the card as questions", () => {
    expect(markup).toContain('data-kind="questions"');
    expect(markup).toContain('<small class="question-header"><span>框选调整</span></small>');
  });

  it("says a lone question once, in the heading", () => {
    const question = asked.questions[0]!;
    const single = render(createElement(Permission, {
      permission: { ...asked, title: question.text, questions: [question] },
      sessionId: "session-a",
    }));
    expect(single).toContain(`<strong>${question.text}</strong>`);
    // Still the question's accessible name, only not shown a second time.
    expect(single).toContain(`<span class="sr-only">${question.text}</span>`);
    expect(single).not.toContain('class="question-text"');
  });

  it("leaves a permission's own options and title alone", () => {
    const approval = render(createElement(Permission, {
      permission: { requestId: "p", title: "Stop", options: [{ optionId: "cancel", name: "Stop", kind: "reject_once" }] },
      sessionId: "session-a",
    }));
    expect(buttons(approval)).toEqual(["Stop"]);
    expect(approval).not.toContain('data-kind="questions"');
  });

  it("badges a recommended async answer too, answering with the agent's own text", () => {
    const async = render(createElement(AsyncQuestions, {
      sessionId: "session-a",
      questions: [{ id: "q", title: "下一步？", options: ["先修布局 (Recommended)", "先补测试"] }],
    }));
    expect(buttons(async)).toContain("先修布局 推荐");
    expect(text(async)).not.toContain("(Recommended)");
  });
});
