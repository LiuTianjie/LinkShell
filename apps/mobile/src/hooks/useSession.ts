import { useCallback, useEffect, useRef, useState } from "react";
import {
  createEnvelope,
  parseEnvelope,
  parseTypedPayload,
  serializeEnvelope,
} from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";

export type ConnectionStatus =
  | "idle"
  | "claiming"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "session_exited"
  | "host_disconnected"
  | `error:${string}`;

const HEARTBEAT_INTERVAL = 15_000;
const RECONNECT_BASE_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 15_000;
const RECONNECT_MAX_ATTEMPTS = 15;

export interface UseSessionOptions {
  gatewayBaseUrl: string;
}

export interface SessionHandle {
  status: ConnectionStatus;
  sessionId: string;
  deviceId: string;
  controllerId: string | null;
  terminalLines: string[];
  lastAckedSeq: number;
  connectionDetail: string | null;
  screenStatus: { active: boolean; mode: "webrtc" | "fallback" | "off"; error?: string };
  screenFrame: { data: string; width: number; height: number; frameId: number } | null;
  claim: (pairingCode: string) => Promise<string | null>;
  connectToSession: (
    sessionId: string,
    gatewayBaseUrlOverride?: string,
  ) => void;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  claimControl: () => void;
  releaseControl: () => void;
  startScreen: (fps: number, quality: number, scale: number) => void;
  stopScreen: () => void;
  reconnect: () => void;
  disconnect: () => void;
}

