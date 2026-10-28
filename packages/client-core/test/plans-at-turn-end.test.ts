import { describe, expect, it } from "vitest";
import { plansAtTurnEnd, type TimelineItem } from "../src/timeline.js";

const user = (id: string): TimelineItem => ({ kind: "user", id, blocks: [{ type: "text", text: id }], ts: 0 });
const agent = (id: string): TimelineItem => ({ kind: "agent", id, text: id, streaming: false, ts: 0 });
const plan = (id: string): TimelineItem => ({ kind: "plan", id, entries: [{ content: "x", priority: "medium", status: "pending" }], ts: 0 });
const end = (id: string): TimelineItem => ({ kind: "turn-end", id, stopReason: "end_turn", ts: 0 });
const ids = (items: TimelineItem[]) => items.map((item) => item.id);

describe("a plan's place in the conversation", () => {
  it("is the end of the turn still going on, under everything the turn has done", () => {
    expect(ids(plansAtTurnEnd([user("u1"), plan("p1"), agent("a1"), agent("a2")]))).toEqual(["u1", "a1", "a2", "p1"]);
  });

  it("is the end of a finished turn, above its turn-ended line and before the next message", () => {
    expect(ids(plansAtTurnEnd([user("u1"), plan("p1"), agent("a1"), end("e1"), user("u2"), plan("p2"), agent("a3")])))
      .toEqual(["u1", "a1", "p1", "e1", "u2", "a3", "p2"]);
    expect(ids(plansAtTurnEnd([user("u1"), plan("p1"), agent("a1"), user("u2")]))).toEqual(["u1", "a1", "p1", "u2"]);
  });

  it("follows the turns the agent reported: a message sent mid-turn doesn't end it", () => {
    const items = [user("u1"), plan("p1"), agent("a1"), user("steer"), agent("a2"), user("u2"), plan("p2"), agent("a3")];
    expect(ids(plansAtTurnEnd(items, ["a2"]))).toEqual(["u1", "a1", "steer", "a2", "p1", "u2", "a3", "p2"]);
  });

  it("stays put when it is itself the last thing its turn did", () => {
    const items = [user("u1"), agent("a1"), plan("p1"), user("u2"), agent("a2")];
    expect(plansAtTurnEnd(items, ["p1"])).toBe(items);
  });

  it("keeps several plans of one turn in their order", () => {
    expect(ids(plansAtTurnEnd([user("u1"), plan("p1"), agent("a1"), plan("p2"), agent("a2")]))).toEqual(["u1", "a1", "a2", "p1", "p2"]);
  });

  it("hands back the same array when nothing moves, so nothing re-renders", () => {
    const already = [user("u1"), agent("a1"), plan("p1")];
    expect(plansAtTurnEnd(already)).toBe(already);
    const none = [user("u1"), agent("a1")];
    expect(plansAtTurnEnd(none)).toBe(none);
  });
});
