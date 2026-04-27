import { useCallback, useEffect, useRef, useState } from "react";
import {
  createEnvelope,
  parseEnvelope,
  parseTypedPayload,
  serializeEnvelope,
} from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";
import type {
  ConnectionStatus,
  TerminalStream,
  TerminalStreamEvent,
  TerminalStreamSnapshot,
} from "./useSession";
import { ensureDeviceToken, setDeviceToken } from "../storage/device-token";

// ── Types ──────────────────────────────────────────────────────────

export interface TerminalInfo {
  terminalId: string;
  cwd: string;
  projectName: string;
  provider: string;
  status: "running" | "exited";
  terminalStream: TerminalStream;
  structuredStatus?: {
    phase: string;
    seq?: number;
    toolName?: string;
    toolInput?: string;
    permissionRequest?: string;
    summary?: string;
    topPermission?: {
      requestId: string;
      toolName: string;
      toolInput: string;
      permissionRequest: string;
      timestamp: number;
    };
    pendingPermissionCount?: number;
    updatedAt: number;
  };
}

export interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface BrowseResult {
  path: string;
  entries: BrowseEntry[];
  error?: string;
}

export interface AgentCapabilities {
  enabled: boolean;
  provider?: "codex" | "claude" | "custom";
  protocolVersion?: number;
  error?: string;
  supportsSessionList: boolean;
  supportsSessionLoad: boolean;
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsPermission: boolean;
  supportsPlan: boolean;
  supportsCancel: boolean;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
  isStreaming?: boolean;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input?: string;
  output?: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface AgentPermission {
  requestId: string;
  toolName?: string;
  toolInput?: string;
  context?: string;
  options: { id: string; label: string; kind: "allow" | "deny" | "other" }[];
}

export interface AgentState {
  capabilities: AgentCapabilities | null;
  activeAgentSessionId: string | null;
  messages: AgentMessage[];
  toolCalls: AgentToolCall[];
  pendingPermissions: AgentPermission[];
  status: "unavailable" | "idle" | "running" | "waiting_permission" | "error";
  error?: string | null;
}

export interface SessionInfo {
  sessionId: string;
  gatewayUrl: string;
  status: ConnectionStatus;
  deviceId: string;
  controllerId: string | null;
  connectionDetail: string | null;
  projectName: string | null;
  cwd: string | null;
  hostname: string | null;
  provider: string | null;
  terminals: Map<string, TerminalInfo>;
  activeTerminalId: string | null;
  terminalStream: TerminalStream; // active terminal's stream (for backward compat)
  screenStatus: {
    active: boolean;
    mode: "webrtc" | "fallback" | "off";
    error?: string;
  };
  screenFrame: {
    data: string;
    width: number;
    height: number;
    frameId: number;
  } | null;
  pendingOffer: { sdp: string } | null;
  pendingIceCandidates: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }[];
  browseResult: BrowseResult | null;
  agent: AgentState;
}

export interface SessionManagerHandle {
  sessions: Map<string, SessionInfo>;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  claim: (pairingCode: string, gatewayUrl: string) => Promise<string | null>;
  connectToSession: (sessionId: string, gatewayUrl: string) => void;
  sendInput: (data: string) => void;
  sendImage: (base64Data: string, filename: string) => void;
  sendResize: (cols: number, rows: number) => void;
  claimControl: () => void;
  releaseControl: () => void;
  startScreen: (fps: number, quality: number, scale: number) => void;
  stopScreen: () => void;
  sendScreenSignal: (
    type: "screen.answer" | "screen.ice",
    payload: any,
  ) => void;
  reconnect: () => void;
  disconnectSession: (sessionId: string) => void;
  disconnectAll: () => void;
  /** Spawn a new terminal in the active session at the given cwd */
  spawnTerminal: (cwd: string) => void;
  /** Switch active terminal within the active session */
  switchTerminal: (terminalId: string) => void;
  /** Request terminal list from host */
  requestTerminalList: () => void;
  /** Browse a directory on the host */
  browseDirectory: (path: string) => void;
  /** Create a directory on the host */
  mkdirRemote: (path: string) => void;
  /** Kill a terminal in the active session */
  killTerminal: (terminalId: string) => void;
  /** Remove an exited terminal from the local map */
  removeTerminal: (terminalId: string) => void;
  /** Register callback for terminal.status changes (for Live Activity fast path) */
  onStatusChange: (
    cb:
      | ((
          sessionId: string,
          terminalId: string,
          status: TerminalInfo["structuredStatus"],
        ) => void)
      | null,
  ) => void;
  /** Send permission decision back to CLI hook server */
  sendPermissionDecision: (
    sessionId: string,
    terminalId: string,
    requestId: string,
    decision: "allow" | "deny",
  ) => void;
  deviceToken: string | null;
  /** Request shell history from the host */
  requestHistory: () => void;
  /** Shell history entries from the host */
  historyEntries: string[];
  initializeAgent: () => void;
  sendAgentPrompt: (text: string) => void;
  cancelAgent: () => void;
  sendAgentPermissionResponse: (
    requestId: string,
    outcome: "allow" | "deny" | "cancelled",
    optionId?: string,
  ) => void;
}

// ── Constants ──────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL = 15_000;
const RECONNECT_BASE_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 15_000;
const RECONNECT_MAX_ATTEMPTS = 15;
const TERMINAL_REPLAY_LIMIT = 100;

function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Internal session state (not React state — lives in a ref) ─────

interface InternalTerminal {
  terminalId: string;
  cwd: string;
  projectName: string;
  provider: string;
  status: "running" | "exited";
  snapshot: TerminalStreamSnapshot;
  listeners: Set<(event: TerminalStreamEvent) => void>;
  stream: TerminalStream;
  structuredStatus?: {
    phase: string;
    seq?: number;
    toolName?: string;
    toolInput?: string;
    permissionRequest?: string;
    summary?: string;
    topPermission?: {
      requestId: string;
      toolName: string;
      toolInput: string;
      permissionRequest: string;
      timestamp: number;
    };
    pendingPermissionCount?: number;
    updatedAt: number;
  };
}

