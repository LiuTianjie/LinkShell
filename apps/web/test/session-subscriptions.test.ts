import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientStore } from "@linkshell/client-core";
import type { SessionSummary } from "@linkshell/wire";
import { SessionSubscriptions } from "../src/live/session-subscriptions";

function session(id: string, archived = false): SessionSummary {
  return {
    id,
    agent: "codex",
    cwd: "/work/project",
    state: "idle",
    archived,
    createdAt: 1,
    updatedAt: 1,
  } as SessionSummary;
}

function makeFakeStore(initialIds = ["a", "b", "c", "d"]) {
  let sessions: Record<string, SessionSummary> = Object.fromEntries(initialIds.map((id) => [id, session(id)]));
  const listeners = new Set<(state: { sessions: Record<string, SessionSummary> }, prev: { sessions: Record<string, SessionSummary> }) => void>();
  const openSession = vi.fn();
  const closeSession = vi.fn();
  const state = () => ({
    sessions,
    openSession,
    closeSession,
  });
  const store = {
    getState: state,
    subscribe(listener: (next: ReturnType<typeof state>, prev: ReturnType<typeof state>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ClientStore;
  const setSessions = (next: Record<string, SessionSummary>) => {
    const prev = state();
    sessions = next;
    const current = state();
    for (const listener of listeners) listener(current, prev);
  };
  return { store, openSession, closeSession, setSessions, getSessions: () => sessions };
}

describe("SessionSubscriptions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reference-counts active views and keeps recently left sessions warm across switches", () => {
    const { store, openSession, closeSession } = makeFakeStore(["a", "b"]);
    const subs = new SessionSubscriptions(store, { maxWarm: 3, ttlMs: 300_000 });

    const releaseFirst = subs.acquire("a");
    const releaseSecond = subs.acquire("a");
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledWith("a");

    releaseFirst();
    expect(closeSession).not.toHaveBeenCalled();

    // Leaving "a" moves it to warm cache without closing its stream.
    releaseSecond();
    expect(closeSession).not.toHaveBeenCalled();

    // Switching to "b" and right back to "a" reuses the warm subscription with zero extra RPCs.
    const releaseB = subs.acquire("b");
    expect(openSession).toHaveBeenCalledTimes(2);
    releaseB();

    const releaseAAgain = subs.acquire("a");
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(closeSession).not.toHaveBeenCalled();

    releaseAAgain();
    vi.advanceTimersByTime(300_000);
    expect(closeSession).toHaveBeenCalledWith("b");
    expect(closeSession).toHaveBeenCalledWith("a");
  });

  it("evicts the oldest warm session when exceeding maxWarm", () => {
    const { store, openSession, closeSession } = makeFakeStore(["s1", "s2", "s3", "s4"]);
    const subs = new SessionSubscriptions(store, { maxWarm: 2, ttlMs: 300_000 });

    subs.acquire("s1")();
    subs.acquire("s2")();
    expect(closeSession).not.toHaveBeenCalled();

    // Touch s1 again so s2 becomes the least-recently-used warm entry.
    subs.acquire("s1")();
    expect(openSession).toHaveBeenCalledTimes(2);

    subs.acquire("s3")();
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith("s2");
  });

  it("immediately closes warm sessions that are archived or deleted", () => {
    const { store, closeSession, setSessions, getSessions } = makeFakeStore(["keep", "archive-me", "delete-me"]);
    const subs = new SessionSubscriptions(store, { maxWarm: 4, ttlMs: 300_000 });

    subs.acquire("keep")();
    subs.acquire("archive-me")();
    subs.acquire("delete-me")();
    expect(closeSession).not.toHaveBeenCalled();

    const current = getSessions();
    setSessions({
      keep: current.keep,
      "archive-me": session("archive-me", true),
    });

    expect(closeSession).toHaveBeenCalledTimes(2);
    expect(closeSession).toHaveBeenCalledWith("archive-me");
    expect(closeSession).toHaveBeenCalledWith("delete-me");
  });

  it("closes all active and warm subscriptions when the connection closes", () => {
    const { store, closeSession } = makeFakeStore(["active", "warm"]);
    const subs = new SessionSubscriptions(store, { maxWarm: 4, ttlMs: 300_000 });

    const releaseActive = subs.acquire("active");
    subs.acquire("warm")();
    subs.close();
    releaseActive();

    expect(closeSession).toHaveBeenCalledTimes(2);
    expect(closeSession).toHaveBeenCalledWith("active");
    expect(closeSession).toHaveBeenCalledWith("warm");
  });
});
