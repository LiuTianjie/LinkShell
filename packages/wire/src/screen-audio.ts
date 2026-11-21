/**
 * Binary packet framing for the remote screen `"audio"` lossy WebRTC DataChannel.
 * Format (8-byte big-endian header + payload):
 *   [u8 version=1][u8 codec][u16 seq BE][u32 timestampMs BE][payload]
 */

export const SCREEN_AUDIO_VERSION = 1;
export const SCREEN_AUDIO_CODEC_OPUS = 1;
export const SCREEN_AUDIO_CODEC_PCM16 = 2;
export const SCREEN_AUDIO_SAMPLE_RATE = 48000;
export const SCREEN_AUDIO_CHANNELS = 2;
export const SCREEN_AUDIO_FRAME_MS = 20;
export const SCREEN_AUDIO_HEADER_BYTES = 8;

export type ScreenAudioCodec = typeof SCREEN_AUDIO_CODEC_OPUS | typeof SCREEN_AUDIO_CODEC_PCM16;

export interface ScreenAudioPacketInput {
  codec: ScreenAudioCodec;
  seq: number;
  timestampMs: number;
  payload: Uint8Array;
}

export interface ScreenAudioPacket {
  version: number;
  codec: ScreenAudioCodec;
  seq: number;
  timestampMs: number;
  payload: Uint8Array;
}

export function encodeScreenAudioPacket(input: ScreenAudioPacketInput): Uint8Array {
  const out = new Uint8Array(SCREEN_AUDIO_HEADER_BYTES + input.payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, SCREEN_AUDIO_VERSION);
  view.setUint8(1, input.codec);
  view.setUint16(2, input.seq & 0xffff, false);
  view.setUint32(4, input.timestampMs >>> 0, false);
  out.set(input.payload, SCREEN_AUDIO_HEADER_BYTES);
  return out;
}

export function decodeScreenAudioPacket(bytes: Uint8Array): ScreenAudioPacket | undefined {
  if (bytes.byteLength < SCREEN_AUDIO_HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== SCREEN_AUDIO_VERSION) return undefined;
  const codec = view.getUint8(1);
  if (codec !== SCREEN_AUDIO_CODEC_OPUS && codec !== SCREEN_AUDIO_CODEC_PCM16) return undefined;
  const seq = view.getUint16(2, false);
  const timestampMs = view.getUint32(4, false);
  const payload = bytes.subarray(SCREEN_AUDIO_HEADER_BYTES);
  return { version, codec, seq, timestampMs, payload };
}