interface InternalSession {
  sessionId: string;
  gatewayUrl: string;
  deviceId: string;
  status: ConnectionStatus;
  controllerId: string | null;
  connectionDetail: string | null;
  projectName: string | null;
  cwd: string | null;
  hostname: string | null;
  provider: string | null;
  socket: WebSocket | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  healthProbeTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  lastAckedSeq: number;
  lastAckedSeqByTerminal: Map<string, number>;
  pendingOutbound: Array<{ envelope: Envelope; dedupeKey?: string }>;
  outboundDedupeKeys: Set<string>;
  manualDisconnect: boolean;
  // Multi-terminal
  terminals: Map<string, InternalTerminal>;
  activeTerminalId: string | null;
  // Legacy single stream (points to active terminal)
  terminalSnapshot: TerminalStreamSnapshot;
  terminalListeners: Set<(event: TerminalStreamEvent) => void>;
  terminalStream: TerminalStream;
  // Screen
  screenStatus: {
    active: boolean;
    mode: "webrtc" | "fallback" | "off";
    error?: string;
  };
  screenFrame: {
    data: string;
    width: number;
    height: number;
    frameId: number;
  } | null;
  pendingOffer: { sdp: string } | null;
  pendingIceCandidates: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }[];
  // Pending status for terminals not yet recreated (during reconnect)
  pendingStatusByTerminal: Map<string, InternalTerminal["structuredStatus"]>;
  chunkBuf: {
    frameId: number;
    chunks: Map<number, string>;
    total: number;
    width: number;
    height: number;
  } | null;
  browseResult: BrowseResult | null;
  agent: AgentState;
}

const OUTBOUND_QUEUE_LIMIT = 100;

