// The direct channel: bulk streams (the screen, port previews) go from the
// computer to the device peer to peer, over a WebRTC data channel, instead of
// through the gateway. The offer and answer travel over the end-to-end
// encrypted RPC channel, so the gateway can neither read them nor stand in for
// either side; it carries only what little sets the connection up. When no
// direct path can be made, the streams stay on the RPC channel as before.

/** The data channel both sides use. */
export const DIRECT_LABEL = "linkshell-bulk";

/** The most stream bytes in one message: every WebRTC stack takes this size. */
export const DIRECT_CHUNK = 16 * 1024;

/**
 * STUN servers used when a host names none: they only tell each side its
 * public address. (Several, because none of them is reachable everywhere.)
 */
export const DEFAULT_ICE_SERVERS = ["stun:stun.cloudflare.com:3478", "stun:stun.chat.bilibili.com:3478", "stun:stun.l.google.com:19302"];

export type DirectFrame =
  | { type: "data"; stream: number; data: Uint8Array }
  /** The sender's end of the stream is finished (`error`: why, when it broke). */
  | { type: "close"; stream: number; error?: string };

const DATA = 1;
const CLOSE = 2;

export function encodeDirectFrame(frame: DirectFrame): Uint8Array {
  const payload = frame.type === "data" ? frame.data : new TextEncoder().encode(frame.error ?? "");
  const bytes = new Uint8Array(5 + payload.length);
  bytes[0] = frame.type === "data" ? DATA : CLOSE;
  new DataView(bytes.buffer).setUint32(1, frame.stream);
  bytes.set(payload, 5);
  return bytes;
}

export function decodeDirectFrame(bytes: Uint8Array): DirectFrame | undefined {
  if (bytes.length < 5) return undefined;
  const stream = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
  const payload = bytes.subarray(5);
  if (bytes[0] === DATA) return { type: "data", stream, data: payload };
  if (bytes[0] === CLOSE) return { type: "close", stream, error: payload.length ? new TextDecoder().decode(payload) : undefined };
  return undefined;
}
