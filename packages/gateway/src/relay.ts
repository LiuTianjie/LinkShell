import type WebSocket from "ws";
import {
  agentV2MessageRoute,
  isProtocolVersionCompatible,
  parseEnvelope,
  parseTypedPayload,
  protocolMessageSchemas,
  serializeEnvelope,
  createEnvelope,
} from "@linkshell/protocol";
import type { Envelope, ProtocolMessageType } from "@linkshell/protocol";
import { ZodError } from "zod";
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
    sendSessionError(socket, sessionId, "invalid_message", "Failed to parse envelope");
    return;
  }

  if (envelope.sessionId !== sessionId) {
    sendSessionError(
      socket,
      sessionId,
      "invalid_message",
      "Envelope sessionId does not match connection sessionId",
    );
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendSessionError(socket, sessionId, "session_not_found", "Session not found");
    return;
  }

  try {
    if (shouldValidatePayloadAtGateway(envelope.type)) {
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
        sessionId,
        "invalid_message",
        error.errors[0]?.message ?? "Invalid message payload",
      );
      return;
    }
    sendSessionError(socket, sessionId, "invalid_message", "Failed to handle message");
  }
}

function isProtocolMessageType(type: string): type is ProtocolMessageType {
  return Object.prototype.hasOwnProperty.call(protocolMessageSchemas, type);
}

function shouldValidatePayloadAtGateway(type: string): type is ProtocolMessageType {
  if (agentV2MessageRoute(type) !== null) return false;
  return isProtocolMessageType(type);
}

function sendSessionError(
  socket: WebSocket,
  sessionId: string,
  code: string,
  message: string,
): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(
    serializeEnvelope(
      createEnvelope({
        type: "session.error",
        sessionId,
        payload: { code, message },
      }),
    ),
  );
}

type AgentConversationLike = {
  id: string;
  status?: string;
  provider?: string;
  title?: string;
  lastMessagePreview?: string;
  lastActivityAt?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    totalTokens?: number;
    contextWindow?: number;
    totalCostUsd?: number;
  };
};

function truncateDetail(text: string, max = 72): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function commandOrPathFromToolInput(toolInput?: string): { command?: string; path?: string } {
  if (!toolInput) return {};
  try {
    const parsed = JSON.parse(toolInput) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      return {
        command: typeof parsed.command === "string" ? parsed.command : undefined,
        path: typeof parsed.path === "string"
          ? parsed.path
          : typeof parsed.file_path === "string"
            ? parsed.file_path
            : undefined,
      };
    }
  } catch {
    const match = toolInput.match(/\$\s+([^\n]+)/);
    if (match?.[1]) return { command: match[1].trim() };
  }
  return {};
}

/** List-line for a live permission request: "运行命令 · pnpm test". */
function permissionAttentionDetail(p: {
  toolName?: string;
  toolInput?: string;
  context?: string;
}): string | undefined {
  const { command, path } = commandOrPathFromToolInput(p.toolInput);
  const name = (p.toolName ?? "").toLowerCase();
  if (command) {
    return truncateDetail(
      /bash|shell|command/.test(name) || !p.toolName
        ? `运行命令 · ${command}`
        : `${p.toolName} · ${command}`,
    );
  }
  if (path) {
    const leaf = path.split("/").filter(Boolean).pop() ?? path;
    if (/write|edit|multiedit/.test(name)) return truncateDetail(`改文件 · ${leaf}`);
    if (/(^|_)read(_|$)|readfile/.test(name)) return truncateDetail(`读取 · ${leaf}`);
    return truncateDetail(`${p.toolName || "文件"} · ${leaf}`);
  }
  if (p.context?.trim()) return truncateDetail(p.context.trim());
  if (p.toolName) return truncateDetail(`需要授权 · ${p.toolName}`);
  return undefined;
}

function conversationAttentionDetail(
  conversation: AgentConversationLike | undefined,
  status: string | undefined,
  current?: { agentStatus?: string; agentDetail?: string },
): string | null | undefined {
  if (status === "waiting_permission") {
    if (current?.agentStatus === "waiting_permission" && current.agentDetail) return undefined;
    return conversation?.lastMessagePreview;
  }
  if (status === "running" || status === "error") {
    return conversation?.lastMessagePreview ?? null;
  }
  return status ? null : undefined;
}

function pickConversationSummary(
  conversations: AgentConversationLike[],
  activeConversationId?: string,
): AgentConversationLike | undefined {
  const active = conversations.find((c) => c.id === activeConversationId);
  if (active) return active;
  const waiting = conversations.find((c) => c.status === "waiting_permission");
  if (waiting) return waiting;
  const running = conversations.find((c) => c.status === "running");
  if (running) return running;
  return [...conversations].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
}

function aggregateAgentStatus(conversations: AgentConversationLike[], fallback?: string): string | undefined {
  if (conversations.some((c) => c.status === "waiting_permission")) return "waiting_permission";
  if (conversations.some((c) => c.status === "running")) return "running";
  return fallback;
}

