import type { AsyncQuestion } from "@linkshell/client-core";
import { createContext, useContext } from "react";

/** The session a timeline belongs to, so rows can open session-scoped screens (a sub-agent's sheet). */
export const TimelineSession = createContext<string | undefined>(undefined);

export function useTimelineSession(): string | undefined {
  return useContext(TimelineSession);
}

/** Forks the session after the reply with this id (set where the session can be forked). */
export const TimelineFork = createContext<((itemId: string) => void) | undefined>(undefined);

export function useTimelineFork(): ((itemId: string) => void) | undefined {
  return useContext(TimelineFork);
}

/**
 * Async questions in this timeline: which are answered, and how to answer one (set where the session can be
 * sent to). Without it the questions show as text, the way an older host's do.
 */
export interface TimelineQuestions {
  /** The answer given to each question answered so far, by its id. */
  answered: ReadonlyMap<string, string>;
  answer: (question: AsyncQuestion, answer: string) => void;
}
export const TimelineQuestions = createContext<TimelineQuestions | undefined>(undefined);

export function useTimelineQuestions(): TimelineQuestions | undefined {
  return useContext(TimelineQuestions);
}
