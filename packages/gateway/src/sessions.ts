import type WebSocket from "ws";
import type { Envelope } from "@linkshell/protocol";

export type DeviceState = "active" | "host_disconnected" | "terminated";

export interface ConnectedDevice {
  socket: WebSocket;
  role: "host" | "client";
  deviceId: string;
  token?: string;
  authorizationId?: string;
  connectedAt: number;
}

export interface HostDevice {
  id: string;
  hostDeviceId: string;
  state: DeviceState;
  host: ConnectedDevice | undefined;
  clients: Map<string, ConnectedDevice>;
  controllerId: string | undefined;
  lastActivity: number;
  createdAt: number;
  outputBuffers: Map<string, Envelope[]>;
  lastStatusByTerminal: Map<string, Envelope>;
  hostDisconnectedAt: number | undefined;
  machineId: string | undefined;
  hostname: string | undefined;
  platform: string | undefined;
  cwd: string | undefined;
  capabilities: string[];
  userId: string | undefined;
}

const OUTPUT_BUFFER_CAPACITY = 200;
const OUTPUT_BUFFER_MAX_PAYLOAD_BYTES = Number(
  process.env.OUTPUT_BUFFER_MAX_PAYLOAD_BYTES ?? 64 * 1024,
);
const HOST_RECONNECT_WINDOW = 60_000;
const CLEANUP_INTERVAL = 30_000;

