import { useCallback, useEffect, useRef, useState } from "react";
import {
  createEnvelope,
  parseEnvelope,
  parseTypedPayload,
  serializeEnvelope,
} from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";
import { getDeviceToken, setDeviceToken } from "../storage/device-token";

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
const HEALTH_PROBE_INTERVAL = 30_000;

export interface UseSessionOptions {
  gatewayBaseUrl: string;
}

export interface TerminalStreamSnapshot {
  sessionId: string;
  chunks: string[];
}

export interface TerminalStreamEventReset {
  type: "reset";
  snapshot: TerminalStreamSnapshot;
}

export interface TerminalStreamEventAppend {
  type: "append";
  sessionId: string;
  chunk: string;
}

export type TerminalStreamEvent =
  | TerminalStreamEventReset
  | TerminalStreamEventAppend;

export interface TerminalStream {
  getSnapshot: () => TerminalStreamSnapshot;
  subscribe: (listener: (event: TerminalStreamEvent) => void) => () => void;
}

const TERMINAL_REPLAY_LIMIT = 100;

export interface SessionHandle {
  status: ConnectionStatus;
  sessionId: string;
  deviceId: string;
  controllerId: string | null;
  terminalStream: TerminalStream;
  connectionDetail: string | null;
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
  claim: (pairingCode: string) => Promise<string | null>;
  connectToSession: (
    sessionId: string,
    gatewayBaseUrlOverride?: string,
  ) => void;
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
  disconnect: () => void;
  requestHistory: (count?: number) => void;
  historyEntries: string[];
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
  const [connectionDetail, setConnectionDetail] = useState<string | null>(null);
  const [screenStatus, setScreenStatus] = useState<{
    active: boolean;
    mode: "webrtc" | "fallback" | "off";
    error?: string;
  }>({ active: false, mode: "off" });
  const [screenFrame, setScreenFrame] = useState<{
    data: string;
    width: number;
    height: number;
    frameId: number;
  } | null>(null);
  const [pendingOffer, setPendingOffer] = useState<{ sdp: string } | null>(
    null,
  );
  const [pendingIceCandidates, setPendingIceCandidates] = useState<
    {
      candidate: string;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
    }[]
  >([]);
  const [historyEntries, setHistoryEntries] = useState<string[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const healthProbeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const deviceIdRef = useRef(generateId());
  const deviceTokenRef = useRef<string | null>(null);
  const sessionIdRef = useRef("");

  useEffect(() => {
    getDeviceToken().then((t) => {
      deviceTokenRef.current = t;
    });
  }, []);
  const lastAckedSeqRef = useRef(-1);
  const terminalSnapshotRef = useRef<TerminalStreamSnapshot>({
    sessionId: "",
    chunks: [],
  });
  const terminalListenersRef = useRef(
    new Set<(event: TerminalStreamEvent) => void>(),
  );
  const terminalStreamRef = useRef<TerminalStream>({
    getSnapshot: () => ({
      sessionId: terminalSnapshotRef.current.sessionId,
      chunks: [...terminalSnapshotRef.current.chunks],
    }),
    subscribe: (listener) => {
      terminalListenersRef.current.add(listener);
      return () => {
        terminalListenersRef.current.delete(listener);
      };
    },
  });
  const chunkBufRef = useRef<{
    frameId: number;
    chunks: Map<number, string>;
    total: number;
    width: number;
    height: number;
  } | null>(null);
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
    activeGatewayBaseUrlRef.current = gatewayBaseUrl;
  }, [gatewayBaseUrl]);

  const emitTerminalEvent = useCallback((event: TerminalStreamEvent) => {
    for (const listener of terminalListenersRef.current) {
      listener(event);
    }
  }, []);

  const resetTerminalStream = useCallback(
    (nextSessionId: string) => {
      terminalSnapshotRef.current = {
        sessionId: nextSessionId,
        chunks: [],
      };
      emitTerminalEvent({
        type: "reset",
        snapshot: {
          sessionId: nextSessionId,
          chunks: [],
        },
      });
    },
    [emitTerminalEvent],
  );

  const appendTerminalChunk = useCallback(
    (chunk: string) => {
      const snapshot = terminalSnapshotRef.current;
      snapshot.chunks.push(chunk);
      if (snapshot.chunks.length > TERMINAL_REPLAY_LIMIT) {
        snapshot.chunks.splice(
          0,
          snapshot.chunks.length - TERMINAL_REPLAY_LIMIT,
        );
      }
      emitTerminalEvent({
        type: "append",
        sessionId: snapshot.sessionId,
        chunk,
      });
    },
    [emitTerminalEvent],
  );

  const wsUrl = useCallback((sid: string, gatewayOverride?: string) => {
    const base = (gatewayOverride ?? activeGatewayBaseUrlRef.current)
      .replace(/^https:/, "wss:")
      .replace(/^http:/, "ws:");
    const tokenParam = deviceTokenRef.current
      ? `&token=${encodeURIComponent(deviceTokenRef.current)}`
      : "";
    return `${base}/ws?sessionId=${encodeURIComponent(sid)}&role=client&deviceId=${deviceIdRef.current}${tokenParam}`;
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
            const headers: Record<string, string> = {};
            const token = await getDeviceToken();
            if (token) headers["Authorization"] = `Bearer ${token}`;
            const res = await fetch(
              `${resolvedGateway}/sessions/${encodeURIComponent(sid)}`,
              { headers },
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
            appendTerminalChunk(p.data);
            if (envelope.seq !== undefined) {
              const next = Math.max(lastAckedSeqRef.current, envelope.seq);
              if (next !== lastAckedSeqRef.current) {
                lastAckedSeqRef.current = next;
                sendRaw(
                  createEnvelope({
                    type: "session.ack",
                    sessionId: sid,
                    payload: { seq: next },
                  }),
                );
              }
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
              setScreenFrame({
                data: p.data,
                width: p.width,
                height: p.height,
                frameId: p.frameId,
              });
            } else {
              // Simple chunk reassembly via ref
              if (
                !chunkBufRef.current ||
                chunkBufRef.current.frameId !== p.frameId
              ) {
                chunkBufRef.current = {
                  frameId: p.frameId,
                  chunks: new Map(),
                  total: p.chunkTotal,
                  width: p.width,
                  height: p.height,
                };
              }
              chunkBufRef.current.chunks.set(p.chunkIndex, p.data);
              if (
                chunkBufRef.current.chunks.size === chunkBufRef.current.total
              ) {
                let fullData = "";
                for (let i = 0; i < chunkBufRef.current.total; i++) {
                  fullData += chunkBufRef.current.chunks.get(i) ?? "";
                }
                setScreenFrame({
                  data: fullData,
                  width: chunkBufRef.current.width,
                  height: chunkBufRef.current.height,
                  frameId: p.frameId,
                });
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
          case "screen.offer": {
            const p = parseTypedPayload("screen.offer", envelope.payload);
            setPendingOffer({ sdp: p.sdp });
            break;
          }
          case "screen.ice": {
            const p = parseTypedPayload("screen.ice", envelope.payload);
            setPendingIceCandidates((prev) => [
              ...prev,
              {
                candidate: p.candidate,
                sdpMid: p.sdpMid,
                sdpMLineIndex: p.sdpMLineIndex,
              },
            ]);
            break;
          }
          case "terminal.history.response": {
            const p = parseTypedPayload("terminal.history.response", envelope.payload);
            setHistoryEntries(p.entries);
            break;
          }
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

  const startHealthProbe = useCallback(
    (sid: string) => {
      if (healthProbeRef.current) clearTimeout(healthProbeRef.current);
      const probe = async () => {
        try {
          const base = activeGatewayBaseUrlRef.current;
          const res = await fetch(`${base}/healthz`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (res.ok) {
            // Gateway is back — reconnect automatically
            reconnectAttempts.current = 0;
            healthProbeRef.current = null;
            connectSocket(sid, true, activeGatewayBaseUrlRef.current);
            return;
          }
        } catch {
          // Still unreachable
        }
        // Schedule next probe
        healthProbeRef.current = setTimeout(probe, HEALTH_PROBE_INTERVAL);
      };
      healthProbeRef.current = setTimeout(probe, HEALTH_PROBE_INTERVAL);
    },
    [connectSocket],
  );

  const scheduleReconnect = useCallback(
    (sid: string) => {
      if (reconnectAttempts.current >= RECONNECT_MAX_ATTEMPTS) {
        setConnectionDetail(
          "Gateway is unreachable. Will auto-retry when the server is back.",
        );
        setStatus("disconnected");
        startHealthProbe(sid);
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
    [connectSocket, startHealthProbe],
  );

  const claim = useCallback(
    async (pairingCode: string) => {
      setStatus("claiming");
      const claimUrl = `${gatewayBaseUrl}/pairings/claim`;

      try {
        const currentToken = deviceTokenRef.current ?? (await getDeviceToken());
        const res = await fetch(claimUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pairingCode,
            deviceToken: currentToken ?? undefined,
          }),
        });
        const body = (await res.json()) as {
          sessionId?: string;
          deviceToken?: string;
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
        if (body.deviceToken) {
          deviceTokenRef.current = body.deviceToken;
          setDeviceToken(body.deviceToken);
        }
        manualDisconnectRef.current = false;
        setConnectionDetail(null);
        setSessionId(body.sessionId);
        setControllerId(null);
        lastAckedSeqRef.current = -1;
        resetTerminalStream(body.sessionId);
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
      lastAckedSeqRef.current = -1;
      resetTerminalStream(sid);
      connectSocket(sid, false, gatewayBaseUrlOverride);
    },
    [connectSocket, resetTerminalStream],
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

  const startScreen = useCallback(
    (fps: number, quality: number, scale: number) => {
      sendRaw(
        createEnvelope({
          type: "screen.start",
          sessionId: sessionIdRef.current,
          payload: { fps, quality, scale },
        }),
      );
    },
    [sendRaw],
  );

  const stopScreen = useCallback(() => {
    sendRaw(
      createEnvelope({
        type: "screen.stop",
        sessionId: sessionIdRef.current,
        payload: {},
      }),
    );
    setScreenStatus({ active: false, mode: "off" });
    setPendingOffer(null);
    setPendingIceCandidates([]);
  }, [sendRaw]);

  const sendScreenSignal = useCallback(
    (type: "screen.answer" | "screen.ice", payload: any) => {
      sendRaw(
        createEnvelope({
          type,
          sessionId: sessionIdRef.current,
          payload,
        }),
      );
    },
    [sendRaw],
  );

  const sendImage = useCallback(
    (base64Data: string, filename: string) => {
      sendRaw(
        createEnvelope({
          type: "file.upload",
          sessionId: sessionIdRef.current,
          deviceId: deviceIdRef.current,
          payload: { data: base64Data, filename },
        }),
      );
    },
    [sendRaw],
  );

  const requestHistory = useCallback(
    (count = 100) => {
      sendRaw(
        createEnvelope({
          type: "terminal.history.request",
          sessionId: sessionIdRef.current,
          payload: { count },
        }),
      );
    },
    [sendRaw],
  );

  const reconnect = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) {
      return;
    }

    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }

    if (healthProbeRef.current) {
      clearTimeout(healthProbeRef.current);
      healthProbeRef.current = null;
    }

    if (socketRef.current) {
      manualDisconnectRef.current = true;
      socketRef.current.close();
      socketRef.current = null;
    }

    reconnectAttempts.current = 0;
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
    lastAckedSeqRef.current = -1;
    resetTerminalStream("");
    setControllerId(null);
    setStatus("disconnected");
  }, [resetTerminalStream, stopHeartbeat]);

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
    terminalStream: terminalStreamRef.current,
    connectionDetail,
    screenStatus,
    screenFrame,
    pendingOffer,
    pendingIceCandidates,
    claim,
    connectToSession,
    sendInput,
    sendImage,
    sendResize,
    claimControl,
    releaseControl,
    startScreen,
    stopScreen,
    sendScreenSignal,
    reconnect,
    disconnect,
    requestHistory,
    historyEntries,
  };
}
