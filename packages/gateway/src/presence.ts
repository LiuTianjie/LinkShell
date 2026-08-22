import type WebSocket from "ws";
import { createEnvelope, serializeEnvelope, PROTOCOL_VERSION } from "@linkshell/protocol";
import type { Session, SessionManager } from "./sessions.js";

interface Watcher {
  socket: WebSocket;
  /** Session ids this watcher is allowed to see. Re-evaluated per notify
   *  so newly-bound tokens pick up sessions without reconnecting. */
  sessionIds: () => Set<string>;
  userId?: string;
}

/** Cross-session presence fan-out for the web session list. */
export class PresenceHub {
  private watchers = new Set<Watcher>();

  add(watcher: Watcher): void {
    this.watchers.add(watcher);
    watcher.socket.on("close", () => this.watchers.delete(watcher));
    watcher.socket.on("error", () => this.watchers.delete(watcher));
  }

  /** Send the current summary for every visible session (connect snapshot). */
  snapshot(watcher: Watcher, sessions: SessionManager): void {
    const allowed = watcher.sessionIds();
    for (const session of sessions.listActive()) {
      if (!this.visible(watcher, session, allowed)) continue;
      this.send(watcher.socket, session);
    }
  }

  notify(session: Session): void {
    if (this.watchers.size === 0) return;
    for (const watcher of this.watchers) {
      if (watcher.socket.readyState !== watcher.socket.OPEN) continue;
      if (!this.visible(watcher, session, watcher.sessionIds())) continue;
      this.send(watcher.socket, session);
    }
  }

  private visible(watcher: Watcher, session: Session, allowed: Set<string>): boolean {
    if (allowed.has(session.id)) return true;
    if (watcher.userId && session.userId && watcher.userId === session.userId) return true;
    return false;
  }

  private send(socket: WebSocket, session: Session): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(
      serializeEnvelope(
        createEnvelope({
          type: "session.presence",
          sessionId: session.id,
          payload: {
            hasHost:
              !!session.host &&
              session.host.socket.readyState === session.host.socket.OPEN,
            agentStatus: session.agentStatus ?? null,
            agentProvider: session.agentProvider ?? null,
            agentConversationId: session.agentConversationId ?? null,
            agentTitle: session.agentTitle ?? null,
            agentDetail: session.agentDetail ?? null,
            agentLastActivity: session.agentLastActivity ?? null,
            lastActivity: session.lastActivity,
            agentUsage: session.agentUsage ?? null,
          },
        }),
      ),
    );
  }
}

export function startPresenceWatcher(input: {
  socket: WebSocket;
  sessions: SessionManager;
  hub: PresenceHub;
  sessionIds: () => Set<string>;
  userId?: string;
  pingIntervalMs?: number;
}): void {
  const { socket, sessions, hub, sessionIds, userId, pingIntervalMs = 20_000 } = input;
  const watcher = { socket, sessionIds, userId };
  hub.add(watcher);

  socket.send(
    serializeEnvelope(
      createEnvelope({
        type: "session.connect",
        sessionId: "_presence",
        payload: {
          role: "client",
          clientName: "watcher",
          protocolVersion: PROTOCOL_VERSION,
        },
      }),
    ),
  );
  hub.snapshot(watcher, sessions);

  const liveSocket = socket as WebSocket & { isAlive?: boolean };
  liveSocket.isAlive = true;
  socket.on("pong", () => {
    liveSocket.isAlive = true;
  });
  socket.on("message", () => {
    liveSocket.isAlive = true;
  });
  const pingTimer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    if (liveSocket.isAlive === false) {
      socket.terminate();
      return;
    }
    liveSocket.isAlive = false;
    socket.ping();
  }, pingIntervalMs);
  socket.on("close", () => clearInterval(pingTimer));
}
