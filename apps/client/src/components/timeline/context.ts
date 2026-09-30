import { createContext, useContext } from "react";

/** The session a timeline belongs to, so rows can open session-scoped screens (a sub-agent's sheet). */
export const TimelineSession = createContext<string | undefined>(undefined);

export function useTimelineSession(): string | undefined {
  return useContext(TimelineSession);
}
