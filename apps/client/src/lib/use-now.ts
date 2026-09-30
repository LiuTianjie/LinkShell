import { useEffect, useState } from "react";

/** The current time, refreshed every `intervalMs` (never when null) — for relative timestamps. */
export function useNow(intervalMs: number | null = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
