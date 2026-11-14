import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import type { SessionSummary } from "@linkshell/wire";
import {
  attentionEvents,
  attentionMessage,
  attentionPhases,
  startSessionAttention,
} from "../src/core/attention";
import type { Connection } from "../src/core/connections";

function session(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    agent: "codex",
    cwd: "/Users/me/code/portal",
    title: `会话 ${id}`,
    state: "idle",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  } as SessionSummary;
}

function byId(...list: SessionSummary[]): Record<string, SessionSummary> {
  return Object.fromEntries(list.map((entry) => [entry.id, entry]));
}

describe("attentionEvents", () => {
  it("stays quiet about sessions it sees for the first time", () => {
    const sessions = byId(session("a", { state: "waiting" }), session("b", { state: "running" }));
    expect(attentionEvents(new Map(), attentionPhases(sessions), sessions)).toEqual([]);
  });

  it("reports a session that starts waiting, finishes or fails", () => {
    const before = byId(
      session("ask", { state: "running" }),
      session("done", { state: "running" }),
      session("broke", { state: "running" }),
      session("still", { state: "running" }),
    );
    const after = byId(
      session("ask", { state: "waiting" }),
      session("done", { state: "idle" }),
      session("broke", { state: "error" }),
      session("still", { state: "running" }),
    );
    expect(attentionEvents(attentionPhases(before), attentionPhases(after), after)).toEqual([
      { sessionId: "ask", kind: "waiting" },
      { sessionId: "done", kind: "finished" },
      { sessionId: "broke", kind: "failed" },
    ]);
  });

  it("leaves a sub-agent's end to its parent but still reports its questions", () => {
    const before = byId(
      session("child", { state: "running", parentId: "root" }),
      session("asks", { state: "running", parentId: "root" }),
    );
    const after = byId(
      session("child", { state: "idle", parentId: "root" }),
      session("asks", { state: "waiting", parentId: "root" }),
    );
    expect(attentionEvents(attentionPhases(before), attentionPhases(after), after)).toEqual([
      { sessionId: "asks", kind: "waiting" },
    ]);
  });

  it("does not call an idle session that was never running finished", () => {
    const before = byId(session("a", { state: "waiting" }));
    const after = byId(session("a", { state: "idle" }));
    expect(attentionEvents(attentionPhases(before), attentionPhases(after), after)).toEqual([]);
  });

  it("ignores archived sessions", () => {
    const sessions = byId(session("a", { state: "waiting", archived: true }));
    expect(attentionPhases(sessions).size).toBe(0);
  });
});

describe("attentionMessage", () => {
  it("names the session and where it runs", () => {
    const waiting = session("a", { state: "waiting" });
    expect(attentionMessage({ sessionId: "a", kind: "finished" }, waiting, "zh")).toEqual({
      title: "会话 a",
      body: "已完成 · portal",
    });
    expect(attentionMessage({ sessionId: "a", kind: "failed" }, waiting, "en").body).toBe(
      "Failed · portal",
    );
  });
});

describe("startSessionAttention", () => {
  function harness() {
    const posted: Record<string, unknown>[] = [];
    const store = createStore(() => ({
      status: "online" as string,
      sessions: byId(session("a", { state: "running" })),
    }));
    const connection = { computer: { key: "desktop:local" }, store } as unknown as Connection;
    let emit: (value: Connection | undefined) => void = () => {};
    const stop = startSessionAttention({
      post: (message) => {
        posted.push(message);
        return true;
      },
      subscribeConnection: (listener) => {
        emit = listener;
        listener(connection);
        return () => {};
      },
    });
    return { posted, store, stop, emit: (value: Connection | undefined) => emit(value) };
  }

  it("posts the badge count and one notification per change", () => {
    const { posted, store } = harness();
    expect(posted).toEqual([{ action: "badge", count: 0 }]);

    store.setState({ sessions: byId(session("a", { state: "waiting" })) });
    expect(posted.slice(1)).toEqual([
      {
        action: "notify",
        id: "desktop:local:a",
        computerKey: "desktop:local",
        sessionId: "a",
        title: "会话 a",
        body: expect.stringContaining("portal"),
      },
      { action: "badge", count: 1 },
    ]);

    // The same summaries again (another field of the store changed) say nothing new.
    store.setState({ sessions: { ...store.getState().sessions } });
    expect(posted).toHaveLength(3);
  });

  it("reports what happened during a dropped link once the list is read again", () => {
    const { posted, store } = harness();
    const notified = () => posted.filter((message) => message.action === "notify");
    store.setState({ status: "connecting" });
    expect(notified()).toEqual([]);

    // Back online with the summaries the store kept: nothing has changed yet.
    store.setState({ status: "online" });
    expect(notified()).toEqual([]);

    store.setState({ sessions: byId(session("a", { state: "idle" })) });
    expect(notified()).toHaveLength(1);
  });

  it("clears the badge when no computer is selected and when stopped", () => {
    const { posted, store, stop, emit } = harness();
    store.setState({ sessions: byId(session("a", { state: "waiting" })) });
    emit(undefined);
    expect(posted.at(-1)).toEqual({ action: "badge", count: 0 });
    stop();
  });
});
