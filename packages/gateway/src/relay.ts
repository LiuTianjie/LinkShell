import type WebSocket from "ws";
import {
  parseEnvelope,
  parseTypedPayload,
  protocolMessageSchemas,
  serializeEnvelope,
  createEnvelope,
} from "@linkshell/protocol";
import type { Envelope, ProtocolMessageType } from "@linkshell/protocol";
import { ZodError } from "zod";
import type { DeviceManager, ConnectedDevice } from "./sessions.js";
import {
  handleTunnelResponse,
  handleTunnelWsData,
  handleTunnelWsClose,
} from "./tunnel.js";
import { resolveAgentPermissionHttpAck } from "./agent-permission-http.js";

export function handleSocketMessage(
  socket: WebSocket,
  raw: string,
  role: "host" | "client",
  hostDeviceId: string,
  deviceId: string,
  sessions: DeviceManager,
): void {
  let envelope: Envelope;
  try {
    envelope = parseEnvelope(raw);
  } catch {
    sendSessionError(socket, hostDeviceId, "invalid_message", "Failed to parse envelope");
    return;
  }

  if (envelope.hostDeviceId !== hostDeviceId) {
    sendSessionError(
      socket,
      hostDeviceId,
      "invalid_message",
      "Envelope hostDeviceId does not match connection hostDeviceId",
    );
    return;
  }

  const session = sessions.get(hostDeviceId);
  if (!session) {
    sendSessionError(socket, hostDeviceId, "device_not_found", "Device not found");
    return;
  }

  try {
    if (isProtocolMessageType(envelope.type)) {
      envelope = {
        ...envelope,
        payload: parseTypedPayload(envelope.type, envelope.payload),
      };
    }

    if (role === "host") {
      handleHostMessage(envelope, session, sessions);
    } else {
      handleClientMessage(envelope, socket, session, deviceId, sessions);
    }
  } catch (error) {
    if (error instanceof ZodError) {
      sendSessionError(
        socket,
        hostDeviceId,
        "invalid_message",
        error.issues[0]?.message ?? "Invalid message payload",
      );
      return;
    }
    sendSessionError(socket, hostDeviceId, "invalid_message", "Failed to handle message");
  }
}

function isProtocolMessageType(type: string): type is ProtocolMessageType {
  return Object.prototype.hasOwnProperty.call(protocolMessageSchemas, type);
}

function sendSessionError(
  socket: WebSocket,
  hostDeviceId: string,
  code: string,
  message: string,
): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(
    serializeEnvelope(
      createEnvelope({
        type: "device.error",
        hostDeviceId,
        payload: { code, message },
      }),
    ),
  );
}

function handleHostMessage(
  envelope: Envelope,
  session: ReturnType<DeviceManager["get"]> & {},
  sessions: DeviceManager,
): void {
  switch (envelope.type) {
    case "device.connect": {
      // Extract metadata from host's connect message
      const p = parseTypedPayload("device.connect", envelope.payload);
      if (p.machineId || p.hostname || p.platform || p.cwd || p.capabilities) {
        sessions.setMetadata(
          session.id,
          undefined,
          p.machineId ?? undefined,
          p.hostname ?? undefined,
          p.platform ?? undefined,
          p.cwd ?? undefined,
          undefined,
          p.capabilities ?? undefined,
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
    case "device.heartbeat":
      break;
    case "permission.decision.result": {
      const p = parseTypedPayload("permission.decision.result", envelope.payload);
      resolveAgentPermissionHttpAck({
        hostDeviceId: session.id,
        ack: {
          requestId: p.requestId,
          decision: p.decision,
          resolved: p.resolved,
          delivered: p.delivered,
          source: p.source,
          message: p.message,
        },
      });
      broadcastToClients(session, envelope);
      break;
    }
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
    // Agent Workspace: host → clients
    case "agent.v2.capabilities":
    case "agent.v2.conversation.opened":
    case "agent.v2.conversation.list.result":
    case "agent.v2.event":
    case "agent.v2.snapshot":
    case "agent.v2.permission.request":
    // Multi-terminal: host → clients
    case "terminal.spawned":
    case "terminal.list":
    case "terminal.browse.result":
    case "terminal.file.read.result":
      broadcastToClients(session, envelope);
      break;
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
  session: ReturnType<DeviceManager["get"]> & {},
  deviceId: string,
  sessions: DeviceManager,
): void {
  const requireController = (): boolean => {
    if (session.controllerId === deviceId) return true;
    socket.send(
      serializeEnvelope(
        createEnvelope({
          type: "device.error",
          hostDeviceId: session.id,
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
    case "device.ack": {
      // Forward ACK to host
      sendToHost(session, envelope);
      break;
    }
    case "device.resume": {
      const p = parseTypedPayload("device.resume", envelope.payload);
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
              hostDeviceId: session.id,
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
      // Also forward resume to host so it can fill gaps beyond gateway buffer.
      sendToHost(session, session.machineId
        ? {
            ...envelope,
            payload: {
              ...(envelope.payload as Record<string, unknown>),
              machineId: session.machineId,
            },
          }
        : envelope);
      break;
    }
    case "control.claim": {
      sessions.claimControl(session.id, deviceId);
      const grantMsg = createEnvelope({
        type: "control.grant",
        hostDeviceId: session.id,
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
        hostDeviceId: session.id,
        payload: { deviceId },
      });
      broadcastToClients(session, releaseMsg);
      sendToHost(session, releaseMsg);
      break;
    }
    case "device.heartbeat":
      break;
    // Screen sharing: client → host
    case "screen.start":
    case "screen.stop":
    case "screen.answer":
    case "screen.ice":
    case "agent.v2.conversation.open":
    case "agent.v2.prompt":
    case "agent.v2.command.execute":
    case "agent.v2.cancel":
    case "agent.v2.permission.respond":
    case "agent.v2.structured_input.respond":
    // Multi-terminal: client → host
    case "terminal.spawn":
    case "terminal.kill":
    case "terminal.list":
    case "terminal.browse":
    case "terminal.file.read":
    case "terminal.mkdir":
    case "terminal.history.request":
    case "file.upload":
    case "permission.decision":
      if (!requireController()) return;
      sendToHost(session, envelope);
      break;
    case "agent.v2.capabilities.request":
    case "agent.v2.conversation.list":
    case "agent.v2.snapshot.request":
      sendToHost(session, envelope);
      break;
    default:
      sendToHost(session, envelope);
      break;
  }
}

function broadcastToClients(
  session: ReturnType<DeviceManager["get"]> & {},
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
  session: ReturnType<DeviceManager["get"]> & {},
  envelope: Envelope,
): void {
  if (
    session.host &&
    session.host.socket.readyState === session.host.socket.OPEN
  ) {
    session.host.socket.send(serializeEnvelope(envelope));
  }
}
