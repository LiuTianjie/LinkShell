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
  /** How long a connection may take to open before it is given up (default 12 s). */
  connectTimeoutMs?: number;
  /** Waits between attempts after a failure (default 15 s, then 45 s; pauses after 3 failed attempts until the link reconnects). */
  retryMs?: number[];
}

const DEFAULT_RETRY_MS = [15_000, 45_000];
const MAX_DIRECT_ATTEMPTS = 3;

const base64 = {
  encode(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  },
  decode(text: string): Uint8Array {
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
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private relayEpoch = 0;
  private openingRelayed = 0;
  private readonly pathListeners = new Set<(path: StreamPath) => void>();
  /** Streams on the RPC channel, by stream id. */
  private readonly relayed = new Map<string, StreamHandlers>();
  /** Frames for a relayed stream whose `proxy.open` hasn't resolved yet. */
  private readonly earlyRelayed = new Map<string, ({ type: "data"; data: Uint8Array } | { type: "closed"; error?: string })[]>();
  /** Streams on the direct channel, by their number there. */
  private readonly directed = new Map<number, StreamHandlers>();
  /** Frames for a direct stream whose `proxy.open` hasn't answered yet (a server that speaks first). */
  private readonly early = new Map<number, DirectFrame[]>();

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
      if (this.openingRelayed > 0) {
        const held = this.earlyRelayed.get(streamId) ?? [];
        if (held.length < 64 && this.earlyRelayed.size < 32) {
          this.earlyRelayed.set(streamId, [...held, { type: "data", data: base64.decode(data) }]);
        }
      }
    });
    link.on("proxy.closed", ({ streamId, error }) => {
      const handlers = this.relayed.get(streamId);
      if (handlers) {
        this.relayed.delete(streamId);
        handlers.closed(error);
        return;
      }
      if (this.openingRelayed > 0) {
        const held = this.earlyRelayed.get(streamId) ?? [];
        if (held.length < 64 && this.earlyRelayed.size < 32) {
          this.earlyRelayed.set(streamId, [...held, { type: "closed", error }]);
        }
      }
    });
    link.onStatus((status) => {
      if (status === "online") return;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }
      this.attempt = 0;
      // The channel dropped: the computer already closed its ends, and the direct channel was made through it.
      this.dropRelayed("连接已断开");
      const connection = this.connection;
      this.dropDirect();
      connection?.close();
    });
    link.onOnline(() => {
      this.attempt = 0;
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

  /** Looks for a direct path now (after the machine's info arrived, or the network changed). */
  connect(): void {
    if (this.stopped || !this.options.connector || this.connection || this.link.status !== "online" || this.attempt >= MAX_DIRECT_ATTEMPTS) return;
    const iceServers = this.options.iceServers();
    if (!iceServers) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const connection = this.options.connector(iceServers);
    this.connection = connection;
    this.setPath("connecting");
    let opened = false;
    const give = setTimeout(() => !opened && this.lose(connection), this.options.connectTimeoutMs ?? 12_000);
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
        this.setPath("direct");
      } else {
        clearTimeout(give);
        this.lose(connection);
      }
    });
    connection
      .offer()
      .then((sdp) => this.link.call("direct.offer", { sdp }, 20_000))
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
    if (!connection) this.openingRelayed += 1;
    let result: { streamId: string; channel?: number };
    try {
      result = await this.link.call("proxy.open", { port, direct: connection ? true : undefined });
    } finally {
      if (!connection) this.openingRelayed -= 1;
    }
    const { streamId } = result;
    // Dropped or stopped while `proxy.open` was in flight: clean up the newly opened stream immediately.
    if (this.stopped || this.relayEpoch !== relayEpoch) {
      this.earlyRelayed.delete(streamId);
      if (result.channel !== undefined) {
        this.early.delete(result.channel);
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
      for (const frame of this.early.get(stream) ?? []) this.receive(frame);
      this.early.delete(stream);
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
      for (const item of pendingRelayed) {
        if (!this.relayed.has(streamId)) break;
        if (item.type === "data") handlers.data(item.data);
        else {
          this.relayed.delete(streamId);
          handlers.closed(item.error);
        }
      }
    }
    let closed = false;
    return {
      direct: false,
      write: (bytes) => {
        if (closed) return;
        void this.link.call("proxy.write", { streamId, data: base64.encode(bytes) }).catch(() => {
          if (this.relayed.delete(streamId)) handlers.closed("发送失败");
        });
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (this.relayed.delete(streamId)) void this.link.call("proxy.close", { streamId }).catch(() => {});
      },
    };
  }

  /** Looks for a direct path again after `stop` (an app coming back to a connection it had put down). */
  start(): void {
    this.stopped = false;
    this.attempt = 0;
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

  private receive(frame: DirectFrame): void {
    const handlers = this.directed.get(frame.stream);
    if (!handlers) {
      // Not a stream we know (yet): keep a little of it for the `proxy.open` that is about to answer.
      const held = this.early.get(frame.stream) ?? [];
      if (held.length < 64 && this.early.size < 32) this.early.set(frame.stream, [...held, frame]);
      return;
    }
    if (frame.type === "data") handlers.data(frame.data);
    else {
      this.directed.delete(frame.stream);
      handlers.closed(frame.error);
    }
  }

  private setPath(path: StreamPath): void {
    if (this.pathValue === path) return;
    this.pathValue = path;
    for (const listener of this.pathListeners) listener(path);
  }

  /** The direct connection failed or ended: its streams end, and another is tried up to 3 times per link session. */
  private lose(connection: DirectConnection): void {
    if (this.connection !== connection) return;
    this.dropDirect();
    connection.close();
    if (this.stopped || this.link.status !== "online") return;
    const waits = this.options.retryMs ?? DEFAULT_RETRY_MS;
    const attemptIndex = this.attempt;
    this.attempt += 1;
    // Pause after 3 consecutive failed attempts on this link session so UDP-blocked networks
    // don't retry forever; reconnecting the link resets `attempt`.
    if (this.attempt >= MAX_DIRECT_ATTEMPTS) return;
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
    this.setPath("relay");
    for (const handlers of streams) handlers.closed("直连中断了");
  }

  private dropRelayed(error?: string): void {
    this.relayEpoch += 1;
    const streams = [...this.relayed.values()];
    this.relayed.clear();
    this.earlyRelayed.clear();
    for (const handlers of streams) handlers.closed(error);
  }
}
