import { useCallback, useEffect, useRef } from "react";
import { NativeModules, NativeEventEmitter, Platform } from "react-native";
import type { SessionManagerHandle, SessionInfo, TerminalInfo } from "./useSessionManager";
import {
  isLiveActivityAvailable,
  startLiveActivity,
  updateLiveActivity,
  endLiveActivity,
  confirmAction,
  type SessionSnapshot,
  type ExtendedSessionData,
} from "../native/LiveActivity";

// ── Build state from structured status (no terminal parsing) ──

function buildState(sessions: Map<string, SessionInfo>, activeSessionId: string | null) {
  const snapshots: SessionSnapshot[] = [];
  const extended: ExtendedSessionData[] = [];
  const now = Date.now();

  for (const [sid, info] of sessions) {
    if (info.status !== "connected") continue;

    const activeTerm = info.activeTerminalId
      ? info.terminals.get(info.activeTerminalId)
      : undefined;
    const ss = activeTerm?.structuredStatus;

    const hasPermission = !!(ss?.topPermission);
    const tp = ss?.topPermission;

    const snapshot: SessionSnapshot = {
      sid,
      tid: info.activeTerminalId || "default",
      phase: ss?.phase || "idle",
      project: (info.projectName || info.hostname || sid.slice(0, 8)).slice(0, 20),
      provider: activeTerm?.provider || info.provider || "claude",
      tool: ss?.toolName || "",
      elapsed: 0, // filled below
      hasPermission,
      permCount: ss?.pendingPermissionCount ?? (hasPermission ? 1 : 0),
    };
    console.log(`[LiveActivity] sid=${sid} provider="${snapshot.provider}" activeTerm?.provider="${activeTerm?.provider}" info.provider="${info.provider}" hasPermission=${hasPermission} phase=${snapshot.phase} topPermission=${JSON.stringify(tp)}`);

    const ext: ExtendedSessionData = {
      sid,
      toolDescription: (ss?.toolInput || ss?.summary || "").slice(0, 200),
      contextLines: (ss?.permissionRequest || ss?.summary || "").slice(0, 300),
      permissionTool: tp?.toolName || "",
      permissionContext: (tp?.permissionRequest || tp?.toolInput || "").slice(0, 200),
      permissionRequestId: tp?.requestId || "",
      quickActions: hasPermission
        ? [
            { label: "允许", input: "1\n", needsInput: false },
            { label: "本次允许", input: "2\n", needsInput: false },
            { label: "拒绝", input: "3\n", needsInput: false },
          ]
        : [],
    };

    snapshots.push(snapshot);
    extended.push(ext);
  }

  // Sort: error > waiting > tool_use > thinking > outputting > idle
  const priority: Record<string, number> = {
    error: 0, waiting: 1, tool_use: 2, thinking: 3, outputting: 4, idle: 5,
  };
  snapshots.sort((a, b) => (priority[a.phase] ?? 9) - (priority[b.phase] ?? 9));
  extended.sort((a, b) => {
    const ai = snapshots.findIndex((s) => s.sid === a.sid);
    const bi = snapshots.findIndex((s) => s.sid === b.sid);
    return ai - bi;
  });

  const aid = activeSessionId ?? snapshots[0]?.sid ?? "";
  return { snapshots, extended, aid };
}

// ── Tiered throttle ──

class TieredThrottle {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFire = 0;
  private pending = false;
  private fn: () => void;

  // Default intervals
  private immediateTypes = new Set(["permission", "phase_change"]);
  private debounceMs = 300;
  private tickMs = 5000;

  constructor(fn: () => void) {
    this.fn = fn;
  }

  fire(reason: "permission" | "phase_change" | "tick") {
    const now = Date.now();

    if (this.immediateTypes.has(reason)) {
      this.cancel();
      this.lastFire = now;
      this.fn();
      return;
    }

    if (reason === "phase_change") {
      // Debounce phase changes
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

    const { snapshots, extended, aid } = buildState(
      sessionsRef.current,
      activeSidRef.current,
    );

    if (snapshots.length === 0) return;

    // Fill elapsed times
    const now = Date.now();
    for (const s of snapshots) {
      const t = startTimesRef.current.get(s.sid);
      s.elapsed = t ? Math.floor((now - t) / 1000) : 0;
    }

    const hasPermission = snapshots.some((s) => s.hasPermission);
    const needsAlert = hasPermission && !lastAlertRef.current;
    lastAlertRef.current = hasPermission;

    updateLiveActivity(snapshots, extended, aid, needsAlert);
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
      // Start
      isLiveActivityAvailable().then((ok) => {
        if (!ok) return;
        const { snapshots, extended, aid } = buildState(
          sessionsRef.current,
          activeSidRef.current,
        );
        if (snapshots.length === 0) return;

        const now = Date.now();
        for (const s of snapshots) {
          const t = startTimesRef.current.get(s.sid);
          s.elapsed = t ? Math.floor((now - t) / 1000) : 0;
        }

        startLiveActivity(snapshots, extended, aid).then((id) => {
          if (id) activeRef.current = true;
        });
      });
    } else if (!hasConnected && activeRef.current) {
      // End
      activeRef.current = false;
      lastAlertRef.current = false;
      endLiveActivity();
    } else if (hasConnected && activeRef.current) {
      // Update
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
        manager.setActiveSessionId(event.sessionId);
        if (event.terminalId && event.terminalId !== "default") {
          manager.switchTerminal(event.terminalId);
        }
        setTimeout(() => manager.sendInput(event.input), 50);

        // Clear permission card from widget
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
