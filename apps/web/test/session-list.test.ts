import { expect, it } from "vitest";
import type { SessionSummary } from "@linkshell/wire";
import { sessionGroup, sessionNeedsAttention, sessionPreview } from "../src/live/session-list";
const session = {
  id: "one",
  state: "running",
  pendingPermissions: 0,
} as SessionSummary;
it("keeps a running agent's async question in the attention group", () => {
  const pending = {
    ...session,
    asyncQuestions: [{ id: "question", title: "补充说明", options: [] }],
  };
  expect(sessionNeedsAttention(pending)).toBe(true);
  expect(sessionGroup(pending)).toBe("waiting");
  expect(sessionGroup({ ...pending, asyncQuestions: [] })).toBe("running");
});
it("keeps blocking approvals visible and finished sessions out of attention", () => {
  expect(sessionGroup({ ...session, state: "waiting" })).toBe("waiting");
  expect(sessionGroup({ ...session, state: "idle" })).toBe("recent");
  expect(sessionNeedsAttention({ ...session, state: "idle" })).toBe(false);
});
it("shows a preview as plain words, without Markdown or a prompt's envelope", () => {
  expect(sessionPreview({ preview: "已修复 [https://example.com/a](https://example.com/a…" })).toBe("已修复 https://example.com/a");
  expect(sessionPreview({ preview: "共 **177 个** 文件，`pnpm test` 通过" })).toBe("共 177 个 文件，pnpm test 通过");
  expect(sessionPreview({ preview: "共 **177…" })).toBe("共 177…");
  expect(sessionPreview({ preview: "## 结果 | 名称 | 状态 | |---|---| | wire | 通过 |" })).toBe("结果 名称 状态 wire 通过");
  expect(sessionPreview({ preview: "# Files mentioned by the user: ## shot.png: /var/folders/x/shot.png Image attachment: true" })).toBe("");
  expect(sessionPreview({ preview: "# Files mentioned by the user: ## a.png: /tmp/a.png ## My request: 修一下按钮" })).toBe("修一下按钮");
  expect(sessionPreview({ preview: "<heartbeat><instructions>检查构建</instructions></heartbeat>" })).toBe("检查构建");
  expect(sessionPreview({ preview: "snake_case_name and 2 * 3 * 4 stay" })).toBe("snake_case_name and 2 * 3 * 4 stay");
  expect(sessionPreview({ preview: "- first * second" })).toBe("first * second");
  expect(sessionPreview({ activity: { kind: "tool", title: "Run `pnpm build`" } as SessionSummary["activity"], preview: "x" })).toBe("Run pnpm build");
  expect(sessionPreview({})).toBe("");
});
