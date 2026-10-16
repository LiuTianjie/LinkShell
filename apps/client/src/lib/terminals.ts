import type { TerminalInfo } from "@linkshell/wire";
import { useEffect, useState } from "react";
import { useConnection } from "./client";

/** The host's terminals, live: listed on connect and updated as they change. */
export function useTerminals(): { terminals: TerminalInfo[]; loaded: boolean } {
  const { link } = useConnection();
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      link
        .call("terminals.list", {})
        .then((result) => {
          if (cancelled) return;
          setTerminals(result.terminals);
          setLoaded(true);
        })
        .catch(() => {});
    void load();
    const offOnline = link.onOnline(() => void load());
    const offChanged = link.on("terminal.changed", ({ terminal, closed }) => {
      setTerminals((current) => {
        const rest = current.filter((entry) => entry.id !== terminal.id);
        return closed ? rest : [terminal, ...rest].sort((a, b) => b.createdAt - a.createdAt);
      });
    });
    return () => {
      cancelled = true;
      offOnline();
      offChanged();
    };
  }, [link]);

  return { terminals, loaded };
}

export { terminalState, commandTitle } from "@linkshell/wire";
