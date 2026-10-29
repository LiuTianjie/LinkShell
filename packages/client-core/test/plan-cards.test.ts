import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionUpdate } from "@linkshell/wire";
import { applyEvents, emptyView, cardsAtTurnEnd, prependEvents, type SessionView } from "../src/timeline.js";

// The task list a Claude desktop session keeps (its update_plan tool) as LinkShell shows it: one
// card per list, at the end of the turn that last moved it on.

let seq = 0;
const at = (update: SessionUpdate): SessionEvent => ({ sessionId: "s", seq: ++seq, ts: seq, update });
const userSays = (id: string) => at({ sessionUpdate: "user_message_chunk", messageId: id, content: { type: "text", text: id } });
const replies = (id: string) => at({ sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text: id } });
const starts = () => at({ sessionUpdate: "ls_turn", state: "started" });
const ends = () => at({ sessionUpdate: "ls_turn", state: "ended", stopReason: "end_turn" });
const plan = (step: number, planId?: string) =>
  at({ sessionUpdate: "plan", ...(planId ? { planId } : {}), entries: [1, 2, 3].map((n) => ({ content: `step ${n}`, priority: "medium" as const, status: n < step ? "completed" as const : n === step ? "in_progress" as const : "pending" as const })) });
const shown = (view: SessionView) => cardsAtTurnEnd(view.items, view.turnBreaks).map((item) => item.kind === "plan" ? `plan@${item.entries.findIndex((e) => e.status === "in_progress") + 1}` : item.id);

describe("plan cards", () => {
  it("a background task reporting back mid-turn doesn't start a second card", () => {
    seq = 0;
    // The Claude app folds the report into the running turn; the host still says a turn started.
    const view = applyEvents(emptyView("s"), [userSays("u1"), starts(), plan(1), replies("a1"), starts(), plan(2), replies("a2")]);
    expect(shown(view)).toEqual(["u1", "a1", "a2", "plan@2"]);
  });

  it("without an id, a new turn still gets a card of its own", () => {
    seq = 0;
    const view = applyEvents(emptyView("s"), [userSays("u1"), starts(), plan(1), replies("a1"), ends(), userSays("u2"), starts(), plan(2), replies("a2")]);
    expect(shown(view)).toEqual(["u1", "a1", "plan@1", "u2", "a2", "plan@2"]);
  });

  it("a named plan moved on in a later turn is one card, taken down to that turn", () => {
    seq = 0;
    const view = applyEvents(emptyView("s"), [
      userSays("u1"), starts(), plan(1, "list"), replies("a1"), ends(),
      // The turn woken by the build finishing goes on with the same list.
      starts(), replies("a2"), plan(2, "list"), replies("a3"), ends(),
      userSays("u3"), starts(), replies("a4"),
    ]);
    expect(shown(view)).toEqual(["u1", "a1", "a2", "a3", "plan@2", "u3", "a4"]);
    // The first turn still ends where it did: after its reply, not after the moved card.
    expect(view.turnBreaks).toContain("a1");
  });

  it("an earlier page of history doesn't pull a moved card back up", () => {
    seq = 0;
    const events = [
      userSays("u1"), starts(), plan(1, "list"), replies("a1"), ends(),
      starts(), replies("a2"), plan(3, "list"), replies("a3"), ends(),
    ];
    const whole = applyEvents(emptyView("s"), events);
    // The phone opens the session at the second turn and loads the first one later.
    const later = applyEvents({ ...emptyView("s"), startSeq: 6 }, events.slice(5));
    const joined = prependEvents(later, events.slice(0, 5), 1);
    expect(shown(joined)).toEqual(shown(whole));
    expect(shown(joined)).toEqual(["u1", "a1", "a2", "a3", "plan@3"]);
  });

  it("an earlier page keeps where its own turns ended", () => {
    seq = 0;
    const events = [
      userSays("u1"), starts(), plan(1), replies("a1"), ends(),
      userSays("u2"), starts(), replies("a2"), ends(),
    ];
    const later = applyEvents({ ...emptyView("s"), startSeq: 6 }, events.slice(5));
    const joined = prependEvents(later, events.slice(0, 5), 1);
    expect(shown(joined)).toEqual(["u1", "a1", "plan@1", "u2", "a2"]);
  });
});
