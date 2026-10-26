import { terminalState as wireTerminalState, type TerminalInfo } from "@linkshell/wire";
import { useEffect, useState } from "react";
import { useConnection } from "./client";
import { baseName } from "./format";

/** The host's terminals, live: listed on connect and updated as they change. */
export function useTerminals(): { terminals: TerminalInfo[]; loaded: boolean; error: string; retry: () => void } {
  const { link } = useConnection();
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setTerminals([]);
    setLoaded(false);
    setError("");
    const load = () => {
      setError("");
      return link
        .call("terminals.list", {})
        .then((result) => {
          if (cancelled) return;
          setTerminals(result.terminals);
          setLoaded(true);
        })
        .catch(() => { if (!cancelled) setError("未能同步终端，请重试。"); });
    };
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
  }, [link, attempt]);

  return { terminals, loaded, error, retry: () => setAttempt((value) => value + 1) };
}

/**
 * The wire's reading of a terminal, except that a plain shell is named after
 * its directory: a list of shells all called "终端" tells them apart by nothing.
 * `named` says the title already is the directory, so a row doesn't repeat it.
 */
export function terminalState(terminal: TerminalInfo) {
  const state = wireTerminalState(terminal);
  const named = !state.mono && !!terminal.cwd;
  return { ...state, title: named ? baseName(terminal.cwd) : state.title, named };
}

export { commandTitle } from "@linkshell/wire";
