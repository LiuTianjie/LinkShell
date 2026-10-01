import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { DIRECT_LABEL, decodeDirectFrame, encodeDirectFrame, type DirectFrame } from "@linkshell/wire";

// The host's end of the direct channel (see wire/direct.ts): one WebRTC
// connection per device connection, made when the device offers one, carrying
// the bulk streams that would otherwise go through the gateway.

/** Stop reading a stream's source while this much is waiting to go out… */
const HIGH_WATER = 1024 * 1024;
/** …and read on once it is down to this. */
const LOW_WATER = 256 * 1024;
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
    await connection.setRemoteDescription({ type: "offer", sdp });
    await connection.setLocalDescription(await connection.createAnswer());
    await gathered(connection);
    const answer = connection.localDescription?.sdp;
    if (!answer) throw new Error("no answer could be made");
    return answer;
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

  send(frame: DirectFrame): void {
    if (!this.open) return;
    try {
      this.channel!.send(Buffer.from(encodeDirectFrame(frame)));
    } catch (error) {
      this.log(`[direct] send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** True while the device isn't keeping up: hold the stream's source until `whenDrained`. */
  get backedUp(): boolean {
    return (this.channel?.bufferedAmount ?? 0) > HIGH_WATER;
  }

  whenDrained(resume: () => void): void {
    this.waiting.add(resume);
  }

  close(): void {
    const connection = this.connection;
    if (!connection) return;
    this.lose(connection);
    void connection.close().catch(() => {});
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
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const resume of waiting) resume();
  }

  /** The connection is gone: so is every stream on it. */
  private lose(connection: RTCPeerConnection): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    this.channel = undefined;
    const streams = [...this.streams.values()];
    this.streams.clear();
    this.waiting.clear();
    if (streams.length > 0) this.log(`[direct] channel lost with ${streams.length} stream${streams.length === 1 ? "" : "s"} open`);
    for (const handler of streams) handler.close(true);
  }
}

/** Resolves once the connection has gathered its addresses, or has looked long enough. */
function gathered(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, GATHER_MS);
    connection.iceGatheringStateChange.subscribe((state) => {
      if (state !== "complete") return;
      clearTimeout(timer);
      resolve();
    });
  });
}
