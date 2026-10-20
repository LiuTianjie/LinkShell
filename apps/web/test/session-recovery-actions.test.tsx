import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";
import type { Connection } from "../src/live/engine";
import { Runtime, SessionReady } from "../src/live/common";
import { AsyncQuestions } from "../src/live/AsyncQuestions";
import { Permission } from "../src/live/Permission";

vi.mock("../src/live/Timeline", () => ({ Diff: () => null, Blocks: () => null }));

const permission = createElement(Permission, {
  sessionId: "session-a",
  permission: {
    requestId: "approval-a",
    title: "运行命令",
    options: [
      { optionId: "allow", name: "允许一次", kind: "allow_once" },
      { optionId: "deny", name: "拒绝", kind: "reject_once" },
    ],
  },
});
const question = createElement(AsyncQuestions, {
  sessionId: "session-a",
  questions: [{ id: "question-a", title: "选择方案", options: ["方案 A", "方案 B"] }],
});

function render(element: typeof permission | typeof question, online: boolean, ready?: boolean) {
  const connection = {
    store: createStore(() => ({ status: online ? "online" : "reconnecting" })),
    link: {},
  } as unknown as Connection;
  return renderToStaticMarkup(createElement(Runtime.Provider, { value: connection },
    ready === undefined ? element : createElement(SessionReady.Provider, { value: ready }, element),
  ));
}

function buttons(markup: string) {
  return [...markup.matchAll(/<button\b[^>]*>/g)].map(([tag]) => tag);
}

describe("conversation recovery interaction boundary", () => {
  it("keeps cached approvals and questions disabled when the socket reconnects before history", () => {
    for (const element of [permission, question]) {
      const markup = render(element, true, false);
      expect(buttons(markup).length).toBeGreaterThan(1);
      expect(buttons(markup).every((tag) => tag.includes('disabled=""'))).toBe(true);
    }
    expect(render(permission, true, false)).toContain("会话正在同步");
  });

  it("enables the recovered request only after both connection and session are ready", () => {
    for (const element of [permission, question]) {
      expect(buttons(render(element, false, true)).every((tag) => tag.includes('disabled=""'))).toBe(true);
      // The free-form answer stays disabled until it has text; options are usable again.
      expect(buttons(render(element, true, true)).some((tag) => !tag.includes('disabled=""'))).toBe(true);
    }
  });

  it("preserves summary approvals outside an opened conversation", () => {
    expect(buttons(render(permission, true)).every((tag) => !tag.includes('disabled=""'))).toBe(true);
    expect(buttons(render(permission, false)).every((tag) => tag.includes('disabled=""'))).toBe(true);
  });
});
