import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ClientState } from "@linkshell/client-core";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore } from "zustand/vanilla";
import { Choice } from "@/components/Choice";
import { engine, type Computer, type Connection } from "./engine";
import { useDesktopVisibility } from "./desktop-visibility";
import { readLocal, saveLocal } from "./storage";
import { crossComputerProjects, type CrossComputerProject } from "./cross-computer-projects";

export const projectScope = createStore<{ value: "current" | "all" }>(() => ({
  value: readLocal<string>("projectScope", "current") === "all" ? "all" : "current",
}));

export function setProjectScope(value: "current" | "all") {
  projectScope.setState({ value });
  try { saveLocal("projectScope", value); } catch { /* The current view still changes without storage. */ }
}

export function ProjectScopeChoice() {
  const scope = useStore(projectScope, (state) => state.value);
  return <Choice label="项目视图" value={scope} className="w-auto" options={[
    { value: "current", label: "当前电脑" }, { value: "all", label: "所有电脑" },
  ]} onValueChange={(value) => {
    const next = value === "all" ? "all" : "current";
    setProjectScope(next);
  }} />;
}

export interface ProjectSource {
  computer: Computer;
  connection?: Connection;
  state?: Pick<ClientState, "projects" | "sessions" | "sessionsLoaded" | "sessionsNextBefore" | "sessionsError" | "status">;
  selected?: boolean;
  error?: string;
}

type OverviewChildren = (sources: ProjectSource[], projects: CrossComputerProject[]) => ReactNode;

/** Both project surfaces borrow the same metadata-only connections and grouping rules. */
export function ProjectOverview({ children }: { children: OverviewChildren }) {
  const account = useStore(engine.state, (state) => state.accountUserId);
  return <ProjectOverviewContent key={account ?? "paired"}>{children}</ProjectOverviewContent>;
}

function ProjectOverviewContent({ children }: { children: OverviewChildren }) {
  const computers = useStore(engine.state, (state) => state.computers);
  const [snapshots, setSnapshots] = useState<Record<string, ProjectSource>>({});
  const update = useCallback((source: ProjectSource) => {
    setSnapshots((current) => ({ ...current, [source.computer.key]: source }));
  }, []);
  const sources = useMemo(() => computers.map((computer) => ({ ...snapshots[computer.key], computer })), [computers, snapshots]);
  const projects = useMemo(() => crossComputerProjects(sources.flatMap(({ computer, state }) =>
    state && state.status !== "locked" ? [{ key: computer.key, projects: state.projects, sessions: Object.values(state.sessions) }] : [])), [sources]);
  return <>
    {computers.map((computer) => <ProjectSourceReader key={computer.key} computer={computer} update={update} />)}
    {children(sources, projects)}
  </>;
}

function ProjectSourceReader({ computer, update }: { computer: Computer; update: (source: ProjectSource) => void }) {
  const retained = useProjectConnection(computer);
  const selected = useStore(engine.state, (state) => state.connection);
  const selectedHere = selected && engine.computerForKey(selected.computer.key)?.key === computer.key ? selected : undefined;
  useEffect(() => {
    if (!retained?.connection) update({ computer, error: retained?.error });
  }, [computer, retained, update]);
  return retained?.connection ? <ProjectSourceSnapshot computer={computer} connection={retained.connection} selected={selectedHere} update={update} /> : null;
}

function ProjectSourceSnapshot({ computer, connection, selected, update }: {
  computer: Computer; connection: Connection; selected?: Connection; update: (source: ProjectSource) => void;
}) {
  const selectedStatus = useStore(selected?.store ?? connection.store, (state) => state.status);
  // Keep the selected relay route's actions when a new local alias becomes available.
  const active = !!selected && (selected === connection || selectedStatus === "online");
  const shown = active ? selected! : connection;
  const state = useStore(shown.store, useShallow((state) => ({
    projects: state.projects, sessions: state.sessions, sessionsLoaded: state.sessionsLoaded,
    sessionsNextBefore: state.sessionsNextBefore, sessionsError: state.sessionsError, status: state.status,
  })));
  useEffect(() => update({ computer, connection: shown, state, selected: active }), [computer, shown, state, active, update]);
  return null;
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