function createInternalTerminal(
  terminalId: string,
  cwd: string,
  projectName: string,
  provider: string,
): InternalTerminal {
  const snapshot: TerminalStreamSnapshot = {
    sessionId: terminalId,
    chunks: [],
  };
  const listeners = new Set<(event: TerminalStreamEvent) => void>();
  return {
    terminalId,
    cwd,
    projectName,
    provider,
    status: "running",
    snapshot,
    listeners,
    stream: {
      getSnapshot: () => ({
        sessionId: snapshot.sessionId,
        chunks: [...snapshot.chunks],
      }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}

function createInternalSession(
  sessionId: string,
  gatewayUrl: string,
  deviceId: string,
): InternalSession {
  const snapshot: TerminalStreamSnapshot = { sessionId, chunks: [] };
  const listeners = new Set<(event: TerminalStreamEvent) => void>();
  return {
    sessionId,
    gatewayUrl,
    deviceId,
    status: "connecting",
    controllerId: null,
    connectionDetail: null,
    projectName: null,
    cwd: null,
    hostname: null,
    provider: null,
    socket: null,
    heartbeatTimer: null,
    reconnectTimer: null,
    healthProbeTimer: null,
    reconnectAttempts: 0,
    lastAckedSeq: -1,
    lastAckedSeqByTerminal: new Map(),
    pendingOutbound: [],
    outboundDedupeKeys: new Set(),
    manualDisconnect: false,
    terminals: new Map(),
    activeTerminalId: null,
    terminalSnapshot: snapshot,
    terminalListeners: listeners,
    terminalStream: {
      getSnapshot: () => ({
        sessionId: snapshot.sessionId,
        chunks: [...snapshot.chunks],
      }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    screenStatus: { active: false, mode: "off" },
    screenFrame: null,
    pendingOffer: null,
    pendingIceCandidates: [],
    pendingStatusByTerminal: new Map(),
    chunkBuf: null,
    browseResult: null,
    agent: {
      capabilities: null,
      activeAgentSessionId: null,
      messages: [],
      toolCalls: [],
      pendingPermissions: [],
      status: "unavailable",
      error: null,
    },
  };
}

function toSessionInfo(s: InternalSession): SessionInfo {
  const terminals = new Map<string, TerminalInfo>();
  for (const [tid, t] of s.terminals) {
    terminals.set(tid, {
      terminalId: t.terminalId,
      cwd: t.cwd,
      projectName: t.projectName,
      provider: t.provider,
      status: t.status,
      terminalStream: t.stream,
      structuredStatus: t.structuredStatus,
    });
  }
  // Use active terminal's stream if available, otherwise legacy stream
  const activeTerm = s.activeTerminalId
    ? s.terminals.get(s.activeTerminalId)
    : undefined;
  return {
    sessionId: s.sessionId,
    gatewayUrl: s.gatewayUrl,
    status: s.status,
    deviceId: s.deviceId,
    controllerId: s.controllerId,
    connectionDetail: s.connectionDetail,
    projectName: s.projectName,
    cwd: s.cwd,
    hostname: s.hostname,
    provider: s.provider,
    terminals,
    activeTerminalId: s.activeTerminalId,
    terminalStream: activeTerm?.stream ?? s.terminalStream,
    screenStatus: s.screenStatus,
    screenFrame: s.screenFrame,
    pendingOffer: s.pendingOffer,
    pendingIceCandidates: s.pendingIceCandidates,
    browseResult: s.browseResult,
    agent: {
      ...s.agent,
      messages: [...s.agent.messages],
      toolCalls: [...s.agent.toolCalls],
      pendingPermissions: [...s.agent.pendingPermissions],
    },
  };
}

// ── Hook ───────────────────────────────────────────────────────────

export function useSessionManager(): SessionManagerHandle {
  const sessionsRef = useRef(new Map<string, InternalSession>());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Bump to force re-render when internal state changes
  const [, setTick] = useState(0);
  const tick = useCallback(() => setTick((t) => t + 1), []);

  const deviceIdRef = useRef(generateId());
  const deviceTokenRef = useRef<string | null>(null);
  const historyEntriesRef = useRef<string[]>([]);
  const [historyEntries, setHistoryEntries] = useState<string[]>([]);
  const statusChangeCbRef = useRef<
    | ((
        sessionId: string,
        terminalId: string,
        status: TerminalInfo["structuredStatus"],
      ) => void)
    | null
  >(null);

  useEffect(() => {
    ensureDeviceToken().then((token) => {
      deviceTokenRef.current = token;
    });
  }, []);

  // ── Helpers ────────────────────────────────────────────────────

  const emitTerminal = (s: InternalSession, event: TerminalStreamEvent) => {
    for (const listener of s.terminalListeners) listener(event);
  };

  const emitTerminalForId = (
    s: InternalSession,
    terminalId: string,
    event: TerminalStreamEvent,
  ) => {
    const term = s.terminals.get(terminalId);
    if (term) {
      for (const listener of term.listeners) listener(event);
    }
    // Also emit on legacy stream if this is the active terminal
    if (s.activeTerminalId === terminalId || !s.activeTerminalId) {
      emitTerminal(s, event);
    }
  };

  const appendChunk = (
    s: InternalSession,
    terminalId: string,
    chunk: string,
  ) => {
    // Append to per-terminal stream
    const term = s.terminals.get(terminalId);
    if (term) {
      term.snapshot.chunks.push(chunk);
      if (term.snapshot.chunks.length > TERMINAL_REPLAY_LIMIT) {
        term.snapshot.chunks.splice(
          0,
          term.snapshot.chunks.length - TERMINAL_REPLAY_LIMIT,
        );
      }
    }
    // Append to legacy stream if active terminal
    if (s.activeTerminalId === terminalId || !s.activeTerminalId) {
      s.terminalSnapshot.chunks.push(chunk);
      if (s.terminalSnapshot.chunks.length > TERMINAL_REPLAY_LIMIT) {
        s.terminalSnapshot.chunks.splice(
          0,
          s.terminalSnapshot.chunks.length - TERMINAL_REPLAY_LIMIT,
        );
      }
    }
    emitTerminalForId(s, terminalId, {
      type: "append",
      sessionId: s.sessionId,
      chunk,
    });
  };

  let connectSocket: (s: InternalSession, isReconnect?: boolean) => Promise<void>;

  const flushOutbound = (s: InternalSession) => {
    if (!s.socket || s.socket.readyState !== WebSocket.OPEN) return;
    const queued = s.pendingOutbound.splice(0);
    s.outboundDedupeKeys.clear();
    for (const item of queued) {
      s.socket.send(serializeEnvelope(item.envelope));
    }
  };

  const sendRaw = (
    s: InternalSession,
    envelope: Envelope,
    options?: { queue?: boolean; dedupeKey?: string },
  ): boolean => {
    if (s.socket && s.socket.readyState === WebSocket.OPEN) {
      s.socket.send(serializeEnvelope(envelope));
      return true;
    }
    if (!options?.queue) return false;
    if (options.dedupeKey && s.outboundDedupeKeys.has(options.dedupeKey)) {
      return true;
    }
    if (s.pendingOutbound.length >= OUTBOUND_QUEUE_LIMIT) {
      const dropped = s.pendingOutbound.shift();
      if (dropped?.dedupeKey) s.outboundDedupeKeys.delete(dropped.dedupeKey);
    }
    s.pendingOutbound.push({ envelope, dedupeKey: options.dedupeKey });
    if (options.dedupeKey) s.outboundDedupeKeys.add(options.dedupeKey);
    if (!s.socket && !s.manualDisconnect) {
      connectSocket(s, true);
    }
    return true;
  };

  const stopHeartbeat = (s: InternalSession) => {
    if (s.heartbeatTimer) {
      clearInterval(s.heartbeatTimer);
      s.heartbeatTimer = null;
    }
  };

  const startHeartbeat = (s: InternalSession) => {
    stopHeartbeat(s);
    s.heartbeatTimer = setInterval(() => {
      sendRaw(
        s,
        createEnvelope({
          type: "session.heartbeat",
          sessionId: s.sessionId,
          payload: { ts: Date.now() },
        }),
      );
    }, HEARTBEAT_INTERVAL);
  };

  const requestControl = (s: InternalSession) => {
    sendRaw(
      s,
      createEnvelope({
        type: "control.claim",
        sessionId: s.sessionId,
        payload: { deviceId: s.deviceId },
      }),
    );
  };

  const cleanupSession = (s: InternalSession) => {
    s.manualDisconnect = true;
    stopHeartbeat(s);
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
    if (s.healthProbeTimer) {
      clearTimeout(s.healthProbeTimer);
      s.healthProbeTimer = null;
    }
    s.socket?.close();
    s.socket = null;
  };

  // ── Connect socket for a session ──────────────────────────────

  connectSocket = async (s: InternalSession, isReconnect = false) => {
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
    s.manualDisconnect = false;
    s.status = isReconnect ? "reconnecting" : "connecting";
    tick();

    const base = s.gatewayUrl
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:");
    const tokenParam = deviceTokenRef.current
      ? `&token=${encodeURIComponent(deviceTokenRef.current)}`
      : "";

    // Add Supabase auth token for official gateways
    let authParam = "";
    try {
      const { getValidSession } = await import("../lib/supabase");
      const session = await getValidSession();
      if (session?.accessToken) {
        authParam = `&auth_token=${encodeURIComponent(session.accessToken)}`;
      }
    } catch {}

    const url = `${base}/ws?sessionId=${encodeURIComponent(s.sessionId)}&role=client&deviceId=${s.deviceId}${tokenParam}${authParam}`;
    const ws = new WebSocket(url);
    s.socket = ws;

    ws.onopen = () => {
      s.connectionDetail = null;
      s.reconnectAttempts = 0;
      startHeartbeat(s);
      requestControl(s);
      flushOutbound(s);

      // Always request terminal list so we discover all running terminals
      sendRaw(
        s,
        createEnvelope({
          type: "terminal.list",
          sessionId: s.sessionId,
          payload: { terminals: [] },
        }),
      );

      // Health probe
      (async () => {
        try {
          const headers: Record<string, string> = {};
          if (deviceTokenRef.current)
            headers["Authorization"] = `Bearer ${deviceTokenRef.current}`;
          const res = await fetch(
            `${s.gatewayUrl}/sessions/${encodeURIComponent(s.sessionId)}`,
            { headers },
          );
          if (!res.ok) {
            if (s.status === "connecting" || s.status === "reconnecting") {
              s.status = "connected";
              tick();
            }
            return;
          }
          const body = (await res.json()) as {
            hasHost?: boolean;
            projectName?: string | null;
            cwd?: string | null;
            hostname?: string | null;
            provider?: string | null;
          };
          // Extract project metadata
          if (body.projectName) s.projectName = body.projectName;
          if (body.cwd) s.cwd = body.cwd;
          if (body.hostname) s.hostname = body.hostname;
          if (body.provider) s.provider = body.provider;

          if (body.hasHost === false) {
            if (s.status === "connecting" || s.status === "reconnecting") {
              s.status = "host_disconnected" as ConnectionStatus;
              s.connectionDetail = "Host is not connected to this session.";
            }
          } else {
            if (s.status === "connecting" || s.status === "reconnecting") {
              s.status = "connected";
            }
          }
          tick();
        } catch {
          if (s.status === "connecting" || s.status === "reconnecting") {
            s.status = "connected";
            tick();
          }
        }
      })();

      if (isReconnect) {
        // Clear terminals — host will resend terminal.list + replay all output
        s.terminals.clear();
        s.activeTerminalId = null;
        s.terminalSnapshot = { sessionId: s.sessionId, chunks: [] };
        emitTerminal(s, {
          type: "reset",
          snapshot: { sessionId: s.sessionId, chunks: [] },
        });
        sendRaw(
          s,
          createEnvelope({
            type: "session.resume",
            sessionId: s.sessionId,
            payload: {
              lastAckedSeq: s.lastAckedSeq,
              lastAckedSeqByTerminal: Object.fromEntries(
                s.lastAckedSeqByTerminal,
              ),
            },
          }),
        );
      }
    };

    ws.onmessage = (event) => {
      let envelope: Envelope;
      try {
        envelope = parseEnvelope(String(event.data));
      } catch {
        return;
      }

      switch (envelope.type as string) {
        case "terminal.output": {
          if (s.status === "connecting" || s.status === "reconnecting") {
            s.status = "connected";
            s.connectionDetail = null;
          }
          const p = parseTypedPayload("terminal.output", envelope.payload);
          const tid = (envelope as any).terminalId ?? "default";
          // Auto-create terminal entry if we don't have it yet (backward compat)
          if (!s.terminals.has(tid)) {
            const t = createInternalTerminal(
              tid,
              s.cwd ?? "",
              s.projectName ?? tid,
              s.provider ?? "claude",
            );
            s.terminals.set(tid, t);
            if (!s.activeTerminalId) s.activeTerminalId = tid;
          }
          appendChunk(s, tid, p.data);
          if (envelope.seq !== undefined) {
            const next = Math.max(s.lastAckedSeq, envelope.seq);
            if (next !== s.lastAckedSeq) {
              s.lastAckedSeq = next;
            }
            const currentForTerminal = s.lastAckedSeqByTerminal.get(tid) ?? -1;
            const nextForTerminal = Math.max(currentForTerminal, envelope.seq);
            if (nextForTerminal !== currentForTerminal) {
              s.lastAckedSeqByTerminal.set(tid, nextForTerminal);
              sendRaw(
                s,
                createEnvelope({
                  type: "session.ack",
                  sessionId: s.sessionId,
                  terminalId: tid,
                  payload: { seq: nextForTerminal },
                }),
              );
            }
          }
          tick();
          break;
        }
        case "terminal.spawned": {
          const p = parseTypedPayload("terminal.spawned", envelope.payload);
          // If terminal already exists (dedup from host), just switch to it
          if (s.terminals.has(p.terminalId)) {
            s.activeTerminalId = p.terminalId;
            const term = s.terminals.get(p.terminalId)!;
            s.terminalSnapshot = {
              sessionId: s.sessionId,
              chunks: [...term.snapshot.chunks],
            };
            emitTerminal(s, {
              type: "reset",
              snapshot: {
                sessionId: s.sessionId,
                chunks: [...term.snapshot.chunks],
              },
            });
          } else {
            const t = createInternalTerminal(
              p.terminalId,
              p.cwd,
              p.projectName,
              (p as any).provider ?? s.provider ?? "claude",
            );
            // Apply any pending status from reconnect replay
            const pendingStatus = s.pendingStatusByTerminal.get(p.terminalId);
            if (pendingStatus) {
              t.structuredStatus = pendingStatus;
              s.pendingStatusByTerminal.delete(p.terminalId);
              statusChangeCbRef.current?.(
                s.sessionId,
                p.terminalId,
                pendingStatus,
              );
            }
            s.terminals.set(p.terminalId, t);
            s.activeTerminalId = p.terminalId;
            s.terminalSnapshot = { sessionId: s.sessionId, chunks: [] };
            emitTerminal(s, {
              type: "reset",
              snapshot: { sessionId: s.sessionId, chunks: [] },
            });
          }
          tick();
          break;
        }
        case "agent.capabilities": {
          const p = parseTypedPayload("agent.capabilities" as any, envelope.payload) as any;
          s.agent.capabilities = p as AgentCapabilities;
          s.agent.status = p.enabled ? "idle" : "unavailable";
          s.agent.error = p.error ?? null;
          tick();
          break;
        }
        case "agent.snapshot": {
          const p = parseTypedPayload("agent.snapshot" as any, envelope.payload) as any;
          s.agent.activeAgentSessionId = p.agentSessionId ?? null;
          s.agent.capabilities = (p.capabilities as AgentCapabilities | undefined) ?? s.agent.capabilities;
          s.agent.messages = p.messages as AgentMessage[];
          s.agent.toolCalls = p.toolCalls as AgentToolCall[];
          s.agent.pendingPermissions = p.pendingPermissions as AgentPermission[];
          s.agent.status = p.status;
          s.agent.error = p.error ?? null;
          tick();
          break;
        }
        case "agent.update": {
          const p = parseTypedPayload("agent.update" as any, envelope.payload) as any;
          s.agent.activeAgentSessionId = p.agentSessionId ?? s.agent.activeAgentSessionId;
          if (p.status) s.agent.status = p.status;
          if (p.error) s.agent.error = p.error;
          if (p.message) {
            const existing = s.agent.messages.findIndex((m) => m.id === p.message!.id);
            if (existing >= 0) s.agent.messages[existing] = p.message as AgentMessage;
            else s.agent.messages.push(p.message as AgentMessage);
            if (s.agent.messages.length > 100) s.agent.messages.shift();
          }
          if (p.toolCall) {
            const existing = s.agent.toolCalls.findIndex((t) => t.id === p.toolCall!.id);
            if (existing >= 0) s.agent.toolCalls[existing] = p.toolCall as AgentToolCall;
            else s.agent.toolCalls.push(p.toolCall as AgentToolCall);
          }
          tick();
          break;
        }
        case "agent.permission.request": {
          const p = parseTypedPayload("agent.permission.request" as any, envelope.payload) as any;
          s.agent.activeAgentSessionId = p.agentSessionId ?? s.agent.activeAgentSessionId;
          s.agent.status = "waiting_permission";
          const next = {
            requestId: p.requestId,
            toolName: p.toolName,
            toolInput: p.toolInput,
            context: p.context,
            options: p.options,
          } as AgentPermission;
          const existing = s.agent.pendingPermissions.findIndex(
            (perm) => perm.requestId === next.requestId,
          );
          if (existing >= 0) s.agent.pendingPermissions[existing] = next;
          else s.agent.pendingPermissions.push(next);
          tick();
          break;
        }
        case "terminal.list": {
          const p = parseTypedPayload("terminal.list", envelope.payload);
          for (const info of p.terminals) {
            if (!s.terminals.has(info.terminalId)) {
              const t = createInternalTerminal(
                info.terminalId,
                info.cwd,
                info.projectName,
                info.provider,
              );
              t.status = info.status;
              // Apply any pending status from reconnect replay
              const pendingStatus = s.pendingStatusByTerminal.get(
                info.terminalId,
              );
              if (pendingStatus) {
                t.structuredStatus = pendingStatus;
                s.pendingStatusByTerminal.delete(info.terminalId);
                statusChangeCbRef.current?.(
                  s.sessionId,
                  info.terminalId,
                  pendingStatus,
                );
              }
              s.terminals.set(info.terminalId, t);
            } else {
              const existing = s.terminals.get(info.terminalId)!;
              existing.status = info.status;
              existing.cwd = info.cwd;
              existing.projectName = info.projectName;
              if (info.provider) existing.provider = info.provider;
            }
          }
          // Set active terminal if not set
          if (!s.activeTerminalId && s.terminals.size > 0) {
            s.activeTerminalId = s.terminals.keys().next().value ?? null;
          }
          tick();
          break;
        }
        case "terminal.exit": {
          const tid = (envelope as any).terminalId ?? "default";
          const term = s.terminals.get(tid);
          if (term) term.status = "exited";
          // Auto-switch if the exited terminal was active
          if (s.activeTerminalId === tid) {
            const next = [...s.terminals.values()].find(
              (t) => t.status === "running",
            );
            if (next) {
              s.activeTerminalId = next.terminalId;
              s.terminalSnapshot = {
                sessionId: s.sessionId,
                chunks: [...next.snapshot.chunks],
              };
              for (const listener of s.terminalListeners) {
                listener({
                  type: "reset",
                  snapshot: {
                    sessionId: s.sessionId,
                    chunks: [...next.snapshot.chunks],
                  },
                });
              }
            }
          }
          // Only mark session exited if all terminals exited
          const allExited =
            s.terminals.size > 0 &&
            [...s.terminals.values()].every((t) => t.status === "exited");
          if (allExited) {
            s.status = "session_exited";
            s.connectionDetail = "All terminals exited.";
            stopHeartbeat(s);
          } else {
            // Auto-remove exited terminal if there are still running ones
            s.terminals.delete(tid);
          }
          tick();
          break;
        }
        case "session.error": {
          const p = parseTypedPayload("session.error", envelope.payload);
          if (p.code === "control_conflict") {
            s.connectionDetail = null;
            break;
          }
          s.connectionDetail = p.message;
          if (p.code === "session_terminated") {
            s.status = "session_exited";
            tick();
            break;
          }
          s.status = `error:${p.code}` as ConnectionStatus;
          tick();
          break;
        }
        case "control.grant": {
          const p = parseTypedPayload("control.grant", envelope.payload);
          s.controllerId = p.deviceId;
          tick();
          break;
        }
        case "control.release": {
          const p = parseTypedPayload("control.release", envelope.payload);
          if (s.controllerId === p.deviceId) s.controllerId = null;
          tick();
          break;
        }
        case "session.host_disconnected":
          s.status = "host_disconnected" as ConnectionStatus;
          s.connectionDetail =
            "Host connection closed. Waiting for it to come back.";
          tick();
          break;
        case "session.host_reconnected":
          s.status = "connected";
          s.connectionDetail = null;
          tick();
          break;
        case "screen.frame": {
          const p = parseTypedPayload("screen.frame", envelope.payload);
          if (p.chunkTotal <= 1) {
            s.screenFrame = {
              data: p.data,
              width: p.width,
              height: p.height,
              frameId: p.frameId,
            };
          } else {
            if (!s.chunkBuf || s.chunkBuf.frameId !== p.frameId) {
              s.chunkBuf = {
                frameId: p.frameId,
                chunks: new Map(),
                total: p.chunkTotal,
                width: p.width,
                height: p.height,
              };
            }
            s.chunkBuf.chunks.set(p.chunkIndex, p.data);
            if (s.chunkBuf.chunks.size === s.chunkBuf.total) {
              let fullData = "";
              for (let i = 0; i < s.chunkBuf.total; i++)
                fullData += s.chunkBuf.chunks.get(i) ?? "";
              s.screenFrame = {
                data: fullData,
                width: s.chunkBuf.width,
                height: s.chunkBuf.height,
                frameId: p.frameId,
              };
              s.chunkBuf = null;
            }
          }
          tick();
          break;
        }
        case "screen.status": {
          const p = parseTypedPayload("screen.status", envelope.payload);
          s.screenStatus = { active: p.active, mode: p.mode, error: p.error };
          tick();
          break;
        }
        case "screen.offer": {
          const p = parseTypedPayload("screen.offer", envelope.payload);
          s.pendingOffer = { sdp: p.sdp };
          tick();
          break;
        }
        case "screen.ice": {
          const p = parseTypedPayload("screen.ice", envelope.payload);
          s.pendingIceCandidates = [
            ...s.pendingIceCandidates,
            {
              candidate: p.candidate,
              sdpMid: p.sdpMid,
              sdpMLineIndex: p.sdpMLineIndex,
            },
          ];
          tick();
          break;
        }
        case "terminal.browse.result": {
          const p = envelope.payload as {
            path: string;
            entries: BrowseEntry[];
            error?: string;
          };
          s.browseResult = { path: p.path, entries: p.entries, error: p.error };
          tick();
          break;
        }
        case "terminal.history.response": {
          const p = envelope.payload as { entries: string[]; shell?: string };
          historyEntriesRef.current = p.entries;
          setHistoryEntries(p.entries);
          break;
        }
        case "terminal.status": {
          const tid = (envelope as any).terminalId ?? "default";
          const p = envelope.payload as {
            phase: string;
            seq?: number;
            toolName?: string;
            toolInput?: string;
            permissionRequest?: string;
            summary?: string;
            topPermission?: {
              requestId: string;
              toolName: string;
              toolInput: string;
              permissionRequest: string;
              timestamp: number;
            };
            pendingPermissionCount?: number;
          };
          const term = s.terminals.get(tid);
          const existingSeq =
            term?.structuredStatus?.seq ??
            s.pendingStatusByTerminal.get(tid)?.seq;
          if (
            p.seq !== undefined &&
            existingSeq !== undefined &&
            p.seq < existingSeq
          ) {
            break;
          }
          const statusData = { ...p, updatedAt: Date.now() };
          if (term) {
            term.structuredStatus = statusData;
            statusChangeCbRef.current?.(
              s.sessionId,
              tid,
              term.structuredStatus,
            );
          } else {
            // Terminal not yet recreated (reconnect) — buffer for later
            s.pendingStatusByTerminal.set(tid, statusData);
          }
          tick();
          break;
        }
        default:
          break;
      }
    };

    ws.onclose = (event) => {
      stopHeartbeat(s);
      if (s.socket === ws) s.socket = null;
      // 4001 = unauthorized (token doesn't own this session) — don't reconnect
      const code = (event as any)?.code as number | undefined;
      if (code === 4001) {
        s.status = "disconnected";
        s.connectionDetail = "Unauthorized: device token does not own this session.";
        tick();
        return;
      }
      if (!s.manualDisconnect && s.status !== "session_exited") {
        s.connectionDetail = "Gateway connection lost. Reconnecting...";
        scheduleReconnect(s);
      }
    };

    ws.onerror = () => {};
  };

  const scheduleReconnect = (s: InternalSession) => {
    if (s.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      s.connectionDetail =
        "Gateway is unreachable. Retry when the server is back.";
      s.status = "disconnected";
      tick();
      return;
    }
    s.status = "reconnecting";
    tick();
    const delay = Math.min(
      RECONNECT_BASE_DELAY * 2 ** s.reconnectAttempts,
      RECONNECT_MAX_DELAY,
    );
    s.reconnectAttempts++;
    s.reconnectTimer = setTimeout(() => connectSocket(s, true), delay);
  };

  // ── Public API ────────────────────────────────────────────────

  const getActive = useCallback((): InternalSession | undefined => {
    if (!activeSessionId) return undefined;
    return sessionsRef.current.get(activeSessionId);
  }, [activeSessionId]);

  const claim = useCallback(
    async (pairingCode: string, gatewayUrl: string): Promise<string | null> => {
      try {
        const currentToken =
          deviceTokenRef.current ?? (await ensureDeviceToken());
        const res = await fetch(`${gatewayUrl}/pairings/claim`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pairingCode, deviceToken: currentToken }),
        });
        const body = (await res.json()) as {
          sessionId?: string;
          deviceToken?: string;
          error?: string;
        };
        if (!res.ok || !body.sessionId) return null;
        if (body.deviceToken) {
          deviceTokenRef.current = body.deviceToken;
          setDeviceToken(body.deviceToken);
        }

        const sid = body.sessionId;
        const s = createInternalSession(sid, gatewayUrl, deviceIdRef.current);
        sessionsRef.current.set(sid, s);
        setActiveSessionId(sid);
        connectSocket(s);
        tick();
        return sid;
      } catch {
        return null;
      }
    },
    [tick],
  );

  const connectToSession = useCallback(
    (sessionId: string, gatewayUrl: string) => {
      // If already connected, just switch to it
      const existing = sessionsRef.current.get(sessionId);
      if (existing) {
        setActiveSessionId(sessionId);
        return;
      }

      const s = createInternalSession(
        sessionId,
        gatewayUrl,
        deviceIdRef.current,
      );
      sessionsRef.current.set(sessionId, s);
      setActiveSessionId(sessionId);
      connectSocket(s);
      tick();
    },
    [tick],
  );

  const sendInput = useCallback(
    (data: string) => {
      const s = getActive();
      if (!s) return;
      sendRaw(
        s,
        createEnvelope({
          type: "terminal.input",
          sessionId: s.sessionId,
          terminalId: s.activeTerminalId ?? "default",
          deviceId: s.deviceId,
          payload: { data },
        }),
        { queue: true },
      );
    },
    [getActive],
  );

  const sendImage = useCallback(
    (base64Data: string, filename: string) => {
      const s = getActive();
      if (!s) return;
      sendRaw(
        s,
        createEnvelope({
          type: "file.upload",
          sessionId: s.sessionId,
          terminalId: s.activeTerminalId ?? "default",
          deviceId: s.deviceId,
          payload: { data: base64Data, filename },
        }),
      );
    },
    [getActive],
  );

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      const s = getActive();
      if (!s) return;
      sendRaw(
        s,
        createEnvelope({
          type: "terminal.resize",
          sessionId: s.sessionId,
          terminalId: s.activeTerminalId ?? "default",
          deviceId: s.deviceId,
          payload: { cols, rows },
        }),
      );
    },
    [getActive],
  );

  const claimControlFn = useCallback(() => {
    const s = getActive();
    if (s) requestControl(s);
  }, [getActive]);

  const releaseControlFn = useCallback(() => {
    const s = getActive();
    if (!s) return;
    sendRaw(
      s,
      createEnvelope({
        type: "control.release",
        sessionId: s.sessionId,
        payload: { deviceId: s.deviceId },
      }),
    );
  }, [getActive]);

  const startScreenFn = useCallback(
    (fps: number, quality: number, scale: number) => {
      const s = getActive();
      if (!s) return;
      sendRaw(
        s,
        createEnvelope({
          type: "screen.start",
          sessionId: s.sessionId,
          payload: { fps, quality, scale },
        }),
      );
    },
    [getActive],
  );

  const stopScreenFn = useCallback(() => {
    const s = getActive();
    if (!s) return;
    sendRaw(
      s,
      createEnvelope({
        type: "screen.stop",
        sessionId: s.sessionId,
        payload: {},
      }),
    );
    s.screenStatus = { active: false, mode: "off" };
    s.pendingOffer = null;
    s.pendingIceCandidates = [];
    tick();
  }, [getActive, tick]);

  const sendScreenSignalFn = useCallback(
    (type: "screen.answer" | "screen.ice", payload: any) => {
      const s = getActive();
      if (!s) return;
      sendRaw(s, createEnvelope({ type, sessionId: s.sessionId, payload }));
    },
    [getActive],
  );

  const reconnectFn = useCallback(() => {
    const s = getActive();
    if (!s) return;
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
      s.reconnectTimer = null;
    }
    if (s.socket) {
      s.manualDisconnect = true;
      s.socket.close();
      s.socket = null;
    }
    s.manualDisconnect = false;
    connectSocket(s, true);
  }, [getActive]);

  const disconnectSession = useCallback(
    (sessionId: string) => {
      const s = sessionsRef.current.get(sessionId);
      if (!s) return;
      cleanupSession(s);
      sessionsRef.current.delete(sessionId);
      if (activeSessionId === sessionId) {
        // Switch to another session or null
        const remaining = [...sessionsRef.current.keys()];
        setActiveSessionId(
          remaining.length > 0 ? remaining[remaining.length - 1] : null,
        );
      }
      tick();
    },
    [activeSessionId, tick],
  );

  const disconnectAll = useCallback(() => {
    for (const s of sessionsRef.current.values()) cleanupSession(s);
    sessionsRef.current.clear();
    setActiveSessionId(null);
    tick();
  }, [tick]);

  const spawnTerminalFn = useCallback(
    (cwd: string) => {
      const s = getActive();
      if (!s) return;
      // Client-side dedup: if a running terminal already exists for this cwd, just switch to it
      for (const [tid, t] of s.terminals) {
        if (t.cwd === cwd && t.status === "running") {
          switchTerminalFn(tid);
          return;
        }
      }
      sendRaw(
        s,
        createEnvelope({
          type: "terminal.spawn",
          sessionId: s.sessionId,
          payload: { cwd },
        }),
      );
    },
    [getActive],
  );

  const switchTerminalFn = useCallback(
    (terminalId: string) => {
      const s = getActive();
      if (!s) return;
      if (!s.terminals.has(terminalId)) return;
      s.activeTerminalId = terminalId;
      // Reset legacy stream to point to new terminal
      const term = s.terminals.get(terminalId)!;
      s.terminalSnapshot = {
        sessionId: s.sessionId,
        chunks: [...term.snapshot.chunks],
      };
      for (const listener of s.terminalListeners) {
        listener({
          type: "reset",
          snapshot: {
            sessionId: s.sessionId,
            chunks: [...term.snapshot.chunks],
          },
        });
      }
      tick();
    },
    [getActive, tick],
  );

  const requestTerminalListFn = useCallback(() => {
    const s = getActive();
    if (!s) return;
    sendRaw(
      s,
      createEnvelope({
        type: "terminal.list",
        sessionId: s.sessionId,
        payload: { terminals: [] },
      }),
    );
  }, [getActive]);

  const browseDirectoryFn = useCallback(
    (path: string) => {
      const s = getActive();
      if (!s) return;
      s.browseResult = null; // clear previous result
      sendRaw(
        s,
        createEnvelope({
          type: "terminal.browse" as any,
          sessionId: s.sessionId,
          payload: { path },
        }),
      );
      tick();
    },
    [getActive, tick],
  );

  const requestHistoryFn = useCallback(() => {
    const s = getActive();
    if (!s) return;
    sendRaw(
      s,
      createEnvelope({
        type: "terminal.history.request" as any,
        sessionId: s.sessionId,
        payload: { count: 200 },
      }),
    );
  }, [getActive]);

  const initializeAgentFn = useCallback(() => {
    const s = getActive();
    if (!s) return;
    sendRaw(
      s,
      createEnvelope({
        type: "agent.initialize" as any,
        sessionId: s.sessionId,
        deviceId: s.deviceId,
        payload: {},
      }),
      { queue: true, dedupeKey: "agent:init" },
    );
  }, [getActive]);

  const sendAgentPromptFn = useCallback(
    (text: string) => {
      const s = getActive();
      const trimmed = text.trim();
      if (!s || !trimmed) return;
      sendRaw(
        s,
        createEnvelope({
          type: "agent.prompt" as any,
          sessionId: s.sessionId,
          deviceId: s.deviceId,
          payload: {
            agentSessionId: s.agent.activeAgentSessionId ?? undefined,
            clientMessageId: generateId(),
            contentBlocks: [{ type: "text", text: trimmed }],
          },
        }),
        { queue: true },
      );
      s.agent.status = "running";
      tick();
    },
    [getActive, tick],
  );

  const cancelAgentFn = useCallback(() => {
    const s = getActive();
    if (!s) return;
    sendRaw(
      s,
      createEnvelope({
        type: "agent.cancel" as any,
        sessionId: s.sessionId,
        deviceId: s.deviceId,
        payload: { agentSessionId: s.agent.activeAgentSessionId ?? undefined },
      }),
      { queue: true },
    );
  }, [getActive]);

  const sendAgentPermissionResponseFn = useCallback(
    (requestId: string, outcome: "allow" | "deny" | "cancelled", optionId?: string) => {
      const s = getActive();
      if (!s) return;
      sendRaw(
        s,
        createEnvelope({
          type: "agent.permission.response" as any,
          sessionId: s.sessionId,
          deviceId: s.deviceId,
          payload: {
            agentSessionId: s.agent.activeAgentSessionId ?? undefined,
            requestId,
            outcome,
            optionId,
          },
        }),
        { queue: true, dedupeKey: `agent-permission:${requestId}` },
      );
      s.agent.pendingPermissions = s.agent.pendingPermissions.filter(
        (perm) => perm.requestId !== requestId,
      );
      tick();
    },
    [getActive, tick],
  );

  const killTerminalFn = useCallback(
    (terminalId: string) => {
      const s = getActive();
      if (!s) return;
      const term = s.terminals.get(terminalId);
      if (!term || term.status !== "running") return;
      sendRaw(
        s,
        createEnvelope({
          type: "terminal.kill" as any,
          sessionId: s.sessionId,
          payload: { terminalId },
        }),
      );
    },
    [getActive],
  );

  const removeTerminalFn = useCallback(
    (terminalId: string) => {
      const s = getActive();
      if (!s) return;
      s.terminals.delete(terminalId);
      // If we removed the active terminal, switch to another
      if (s.activeTerminalId === terminalId) {
        const next =
          [...s.terminals.values()].find((t) => t.status === "running") ??
          [...s.terminals.values()][0];
        if (next) {
          s.activeTerminalId = next.terminalId;
          s.terminalSnapshot = {
            sessionId: s.sessionId,
            chunks: [...next.snapshot.chunks],
          };
          for (const listener of s.terminalListeners) {
            listener({
              type: "reset",
              snapshot: {
                sessionId: s.sessionId,
                chunks: [...next.snapshot.chunks],
              },
            });
          }
        } else {
          s.activeTerminalId = null;
        }
      }
      tick();
    },
    [getActive, tick],
  );

  // Build sessions map for consumers
  const sessions = new Map<string, SessionInfo>();
  for (const [id, s] of sessionsRef.current) {
    sessions.set(id, toSessionInfo(s));
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const s of sessionsRef.current.values()) cleanupSession(s);
    };
  }, []);

  return {
    sessions,
    activeSessionId,
    setActiveSessionId,
    claim,
    connectToSession,
    sendInput,
    sendImage,
    sendResize,
    claimControl: claimControlFn,
    releaseControl: releaseControlFn,
    startScreen: startScreenFn,
    stopScreen: stopScreenFn,
    sendScreenSignal: sendScreenSignalFn,
    reconnect: reconnectFn,
    disconnectSession,
    disconnectAll,
    spawnTerminal: spawnTerminalFn,
    switchTerminal: switchTerminalFn,
    requestTerminalList: requestTerminalListFn,
    browseDirectory: browseDirectoryFn,
    mkdirRemote: (path: string) => {
      const s = getActive();
      if (!s) return;
      sendRaw(
        s,
        createEnvelope({
          type: "terminal.mkdir" as any,
          sessionId: s.sessionId,
          payload: { path },
        }),
      );
    },
    killTerminal: killTerminalFn,
    removeTerminal: removeTerminalFn,
    onStatusChange: (cb) => {
      statusChangeCbRef.current = cb;
    },
    sendPermissionDecision: (
      sessionId: string,
      terminalId: string,
      requestId: string,
      decision: "allow" | "deny",
    ) => {
      const s = sessionsRef.current.get(sessionId);
      if (!s) return;
      const accepted = sendRaw(
        s,
        createEnvelope({
          type: "permission.decision",
          sessionId,
          terminalId,
          deviceId: s.deviceId,
          payload: { requestId, decision },
        }),
        { queue: true, dedupeKey: `permission:${requestId}` },
      );
      if (!accepted) return;
      // Clear topPermission from structuredStatus so buildState
      // doesn't re-add the permission to the Live Activity
      const term = s.terminals.get(terminalId);
      if (term?.structuredStatus) {
        const ss = term.structuredStatus;
        if (ss.topPermission?.requestId === requestId) {
          ss.topPermission = undefined;
          ss.pendingPermissionCount = Math.max(0, (ss.pendingPermissionCount ?? 1) - 1);
          if (ss.phase === "waiting") ss.phase = "thinking";
        }
        tick();
      }
    },
    deviceToken: deviceTokenRef.current,
    requestHistory: requestHistoryFn,
    historyEntries,
    initializeAgent: initializeAgentFn,
    sendAgentPrompt: sendAgentPromptFn,
    cancelAgent: cancelAgentFn,
    sendAgentPermissionResponse: sendAgentPermissionResponseFn,
  };
}
