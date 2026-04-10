import { useCallback, useEffect, useRef } from "react";
import {
  isLiveActivityAvailable,
  startLiveActivity,
  updateLiveActivity,
  endLiveActivity,
  type ActivityState,
  type ExtendedActivityData,
  type SecondaryTerminal,
} from "../native/LiveActivity";
import { ThrottledTerminalParser } from "../utils/terminal-parser";
import type { SessionManagerHandle } from "./useSessionManager";

type ParserEntry = {
  parser: ThrottledTerminalParser;
  unsub: () => void;
  status: string;
  lastLine: string;
  contextLines: string;
  quickActions: { label: string; input: string; needsInput: boolean; desc?: string }[];
  provider: string;
  connectedAt: number;
};

type Candidate = {
  sid: string;
  tid: string;
  phase: string;
  project: string;
  provider: string;
  tool: string;
  elapsed: number;
  hasPermission: boolean;
  permCount: number;
  toolDescription: string;
  contextLines: string;
  permissionTool: string;
  permissionContext: string;
  permissionRequestId: string;
  quickActions: { label: string; input: string; needsInput: boolean; desc?: string }[];
};

const PHASE_PRIORITY: Record<string, number> = {
  error: 0, waiting: 1, tool_use: 2, thinking: 3, outputting: 4, idle: 5,
};

function buildCandidate(
  sid: string,
  info: ReturnType<SessionManagerHandle["sessions"]["get"]> & {},
  entry: ParserEntry | undefined,
  now: number,
  useStructured: boolean,
): Candidate {
  const activeTerm = info.activeTerminalId
    ? info.terminals.get(info.activeTerminalId)
    : undefined;
  const ss = activeTerm?.structuredStatus;
  const hasPermission = !!ss?.topPermission;

  return {
    sid,
    tid: info.activeTerminalId || "default",
    phase: useStructured ? ss!.phase : (entry?.status ?? "idle"),
    project: (info.projectName || info.hostname || sid.slice(0, 8)).slice(0, 30),
    provider: (() => {
      // Priority: active terminal provider (from hooks via terminal.list) > session provider > fallback
      const termProvider = activeTerm?.provider;
      const resolved = (termProvider && termProvider !== "custom" ? termProvider : null)
        ?? (info.provider && info.provider !== "custom" ? info.provider : null)
        ?? info.provider ?? "claude";
      return resolved;
    })(),
    tool: ss?.toolName || "",
    elapsed: Math.floor((now - (entry?.connectedAt ?? now)) / 1000),
    hasPermission,
    permCount: ss?.pendingPermissionCount ?? 0,
    toolDescription: (ss?.toolInput || ss?.summary || "").slice(0, 500),
    contextLines: (useStructured && ss?.permissionRequest ? ss.permissionRequest : (entry?.contextLines ?? "")).slice(0, 500),
    permissionTool: ss?.topPermission?.toolName || "",
    permissionContext: (ss?.topPermission?.permissionRequest || ss?.topPermission?.toolInput || "").slice(0, 400),
    permissionRequestId: ss?.topPermission?.requestId || "",
    quickActions: hasPermission
      ? [
          { label: "允许", input: "allow", needsInput: false },
          { label: "拒绝", input: "deny", needsInput: false },
          ...(entry?.quickActions?.filter((a) => a.input !== "allow" && a.input !== "deny").map((a) => ({ ...a, desc: a.desc ?? a.label })) ?? []),
        ]
      : (entry?.quickActions?.map((a) => ({ ...a, desc: a.desc ?? a.label })) ?? []),
  };
}

function buildStateAndExtended(candidates: Candidate[]) {
  const primary = candidates[0];
  const totalPermCount = candidates.reduce((sum, c) => sum + c.permCount, 0);

  const state: ActivityState = {
    sid: primary.sid, tid: primary.tid, phase: primary.phase,
    project: primary.project, provider: primary.provider,
    tool: primary.tool, elapsed: primary.elapsed,
    hasPermission: primary.hasPermission, permCount: primary.permCount,
    otherCount: candidates.length - 1, totalPermCount,
  };

  const secondaryTerminals: SecondaryTerminal[] = candidates.slice(1, 6).map((c) => ({
    sid: c.sid, tid: c.tid, provider: c.provider, phase: c.phase, hasPermission: c.hasPermission,
  }));

  const extended: ExtendedActivityData = {
    sid: primary.sid, tid: primary.tid,
    toolDescription: primary.toolDescription,
    contextLines: primary.contextLines,
    permissionTool: primary.permissionTool,
    permissionContext: primary.permissionContext,
    permissionRequestId: primary.permissionRequestId,
    quickActions: primary.quickActions,
    secondaryTerminals,
  };

  return { state, extended };
}

