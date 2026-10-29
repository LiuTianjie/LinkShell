import { describe, expect, it } from "vitest";
import { cardsAtTurnEnd, type TimelineItem } from "../src/timeline.js";

const user = (id: string): TimelineItem => ({ kind: "user", id, blocks: [{ type: "text", text: id }], ts: 0 });
const agent = (id: string): TimelineItem => ({ kind: "agent", id, text: id, streaming: false, ts: 0 });
const plan = (id: string): TimelineItem => ({ kind: "plan", id, entries: [{ content: "x", priority: "medium", status: "pending" }], ts: 0 });
const end = (id: string): TimelineItem => ({ kind: "turn-end", id, stopReason: "end_turn", ts: 0 });
const ids = (items: TimelineItem[]) => items.map((item) => item.id);

describe("a plan's place in the conversation", () => {
  it("is the end of the turn still going on, under everything the turn has done", () => {
    expect(ids(cardsAtTurnEnd([user("u1"), plan("p1"), agent("a1"), agent("a2")]))).toEqual(["u1", "a1", "a2", "p1"]);
  });

  it("is the end of a finished turn, above its turn-ended line and before the next message", () => {
    expect(ids(cardsAtTurnEnd([user("u1"), plan("p1"), agent("a1"), end("e1"), user("u2"), plan("p2"), agent("a3")])))
      .toEqual(["u1", "a1", "p1", "e1", "u2", "a3", "p2"]);
    expect(ids(cardsAtTurnEnd([user("u1"), plan("p1"), agent("a1"), user("u2")]))).toEqual(["u1", "a1", "p1", "u2"]);
  });

  it("follows the turns the agent reported: a message sent mid-turn doesn't end it", () => {
    const items = [user("u1"), plan("p1"), agent("a1"), user("steer"), agent("a2"), user("u2"), plan("p2"), agent("a3")];
    expect(ids(cardsAtTurnEnd(items, ["a2"]))).toEqual(["u1", "a1", "steer", "a2", "p1", "u2", "a3", "p2"]);
  });

  it("stays put when it is itself the last thing its turn did", () => {
    const items = [user("u1"), agent("a1"), plan("p1"), user("u2"), agent("a2")];
    expect(cardsAtTurnEnd(items, ["p1"])).toBe(items);
  });

  it("keeps several plans of one turn in their order", () => {
    expect(ids(cardsAtTurnEnd([user("u1"), plan("p1"), agent("a1"), plan("p2"), agent("a2")]))).toEqual(["u1", "a1", "a2", "p1", "p2"]);
  });

  it("hands back the same array when nothing moves, so nothing re-renders", () => {
    const already = [user("u1"), agent("a1"), plan("p1")];
    expect(cardsAtTurnEnd(already)).toBe(already);
    const none = [user("u1"), agent("a1")];
    expect(cardsAtTurnEnd(none)).toBe(none);
  });
});

// The Claude app's end-of-turn box: its `wrap_up` call, written before the turn's last words.
const box = (id: string): TimelineItem => ({
  kind: "tool", id, title: "ccd_turn · wrap_up", toolKind: "other", status: "completed", content: [],
  detail: { type: "mcp", server: "ccd_turn", tool: "wrap_up" }, rawInput: { recap: "done", ask: "Ship it?", actions: [{ label: "Ship" }] }, ts: 0,
} as TimelineItem);
// A turn the app starts itself, when a session this one started reports back.
const reported = (id: string): TimelineItem => ({
  kind: "user", id, ts: 0,
  blocks: [{ type: "text", text: '<system-reminder>\nThe session "Docs" you started (local_1a2b) finished a turn. It reported (quoted): ok\n</system-reminder><side-sessions-event>None of the sessions you started is working now.</side-sessions-event>' }],
});

describe("the end-of-turn box's place", () => {
  it("is under the turn's last words and its plan, not where it was written", () => {
    expect(ids(cardsAtTurnEnd([user("u1"), agent("a1"), box("w1"), agent("a2"), plan("p1")], ["p1"]))).toEqual(["u1", "a1", "a2", "p1", "w1"]);
  });

  it("is under the last words when the turn's end was marked at their thinking", () => {
    const thought: TimelineItem = { kind: "thought", id: "thought:m2", text: "…", streaming: false, ts: 0 };
    const items = [user("u1"), agent("a1"), box("w1"), thought, agent("m2"), user("u2")];
    expect(ids(cardsAtTurnEnd(items, ["thought:m2", "m2"]))).toEqual(["u1", "a1", "thought:m2", "m2", "w1", "u2"]);
    // A thought with no words after it still ends the turn there.
    expect(ids(cardsAtTurnEnd([user("u1"), plan("p1"), thought, user("u2")], ["thought:m2"]))).toEqual(["u1", "thought:m2", "p1", "u2"]);
  });

  it("stays at the bottom, under turns the agent ran on its own, until the person writes", () => {
    const items = [user("u1"), agent("a1"), box("w1"), agent("a2"), reported("r1"), agent("a3")];
    expect(ids(cardsAtTurnEnd(items, ["a2", "a3"]))).toEqual(["u1", "a1", "a2", "r1", "a3", "w1"]);
    // Answered: it stays with its turn, and the next box is the one at the bottom.
    const answered = [...items, user("u2"), agent("a4"), box("w2"), agent("a5")];
    expect(ids(cardsAtTurnEnd(answered, ["a2", "a3", "a5"]))).toEqual(["u1", "a1", "a2", "w1", "r1", "a3", "u2", "a4", "a5", "w2"]);
  });
});
