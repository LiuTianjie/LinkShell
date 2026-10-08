import { createContext, use } from "react";

export interface SessionFoldLayout {
  bottomReserved: number;
}

export const SessionFoldLayoutContext = createContext<SessionFoldLayout | null>(null);
export const useSessionFoldLayout = () => use(SessionFoldLayoutContext);