export function useLiveActivityLifecycle(manager: SessionManagerHandle) {
  const liveActivityActiveRef = useRef(false);
  const parsersRef = useRef(new Map<string, ParserEntry>());
  const sessionsRef = useRef(manager.sessions);
  const activeSidRef = useRef(manager.activeSessionId);
  sessionsRef.current = manager.sessions;
  activeSidRef.current = manager.activeSessionId;

  const pushLiveActivityUpdate = useCallback(() => {
    if (!liveActivityActiveRef.current) return;
    const currentSessions = sessionsRef.current;
    const now = Date.now();
    const candidates: Candidate[] = [];

    for (const [sid, info] of currentSessions) {
      if (info.status !== "connected") continue;
      const entry = parsersRef.current.get(sid);

      // Collect ALL running terminals, not just the active one
      for (const [tid, term] of info.terminals) {
        if (term.status === "exited") continue;
        const ss = term.structuredStatus;
        const useStructured = !!(ss && now - ss.updatedAt < 30_000);
        const hasPermission = !!ss?.topPermission;
        const termProvider = term.provider;

        candidates.push({
          sid,
          tid,
          phase: useStructured ? ss!.phase : (entry?.status ?? "idle"),
          project: (info.projectName || info.hostname || sid.slice(0, 8)).slice(0, 30),
          provider: (() => {
            const resolved = (termProvider && termProvider !== "custom" ? termProvider : null)
              ?? (info.provider && info.provider !== "custom" ? info.provider : null)
              ?? info.provider ?? "claude";
            return resolved;
          })(),
          tool: ss?.toolName || "",
          elapsed: Math.floor((now - (entry?.connectedAt ?? now)) / 1000),
          hasPermission,
          permCount: ss?.pendingPermissionCount ?? 0,
          toolDescription: (ss?.toolInput || ss?.summary || "").slice(0, 500),
          contextLines: (useStructured && ss?.permissionRequest ? ss.permissionRequest : (entry?.contextLines ?? "")).slice(0, 500),
          permissionTool: ss?.topPermission?.toolName || "",
          permissionContext: (ss?.topPermission?.permissionRequest || ss?.topPermission?.toolInput || "").slice(0, 400),
          permissionRequestId: ss?.topPermission?.requestId || "",
          quickActions: hasPermission
            ? [
                { label: "允许", input: "allow", needsInput: false },
                { label: "拒绝", input: "deny", needsInput: false },
                ...(entry?.quickActions?.filter((a) => a.input !== "allow" && a.input !== "deny").map((a) => ({ ...a, desc: a.desc ?? a.label })) ?? []),
              ]
            : (entry?.quickActions?.map((a) => ({ ...a, desc: a.desc ?? a.label })) ?? []),
        });
      }

      // If no terminals yet, add a single candidate for the session
      if (info.terminals.size === 0) {
        const activeTerm = info.activeTerminalId
          ? info.terminals.get(info.activeTerminalId)
          : undefined;
        const ss = activeTerm?.structuredStatus;
        const useStructured = !!(ss && now - ss.updatedAt < 30_000);
        candidates.push(buildCandidate(sid, info, entry, now, useStructured));
      }
    }

    if (candidates.length === 0) return;

    candidates.sort((a, b) => {
      if (a.hasPermission !== b.hasPermission) return a.hasPermission ? -1 : 1;
      return (PHASE_PRIORITY[a.phase] ?? 9) - (PHASE_PRIORITY[b.phase] ?? 9);
    });

    const { state, extended } = buildStateAndExtended(candidates);
    const needsAlert = candidates.some((c) => c.hasPermission);
    updateLiveActivity(state, extended, needsAlert);
  }, []);

  // Manage parsers and start/end live activity
  useEffect(() => {
    const currentSessions = manager.sessions;

    // Remove parsers for sessions that no longer exist
    for (const [sid, entry] of parsersRef.current) {
      if (!currentSessions.has(sid)) {
        entry.parser.destroy();
        entry.unsub();
        parsersRef.current.delete(sid);
      }
    }

    // Add parsers for new sessions
    for (const [sid, info] of currentSessions) {
      if (info.status !== "connected") continue;
      if (parsersRef.current.has(sid)) continue;

      const entry: ParserEntry = {
        parser: null as unknown as ThrottledTerminalParser,
        unsub: null as unknown as () => void,
        status: "idle",
        lastLine: "",
        contextLines: "",
        quickActions: [],
        provider: info.provider || "claude",
        connectedAt: Date.now(),
      };

      entry.parser = new ThrottledTerminalParser((result) => {
        entry.status = result.status;
        entry.lastLine = result.lastLine;
        entry.contextLines = result.contextLines;
        entry.quickActions = result.quickActions;
        pushLiveActivityUpdate();
      }, 1000);

      entry.unsub = info.terminalStream.subscribe((event) => {
        if (event.type === "append") entry.parser.push(event.chunk);
      });

      parsersRef.current.set(sid, entry);
    }

    // Start or end live activity based on session count
    const hasConnected = [...currentSessions.values()].some(
      (s) => s.status === "connected",
    );

    if (hasConnected && !liveActivityActiveRef.current) {
      isLiveActivityAvailable().then((ok) => {
        if (!ok) return;
        const now = Date.now();
        const candidates: Candidate[] = [];

        for (const [sid, info] of sessionsRef.current) {
          if (info.status !== "connected") continue;
          const e = parsersRef.current.get(sid);
          const activeTerm = info.activeTerminalId
            ? info.terminals.get(info.activeTerminalId)
            : undefined;
          const ss = activeTerm?.structuredStatus;
          const hasPermission = !!ss?.topPermission;

          candidates.push({
            sid,
            tid: info.activeTerminalId || "default",
            phase: ss?.phase || (e?.status ?? "idle"),
            project: (info.projectName || info.hostname || sid.slice(0, 8)).slice(0, 30),
            provider: e?.provider ?? info.provider ?? "claude",
            tool: ss?.toolName || "",
            elapsed: Math.floor((now - (e?.connectedAt ?? now)) / 1000),
            hasPermission,
            permCount: ss?.pendingPermissionCount ?? 0,
            toolDescription: (ss?.toolInput || ss?.summary || "").slice(0, 500),
            contextLines: (e?.contextLines ?? "").slice(0, 500),
            permissionTool: ss?.topPermission?.toolName || "",
            permissionContext: (ss?.topPermission?.permissionRequest || ss?.topPermission?.toolInput || "").slice(0, 400),
            permissionRequestId: ss?.topPermission?.requestId || "",
            quickActions: hasPermission
              ? [
                  { label: "允许", input: "allow", needsInput: false, desc: "允许执行此操作" },
                  { label: "拒绝", input: "deny", needsInput: false, desc: "拒绝此操作" },
                ]
              : (e?.quickActions?.map((a) => ({ ...a, desc: a.desc ?? a.label })) ?? []),
          });
        }
        if (candidates.length === 0) return;

        candidates.sort((a, b) => {
          if (a.hasPermission !== b.hasPermission) return a.hasPermission ? -1 : 1;
          return (PHASE_PRIORITY[a.phase] ?? 9) - (PHASE_PRIORITY[b.phase] ?? 9);
        });

        const { state, extended } = buildStateAndExtended(candidates);
        startLiveActivity(state, extended).then((id) => {
          if (id) liveActivityActiveRef.current = true;
        });
      });
    } else if (!hasConnected && liveActivityActiveRef.current) {
      liveActivityActiveRef.current = false;
      endLiveActivity();
      for (const entry of parsersRef.current.values()) {
        entry.parser.destroy();
        entry.unsub();
      }
      parsersRef.current.clear();
    } else if (hasConnected && liveActivityActiveRef.current) {
      pushLiveActivityUpdate();
    }
  }, [manager.activeSessionId, manager.sessions, pushLiveActivityUpdate]);

  // Periodic refresh
  useEffect(() => {
    const id = setInterval(() => {
      if (liveActivityActiveRef.current) pushLiveActivityUpdate();
    }, 2000);
    return () => clearInterval(id);
  }, [pushLiveActivityUpdate]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (liveActivityActiveRef.current) {
        endLiveActivity();
        liveActivityActiveRef.current = false;
      }
      for (const entry of parsersRef.current.values()) {
        entry.parser.destroy();
        entry.unsub();
      }
      parsersRef.current.clear();
    };
  }, []);
}
