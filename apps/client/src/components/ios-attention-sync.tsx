import { useMemo } from "react";
import { useActions, useClient, useConnection } from "@/lib/client";
import { listComputers, useComputers } from "@/lib/computers";
import { useIOSAttentionSync } from "@/lib/session-attention";
import { useTerminals } from "@/lib/terminals";
import { useLiveActivityPush } from "@/lib/live-activity-push";
import { computerDisplayName, useComputerNames } from "@/lib/computer-names";
import { useAccount } from "@/lib/account";
import { useIOSWatchSync } from "@/lib/watch-sync";
import { liveActivityPushURL } from "../../modules/link-layout";

/** Also mounted on cold launches straight from an activity. */
export function IOSAttentionSync() {
  const { computer } = useConnection();
  useLiveActivityPush();
  return <ComputerAttentionSync key={computer.key} />;
}

function ComputerAttentionSync() {
  const signedIn = useAccount((state) => Boolean(state.session));
  const { computer, link } = useConnection();
  const actions = useActions();
  const sessionsById = useClient((state) => state.sessions);
  const sessions = useMemo(() => Object.values(sessionsById), [sessionsById]);
  const loaded = useClient((state) => state.sessionsLoaded);
  const names = useComputerNames((state) => state.names);
  const online = useClient((state) => state.status === "online");
  const views = useClient((state) => state.views);
  const progress = useClient((state) => state.promptProgress);
  const machine = useClient((state) => state.machine);
  const projects = useClient((state) => state.projects);
  const saved = useComputers((state) => state.saved);
  const live = useComputers((state) => state.live);
  const relayStatus = useComputers((state) => state.relayStatus);
  const { terminals, loaded: terminalsLoaded } = useTerminals();

  const computerName = computerDisplayName(computer, names);
  const watchComputers = useMemo(
    () =>
      listComputers({ saved, live }).map((item) => ({
        key: item.key,
        name: computerDisplayName(item, names),
        online:
          item.key === computer.key
            ? online
            : item.kind === "relay"
              ? item.machine.online && relayStatus[item.gateway] === "online"
              : false,
        selected: item.key === computer.key,
      })),
    [saved, live, names, computer.key, online, relayStatus],
  );

  useIOSAttentionSync(
    computerName,
    sessions,
    terminals,
    online,
    views,
    progress,
    computer.key,
    loaded && terminalsLoaded && (!liveActivityPushURL || signedIn),
  );

  useIOSWatchSync(
    {
      computerKey: computer.key,
      computerName,
      sessions,
      terminals,
      online,
      views,
      promptProgress: progress,
      computers: watchComputers,
      agents: machine?.agents,
      projects,
      homeDir: machine?.home,
    },
    {
      computerKey: computer.key,
      online,
      sessions: sessionsById,
      views,
      computers: watchComputers,
      selectComputer: (key) => useComputers.getState().select(key),
      actions,
      createTerminal: async ({ cwd, command }) => {
        const res = await link.call("terminals.create", {
          ...(cwd ? { cwd } : {}),
          ...(command ? { command } : {}),
          cols: 80,
          rows: 24,
        });
        return res.terminal;
      },
      openTerminal: async (terminalId) => {
        await link.call("terminals.attach", { terminalId });
      },
      terminalInput: async (terminalId, data) => {
        await link.call("terminals.input", { terminalId, data });
      },
      closeTerminal: async (terminalId) => {
        await link.call("terminals.close", { terminalId });
      },
    },
    !online || (loaded && terminalsLoaded),
    link,
  );
  return null;
}
