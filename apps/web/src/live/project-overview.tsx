import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { Choice } from "@/components/Choice";
import { engine, type Computer, type Connection } from "./engine";
import { useDesktopVisibility } from "./desktop-visibility";
import { readLocal, saveLocal } from "./storage";

export const projectScope = createStore<{ value: "current" | "all" }>(() => ({
  value: readLocal<string>("projectScope", "current") === "all" ? "all" : "current",
}));

export function ProjectScopeChoice() {
  const scope = useStore(projectScope, (state) => state.value);
  return <Choice label="项目视图" value={scope} className="w-auto" options={[
    { value: "current", label: "当前电脑" }, { value: "all", label: "所有电脑" },
  ]} onValueChange={(value) => {
    const next = value === "all" ? "all" : "current";
    projectScope.setState({ value: next });
    try { saveLocal("projectScope", next); } catch { /* The current view still changes without storage. */ }
  }} />;
}

/** Borrow an authenticated metadata connection; it never selects a computer or opens its screen. */
export function useProjectConnection(computer: Computer) {
  const key = computer.key;
  const online = computer.machine.online;
  const ready = useStore(engine.state, (state) => state.ready && !state.locked);
  const account = useStore(engine.state, (state) => state.accountUserId);
  const shellVisible = useDesktopVisibility();
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [retained, setRetained] = useState<{ key: string; account?: string; connection?: Connection; error?: string }>();
  useEffect(() => {
    const changed = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (!ready || !online || !shellVisible || !pageVisible) return;
    const current = engine.state.getState().computers.find((entry) => entry.key === key);
    if (!current) return;
    try {
      const lease = engine.retainComputer(current, { metadataOnly: true });
      setRetained({ key, account, connection: lease.connection });
      return () => { lease.release(); setRetained(undefined); };
    } catch (error) {
      setRetained({ key, account, error: error instanceof Error ? error.message : String(error) });
    }
  }, [key, account, online, ready, shellVisible, pageVisible]);
  return retained?.key === key && retained.account === account && ready ? retained : undefined;
}
