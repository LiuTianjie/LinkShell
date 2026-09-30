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

const SHELLS = /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|nu|pwsh|powershell)\b/;

/** How a terminal reads in a list: its title, what it's doing, and whether it has ended. */
export function terminalState(terminal: TerminalInfo) {
  const ended = terminal.exitCode !== undefined || terminal.interrupted === true;
  const foreground = ended || SHELLS.test(terminal.title) ? undefined : terminal.title;
  const failed = !terminal.interrupted && typeof terminal.exitCode === "number" && terminal.exitCode !== 0;
  const detail = terminal.interrupted
    ? "电脑重启时中断"
    : ended
      ? failed
        ? `已退出 · 代码 ${terminal.exitCode}`
        : "已结束"
      : foreground
        ? `正在运行 ${foreground}`
        : "空闲";
  return {
    title: terminal.command ?? "终端",
    mono: Boolean(terminal.command),
    ended,
    busy: Boolean(foreground),
    failed,
    detail,
  };
}
