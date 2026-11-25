import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { DIRECT_LABEL, decodeDirectFrame, encodeDirectFrame, type DirectFrame } from "@linkshell/wire";

// The host's end of the direct channel (see wire/direct.ts): one WebRTC
// connection per device connection, made when the device offers one, carrying
// the bulk streams that would otherwise go through the gateway.

/** Stop reading a stream's source while this much is waiting to go out… */
const HIGH_WATER = 1024 * 1024;
/** …and read on once it is down to this. */
const LOW_WATER = 256 * 1024;
/** Cap on frames queued in memory while waiting for `bufferedAmount` to drain. */
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
/** Fallback poll interval in case werift misses a `bufferedAmountLow` transition. */
const DRAIN_POLL_MS = 25;
/** How long to look for addresses before answering with the ones found. */
const GATHER_MS = 2500;

export interface DirectStreamHandler {
  data(bytes: Uint8Array): void;
  /** The device finished its end, or the channel went away (`lost`). */
  close(lost: boolean): void;
}

export class DirectPeer {
  private connection?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private readonly streams = new Map<number, DirectStreamHandler>();
  private readonly waiting = new Set<() => void>();
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private drainTimer?: ReturnType<typeof setInterval>;
  private nextStream = 1;

  constructor(
    private readonly iceServers: string[],
    private readonly log: (message: string) => void,
  ) {}

  /** Whether streams can go on the channel right now. */
  get open(): boolean {
    return this.channel?.readyState === "open";
  }

  /** Answers a device's offer. The connection an earlier offer made is replaced. */
  async answer(sdp: string): Promise<string> {
    this.close();
    const connection = new RTCPeerConnection({ iceServers: this.iceServers.map((urls) => ({ urls })) });
    this.connection = connection;
    connection.onDataChannel.subscribe((channel) => {
      if (channel.label !== DIRECT_LABEL || this.connection !== connection) return;
      this.channel = channel;
      channel.bufferedAmountLowThreshold = LOW_WATER;
      channel.bufferedAmountLow.subscribe(() => this.drained());
      channel.onMessage.subscribe((message) => {
        if (typeof message === "string") return;
        const frame = decodeDirectFrame(message);
        if (frame) this.receive(frame);
      });
      channel.stateChanged.subscribe((state) => {
        if (state === "open") this.log("[direct] channel open");
        if (state === "closed" && this.channel === channel) this.lose(connection);
      });
    });
    connection.connectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "closed") this.lose(connection);
    });
    try {
      await connection.setRemoteDescription({ type: "offer", sdp });
      await connection.setLocalDescription(await connection.createAnswer());
      await gathered(connection);
      const answer = connection.localDescription?.sdp;
      if (!answer) throw new Error("no answer could be made");
      return answer;
    } catch (error) {
      if (this.connection === connection) this.close();
      else void connection.close().catch(() => {});
      throw error;
    }
  }

  /** A stream on the channel: its number, for the device to use too. */
  attach(handler: DirectStreamHandler): number {
    const stream = this.nextStream++;
    this.streams.set(stream, handler);
    return stream;
  }

  detach(stream: number): void {
    this.streams.delete(stream);
  }

  /**
   * Sends a direct frame, queuing within `MAX_QUEUE_BYTES` if the data channel is backed up.
   * Returns `false` if the channel is closed, failed, or the backpressure queue is full.
   */
  send(frame: DirectFrame): boolean {
    if (!this.open || !this.channel) return false;
    const encoded = Buffer.from(encodeDirectFrame(frame));
    if (this.pending.length > 0 || (this.channel.bufferedAmount ?? 0) > HIGH_WATER) {
      if (this.pendingBytes + encoded.byteLength > MAX_QUEUE_BYTES) {
        this.log(`[direct] send queue full (${this.pendingBytes} bytes); dropping frame`);
        return false;
      }
      this.pending.push(encoded);
      this.pendingBytes += encoded.byteLength;
      this.ensureDrainPoll();
      return true;
    }
    return this.writeNow(encoded);
  }

  /** True while the device isn't keeping up: hold the stream's source until `whenDrained`. */
  get backedUp(): boolean {
    return (this.channel?.bufferedAmount ?? 0) + this.pendingBytes > HIGH_WATER;
  }

  whenDrained(resume: () => void): () => void {
    if (!this.open) return () => {};
    if (!this.backedUp) {
      queueMicrotask(() => {
        if (this.open) resume();
      });
      return () => {};
    }
    this.waiting.add(resume);
    this.ensureDrainPoll();
    return () => {
      this.waiting.delete(resume);
      this.maybeStopDrainPoll();
    };
  }

  close(): void {
    const connection = this.connection;
    if (!connection) return;
    this.lose(connection);
  }

  private writeNow(encoded: Buffer): boolean {
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") return false;
    try {
      channel.send(encoded);
      return true;
    } catch (error) {
      this.log(`[direct] send failed: ${error instanceof Error ? error.message : String(error)}`);
      if (this.connection && channel.readyState !== "open") this.lose(this.connection);
      return false;
    }
  }

  private flushPending(): void {
    while (this.pending.length > 0 && this.open && (this.channel?.bufferedAmount ?? 0) <= HIGH_WATER) {
      const next = this.pending.shift()!;
      this.pendingBytes -= next.byteLength;
      if (!this.writeNow(next)) break;
    }
  }

  private ensureDrainPoll(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      if (!this.open) {
        this.stopDrainPoll();
        return;
      }
      this.flushPending();
      if ((this.channel?.bufferedAmount ?? 0) + this.pendingBytes <= LOW_WATER) {
        this.drained();
      }
      this.maybeStopDrainPoll();
    }, DRAIN_POLL_MS);
    this.drainTimer.unref?.();
  }

  private maybeStopDrainPoll(): void {
    if (this.waiting.size === 0 && this.pending.length === 0) this.stopDrainPoll();
  }

  private stopDrainPoll(): void {
    if (!this.drainTimer) return;
    clearInterval(this.drainTimer);
    this.drainTimer = undefined;
  }

  private receive(frame: DirectFrame): void {
    const handler = this.streams.get(frame.stream);
    if (!handler) return;
    if (frame.type === "data") handler.data(frame.data);
    else {
      this.streams.delete(frame.stream);
      handler.close(false);
    }
  }

  private drained(): void {
    this.flushPending();
    if (this.backedUp) return;
    const waiting = [...this.waiting];
    this.waiting.clear();
    this.maybeStopDrainPoll();
    for (const resume of waiting) resume();
  }

  /** The connection is gone: so is every stream on it. */
  private lose(connection: RTCPeerConnection): void {
    if (this.connection !== connection) return;
    this.stopDrainPoll();
    this.connection = undefined;
    this.channel = undefined;
    this.pending.length = 0;
    this.pendingBytes = 0;
    const streams = [...this.streams.values()];
    this.streams.clear();
    this.waiting.clear();
    if (streams.length > 0) this.log(`[direct] channel lost with ${streams.length} stream${streams.length === 1 ? "" : "s"} open`);
    for (const handler of streams) handler.close(true);
    void connection.close().catch(() => {});
  }
}

/** Resolves once the connection has gathered its addresses, or has looked long enough. */
function gathered(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let sub: { unSubscribe?: () => void } | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub?.unSubscribe?.();
      resolve();
    };
    const timer = setTimeout(finish, GATHER_MS);
    timer.unref();
    sub = connection.iceGatheringStateChange.subscribe((state) => {
      if (state !== "complete") return;
      finish();
    });
    if (connection.iceGatheringState === "complete") finish();
  });
}