function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function useSession({
  gatewayBaseUrl,
}: UseSessionOptions): SessionHandle {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [sessionId, setSessionId] = useState("");
  const [controllerId, setControllerId] = useState<string | null>(null);
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [lastAckedSeq, setLastAckedSeq] = useState(-1);
  const [connectionDetail, setConnectionDetail] = useState<string | null>(null);
  const [screenStatus, setScreenStatus] = useState<{ active: boolean; mode: "webrtc" | "fallback" | "off"; error?: string }>({ active: false, mode: "off" });
  const [screenFrame, setScreenFrame] = useState<{ data: string; width: number; height: number; frameId: number } | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const healthProbeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const deviceIdRef = useRef(generateId());
  const sessionIdRef = useRef("");
  const lastAckedSeqRef = useRef(-1);
  const chunkBufRef = useRef<{ frameId: number; chunks: Map<number, string>; total: number; width: number; height: number } | null>(null);
  const activeGatewayBaseUrlRef = useRef(gatewayBaseUrl);
  const statusRef = useRef<ConnectionStatus>("idle");
  const manualDisconnectRef = useRef(false);

  // Keep refs in sync
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    lastAckedSeqRef.current = lastAckedSeq;
  }, [lastAckedSeq]);
  useEffect(() => {
    activeGatewayBaseUrlRef.current = gatewayBaseUrl;
  }, [gatewayBaseUrl]);

  const wsUrl = useCallback((sid: string, gatewayOverride?: string) => {
    const base = (gatewayOverride ?? activeGatewayBaseUrlRef.current)
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:");
    return `${base}/ws?sessionId=${encodeURIComponent(sid)}&role=client&deviceId=${deviceIdRef.current}`;
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const sendRaw = useCallback((envelope: Envelope) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(serializeEnvelope(envelope));
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    heartbeatRef.current = setInterval(() => {
      sendRaw(
        createEnvelope({
          type: "session.heartbeat",
          sessionId: sessionIdRef.current,
          payload: { ts: Date.now() },
        }),
      );
    }, HEARTBEAT_INTERVAL);
  }, [sendRaw, stopHeartbeat]);

  const requestControl = useCallback(
    (sid: string) => {
      sendRaw(
        createEnvelope({
          type: "control.claim",
          sessionId: sid,
          payload: { deviceId: deviceIdRef.current },
        }),
      );
    },
    [sendRaw],
  );

  const connectSocket = useCallback(
    (sid: string, isReconnect = false, gatewayOverride?: string) => {
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      manualDisconnectRef.current = false;
      setStatus(isReconnect ? "reconnecting" : "connecting");
      const resolvedGateway =
        gatewayOverride ?? activeGatewayBaseUrlRef.current;
      activeGatewayBaseUrlRef.current = resolvedGateway;
      const ws = new WebSocket(wsUrl(sid, resolvedGateway));
      socketRef.current = ws;

      ws.onopen = () => {
        // Don't set "connected" yet — we only know the gateway accepted the WS.
        // Stay in connecting/reconnecting until we confirm the host is actually online.
        setConnectionDetail(null);
        reconnectAttempts.current = 0;
        startHeartbeat();
        requestControl(sid);
        // Health probe immediately to verify host status
        if (healthProbeRef.current) clearTimeout(healthProbeRef.current);
        (async () => {
          try {
            const res = await fetch(
              `${resolvedGateway}/sessions/${encodeURIComponent(sid)}`,
            );
            if (!res.ok) {
              // Can't verify — fallback to connected
              if (
                statusRef.current === "connecting" ||
                statusRef.current === "reconnecting"
              ) {
                setStatus("connected");
              }
              return;
            }
            const body = (await res.json()) as { hasHost?: boolean };
            if (body.hasHost === false) {
              if (
                statusRef.current === "connecting" ||
                statusRef.current === "reconnecting"
              ) {
                setStatus("host_disconnected" as ConnectionStatus);
                setConnectionDetail("Host is not connected to this session.");
              }
            } else {
              if (
                statusRef.current === "connecting" ||
                statusRef.current === "reconnecting"
              ) {
                setStatus("connected");
              }
            }
          } catch {
            // REST probe failed — fallback to connected
            if (
              statusRef.current === "connecting" ||
              statusRef.current === "reconnecting"
            ) {
              setStatus("connected");
            }
          }
        })();
        if (isReconnect) {
          sendRaw(
            createEnvelope({
              type: "session.resume",
              sessionId: sid,
              payload: { lastAckedSeq: lastAckedSeqRef.current },
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

        switch (envelope.type) {
          case "terminal.output": {
            // Receiving data means host is definitely alive
            if (
              statusRef.current === "connecting" ||
              statusRef.current === "reconnecting"
            ) {
              setStatus("connected");
              setConnectionDetail(null);
            }
            const p = parseTypedPayload("terminal.output", envelope.payload);
            setTerminalLines((prev) => [...prev, p.data]);
            if (envelope.seq !== undefined) {
              const newSeq = envelope.seq;
              setLastAckedSeq((prev) => {
                const next = Math.max(prev, newSeq);
                // Send ACK
                sendRaw(
                  createEnvelope({
                    type: "session.ack",
                    sessionId: sid,
                    payload: { seq: next },
                  }),
                );
                return next;
              });
            }
            break;
          }
          case "session.error": {
            const p = parseTypedPayload("session.error", envelope.payload);
            setConnectionDetail(p.message);
            if (p.code === "control_conflict") {
              break;
            }

            if (p.code === "session_terminated") {
              setStatus("session_exited");
              break;
            }

            setStatus(`error:${p.code}` as ConnectionStatus);
            break;
          }
          case "terminal.exit":
            setStatus("session_exited");
            setConnectionDetail("The shell process exited.");
            stopHeartbeat();
            break;
          case "control.grant": {
            const p = parseTypedPayload("control.grant", envelope.payload);
            setControllerId(p.deviceId);
            break;
          }
          case "control.reject":
            console.warn("[useSession] control.reject received (unexpected)");
            break;
          case "control.release": {
            const p = parseTypedPayload("control.release", envelope.payload);
            setControllerId((prev) => (prev === p.deviceId ? null : prev));
            break;
          }
          case "session.connect":
          case "session.heartbeat":
            break;
          case "session.host_disconnected":
            setStatus("host_disconnected" as ConnectionStatus);
            setConnectionDetail(
              "Host connection closed. Waiting for it to come back.",
            );
            break;
          case "session.host_reconnected":
            setStatus("connected");
            setConnectionDetail(null);
            break;
          case "screen.frame": {
            const p = parseTypedPayload("screen.frame", envelope.payload);
            // Reassemble chunks if needed
            if (p.chunkTotal <= 1) {
              setScreenFrame({ data: p.data, width: p.width, height: p.height, frameId: p.frameId });
            } else {
              // Simple chunk reassembly via ref
              if (!chunkBufRef.current || chunkBufRef.current.frameId !== p.frameId) {
                chunkBufRef.current = { frameId: p.frameId, chunks: new Map(), total: p.chunkTotal, width: p.width, height: p.height };
              }
              chunkBufRef.current.chunks.set(p.chunkIndex, p.data);
              if (chunkBufRef.current.chunks.size === chunkBufRef.current.total) {
                let fullData = "";
                for (let i = 0; i < chunkBufRef.current.total; i++) {
                  fullData += chunkBufRef.current.chunks.get(i) ?? "";
                }
                setScreenFrame({ data: fullData, width: chunkBufRef.current.width, height: chunkBufRef.current.height, frameId: p.frameId });
                chunkBufRef.current = null;
              }
            }
            break;
          }
          case "screen.status": {
            const p = parseTypedPayload("screen.status", envelope.payload);
            setScreenStatus({ active: p.active, mode: p.mode, error: p.error });
            break;
          }
          case "screen.offer":
          case "screen.ice":
            // WebRTC signaling — will be handled in Phase 2
            break;
          default:
            break;
        }
      };

      ws.onclose = () => {
        stopHeartbeat();
        if (socketRef.current === ws) {
          socketRef.current = null;
        }
        if (
          !manualDisconnectRef.current &&
          statusRef.current !== "session_exited"
        ) {
          setConnectionDetail("Gateway connection lost. Reconnecting...");
          scheduleReconnect(sid);
        }
      };

      ws.onerror = () => {
        // onclose will fire
      };
    },
    [wsUrl, startHeartbeat, stopHeartbeat, sendRaw, requestControl],
  );

  const scheduleReconnect = useCallback(
    (sid: string) => {
      if (reconnectAttempts.current >= RECONNECT_MAX_ATTEMPTS) {
        setConnectionDetail(
          "Gateway is unreachable. Retry when the server is back.",
        );
        setStatus("disconnected");
        return;
      }
      setStatus("reconnecting");
      const delay = Math.min(
        RECONNECT_BASE_DELAY * 2 ** reconnectAttempts.current,
        RECONNECT_MAX_DELAY,
      );
      reconnectAttempts.current++;
      reconnectRef.current = setTimeout(() => {
        connectSocket(sid, true, activeGatewayBaseUrlRef.current);
      }, delay);
    },
    [connectSocket],
  );

  const claim = useCallback(
    async (pairingCode: string) => {
      setStatus("claiming");
      const claimUrl = `${gatewayBaseUrl}/pairings/claim`;

      try {
        const res = await fetch(claimUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pairingCode }),
        });
        const body = (await res.json()) as {
          sessionId?: string;
          error?: string;
        };
        if (!res.ok || !body.sessionId) {
          const errMsg = body.error ?? "Claim failed";
          setConnectionDetail(errMsg);
          setStatus(
            ("error:" + (body.error ?? "claim_failed")) as ConnectionStatus,
          );
          return null;
        }
        manualDisconnectRef.current = false;
        setConnectionDetail(null);
        setSessionId(body.sessionId);
        setControllerId(null);
        setTerminalLines([]);
        setLastAckedSeq(-1);
        connectSocket(body.sessionId);
        return body.sessionId;
      } catch (error) {
        const name = error instanceof Error ? error.name : "Unknown";
        const message =
          error instanceof Error ? error.message : "Network request failed";
        console.warn(`[LinkShell] claim error [${name}]:`, message);
        setConnectionDetail(`${name}: ${message}`);
        setStatus("error:network");
        return null;
      }
    },
    [gatewayBaseUrl, connectSocket],
  );

  const connectToSession = useCallback(
    (sid: string, gatewayBaseUrlOverride?: string) => {
      manualDisconnectRef.current = false;
      setConnectionDetail(null);
      setSessionId(sid);
      setControllerId(null);
      setTerminalLines([]);
      setLastAckedSeq(-1);
      connectSocket(sid, false, gatewayBaseUrlOverride);
    },
    [connectSocket],
  );

  const sendInput = useCallback(
    (data: string) => {
      sendRaw(
        createEnvelope({
          type: "terminal.input",
          sessionId: sessionIdRef.current,
          deviceId: deviceIdRef.current,
          payload: { data },
        }),
      );
    },
    [sendRaw],
  );

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      sendRaw(
        createEnvelope({
          type: "terminal.resize",
          sessionId: sessionIdRef.current,
          deviceId: deviceIdRef.current,
          payload: { cols, rows },
        }),
      );
    },
    [sendRaw],
  );

  const claimControl = useCallback(() => {
    requestControl(sessionIdRef.current);
  }, [requestControl]);

  const releaseControl = useCallback(() => {
    sendRaw(
      createEnvelope({
        type: "control.release",
        sessionId: sessionIdRef.current,
        payload: { deviceId: deviceIdRef.current },
      }),
    );
  }, [sendRaw]);

  const startScreen = useCallback((fps: number, quality: number, scale: number) => {
    sendRaw(
      createEnvelope({
        type: "screen.start",
        sessionId: sessionIdRef.current,
        payload: { fps, quality, scale },
      }),
    );
  }, [sendRaw]);

  const stopScreen = useCallback(() => {
    sendRaw(
      createEnvelope({
        type: "screen.stop",
        sessionId: sessionIdRef.current,
        payload: {},
      }),
    );
    setScreenStatus({ active: false, mode: "off" });
  }, [sendRaw]);

  const reconnect = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) {
      return;
    }

    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }

    if (socketRef.current) {
      manualDisconnectRef.current = true;
      socketRef.current.close();
      socketRef.current = null;
    }

    manualDisconnectRef.current = false;
    connectSocket(sid, true, activeGatewayBaseUrlRef.current);
  }, [connectSocket]);

  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true;
    stopHeartbeat();
    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }
    if (healthProbeRef.current) {
      clearTimeout(healthProbeRef.current);
      healthProbeRef.current = null;
    }
    socketRef.current?.close();
    socketRef.current = null;
    reconnectAttempts.current = 0;
    setConnectionDetail(null);
    setSessionId("");
    setTerminalLines([]);
    setLastAckedSeq(-1);
    setControllerId(null);
    setStatus("disconnected");
  }, [stopHeartbeat]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopHeartbeat();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (healthProbeRef.current) clearTimeout(healthProbeRef.current);
      socketRef.current?.close();
    };
  }, [stopHeartbeat]);

  return {
    status,
    sessionId,
    deviceId: deviceIdRef.current,
    controllerId,
    terminalLines,
    lastAckedSeq,
    connectionDetail,
    screenStatus,
    screenFrame,
    claim,
    connectToSession,
    sendInput,
    sendResize,
    claimControl,
    releaseControl,
    startScreen,
    stopScreen,
    reconnect,
    disconnect,
  };
}
