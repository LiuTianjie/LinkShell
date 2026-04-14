import type WebSocket from "ws";
import type { Envelope } from "@linkshell/protocol";

export type SessionState = "active" | "host_disconnected" | "terminated";

export interface ConnectedDevice {
  socket: WebSocket;
  role: "host" | "client";
  deviceId: string;
  connectedAt: number;
}

export interface Session {
  id: string;
  state: SessionState;
  host: ConnectedDevice | undefined;
  clients: Map<string, ConnectedDevice>;
  controllerId: string | undefined;
  lastActivity: number;
  createdAt: number;
  outputBuffers: Map<string, Envelope[]>; // keyed by terminalId
  lastStatusByTerminal: Map<string, Envelope>; // last terminal.status per terminal
  hostDisconnectedAt: number | undefined;
  // Metadata from host's session.connect
  provider: string | undefined;
  hostname: string | undefined;
  platform: string | undefined;
  cwd: string | undefined;
  projectName: string | undefined;
  // Auth: user who owns this session (set on AUTH_REQUIRED gateways)
  userId: string | undefined;
}

const OUTPUT_BUFFER_CAPACITY = 200;
const HOST_RECONNECT_WINDOW = 60_000; // 60s
const CLEANUP_INTERVAL = 30_000;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
  }

  getOrCreate(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        state: "active",
        host: undefined,
        clients: new Map(),
        controllerId: undefined,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        outputBuffers: new Map(),
        lastStatusByTerminal: new Map(),
        hostDisconnectedAt: undefined,
        provider: undefined,
        hostname: undefined,
        platform: undefined,
        cwd: undefined,
        projectName: undefined,
        userId: undefined,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  setHost(sessionId: string, device: ConnectedDevice): void {
    const session = this.getOrCreate(sessionId);
    session.host = device;
    session.state = "active";
    session.hostDisconnectedAt = undefined;
    session.lastActivity = Date.now();
  }

  addClient(sessionId: string, device: ConnectedDevice): void {
    const session = this.getOrCreate(sessionId);
    session.clients.set(device.deviceId, device);
    session.lastActivity = Date.now();
  }

  removeHost(
    sessionId: string,
  ): { clients: Map<string, ConnectedDevice> } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.host = undefined;
    session.state = "host_disconnected";
    session.hostDisconnectedAt = Date.now();
    return { clients: session.clients };
  }

  removeClient(sessionId: string, deviceId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.clients.delete(deviceId);
    if (session.controllerId === deviceId) {
      // Transfer control to next client or clear
      const next = session.clients.keys().next();
      session.controllerId = next.done ? undefined : next.value;
    }
    this.maybeDelete(sessionId);
  }

  bufferOutput(sessionId: string, envelope: Envelope): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const tid = (envelope as any).terminalId ?? "default";
    let buf = session.outputBuffers.get(tid);
    if (!buf) {
      buf = [];
      session.outputBuffers.set(tid, buf);
    }
    buf.push(envelope);
    if (buf.length > OUTPUT_BUFFER_CAPACITY) {
      buf.shift();
    }
    session.lastActivity = Date.now();
  }

  cacheStatus(sessionId: string, envelope: Envelope): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const tid = (envelope as any).terminalId ?? "default";
    session.lastStatusByTerminal.set(tid, envelope);
    session.lastActivity = Date.now();
  }

  getStatusReplay(sessionId: string): Envelope[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return [...session.lastStatusByTerminal.values()];
  }

  getReplayFrom(sessionId: string, afterSeq: number): Envelope[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const result: Envelope[] = [];
    for (const buf of session.outputBuffers.values()) {
      for (const e of buf) {
        if (e.seq !== undefined && e.seq > afterSeq) result.push(e);
      }
    }
    return result.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  claimControl(sessionId: string, deviceId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    // Always allow takeover – last claimer wins
    session.controllerId = deviceId;
    return true;
  }

  releaseControl(sessionId: string, deviceId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.controllerId !== deviceId) return false;
    session.controllerId = undefined;
    return true;
  }

  terminate(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state = "terminated";
  }

  listActive(): Session[] {
    return [...this.sessions.values()].filter((s) => s.state !== "terminated");
  }

  getSummary(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return {
      id: session.id,
      state: session.state,
      hasHost:
        !!session.host &&
        session.host.socket.readyState === session.host.socket.OPEN,
      clientCount: session.clients.size,
      controllerId: session.controllerId ?? null,
      lastActivity: session.lastActivity,
      createdAt: session.createdAt,
      bufferSize: [...session.outputBuffers.values()].reduce((sum, buf) => sum + buf.length, 0),
      provider: session.provider ?? null,
      hostname: session.hostname ?? null,
      platform: session.platform ?? null,
      cwd: session.cwd ?? null,
      projectName: session.projectName ?? null,
      userId: session.userId ?? null,
    };
  }

  setMetadata(
    sessionId: string,
    provider?: string,
    hostname?: string,
    platform?: string,
    cwd?: string,
    projectName?: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (provider) session.provider = provider;
    if (hostname) session.hostname = hostname;
    if (platform) session.platform = platform;
    if (cwd) session.cwd = cwd;
    if (projectName) session.projectName = projectName;
  }

  private maybeDelete(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!session.host && session.clients.size === 0) {
      this.sessions.delete(sessionId);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      // Remove sessions where host disconnected and window expired
      if (
        session.state === "host_disconnected" &&
        session.hostDisconnectedAt &&
        now - session.hostDisconnectedAt > HOST_RECONNECT_WINDOW
      ) {
        session.state = "terminated";
      }
      // Clean up terminated sessions with no connections
      if (
        session.state === "terminated" &&
        !session.host &&
        session.clients.size === 0
      ) {
        this.sessions.delete(id);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
