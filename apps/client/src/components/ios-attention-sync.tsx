import { useMemo } from "react";
import { useClient, useConnection } from "@/lib/client";
import { useIOSAttentionSync } from "@/lib/session-attention";
import { useTerminals } from "@/lib/terminals";
import { useLiveActivityPush } from "@/lib/live-activity-push";
import { computerDisplayName, useComputerNames } from "@/lib/computer-names";
import { useAccount } from "@/lib/account";
import { liveActivityPushURL } from "../../modules/link-layout";

/** Also mounted on cold launches straight from an activity. */
export function IOSAttentionSync() {
  const { computer } = useConnection();
  useLiveActivityPush();
  return <ComputerAttentionSync key={computer.key} />;
}

function ComputerAttentionSync() {
  const signedIn = useAccount((state) => Boolean(state.session));
  const { computer } = useConnection();
  const sessionsById = useClient((state) => state.sessions);
  const sessions = useMemo(() => Object.values(sessionsById), [sessionsById]);
  const loaded = useClient((state) => state.sessionsLoaded);
  const names = useComputerNames((state) => state.names);
  const online = useClient((state) => state.status === "online");
  const views = useClient((state) => state.views);
  const progress = useClient((state) => state.promptProgress);
  const { terminals, loaded: terminalsLoaded } = useTerminals();
  useIOSAttentionSync(computerDisplayName(computer, names), sessions, terminals,
    online, views, progress, computer.key, loaded && terminalsLoaded && (!liveActivityPushURL || signedIn));
  return null;
}