function agentStatusFromTerminalPhase(phase: string): string | undefined {
  switch (phase) {
    case "thinking":
    case "tool_use":
    case "outputting":
      return "running";
    case "waiting":
      return "waiting_permission";
    case "idle":
      return "idle";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

function terminalStatusTitle(payload: { phase: string; toolName?: string; summary?: string }): string {
  if (payload.toolName) return `外部终端 · ${payload.toolName}`;
  if (payload.summary) return `外部终端 · ${payload.summary}`;
  return "外部终端";
}

function shouldPromoteTerminalStatus(status: string, current?: string): boolean {
  if (status !== "idle") return true;
  return current !== "running" && current !== "waiting_permission";
}

function cacheAgentEnvelope(envelope: Envelope, sessions: SessionManager): void {
  try {
    if (envelope.type === "agent.v2.conversation.list.result") {
      const p = parseTypedPayload("agent.v2.conversation.list.result", envelope.payload);
      const picked = pickConversationSummary(p.conversations);
      const status = aggregateAgentStatus(p.conversations, picked?.status ?? "idle");
      sessions.cacheAgentSummary(envelope.sessionId, {
        status,
        provider: picked?.provider,
        conversationId: picked?.id,
        title: picked?.title,
        detail: conversationAttentionDetail(picked, status, sessions.get(envelope.sessionId)),
        lastActivity: picked?.lastActivityAt ?? Date.now(),
        usage: picked?.usage ?? null,
      });
      return;
    }
    if (envelope.type === "agent.v2.conversation.opened") {
      const p = parseTypedPayload("agent.v2.conversation.opened", envelope.payload);
      const conversation = p.conversation;
      sessions.cacheAgentSummary(envelope.sessionId, {
        status: conversation.status,
        provider: conversation.provider,
        conversationId: conversation.id,
        title: conversation.title,
        detail: conversationAttentionDetail(conversation, conversation.status, sessions.get(envelope.sessionId)),
        lastActivity: conversation.lastActivityAt ?? Date.now(),
        usage: conversation.usage ?? null,
      });
      return;
    }
    if (envelope.type === "agent.v2.snapshot") {
      const p = parseTypedPayload("agent.v2.snapshot", envelope.payload);
      const picked = pickConversationSummary(p.conversations, p.activeConversationId);
      const status = aggregateAgentStatus(p.conversations, picked?.status ?? "idle");
      sessions.cacheAgentSummary(envelope.sessionId, {
        status,
        provider: picked?.provider,
        conversationId: picked?.id ?? p.activeConversationId,
        title: picked?.title,
        detail: conversationAttentionDetail(picked, status, sessions.get(envelope.sessionId)),
        lastActivity: picked?.lastActivityAt ?? Date.now(),
        usage: picked?.usage ?? null,
      });
      return;
    }
    if (envelope.type === "agent.v2.event") {
      const p = parseTypedPayload("agent.v2.event", envelope.payload);
      const current = sessions.get(envelope.sessionId);
      if (p.conversation) {
        sessions.cacheAgentSummary(envelope.sessionId, {
          status: p.conversation.status,
          provider: p.conversation.provider,
          conversationId: p.conversation.id,
          title: p.conversation.title,
          detail: conversationAttentionDetail(p.conversation, p.conversation.status, current),
          lastActivity: p.conversation.lastActivityAt,
          usage: p.conversation.usage ?? null,
        });
      } else if (p.patch?.status) {
        sessions.cacheAgentSummary(envelope.sessionId, {
          status: p.patch.status,
          conversationId: p.conversationId,
          detail: conversationAttentionDetail(undefined, p.patch.status, current),
          lastActivity: Date.now(),
        });
      }
      return;
    }
    if (envelope.type === "agent.v2.permission.request") {
      const p = parseTypedPayload("agent.v2.permission.request", envelope.payload);
      sessions.cacheAgentSummary(envelope.sessionId, {
        status: "waiting_permission",
        conversationId: p.conversationId,
        detail: permissionAttentionDetail(p),
        lastActivity: Date.now(),
      });
      return;
    }
    if (envelope.type === "agent.snapshot") {
      const p = parseTypedPayload("agent.snapshot", envelope.payload);
      sessions.cacheAgentSummary(envelope.sessionId, {
        status: p.status,
        conversationId: p.agentSessionId,
        lastActivity: Date.now(),
      });
      return;
    }
    if (envelope.type === "agent.update") {
      const p = parseTypedPayload("agent.update", envelope.payload);
      if (p.status) {
        sessions.cacheAgentSummary(envelope.sessionId, {
          status: p.status,
          conversationId: p.agentSessionId,
          lastActivity: Date.now(),
        });
      }
      return;
    }
    if (envelope.type === "agent.permission.request") {
      const p = parseTypedPayload("agent.permission.request", envelope.payload);
      sessions.cacheAgentSummary(envelope.sessionId, {
        status: "waiting_permission",
        conversationId: p.agentSessionId,
        detail: permissionAttentionDetail(p),
        lastActivity: Date.now(),
      });
      return;
    }
    if (envelope.type === "terminal.status") {
      const p = parseTypedPayload("terminal.status", envelope.payload);
      const status = agentStatusFromTerminalPhase(p.phase);
      const currentStatus = sessions.get(envelope.sessionId)?.agentStatus;
      if (status && shouldPromoteTerminalStatus(status, currentStatus)) {
        sessions.cacheAgentSummary(envelope.sessionId, {
          status,
          provider: p.provider ?? null,
          conversationId: null,
          title: terminalStatusTitle(p),
          lastActivity: Date.now(),
        });
      }
      return;
    }
    if (envelope.type === "agent.v2.usage.report") {
      // Cache the full usage report on the session so the session-list page
      // (HTTP /sessions) can show summary cards without a WebSocket connection.
      const session = sessions.get(envelope.sessionId);
      if (session) session.agentUsageReport = envelope.payload;
      return;
    }
  } catch {
    // Agent summaries are best-effort; never block relay on a status parse.
  }
}

function handleHostMessage(
  envelope: Envelope,
  session: ReturnType<SessionManager["get"]> & {},
  sessions: SessionManager,
): void {
  if (agentV2MessageRoute(envelope.type) === "host_to_client") {
    cacheAgentEnvelope(envelope, sessions);
    sessions.bufferAgentEnvelope(session.id, envelope);
    broadcastToClients(session, envelope);
    return;
  }

  switch (envelope.type) {
    case "session.connect": {
      // Extract metadata from host's connect message
      const p = parseTypedPayload("session.connect", envelope.payload);
      // Non-breaking version negotiation: warn (never disconnect) when a host
      // advertises an incompatible protocol version. CLI and app update
      // independently, so an out-of-date peer must keep working in degraded
      // mode rather than being rejected.
      if (!isProtocolVersionCompatible(p.protocolVersion)) {
        process.stderr.write(
          `[gateway] host on session ${session.id} advertises protocol v${p.protocolVersion}, ` +
          `which is older than the minimum compatible version — continuing in degraded mode\n`,
        );
      }
      if (p.provider || p.machineId || p.hostname || p.platform || p.cwd || p.projectName) {
        sessions.setMetadata(
          session.id,
          p.provider ?? undefined,
          p.machineId ?? undefined,
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
    case "permission.decision.result": {
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
    // Agent GUI: host → clients
    case "agent.capabilities":
    case "agent.update":
    case "agent.permission.request":
    case "agent.snapshot":
      cacheAgentEnvelope(envelope, sessions);
      broadcastToClients(session, envelope);
      break;
    // Multi-terminal: host → clients
    case "terminal.spawned":
    case "terminal.list":
    case "terminal.browse.result":
    case "terminal.file.read.result":
      broadcastToClients(session, envelope);
      break;
    // Structured status from hooks
    case "terminal.status":
      cacheAgentEnvelope(envelope, sessions);
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

  const agentRoute = agentV2MessageRoute(envelope.type);
  if (agentRoute === "client_write") {
    if (!requireController()) return;
    sendToHost(session, envelope);
    return;
  }
  if (agentRoute === "client_read") {
    sendToHost(session, envelope);
    return;
  }

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
      replayAgentToSocket(socket, session.id, sessions);
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
    // Multi-terminal write ops: client → host (require controller)
    case "terminal.spawn":
    case "terminal.kill":
    case "terminal.mkdir":
    case "file.upload":
    case "permission.decision":
      if (!requireController()) return;
      sendToHost(session, envelope);
      break;
    // Read-only ops: any client may issue (no controller gate)
    case "terminal.list":
    case "terminal.browse":
    case "terminal.file.read":
    case "terminal.history.request":
    case "agent.initialize":
    case "agent.session.list":
      sendToHost(session, envelope);
      break;
    default:
      sendToHost(session, envelope);
      break;
  }
}

/** Skip clients whose send buffer exceeds this, so one slow/stalled client
 *  can't grow gateway memory without bound (backpressure). */
const MAX_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024; // 8MB

function broadcastToClients(
  session: ReturnType<SessionManager["get"]> & {},
  envelope: Envelope,
): void {
  const data = serializeEnvelope(envelope);
  for (const [, client] of session.clients) {
    if (client.socket.readyState !== client.socket.OPEN) continue;
    if (client.socket.bufferedAmount > MAX_CLIENT_BUFFER_BYTES) continue;
    client.socket.send(data);
  }
}

/** Replay the last agent snapshot + recent host→client agent envelopes. */
export function replayAgentToSocket(
  socket: WebSocket,
  sessionId: string,
  sessions: SessionManager,
): void {
  if (socket.readyState !== socket.OPEN) return;
  for (const envelope of sessions.getAgentReplay(sessionId)) {
    if (socket.bufferedAmount > MAX_CLIENT_BUFFER_BYTES) break;
    socket.send(serializeEnvelope(envelope));
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
