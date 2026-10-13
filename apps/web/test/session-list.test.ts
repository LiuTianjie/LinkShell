import { expect, it } from "vitest";
import type { SessionSummary } from "@linkshell/wire";
import { sessionGroup, sessionNeedsAttention } from "../src/live/session-list";
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