export class DeviceManager {
  private devices = new Map<string, HostDevice>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
  }

  getOrCreate(hostDeviceId: string): HostDevice {
    let device = this.devices.get(hostDeviceId);
    if (!device) {
      device = {
        id: hostDeviceId,
        hostDeviceId,
        state: "active",
        host: undefined,
        clients: new Map(),
        controllerId: undefined,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        outputBuffers: new Map(),
        lastStatusByTerminal: new Map(),
        hostDisconnectedAt: undefined,
        machineId: undefined,
        hostname: undefined,
        platform: undefined,
        cwd: undefined,
        capabilities: [],
        userId: undefined,
      };
      this.devices.set(hostDeviceId, device);
    }
    return device;
  }

  get(hostDeviceId: string): HostDevice | undefined {
    return this.devices.get(hostDeviceId);
  }

  setHost(hostDeviceId: string, socketDevice: ConnectedDevice): void {
    const device = this.getOrCreate(hostDeviceId);
    device.host = socketDevice;
    device.state = "active";
    device.hostDisconnectedAt = undefined;
    device.lastActivity = Date.now();
  }

  addClient(hostDeviceId: string, socketDevice: ConnectedDevice): void {
    const device = this.getOrCreate(hostDeviceId);
    device.clients.set(socketDevice.deviceId, socketDevice);
    if (!device.controllerId) {
      device.controllerId = socketDevice.deviceId;
    }
    device.lastActivity = Date.now();
  }

  removeHost(
    hostDeviceId: string,
  ): { clients: Map<string, ConnectedDevice> } | undefined {
    const device = this.devices.get(hostDeviceId);
    if (!device) return undefined;
    device.host = undefined;
    device.state = "host_disconnected";
    device.hostDisconnectedAt = Date.now();
    return { clients: device.clients };
  }

  removeClient(hostDeviceId: string, deviceId: string): void {
    const device = this.devices.get(hostDeviceId);
    if (!device) return;
    device.clients.delete(deviceId);
    if (device.controllerId === deviceId) {
      const next = device.clients.keys().next();
      device.controllerId = next.done ? undefined : next.value;
    }
    this.maybeDelete(hostDeviceId);
  }

  disconnectAuthorization(hostDeviceId: string, authorizationId: string): number {
    const device = this.devices.get(hostDeviceId);
    if (!device) return 0;
    let closed = 0;
    for (const [deviceId, client] of device.clients) {
      if (client.authorizationId !== authorizationId) continue;
      try {
        client.socket.close(4001, "authorization revoked");
      } catch {}
      device.clients.delete(deviceId);
      closed++;
    }
    if (device.controllerId && !device.clients.has(device.controllerId)) {
      const next = device.clients.keys().next();
      device.controllerId = next.done ? undefined : next.value;
    }
    this.maybeDelete(hostDeviceId);
    return closed;
  }

  forceDelete(hostDeviceId: string): boolean {
    const device = this.devices.get(hostDeviceId);
    if (!device) return false;
    if (device.host) {
      try {
        device.host.socket.close(1000, "device deleted");
      } catch {}
    }
    for (const [, client] of device.clients) {
      try {
        client.socket.close(1000, "device deleted");
      } catch {}
    }
    this.devices.delete(hostDeviceId);
    return true;
  }

  bufferOutput(hostDeviceId: string, envelope: Envelope): void {
    const device = this.devices.get(hostDeviceId);
    if (!device) return;
    const payload = envelope.payload as { data?: unknown } | undefined;
    if (
      typeof payload?.data === "string" &&
      Buffer.byteLength(payload.data, "utf8") > OUTPUT_BUFFER_MAX_PAYLOAD_BYTES
    ) {
      device.lastActivity = Date.now();
      return;
    }
    const terminalId = envelope.terminalId ?? "default";
    let buffer = device.outputBuffers.get(terminalId);
    if (!buffer) {
      buffer = [];
      device.outputBuffers.set(terminalId, buffer);
    }
    buffer.push(envelope);
    if (buffer.length > OUTPUT_BUFFER_CAPACITY) {
      buffer.shift();
    }
    device.lastActivity = Date.now();
  }

  cacheStatus(hostDeviceId: string, envelope: Envelope): void {
    const device = this.devices.get(hostDeviceId);
    if (!device) return;
    const terminalId = envelope.terminalId ?? "default";
    device.lastStatusByTerminal.set(terminalId, envelope);
    device.lastActivity = Date.now();
  }

  getStatusReplay(hostDeviceId: string): Envelope[] {
    const device = this.devices.get(hostDeviceId);
    if (!device) return [];
    return [...device.lastStatusByTerminal.values()];
  }

  getReplayFrom(
    hostDeviceId: string,
    afterSeqByTerminal: Record<string, number>,
    fallbackAfterSeq = -1,
  ): Envelope[] {
    const device = this.devices.get(hostDeviceId);
    if (!device) return [];
    const result: Envelope[] = [];
    for (const [terminalId, buffer] of device.outputBuffers) {
      const afterSeq = afterSeqByTerminal[terminalId] ?? fallbackAfterSeq;
      for (const envelope of buffer) {
        if (envelope.seq !== undefined && envelope.seq > afterSeq) {
          result.push(envelope);
        }
      }
    }
    return result.sort((a, b) => {
      const at = Date.parse(a.timestamp);
      const bt = Date.parse(b.timestamp);
      if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return at - bt;
      return (a.seq ?? 0) - (b.seq ?? 0);
    });
  }

  claimControl(hostDeviceId: string, deviceId: string): boolean {
    const device = this.devices.get(hostDeviceId);
    if (!device) return false;
    device.controllerId = deviceId;
    return true;
  }

  releaseControl(hostDeviceId: string, deviceId: string): boolean {
    const device = this.devices.get(hostDeviceId);
    if (!device) return false;
    if (device.controllerId !== deviceId) return false;
    device.controllerId = undefined;
    return true;
  }

  terminate(hostDeviceId: string): void {
    const device = this.devices.get(hostDeviceId);
    if (!device) return;
    device.state = "terminated";
  }

  listActive(): HostDevice[] {
    return [...this.devices.values()].filter((device) => device.state !== "terminated");
  }

  getSummary(hostDeviceId: string) {
    const device = this.devices.get(hostDeviceId);
    if (!device) return undefined;
    return {
      id: device.hostDeviceId,
      hostDeviceId: device.hostDeviceId,
      state: device.state,
      online:
        !!device.host &&
        device.host.socket.readyState === device.host.socket.OPEN,
      hasHost:
        !!device.host &&
        device.host.socket.readyState === device.host.socket.OPEN,
      clientCount: device.clients.size,
      controllerId: device.controllerId ?? null,
      lastActivity: device.lastActivity,
      createdAt: device.createdAt,
      bufferSize: [...device.outputBuffers.values()].reduce((sum, buf) => sum + buf.length, 0),
      machineId: device.machineId ?? null,
      hostname: device.hostname ?? null,
      platform: device.platform ?? null,
      cwd: device.cwd ?? null,
      capabilities: device.capabilities,
      userId: device.userId ?? null,
    };
  }

  getStats() {
    let clientCount = 0;
    let bufferedTerminalFrames = 0;
    let terminalCount = 0;
    for (const device of this.devices.values()) {
      clientCount += device.clients.size;
      terminalCount += device.outputBuffers.size;
      bufferedTerminalFrames += [...device.outputBuffers.values()].reduce((sum, buf) => sum + buf.length, 0);
    }
    return {
      devices: this.devices.size,
      activeDevices: this.listActive().length,
      clients: clientCount,
      terminalsWithReplay: terminalCount,
      bufferedTerminalFrames,
    };
  }

  setMetadata(
    hostDeviceId: string,
    _provider?: string,
    machineId?: string,
    hostname?: string,
    platform?: string,
    cwd?: string,
    _projectName?: string,
    capabilities?: string[],
  ): void {
    const device = this.devices.get(hostDeviceId);
    if (!device) return;
    if (machineId) device.machineId = machineId;
    if (hostname) device.hostname = hostname;
    if (platform) device.platform = platform;
    if (cwd) device.cwd = cwd;
    if (capabilities) device.capabilities = capabilities;
  }

  private maybeDelete(hostDeviceId: string): void {
    const device = this.devices.get(hostDeviceId);
    if (!device) return;
    if (!device.host && device.clients.size === 0) {
      this.devices.delete(hostDeviceId);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [hostDeviceId, device] of this.devices) {
      if (
        device.state === "host_disconnected" &&
        device.hostDisconnectedAt &&
        now - device.hostDisconnectedAt > HOST_RECONNECT_WINDOW
      ) {
        device.state = "terminated";
      }
      if (
        device.state === "terminated" &&
        !device.host &&
        device.clients.size === 0
      ) {
        this.devices.delete(hostDeviceId);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
