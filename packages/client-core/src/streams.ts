import { DIRECT_CHUNK, decodeDirectFrame, encodeDirectFrame, type DirectFrame } from "@linkshell/wire";
import type { HostLink } from "./host-link.js";

// Byte streams to the computer's local ports (previews, the screen viewer),
// and the path they take. The RPC channel through the gateway always works;
// when the computer supports it, a peer-to-peer channel is set up beside it
// and streams opened while it is up go there instead — the gateway then
// carries only the little that set the channel up.

/**
 * One WebRTC connection holding the bulk data channel, as the platform
 * provides it (react-native-webrtc on a phone, werift in tests).
 */
export interface DirectConnection {
  /** The offer for a connection with the data channel in it, once its addresses are gathered. */
  offer(): Promise<string>;
  accept(answer: string): Promise<void>;
  send(bytes: Uint8Array): void;
  /** `open` once the channel can carry data; `closed` when it (or the connection) is gone, for good. */
  onState(listener: (state: "open" | "closed") => void): void;
  onMessage(listener: (bytes: Uint8Array) => void): void;
  close(): void;
}

export type DirectConnector = (iceServers: string[]) => DirectConnection;

/**
 * - `relay`: streams go through the gateway (no direct path, or none yet)
 * - `connecting`: looking for a direct path; streams opened now use the gateway
 * - `direct`: streams opened now go peer to peer
 */
export type StreamPath = "relay" | "connecting" | "direct";

export interface StreamHandlers {
  data(bytes: Uint8Array): void;
  /** The computer's end closed, or the path under the stream went away. */
  closed(error?: string): void;
}

export interface HostStream {
  /** Whether it goes peer to peer (decided when it was opened). */
  readonly direct: boolean;
  write(bytes: Uint8Array): void;
  close(): void;
}

