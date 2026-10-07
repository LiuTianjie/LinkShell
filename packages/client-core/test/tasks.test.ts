import { expect, it } from "vitest";
import type { BackgroundTask, SessionEvent } from "@linkshell/wire";
import { applyTaskEvent, mergeTaskList } from "../src/tasks.js";
it("restores tasks outside chat history and ignores late reconnect snapshots", () => {
  const task: BackgroundTask = { id: "b1", title: "same command", kind: "shell", startedAt: 1, state: "running", lastSeq: 10 };
  const restored = mergeTaskList({}, [task, { ...task, id: "b2" }]);
  const event: SessionEvent = { sessionId: "s", seq: 12, ts: 2, update: { sessionUpdate: "ls_task", task: { ...task, state: "completed" } } };
  const next = applyTaskEvent(restored, event);
  expect(mergeTaskList(next, [task])).toBe(next);
  expect(applyTaskEvent(next, { ...event, seq: 9 })).toBe(next);
  expect(next.b1?.state).toBe("completed"); expect(next.b2?.state).toBe("running");
});
