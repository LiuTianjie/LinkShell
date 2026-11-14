import type { Locale } from "@linkshell/client-core";
import type { SessionSummary } from "@linkshell/wire";
import { isElectronDesktop, postDesktopMessage } from "../bridge/desktop-bridge";
import type { Connection } from "./connections";
import { engine } from "./engine";
import { getDesktopLocale } from "./i18n";
import { sessionNeedsAttention, sessionTitle, waitingLabel } from "./session-tree";

/**
 * What reaches the person outside the window: a system notification when a session starts
 * waiting for them or finishes, and the number of sessions waiting on the app's icon. The main
 * process decides whether a notification is shown (the setting, and whether the window already
 * has their eyes); this only reports what changed.
 */

export type AttentionPhase = "waiting" | "running" | "error" | "idle";

export interface AttentionEvent {
  sessionId: string;
  kind: "waiting" | "finished" | "failed";
}

export function attentionPhase(session: SessionSummary): AttentionPhase {
  if (sessionNeedsAttention(session)) return "waiting";
  if (session.state === "running") return "running";
  return session.state === "error" ? "error" : "idle";
}

export function attentionPhases(
  sessions: Record<string, SessionSummary>,
): Map<string, AttentionPhase> {
  const phases = new Map<string, AttentionPhase>();
  for (const session of Object.values(sessions)) {
    if (!session.archived) phases.set(session.id, attentionPhase(session));
  }
  return phases;
}

/**
 * A session seen for the first time says nothing: connecting to a computer must not replay
 * everything that was already waiting. A sub-agent finishing is its parent's business, so only
 * its questions and approvals are reported.
 */
export function attentionEvents(
  previous: ReadonlyMap<string, AttentionPhase>,
  next: ReadonlyMap<string, AttentionPhase>,
  sessions: Record<string, SessionSummary>,
): AttentionEvent[] {
  const events: AttentionEvent[] = [];
  for (const [sessionId, phase] of next) {
    const before = previous.get(sessionId);
    if (before === undefined || before === phase) continue;
    if (phase === "waiting") {
      events.push({ sessionId, kind: "waiting" });
      continue;
    }
    if (before !== "running" || sessions[sessionId]?.parentId) continue;
    if (phase === "idle") events.push({ sessionId, kind: "finished" });
    else if (phase === "error") events.push({ sessionId, kind: "failed" });
  }
  return events;
}

const OUTCOME: Record<Locale, { finished: string; failed: string }> = {
  zh: { finished: "已完成", failed: "出错" },
  en: { finished: "Finished", failed: "Failed" },
  ja: { finished: "完了", failed: "エラー" },
};

function folderName(cwd: string | undefined): string {
  const parts = (cwd ?? "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? "";
}

export function attentionMessage(
  event: AttentionEvent,
  session: SessionSummary,
  locale: Locale = getDesktopLocale(),
): { title: string; body: string } {
  const outcome = OUTCOME[locale] ?? OUTCOME.zh;
  const label =
    event.kind === "waiting"
      ? waitingLabel(session, locale)
      : event.kind === "failed"
        ? outcome.failed
        : outcome.finished;
  const folder = folderName(session.cwd);
  return { title: sessionTitle(session), body: folder ? `${label} · ${folder}` : label };
}

export interface AttentionDeps {
  post?: (message: Record<string, unknown>) => boolean;
  /** The connection whose sessions are watched: the selected computer's. */
  subscribeConnection?: (listener: (connection: Connection | undefined) => void) => () => void;
}

function subscribeSelectedConnection(
  listener: (connection: Connection | undefined) => void,
): () => void {
  listener(engine.state.getState().connection);
  return engine.state.subscribe((state, previous) => {
    if (state.connection !== previous.connection) listener(state.connection);
  });
}

export function startSessionAttention(deps: AttentionDeps = {}): () => void {
  if (!deps.post && !isElectronDesktop) return () => {};
  const post = deps.post ?? postDesktopMessage;
  const subscribe = deps.subscribeConnection ?? subscribeSelectedConnection;

  let detach: (() => void) | undefined;
  let badge = -1;
  const setBadge = (count: number) => {
    if (count === badge) return;
    badge = count;
    post({ action: "badge", count });
  };

  const unsubscribe = subscribe((connection) => {
    detach?.();
    detach = undefined;
    if (!connection) {
      setBadge(0);
      return;
    }
    const computerKey = connection.computer.key;
    // The store keeps its summaries while the link is down, so what changed during a sleep or a
    // network change shows up as one difference when the list is read again: still worth saying.
    let phases = new Map<string, AttentionPhase>();
    const observe = () => {
      const state = connection.store.getState();
      const next = attentionPhases(state.sessions ?? {});
      if (state.status === "online") {
        for (const event of attentionEvents(phases, next, state.sessions)) {
          const session = state.sessions[event.sessionId];
          if (!session) continue;
          post({
            action: "notify",
            id: `${computerKey}:${event.sessionId}`,
            computerKey,
            sessionId: event.sessionId,
            ...attentionMessage(event, session),
          });
        }
      }
      phases = next;
      let waiting = 0;
      for (const phase of next.values()) if (phase === "waiting") waiting += 1;
      setBadge(waiting);
    };
    observe();
    detach = connection.store.subscribe((state, previous) => {
      if (state.sessions !== previous.sessions || state.status !== previous.status) observe();
    });
  });

  return () => {
    unsubscribe();
    detach?.();
    setBadge(0);
  };
}
