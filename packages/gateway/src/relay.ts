import type WebSocket from "ws";
import {
  parseEnvelope,
  parseTypedPayload,
  serializeEnvelope,
  createEnvelope,
} from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";
import type { SessionManager, ConnectedDevice } from "./sessions.js";
import {
  handleTunnelResponse,
  handleTunnelWsData,
  handleTunnelWsClose,
} from "./tunnel.js";

export function handleSocketMessage(
  socket: WebSocket,
  raw: string,
  role: "host" | "client",
  sessionId: string,
  deviceId: string,
  sessions: SessionManager,
): void {
  let envelope: Envelope;
  try {
    envelope = parseEnvelope(raw);
  } catch {
    socket.send(
      serializeEnvelope(
        createEnvelope({
          type: "session.error",
          sessionId,
          payload: {
            code: "invalid_message",
            message: "Failed to parse envelope",
          },
        }),
      ),
    );
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    socket.send(
      serializeEnvelope(
        createEnvelope({
          type: "session.error",
          sessionId,
          payload: { code: "session_not_found", message: "Session not found" },
        }),
      ),
    );
    return;
  }

  if (role === "host") {
    handleHostMessage(envelope, session, sessions);
  } else {
    handleClientMessage(envelope, socket, session, deviceId, sessions);
  }
}

function handleHostMessage(
  envelope: Envelope,
  session: ReturnType<SessionManager["get"]> & {},
  sessions: SessionManager,
): void {
  switch (envelope.type) {
    case "session.connect": {
      // Extract metadata from host's connect message
      const p = parseTypedPayload("session.connect", envelope.payload);
      if (p.provider || p.hostname || p.platform || p.cwd || p.projectName) {
        sessions.setMetadata(
          session.id,
          p.provider ?? undefined,
          p.hostname ?? undefined,
          p.platform ?? undefined,
          p.cwd ?? undefined,
          p.projectName ?? undefined,
        );
      }
      break;
    }
    case "terminal.output": {
      sessions.bufferOutput(session.id, envelope);
      broadcastToClients(session, envelope);
      break;
    }
    case "terminal.exit": {
      // Don't terminate session — other terminals may still be running
      broadcastToClients(session, envelope);
      break;
    }
    case "session.heartbeat":
      break;
    // Tunnel: host → gateway (not broadcast to clients)
    case "tunnel.response": {
      const p = parseTypedPayload("tunnel.response", envelope.payload);
      handleTunnelResponse(p);
      return;
    }
    case "tunnel.ws.data": {
      const p = parseTypedPayload("tunnel.ws.data", envelope.payload);
      handleTunnelWsData(p);
      return;
    }
    case "tunnel.ws.close": {
      const p = parseTypedPayload("tunnel.ws.close", envelope.payload);
      handleTunnelWsClose(p);
      return;
    }
    case "control.grant":
    case "control.reject":
      broadcastToClients(session, envelope);
      break;
    // Screen sharing: host → clients
    case "screen.frame":
    case "screen.status":
    case "screen.offer":
    case "screen.ice":
    // Agent GUI: host → clients
    case "agent.capabilities":
    case "agent.update":
    case "agent.permission.request":
    case "agent.snapshot":
    // Multi-terminal: host → clients
    case "terminal.spawned":
    case "terminal.list":
    case "terminal.browse.result":
    // Structured status from hooks
    case "terminal.status":
      sessions.cacheStatus(session.id, envelope);
      broadcastToClients(session, envelope);
      break;
    default:
      broadcastToClients(session, envelope);
      break;
  }
}

function handleClientMessage(
  envelope: Envelope,
  socket: WebSocket,
  session: ReturnType<SessionManager["get"]> & {},
  deviceId: string,
  sessions: SessionManager,
): void {
  const requireController = (): boolean => {
    if (session.controllerId === deviceId) return true;
    socket.send(
      serializeEnvelope(
        createEnvelope({
          type: "session.error",
          sessionId: session.id,
          payload: {
            code: "control_conflict",
            message: "Not the controller",
          },
        }),
      ),
    );
    return false;
  };

  switch (envelope.type) {
    case "terminal.input": {
      if (!requireController()) return;
      sendToHost(session, envelope);
      break;
    }
    case "terminal.resize": {
      if (!requireController()) return;
      sendToHost(session, envelope);
      break;
    }
    case "session.ack": {
      // Forward ACK to host
      sendToHost(session, envelope);
      break;
    }
    case "session.resume": {
      const p = parseTypedPayload("session.resume", envelope.payload);
      // Replay from gateway buffer first
      const replay = sessions.getReplayFrom(
        session.id,
        p.lastAckedSeqByTerminal,
        p.lastAckedSeq,
      );
      for (const msg of replay) {
        const payload = msg.payload as Record<string, unknown>;
        socket.send(
          serializeEnvelope(
            createEnvelope({
              type: "terminal.output",
              sessionId: session.id,
              terminalId: msg.terminalId,
              seq: msg.seq,
              payload: { ...payload, isReplay: true },
            }),
          ),
        );
      }
      // Replay last terminal.status for each terminal
      const statusReplay = sessions.getStatusReplay(session.id);
      for (const statusMsg of statusReplay) {
        socket.send(serializeEnvelope(statusMsg));
      }
      // Also forward resume to host so it can fill gaps beyond gateway buffer
      sendToHost(session, envelope);
      break;
    }
    case "control.claim": {
      sessions.claimControl(session.id, deviceId);
      const grantMsg = createEnvelope({
        type: "control.grant",
        sessionId: session.id,
        payload: { deviceId },
      });
      // Broadcast to ALL clients so previous controller updates its state
      broadcastToClients(session, grantMsg);
      sendToHost(session, grantMsg);
      break;
    }
    case "control.release": {
      sessions.releaseControl(session.id, deviceId);
      const releaseMsg = createEnvelope({
        type: "control.release",
        sessionId: session.id,
        payload: { deviceId },
      });
      broadcastToClients(session, releaseMsg);
      sendToHost(session, releaseMsg);
      break;
    }
    case "session.heartbeat":
      break;
    // Screen sharing: client → host
    case "screen.start":
    case "screen.stop":
    case "screen.answer":
    case "screen.ice":
    case "agent.session.new":
    case "agent.session.load":
    case "agent.prompt":
    case "agent.cancel":
    case "agent.permission.response":
    // Multi-terminal: client → host
    case "terminal.spawn":
    case "terminal.kill":
    case "terminal.list":
    case "terminal.browse":
    case "terminal.mkdir":
    case "terminal.history.request":
    case "file.upload":
    case "permission.decision":
      if (!requireController()) return;
      sendToHost(session, envelope);
      break;
    case "agent.initialize":
    case "agent.session.list":
      sendToHost(session, envelope);
      break;
    default:
      sendToHost(session, envelope);
      break;
  }
}

function broadcastToClients(
  session: ReturnType<SessionManager["get"]> & {},
  envelope: Envelope,
): void {
  const data = serializeEnvelope(envelope);
  for (const [, client] of session.clients) {
    if (client.socket.readyState === client.socket.OPEN) {
      client.socket.send(data);
    }
  }
}

function sendToHost(
  session: ReturnType<SessionManager["get"]> & {},
  envelope: Envelope,
): void {
  if (
    session.host &&
    session.host.socket.readyState === session.host.socket.OPEN
  ) {
    session.host.socket.send(serializeEnvelope(envelope));
  }
}
