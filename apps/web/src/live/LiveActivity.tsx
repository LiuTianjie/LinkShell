import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { ELAPSED_FROM, formatElapsed, liveActivity, type SessionView } from "@linkshell/client-core";

/** How long the turn has run, counted here: the clock needs nothing from the computer. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = now - since;
  return elapsed >= ELAPSED_FROM ? <span className="conversation-activity-elapsed">{formatElapsed(elapsed)}</span> : null;
}

/** The row under a running turn: what the agent does right now, and for how long the turn has gone on. */
export function LiveActivity({ view, asking }: { view: SessionView; asking: boolean }) {
  const activity = liveActivity(view);
  const label = asking && !activity.waiting ? "需要您的输入" : activity.label;
  return (
    <div className="conversation-activity" role="status" data-waiting={activity.waiting || asking || undefined}>
      <LoaderCircle aria-hidden="true" />
      <span className="conversation-activity-label">{label}</span>
      {activity.startedAt !== undefined && <Elapsed since={activity.startedAt} />}
    </div>
  );
}
