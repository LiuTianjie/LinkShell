import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { ELAPSED_FROM, formatElapsed, liveActivity, type SessionView } from "@linkshell/client-core";

/** How long the turn has run, counted here: the clock needs nothing from the computer. */
function useElapsed(since: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === undefined ? undefined : now - since;
}

/** The row under a running turn: what the agent does right now, and for how long the turn has gone on. */
export function LiveActivity({ view, asking }: { view: SessionView; asking: boolean }) {
  const activity = liveActivity(view);
  const elapsed = useElapsed(activity.startedAt);
  const clock = elapsed !== undefined && elapsed >= ELAPSED_FROM ? formatElapsed(elapsed) : undefined;
  // The running call, the reply or the thought already spins in the timeline above: here only the turn's time.
  if (activity.echo && !asking) {
    return clock ? (
      <div className="conversation-activity" role="status" data-quiet>
        <span className="conversation-activity-label">本轮已进行</span>
        <span className="conversation-activity-elapsed">{clock}</span>
      </div>
    ) : null;
  }
  const label = asking && !activity.waiting ? "需要您的输入" : activity.label;
  return (
    <div className="conversation-activity" role="status" data-waiting={activity.waiting || asking || undefined}>
      <LoaderCircle aria-hidden="true" />
      <span className="conversation-activity-label">{label}</span>
      {clock && <span className="conversation-activity-elapsed">{clock}</span>}
    </div>
  );
}
