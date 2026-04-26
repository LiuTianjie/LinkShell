import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
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
import type { SessionInfo, SessionManagerHandle, TerminalInfo } from "./useSessionManager";

type ParserEntry = {
  parser: ThrottledTerminalParser;
  unsub: () => void;
  stream: unknown;
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

const DEFAULT_TERMINAL_ID = "default";

function parserKey(sid: string, tid: string) {
  return `${sid}:${tid}`;
}

function resolveProvider(info: SessionInfo, terminalProvider?: string | null) {
  return (terminalProvider && terminalProvider !== "custom" ? terminalProvider : null)
    ?? (info.provider && info.provider !== "custom" ? info.provider : null)
    ?? info.provider
    ?? "claude";
}

function buildQuickActions(
  hasPermission: boolean,
  entry: ParserEntry | undefined,
) {
  if (hasPermission) {
    return [
      { label: "允许", input: "allow", needsInput: false, desc: "允许执行此操作" },
      { label: "拒绝", input: "deny", needsInput: false, desc: "拒绝此操作" },
      ...(entry?.quickActions
        ?.filter((a) => a.input !== "allow" && a.input !== "deny")
        .map((a) => ({ ...a, desc: a.desc ?? a.label })) ?? []),
    ];
  }
  return entry?.quickActions?.map((a) => ({ ...a, desc: a.desc ?? a.label })) ?? [];
}

function buildTerminalCandidate(
  sid: string,
  info: SessionInfo,
  tid: string,
  term: TerminalInfo | undefined,
  entry: ParserEntry | undefined,
  now: number,
): Candidate {
  const ss = term?.structuredStatus;
  const useStructured = !!(ss && now - ss.updatedAt < 30_000);
  const hasPermission = !!ss?.topPermission;

  return {
    sid,
    tid,
    phase: useStructured ? ss!.phase : (entry?.status ?? "idle"),
    project: (info.projectName || info.hostname || sid.slice(0, 8)).slice(0, 30),
    provider: resolveProvider(info, term?.provider),
    tool: ss?.toolName || "",
    elapsed: Math.floor((now - (entry?.connectedAt ?? now)) / 1000),
    hasPermission,
    permCount: ss?.pendingPermissionCount ?? (hasPermission ? 1 : 0),
    toolDescription: (ss?.toolInput || ss?.summary || "").slice(0, 500),
    contextLines: (useStructured && ss?.permissionRequest ? ss.permissionRequest : (entry?.contextLines ?? "")).slice(0, 500),
    permissionTool: ss?.topPermission?.toolName || "",
    permissionContext: (ss?.topPermission?.permissionRequest || ss?.topPermission?.toolInput || "").slice(0, 400),
    permissionRequestId: ss?.topPermission?.requestId || "",
    quickActions: buildQuickActions(hasPermission, entry),
  };
}

function collectCandidates(
  currentSessions: SessionManagerHandle["sessions"],
  parsers: Map<string, ParserEntry>,
  now = Date.now(),
) {
  const candidates: Candidate[] = [];

  for (const [sid, info] of currentSessions) {
    if (info.status !== "connected") continue;

    const runningTerms = [...info.terminals.entries()].filter(
      ([, term]) => term.status !== "exited",
    );

    if (runningTerms.length === 0) {
      candidates.push(
        buildTerminalCandidate(
          sid,
          info,
          info.activeTerminalId || DEFAULT_TERMINAL_ID,
          undefined,
          parsers.get(parserKey(sid, DEFAULT_TERMINAL_ID)),
          now,
        ),
      );
      continue;
    }

    for (const [tid, term] of runningTerms) {
      candidates.push(
        buildTerminalCandidate(
          sid,
          info,
          tid,
          term,
          parsers.get(parserKey(sid, tid)),
          now,
        ),
      );
    }
  }

  candidates.sort((a, b) => {
    if (a.hasPermission !== b.hasPermission) return a.hasPermission ? -1 : 1;
    return (PHASE_PRIORITY[a.phase] ?? 9) - (PHASE_PRIORITY[b.phase] ?? 9);
  });

  return candidates;
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
  const liveActivityStartingRef = useRef(false);
  const alertedRequestIdsRef = useRef<string[]>([]);
  const appStateRef = useRef(AppState.currentState);
  const parsersRef = useRef(new Map<string, ParserEntry>());
  const sessionsRef = useRef(manager.sessions);
  sessionsRef.current = manager.sessions;

  const startFromCandidates = useCallback((candidates: Candidate[]) => {
    if (
      candidates.length === 0 ||
      liveActivityActiveRef.current ||
      liveActivityStartingRef.current
    ) {
      return;
    }

    liveActivityStartingRef.current = true;
    const { state, extended } = buildStateAndExtended(candidates);

    isLiveActivityAvailable()
      .then((ok) => {
        if (!ok) return null;
        return startLiveActivity(state, extended);
      })
      .then((id) => {
        if (id) liveActivityActiveRef.current = true;
      })
      .finally(() => {
        liveActivityStartingRef.current = false;
      });
  }, []);

  const pushLiveActivityUpdate = useCallback(() => {
    if (!liveActivityActiveRef.current) return;
    const candidates = collectCandidates(sessionsRef.current, parsersRef.current);
    if (candidates.length === 0) return;

    const { state, extended } = buildStateAndExtended(candidates);
    const alertRequestId =
      candidates.find((c) => c.hasPermission && c.permissionRequestId)
        ?.permissionRequestId ?? null;
    const needsAlert =
      !!alertRequestId &&
      appStateRef.current !== "active" &&
      !alertedRequestIdsRef.current.includes(alertRequestId);
    if (needsAlert) {
      alertedRequestIdsRef.current = [
        ...alertedRequestIdsRef.current.slice(-49),
        alertRequestId,
      ];
    }

    updateLiveActivity(state, extended, needsAlert).then((ok) => {
      if (ok || !liveActivityActiveRef.current) return;
      liveActivityActiveRef.current = false;
      startFromCandidates(candidates);
    });
  }, [startFromCandidates]);

  // Manage parsers and start/end live activity
  useEffect(() => {
    const currentSessions = manager.sessions;

    const desiredParsers = new Map<string, {
      sid: string;
      tid: string;
      provider: string;
      stream: unknown;
    }>();

    for (const [sid, info] of currentSessions) {
      if (info.status !== "connected") continue;

      const runningTerms = [...info.terminals.entries()].filter(
        ([, term]) => term.status !== "exited",
      );

      if (runningTerms.length === 0) {
        desiredParsers.set(parserKey(sid, DEFAULT_TERMINAL_ID), {
          sid,
          tid: DEFAULT_TERMINAL_ID,
          provider: resolveProvider(info),
          stream: info.terminalStream,
        });
        continue;
      }

      for (const [tid, term] of runningTerms) {
        desiredParsers.set(parserKey(sid, tid), {
          sid,
          tid,
          provider: resolveProvider(info, term.provider),
          stream: term.terminalStream,
        });
      }
    }

    // Remove parsers for sessions/terminals that no longer exist, or whose
    // stream was recreated after reconnect.
    for (const [key, entry] of parsersRef.current) {
      const desired = desiredParsers.get(key);
      if (!desired || desired.stream !== entry.stream) {
        entry.parser.destroy();
        entry.unsub();
        parsersRef.current.delete(key);
      }
    }

    // Add parsers for new terminals.
    for (const [key, desired] of desiredParsers) {
      if (parsersRef.current.has(key)) continue;
      const entry: ParserEntry = {
        parser: null as unknown as ThrottledTerminalParser,
        unsub: null as unknown as () => void,
        stream: desired.stream,
        status: "idle",
        lastLine: "",
        contextLines: "",
        quickActions: [],
        provider: desired.provider,
        connectedAt: Date.now(),
      };

      entry.parser = new ThrottledTerminalParser((result) => {
        entry.status = result.status;
        entry.lastLine = result.lastLine;
        entry.contextLines = result.contextLines;
        entry.quickActions = result.quickActions;
        pushLiveActivityUpdate();
      }, 1000);

      entry.unsub = (desired.stream as TerminalInfo["terminalStream"]).subscribe((event) => {
        if (event.type === "append") entry.parser.push(event.chunk);
      });

      parsersRef.current.set(key, entry);
    }

    // Start or end live activity based on session count
    const hasConnected = [...currentSessions.values()].some(
      (s) => s.status === "connected",
    );

    if (
      hasConnected &&
      !liveActivityActiveRef.current &&
      !liveActivityStartingRef.current
    ) {
      startFromCandidates(
        collectCandidates(sessionsRef.current, parsersRef.current),
      );
    } else if (!hasConnected) {
      liveActivityActiveRef.current = false;
      liveActivityStartingRef.current = false;
      alertedRequestIdsRef.current = [];
      endLiveActivity();
      for (const entry of parsersRef.current.values()) {
        entry.parser.destroy();
        entry.unsub();
      }
      parsersRef.current.clear();
    } else if (hasConnected && liveActivityActiveRef.current) {
      pushLiveActivityUpdate();
    }
  }, [manager.activeSessionId, manager.sessions, pushLiveActivityUpdate, startFromCandidates]);

  // Periodic refresh
  useEffect(() => {
    const id = setInterval(() => {
      if (liveActivityActiveRef.current) pushLiveActivityUpdate();
    }, 2000);
    return () => clearInterval(id);
  }, [pushLiveActivityUpdate]);

  // Track foreground state so Live Activity alerts do not make noise while the
  // user is already inside the app.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      appStateRef.current = state;
    });
    return () => sub.remove();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (liveActivityActiveRef.current) {
        endLiveActivity();
        liveActivityActiveRef.current = false;
      }
      liveActivityStartingRef.current = false;
      alertedRequestIdsRef.current = [];
      for (const entry of parsersRef.current.values()) {
        entry.parser.destroy();
        entry.unsub();
      }
      parsersRef.current.clear();
    };
  }, []);
}