export interface HostStreamsOptions {
  /** Makes a WebRTC connection; without it every stream goes through the gateway. */
  connector?: DirectConnector;
  /** The computer's STUN servers (`machine.info`'s `direct`), or undefined when it has no direct channel. */
  iceServers: () => string[] | undefined;
  /** How long a connection and its `direct.offer` handshake may take before it is given up (default 20 s). */
  connectTimeoutMs?: number;
  /** Waits between attempts after a failure (default 15 s, then 45 s; pauses after 3 failed attempts until cooldown, network change, or link reconnect). */
  retryMs?: number[];
  /** Cooldown before trying direct again after 3 consecutive failures (default 15 min; 0 disables timed recovery). */
  cooldownMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_MS = [15_000, 45_000];
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const MAX_DIRECT_ATTEMPTS = 3;
const MAX_EARLY_STREAMS = 64;
const MAX_EARLY_FRAMES = 2048;
const MAX_EARLY_BYTES = 8 * 1024 * 1024;

type EarlyRelayedFrame = { type: "data"; data: Uint8Array } | { type: "closed"; error?: string };
interface EarlyBuffer<T> {
  frames: T[];
  bytes: number;
  overflowed?: boolean;
}

interface NodeBufferInstance extends Uint8Array {
  toString(encoding?: "base64"): string;
}
interface NodeBufferCtor {
  from(text: string, encoding: "base64"): NodeBufferInstance;
  from(buffer: ArrayBufferLike, byteOffset: number, byteLength: number): NodeBufferInstance;
}
function nodeBuffer(): NodeBufferCtor | undefined {
  const buf = (globalThis as { Buffer?: unknown }).Buffer;
  return typeof buf === "function" ? (buf as unknown as NodeBufferCtor) : undefined;
}

const base64 = {
  encode(bytes: Uint8Array): string {
    const BufferCtor = nodeBuffer();
    if (BufferCtor) {
      return BufferCtor.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  },
  decode(text: string): Uint8Array {
    const BufferCtor = nodeBuffer();
    if (BufferCtor) {
      const buf = BufferCtor.from(text, "base64");
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  },
};

export class HostStreams {
  private pathValue: StreamPath = "relay";
  private connection?: DirectConnection;
  private attempt = 0;
  private pausedAt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private relayEpoch = 0;
  private openingStreams = 0;
  private readonly pathListeners = new Set<(path: StreamPath) => void>();
  /** Streams on the RPC channel, by stream id. */
  private readonly relayed = new Map<string, StreamHandlers>();
  /** Frames for a relayed stream whose `proxy.open` hasn't resolved yet. */
  private readonly earlyRelayed = new Map<string, EarlyBuffer<EarlyRelayedFrame>>();
  /** Recently closed relayed streams whose trailing frames must not re-populate `earlyRelayed`. */
  private readonly closedRelayed = new Set<string>();
  /** Streams on the direct channel, by their number there. */
  private readonly directed = new Map<number, StreamHandlers>();
  /** Frames for a direct stream whose `proxy.open` hasn't answered yet (a server that speaks first). */
  private readonly early = new Map<number, EarlyBuffer<DirectFrame>>();
  /** Recently closed direct streams whose trailing frames must not saturate `early`. */
  private readonly closedDirect = new Set<number>();

  constructor(
    private readonly link: HostLink,
    private readonly options: HostStreamsOptions,
  ) {
    link.on("proxy.data", ({ streamId, data }) => {
      const handlers = this.relayed.get(streamId);
      if (handlers) {
        handlers.data(base64.decode(data));
        return;
      }
      if (this.openingStreams > 0 && !this.closedRelayed.has(streamId)) {
        const bytes = base64.decode(data);
        this.bufferEarly(this.earlyRelayed, streamId, { type: "data", data: bytes }, bytes.byteLength);
      }
    });
    link.on("proxy.closed", ({ streamId, error }) => {
      const handlers = this.relayed.get(streamId);
      if (handlers) {
        this.relayed.delete(streamId);
        this.rememberClosed(this.closedRelayed, streamId);
        handlers.closed(error);
        return;
      }
      if (this.openingStreams > 0 && !this.closedRelayed.has(streamId)) {
        this.bufferEarly(this.earlyRelayed, streamId, { type: "closed", error }, 0, true);
      }
    });
    link.onStatus((status) => {
      if (status === "online") return;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
      this.attempt = 0;
      this.pausedAt = 0;
      // The channel dropped: the computer already closed its ends, and the direct channel was made through it.
      this.dropRelayed("连接已断开");
      const connection = this.connection;
      this.dropDirect();
      connection?.close();
    });
    link.onOnline(() => {
      this.attempt = 0;
      this.pausedAt = 0;
      this.connect();
    });
    if (link.status === "online") this.connect();
  }

  get path(): StreamPath {
    return this.pathValue;
  }

  onPath(listener: (path: StreamPath) => void): () => void {
    this.pathListeners.add(listener);
    return () => this.pathListeners.delete(listener);
  }

  /**
   * Looks for a direct path now (after the machine's info arrived, or the network changed).
   * Pass `force = true` on network transitions so a previous failure pause resets immediately.
   */
  connect(force = false): void {
    if (this.stopped || !this.options.connector || this.connection || this.link.status !== "online") return;
    if (force) {
      this.attempt = 0;
      this.pausedAt = 0;
    } else if (this.attempt >= MAX_DIRECT_ATTEMPTS) {
      const cooldown = this.options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
      if (cooldown <= 0 || this.pausedAt === 0 || Date.now() - this.pausedAt < cooldown) return;
      this.attempt = 0;
      this.pausedAt = 0;
    }
    const iceServers = this.options.iceServers();
    if (!iceServers) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const connection = this.options.connector(iceServers);
    this.connection = connection;
    this.setPath("connecting");
    let opened = false;
    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const give = setTimeout(() => !opened && this.lose(connection), timeoutMs);
    connection.onMessage((bytes) => {
      const frame = decodeDirectFrame(bytes);
      if (frame) this.receive(frame);
    });
    connection.onState((state) => {
      if (this.connection !== connection) return;
      if (state === "open") {
        opened = true;
        clearTimeout(give);
        this.attempt = 0;
        this.pausedAt = 0;
        this.setPath("direct");
      } else {
        clearTimeout(give);
        this.lose(connection);
      }
    });
    connection
      .offer()
      .then((sdp) => this.link.call("direct.offer", { sdp }, timeoutMs))
      .then((answer) => connection.accept(answer.sdp))
      .catch(() => {
        clearTimeout(give);
        this.lose(connection);
      });
  }

  async open(port: number, handlers: StreamHandlers, options: { direct?: boolean } = {}): Promise<HostStream> {
    if (this.stopped) throw new Error("连接已断开");
    const relayEpoch = this.relayEpoch;
    const connection = options.direct !== false && this.pathValue === "direct" ? this.connection : undefined;
    this.openingStreams += 1;
    try {
      const result = await this.link.call("proxy.open", { port, direct: connection ? true : undefined });
      const { streamId } = result;
      // Dropped or stopped while `proxy.open` was in flight: clean up the newly opened stream immediately.
      if (this.stopped || this.relayEpoch !== relayEpoch) {
        this.earlyRelayed.delete(streamId);
        this.rememberClosed(this.closedRelayed, streamId);
        if (result.channel !== undefined) {
          this.early.delete(result.channel);
          this.rememberClosed(this.closedDirect, result.channel);
          if (connection && this.connection === connection) {
            connection.send(encodeDirectFrame({ type: "close", stream: result.channel }));
          }
        } else if (this.link.status === "online") {
          void this.link.call("proxy.close", { streamId }).catch(() => {});
        }
        throw new Error("连接已断开");
      }
      if (result.channel !== undefined && connection && this.connection === connection) {
        const stream = result.channel;
        this.directed.set(stream, handlers);
        const pendingDirect = this.early.get(stream);
        if (pendingDirect) {
          this.early.delete(stream);
          if (pendingDirect.overflowed) {
            this.directed.delete(stream);
            this.rememberClosed(this.closedDirect, stream);
            connection.send(encodeDirectFrame({ type: "close", stream }));
            handlers.closed("缓冲已满，连接已重置");
          } else {
            for (const frame of pendingDirect.frames) {
              if (!this.directed.has(stream)) break;
              this.receive(frame);
            }
          }
        }
        let closed = false;
        return {
          direct: true,
          write: (bytes) => {
            if (closed || this.connection !== connection) return;
            for (let offset = 0; offset < bytes.length; offset += DIRECT_CHUNK) {
              connection.send(encodeDirectFrame({ type: "data", stream, data: bytes.subarray(offset, offset + DIRECT_CHUNK) }));
            }
          },
          close: () => {
            if (closed) return;
            closed = true;
            this.rememberClosed(this.closedDirect, stream);
            if (this.directed.delete(stream) && this.connection === connection) connection.send(encodeDirectFrame({ type: "close", stream }));
          },
        };
      }
      if (result.channel !== undefined) {
        // The direct channel went away while the stream was being opened: its end on the computer is gone with it.
        throw new Error("直连中断了");
      }
      this.relayed.set(streamId, handlers);
      const pendingRelayed = this.earlyRelayed.get(streamId);
      if (pendingRelayed) {
        this.earlyRelayed.delete(streamId);
        if (pendingRelayed.overflowed) {
          this.relayed.delete(streamId);
          this.rememberClosed(this.closedRelayed, streamId);
          void this.link.call("proxy.close", { streamId }).catch(() => {});
          handlers.closed("缓冲已满，连接已重置");
        } else {
          for (const item of pendingRelayed.frames) {
            if (!this.relayed.has(streamId)) break;
            if (item.type === "data") handlers.data(item.data);
            else {
              this.relayed.delete(streamId);
              this.rememberClosed(this.closedRelayed, streamId);
              handlers.closed(item.error);
            }
          }
        }
      }
      let closed = false;
      return {
        direct: false,
        write: (bytes) => {
          if (closed) return;
          void this.link.call("proxy.write", { streamId, data: base64.encode(bytes) }).catch(() => {
            if (this.relayed.delete(streamId)) {
              this.rememberClosed(this.closedRelayed, streamId);
              handlers.closed("发送失败");
            }
          });
        },
        close: () => {
          if (closed) return;
          closed = true;
          this.rememberClosed(this.closedRelayed, streamId);
          if (this.relayed.delete(streamId)) void this.link.call("proxy.close", { streamId }).catch(() => {});
        },
      };
    } finally {
      this.openingStreams -= 1;
      if (this.openingStreams === 0) {
        this.early.clear();
        this.earlyRelayed.clear();
      }
    }
  }

  /** Looks for a direct path again after `stop` (an app coming back to a connection it had put down). */
  start(): void {
    this.stopped = false;
    this.attempt = 0;
    this.pausedAt = 0;
    this.connect();
  }

  /** Ends every stream and the direct connection; nothing is tried until `start`. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.dropRelayed();
    const connection = this.connection;
    this.dropDirect();
    connection?.close();
  }

  private bufferEarly<K, T>(store: Map<K, EarlyBuffer<T>>, key: K, frame: T, byteLength: number, isTerminal = false): void {
    let entry = store.get(key);
    if (!entry) {
      if (store.size >= MAX_EARLY_STREAMS) return;
      entry = { frames: [], bytes: 0 };
      store.set(key, entry);
    }
    if (entry.overflowed) return;
    if (!isTerminal && (entry.frames.length >= MAX_EARLY_FRAMES || entry.bytes + byteLength > MAX_EARLY_BYTES)) {
      // Never silently drop middle bytes of a TCP/HTTP byte stream: mark overflow so `open()` resets cleanly.
      entry.frames.length = 0;
      entry.bytes = 0;
      entry.overflowed = true;
      return;
    }
    entry.frames.push(frame);
    entry.bytes += byteLength;
  }

  private rememberClosed<K>(tombstones: Set<K>, key: K): void {
    tombstones.delete(key);
    tombstones.add(key);
    if (tombstones.size > 512) {
      const oldest = tombstones.values().next().value;
      if (oldest !== undefined) tombstones.delete(oldest);
    }
  }

  private receive(frame: DirectFrame): void {
    const handlers = this.directed.get(frame.stream);
    if (!handlers) {
      // Only buffer unknown stream frames while a `proxy.open` is actually in flight and the
      // stream hasn't already been closed, so late frames from closed streams never saturate `early`.
      if (this.openingStreams > 0 && !this.closedDirect.has(frame.stream)) {
        const bytes = frame.type === "data" ? frame.data.byteLength : 0;
        this.bufferEarly(this.early, frame.stream, frame, bytes, frame.type !== "data");
      }
      return;
    }
    if (frame.type === "data") handlers.data(frame.data);
    else {
      this.directed.delete(frame.stream);
      this.rememberClosed(this.closedDirect, frame.stream);
      handlers.closed(frame.error);
    }
  }

  private setPath(path: StreamPath): void {
    if (this.pathValue === path) return;
    this.pathValue = path;
    for (const listener of this.pathListeners) listener(path);
  }

  /** The direct connection failed or ended: its streams end, and another is tried up to 3 times before cooling down. */
  private lose(connection: DirectConnection): void {
    if (this.connection !== connection) return;
    this.dropDirect();
    connection.close();
    if (this.stopped || this.link.status !== "online") return;
    const waits = this.options.retryMs ?? DEFAULT_RETRY_MS;
    const attemptIndex = this.attempt;
    this.attempt += 1;
    // Pause after 3 consecutive failed attempts so UDP-blocked networks don't churn,
    // but recover automatically after cooldown (or immediately on network change / link reconnect).
    if (this.attempt >= MAX_DIRECT_ATTEMPTS) {
      this.pausedAt = Date.now();
      const cooldown = this.options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
      if (cooldown > 0) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.attempt = 0;
          this.pausedAt = 0;
          this.connect();
        }, cooldown);
      }
      return;
    }
    const wait = waits[Math.min(attemptIndex, waits.length - 1)]!;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, wait);
  }

  private dropDirect(): void {
    this.connection = undefined;
    const streams = [...this.directed.values()];
    this.directed.clear();
    this.early.clear();
    this.closedDirect.clear();
    this.setPath("relay");
    for (const handlers of streams) handlers.closed("直连中断了");
  }

  private dropRelayed(error?: string): void {
    this.relayEpoch += 1;
    const streams = [...this.relayed.values()];
    this.relayed.clear();
    this.earlyRelayed.clear();
    this.closedRelayed.clear();
    for (const handlers of streams) handlers.closed(error);
  }
}
