import { parseEnvelope } from "@linkshell/protocol";
import { watcherWsUrl } from "./gateway-api";
import type { GatewayConfig, SessionSummary } from "./types";

export type PresenceLiveState = "connecting" | "live" | "poll";

export type SessionPresencePatch = Pick<
  SessionSummary,
  | "hasHost"
  | "agentStatus"
  | "agentProvider"
  | "agentConversationId"
  | "agentTitle"
  | "agentDetail"
  | "agentLastActivity"
  | "lastActivity"
  | "agentUsage"
>;

/** Lightweight WS client for session.presence on the list page. */
export function connectPresenceWatcher(input: {
  config: GatewayConfig;
  deviceToken?: string | null;
  jwt?: string | null;
  onPresence: (sessionId: string, patch: SessionPresencePatch) => void;
  onState: (state: PresenceLiveState) => void;
}): () => void {
  if (!input.deviceToken && !input.jwt) {
    input.onState("poll");
    return () => {};
  }

  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | undefined;
  let attempts = 0;

  const connect = () => {
    if (closed) return;
    input.onState(attempts === 0 ? "connecting" : "poll");
    const url = watcherWsUrl(input.config, {
      deviceToken: input.deviceToken,
      jwt: input.jwt,
    });
    const ws = new WebSocket(url);
    socket = ws;

    ws.onopen = () => {
      attempts = 0;
      input.onState("live");
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const envelope = parseEnvelope(event.data);
        if (envelope.type !== "session.presence") return;
        const p = envelope.payload as SessionPresencePatch;
        input.onPresence(envelope.sessionId, {
          hasHost: p.hasHost,
          agentStatus: p.agentStatus ?? null,
          agentProvider: p.agentProvider ?? null,
          agentConversationId: p.agentConversationId ?? null,
          agentTitle: p.agentTitle ?? null,
          agentDetail: p.agentDetail ?? null,
          agentLastActivity: p.agentLastActivity ?? null,
          lastActivity: p.lastActivity ?? Date.now(),
          agentUsage: p.agentUsage ?? null,
        });
      } catch {
        // Ignore malformed frames; HTTP fallback still runs.
      }
    };
    ws.onclose = () => {
      if (closed) return;
      input.onState("poll");
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempts, 4));
      attempts += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    };
    ws.onerror = () => {
      ws.close();
    };
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    socket?.close();
  };
}
