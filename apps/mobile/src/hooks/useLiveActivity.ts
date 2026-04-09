import { useCallback, useEffect, useRef } from "react";
import { NativeModules, NativeEventEmitter, Platform } from "react-native";
import type { SessionManagerHandle, SessionInfo, TerminalInfo } from "./useSessionManager";
import {
  isLiveActivityAvailable,
  startLiveActivity,
  updateLiveActivity,
  endLiveActivity,
  confirmAction,
  type TerminalSnapshot,
  type ExtendedTerminalData,
} from "../native/LiveActivity";

// ── Build state from all terminals across all sessions ──

function buildState(
  sessions: Map<string, SessionInfo>,
  activeSessionId: string | null,
) {
  const terminals: TerminalSnapshot[] = [];
  const extended: ExtendedTerminalData[] = [];

  let focusedSid = "";
  let focusedTid = "";

  for (const [sid, info] of sessions) {
    if (info.status !== "connected") continue;

    for (const [tid, term] of info.terminals) {
      const ss = term.structuredStatus;
      const hasPermission = !!(ss?.topPermission);
      const tp = ss?.topPermission;

      terminals.push({
        sid,
        tid,
        phase: ss?.phase || "idle",
        project: (term.projectName || info.projectName || info.hostname || sid.slice(0, 8)).slice(0, 20),
        provider: term.provider || info.provider || "claude",
        tool: ss?.toolName || "",
        elapsed: 0,
        hasPermission,
        permCount: ss?.pendingPermissionCount ?? (hasPermission ? 1 : 0),
      });

      extended.push({
        sid,
        tid,
        toolDescription: (ss?.toolInput || ss?.summary || "").slice(0, 200),
        contextLines: (ss?.permissionRequest || ss?.summary || "").slice(0, 300),
        permissionTool: tp?.toolName || "",
        permissionContext: (tp?.permissionRequest || tp?.toolInput || "").slice(0, 200),
        permissionRequestId: tp?.requestId || "",
        quickActions: hasPermission
          ? [
              { label: "允许", input: "allow", needsInput: false },
              { label: "拒绝", input: "deny", needsInput: false },
            ]
          : [],
      });

      // Track focused terminal
      if (sid === activeSessionId && tid === info.activeTerminalId) {
        focusedSid = sid;
        focusedTid = tid;
      }
    }
  }

  // Sort: hasPermission first, then by phase priority
  const priority: Record<string, number> = {
    error: 0, waiting: 1, tool_use: 2, thinking: 3, outputting: 4, idle: 5,
  };
  terminals.sort((a, b) => {
    if (a.hasPermission !== b.hasPermission) return a.hasPermission ? -1 : 1;
    return (priority[a.phase] ?? 9) - (priority[b.phase] ?? 9);
  });
  // Keep extended in same order as terminals
  const termOrder = new Map(terminals.map((t, i) => [`${t.sid}:${t.tid}`, i]));
  extended.sort((a, b) => (termOrder.get(`${a.sid}:${a.tid}`) ?? 99) - (termOrder.get(`${b.sid}:${b.tid}`) ?? 99));

  // Cap at 10 terminals (4KB budget)
  terminals.splice(10);
  extended.splice(10);

  // Default focused to first terminal if not set
  if (!focusedSid && terminals.length > 0) {
    focusedSid = terminals[0].sid;
    focusedTid = terminals[0].tid;
  }

  return { terminals, extended, focusedSid, focusedTid };
}

// ── Tiered throttle ──

class TieredThrottle {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFire = 0;
  private fn: () => void;
  private debounceMs = 300;
  private tickMs = 5000;

  constructor(fn: () => void) {
    this.fn = fn;
  }

  fire(reason: "permission" | "phase_change" | "tick") {
    const now = Date.now();

    if (reason === "permission") {
      this.cancel();
      this.lastFire = now;
      this.fn();
      return;
    }

    if (reason === "phase_change") {
      this.cancel();
      this.timer = setTimeout(() => {
        this.lastFire = Date.now();
        this.fn();
        this.timer = null;
      }, this.debounceMs);
      return;
    }

    // Tick: only fire if enough time has passed
    if (now - this.lastFire >= this.tickMs) {
      this.lastFire = now;
      this.fn();
    }
  }

  cancel() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  destroy() {
    this.cancel();
  }
}

// ── Hook ──

