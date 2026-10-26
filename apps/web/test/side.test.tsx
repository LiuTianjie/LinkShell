import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary, SideChat } from "@linkshell/wire";
import type { Connection } from "../src/live/engine";
import { Runtime } from "../src/live/common";
import { Side } from "../src/live/Side";

vi.mock("../src/live/Timeline", () => ({ RichText: ({ text }: { text: string }) => createElement("div", { className: "markdown" }, text) }));

const session = { id: "codex:t1", agent: "codex", cwd: "/w" } as SessionSummary;

function render(sides: SideChat[], online = true) {
  const connection = {
    store: createStore(() => ({ status: online ? "online" : "reconnecting", sides: { [session.id]: sides }, loadSides: async () => sides })),
    link: {},
  } as unknown as Connection;
  return renderToStaticMarkup(createElement(Runtime.Provider, { value: connection }, createElement(Side, { session, label: "Codex" })));
}

describe("side conversations panel", () => {
  it("says how the agent answers before anything is asked", () => {
    const markup = render([]);
    expect(markup).toContain("只读的临时分叉");
    expect(markup).toContain("提问");
    expect(markup).not.toContain("side-chat-tabs");
  });

  it("shows the latest conversation with what the agent did and offers to stop while it answers", () => {
    const markup = render([
      {
        sideId: "a",
        createdAt: 1,
        running: true,
        revision: 3,
        messages: [
          { id: "q", role: "user", text: "这个函数在哪里调用？" },
          { id: "r", role: "assistant", text: "在 `hub.ts` 里。", activity: ["rg side"] },
        ],
      },
    ]);
    expect(markup).toContain("这个函数在哪里调用？");
    expect(markup).toContain("在 `hub.ts` 里。");
    expect(markup).toContain("rg side");
    expect(markup).toContain("停止回答");
    expect(markup).toContain("结束这个旁支");
    expect(markup).toContain("＋ 新的旁支");
  });

  it("shows why an answer didn't come", () => {
    const markup = render([
      { sideId: "a", createdAt: 1, running: false, revision: 2, messages: [{ id: "q", role: "user", text: "早" }, { id: "r", role: "assistant", text: "", error: "先发一条再问" }] },
    ]);
    expect(markup).toContain("先发一条再问");
    expect(markup).toContain("接着问");
  });
});
