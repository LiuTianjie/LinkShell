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