export function useLiveActivity(manager: SessionManagerHandle) {
  const activeRef = useRef(false);
  const lastAlertRef = useRef(false);
  const sessionsRef = useRef(manager.sessions);
  const activeSidRef = useRef(manager.activeSessionId);
  const startTimesRef = useRef(new Map<string, number>());
  const lastProviderRef = useRef(new Map<string, string>());

  sessionsRef.current = manager.sessions;
  activeSidRef.current = manager.activeSessionId;

  // Track session connect times
  useEffect(() => {
    const times = startTimesRef.current;
    for (const [sid, info] of manager.sessions) {
      if (info.status === "connected" && !times.has(sid)) {
        times.set(sid, Date.now());
      }
    }
    for (const sid of times.keys()) {
      if (!manager.sessions.has(sid)) {
        times.delete(sid);
      }
    }
  }, [manager.sessions]);

  const pushUpdate = useCallback(() => {
    if (!activeRef.current) return;

    const { terminals, extended, focusedSid, focusedTid } = buildState(
      sessionsRef.current,
      activeSidRef.current,
    );

    if (terminals.length === 0) return;

    // Fill elapsed times
    const now = Date.now();
    for (const t of terminals) {
      const start = startTimesRef.current.get(t.sid);
      t.elapsed = start ? Math.floor((now - start) / 1000) : 0;
    }

    // Detect provider changes and clear stale permission data
    for (let i = 0; i < terminals.length; i++) {
      const key = `${terminals[i].sid}:${terminals[i].tid}`;
      const prev = lastProviderRef.current.get(key);
      if (prev && prev !== terminals[i].provider) {
        // Provider switched — clear permission state
        extended[i].permissionTool = "";
        extended[i].permissionContext = "";
        extended[i].permissionRequestId = "";
        extended[i].quickActions = [];
      }
      lastProviderRef.current.set(key, terminals[i].provider);
    }

    const hasPermission = terminals.some((t) => t.hasPermission);
    const needsAlert = hasPermission && !lastAlertRef.current;
    lastAlertRef.current = hasPermission;

    updateLiveActivity(terminals, extended, focusedSid, focusedTid, needsAlert);
  }, []);

  const throttle = useRef<TieredThrottle | null>(null);
  if (!throttle.current) {
    throttle.current = new TieredThrottle(pushUpdate);
  }

  // Session lifecycle → start/end activity
  useEffect(() => {
    const hasConnected = [...manager.sessions.values()].some(
      (s) => s.status === "connected",
    );

    if (hasConnected && !activeRef.current) {
      isLiveActivityAvailable().then((ok) => {
        if (!ok) return;
        const { terminals, extended, focusedSid, focusedTid } = buildState(
          sessionsRef.current,
          activeSidRef.current,
        );
        if (terminals.length === 0) return;

        const now = Date.now();
        for (const t of terminals) {
          const start = startTimesRef.current.get(t.sid);
          t.elapsed = start ? Math.floor((now - start) / 1000) : 0;
        }

        startLiveActivity(terminals, extended, focusedSid, focusedTid).then((id) => {
          if (id) activeRef.current = true;
        });
      });
    } else if (!hasConnected && activeRef.current) {
      activeRef.current = false;
      lastAlertRef.current = false;
      lastProviderRef.current.clear();
      endLiveActivity();
    } else if (hasConnected && activeRef.current) {
      throttle.current?.fire("phase_change");
    }
  }, [manager.sessions, manager.activeSessionId, pushUpdate]);

  // Structured status changes → immediate or debounced update
  useEffect(() => {
    manager.onStatusChange((_sid, _tid, status) => {
      if (!activeRef.current) return;
      if (status?.topPermission || status?.phase === "waiting") {
        throttle.current?.fire("permission");
      } else {
        throttle.current?.fire("phase_change");
      }
    });
    return () => manager.onStatusChange(null);
  }, [manager]);

  // Elapsed time tick
  useEffect(() => {
    const id = setInterval(() => {
      throttle.current?.fire("tick");
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // ActionBridge: receive quick actions from widget
  useEffect(() => {
    if (Platform.OS !== "ios" || !NativeModules.ActionBridgeModule) return;
    const emitter = new NativeEventEmitter(NativeModules.ActionBridgeModule);
    const sub = emitter.addListener(
      "onQuickAction",
      (event: { sessionId: string; terminalId: string; input: string; requestId: string }) => {
        const info = manager.sessions.get(event.sessionId);
        if (!info) return;

        // input is "allow" or "deny" — send as permission decision
        if (event.requestId && (event.input === "allow" || event.input === "deny")) {
          manager.sendPermissionDecision(
            event.sessionId,
            event.terminalId,
            event.requestId,
            event.input,
          );
        } else {
          // Fallback: send as terminal input
          manager.setActiveSessionId(event.sessionId);
          if (event.terminalId && event.terminalId !== "default") {
            manager.switchTerminal(event.terminalId);
          }
          setTimeout(() => manager.sendInput(event.input), 50);
        }

        if (event.requestId) {
          confirmAction(event.requestId);
        }
      },
    );
    return () => sub.remove();
  }, [manager]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        endLiveActivity();
        activeRef.current = false;
      }
      throttle.current?.destroy();
    };
  }, []);
}
