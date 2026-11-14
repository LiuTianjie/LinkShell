import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type {
  ClientActions,
  ClientState,
  SessionView,
  TaskRecords,
} from "@linkshell/client-core";
import type {
  AgentInfo,
  BackgroundTask,
  MachineInfo,
  MethodResult,
  SessionSummary,
  SideChat,
  SubagentInfo,
} from "@linkshell/wire";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Computer, Connection } from "../../core/connections";
import { engine } from "../../core/engine";

const EMPTY_CLIENT_STORE: StoreApi<Pick<
  ClientState,
  "status" | "machine" | "sessions" | "views" | "subagentViews" | "subagents" | "tasks" | "sides"
>> = createStore(() => ({
  status: "idle",
  machine: undefined,
  sessions: {},
  views: {},
  subagentViews: {},
  subagents: {},
  tasks: {},
  sides: {},
}));

export interface InspectorSessionActions {
  send(text: string): Promise<void>;
  loadTasks(): Promise<BackgroundTask[]>;
  loadTaskOutput(
    taskId: string,
    before?: number,
  ): Promise<MethodResult<"sessions.taskOutput">>;
  stopTask(taskId: string): Promise<void>;
  loadSubagents(): Promise<SubagentInfo[]>;
  openSubagent(toolCallId: string): Promise<boolean>;
  closeSubagent(toolCallId: string): void;
  cancelSubagent(nativeSessionId: string): Promise<void>;
  loadSides(): Promise<SideChat[]>;
  askSide(text: string, sideId?: string): Promise<SideChat>;
  cancelSide(sideId: string): Promise<void>;
  closeSide(sideId: string): Promise<void>;
}

export interface ResolvedInspectorConnection {
  connection?: Connection;
  computer?: Computer;
  online: boolean;
  machine?: MachineInfo;
  session?: SessionSummary;
  view?: SessionView;
  subagentViews: Record<string, SessionView>;
  sessionsMap: Record<string, SessionSummary>;
  subagents: SubagentInfo[];
  tasksMap: TaskRecords;
  sides: SideChat[];
  cwd?: string;
  agents: AgentInfo[];
  protocol: number;
  actions?: InspectorSessionActions;
}

const EMPTY_SUBAGENT_VIEWS: Record<string, SessionView> = {};

const EMPTY_SUBAGENTS: SubagentInfo[] = [];
const EMPTY_TASKS: TaskRecords = {};
const EMPTY_SIDES: SideChat[] = [];
const EMPTY_AGENTS: AgentInfo[] = [];

/**
 * Resolves the live `Connection` and optional `SessionView` for `computerKey` + `sessionId`.
 * Uses `engine.state.connection` directly when keys match, and acquires a fleet connection via
 * `engine.retainComputer()` when inspecting another computer.
 */
export function useInspectorConnection(params: {
  computerKey: string;
  sessionId?: string;
  cwd?: string;
}): ResolvedInspectorConnection {
  const { computerKey, sessionId, cwd } = params;
  const engineSnap = useStore(engine.state);

  const primaryMatches =
    engineSnap.connection !== undefined &&
    (engineSnap.connection.computer.key === computerKey ||
      !computerKey ||
      computerKey === "default");

  const targetComputer = useMemo<Computer | undefined>(() => {
    if (primaryMatches) return engineSnap.connection?.computer;
    return engine.computerForKey(computerKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryMatches, engineSnap.connection, engineSnap.computers, engineSnap.localComputer, computerKey]);

  const targetComputerRef = useRef<Computer | undefined>(targetComputer);
  targetComputerRef.current = targetComputer;
  const targetComputerKey = targetComputer?.key;

  const [retained, setRetained] = useState<{
    key: string;
    conn: Connection;
  } | null>(null);

  useEffect(() => {
    const comp = targetComputerRef.current;
    if (primaryMatches || !comp || !targetComputerKey) {
      setRetained(null);
      return undefined;
    }
    try {
      const handle = engine.retainComputer(comp);
      setRetained({ key: comp.key, conn: handle.connection });
      return () => {
        handle.release();
      };
    } catch {
      setRetained(null);
      return undefined;
    }
  }, [primaryMatches, targetComputerKey]);

  const connection = primaryMatches
    ? engineSnap.connection
    : retained?.key === computerKey
      ? retained.conn
      : undefined;

  const clientStore = (connection?.store ??
    EMPTY_CLIENT_STORE) as StoreApi<ClientState & ClientActions>;
  const clientState = useStore(clientStore);

  useEffect(() => {
    if (!connection || !sessionId) return undefined;
    return connection.sessions.acquire(sessionId);
  }, [connection, sessionId]);

  const session = sessionId ? clientState.sessions[sessionId] : undefined;
  const view = sessionId ? clientState.views[sessionId] : undefined;
  const subagents = sessionId
    ? (clientState.subagents[sessionId] ?? EMPTY_SUBAGENTS)
    : EMPTY_SUBAGENTS;
  const tasksMap = sessionId
    ? (clientState.tasks[sessionId] ?? EMPTY_TASKS)
    : EMPTY_TASKS;
  const sides = sessionId
    ? (clientState.sides[sessionId] ?? EMPTY_SIDES)
    : EMPTY_SIDES;

  const effectiveCwd = cwd ?? session?.cwd;
  const agents = clientState.machine?.agents ?? EMPTY_AGENTS;
  const protocol = clientState.machine?.protocol ?? 2;

  const actions = useMemo<InspectorSessionActions | undefined>(() => {
    if (!connection || !sessionId) return undefined;
    const getStore = () => connection.store.getState();
    return {
      send: async (text: string) => {
        await getStore().send(sessionId, [{ type: "text", text }]);
      },
      loadTasks: () => getStore().loadTasks(sessionId),
      loadTaskOutput: (taskId, before) =>
        getStore().loadTaskOutput(sessionId, taskId, before),
      stopTask: (taskId) => getStore().stopTask(sessionId, taskId),
      loadSubagents: () => getStore().loadSubagents(sessionId),
      openSubagent: (toolCallId) =>
        typeof getStore().openSubagent === "function"
          ? getStore().openSubagent(sessionId, toolCallId)
          : Promise.resolve(false),
      closeSubagent: (toolCallId) => {
        if (typeof getStore().closeSubagent === "function") {
          getStore().closeSubagent(sessionId, toolCallId);
        }
      },
      cancelSubagent: async (nativeSessionId) => {
        await connection.link.call("sessions.cancelSubagent", {
          sessionId,
          nativeSessionId,
        });
      },
      loadSides: () => getStore().loadSides(sessionId),
      askSide: (text, sideId) => getStore().askSide(sessionId, text, sideId),
      cancelSide: (sideId) => getStore().cancelSide(sessionId, sideId),
      closeSide: (sideId) => getStore().closeSide(sessionId, sideId),
    };
  }, [connection, sessionId]);

  return {
    connection,
    computer: connection?.computer ?? targetComputer,
    online: Boolean(connection && clientState.status === "online"),
    machine: clientState.machine,
    session,
    view,
    subagentViews: clientState.subagentViews ?? EMPTY_SUBAGENT_VIEWS,
    sessionsMap: clientState.sessions,
    subagents,
    tasksMap,
    sides,
    cwd: effectiveCwd,
    agents,
    protocol,
    actions,
  };
}
