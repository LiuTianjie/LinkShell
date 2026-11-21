import { describe, expect, it } from "vitest";
import {
  decodeScreenAudioPacket,
  encodeScreenAudioPacket,
  SCREEN_AUDIO_CHANNELS,
  SCREEN_AUDIO_CODEC_OPUS,
  SCREEN_AUDIO_CODEC_PCM16,
  SCREEN_AUDIO_FRAME_MS,
  SCREEN_AUDIO_HEADER_BYTES,
  SCREEN_AUDIO_SAMPLE_RATE,
  SCREEN_AUDIO_VERSION,
} from "../src/index.js";

describe("screen audio binary packet framing", () => {
  it("exports standard 48kHz stereo 20ms audio constants", () => {
    expect(SCREEN_AUDIO_VERSION).toBe(1);
    expect(SCREEN_AUDIO_CODEC_OPUS).toBe(1);
    expect(SCREEN_AUDIO_CODEC_PCM16).toBe(2);
    expect(SCREEN_AUDIO_SAMPLE_RATE).toBe(48000);
    expect(SCREEN_AUDIO_CHANNELS).toBe(2);
    expect(SCREEN_AUDIO_FRAME_MS).toBe(20);
    expect(SCREEN_AUDIO_HEADER_BYTES).toBe(8);
  });

  it("round-trips Opus and PCM16 packets with big-endian header fields", () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    const encoded = encodeScreenAudioPacket({
      codec: SCREEN_AUDIO_CODEC_OPUS,
      seq: 0x1234,
      timestampMs: 0x01020304,
      payload,
    });
    expect(encoded.byteLength).toBe(8 + payload.byteLength);
    expect(Array.from(encoded.subarray(0, 8))).toEqual([1, 1, 0x12, 0x34, 0x01, 0x02, 0x03, 0x04]);

    const decoded = decodeScreenAudioPacket(encoded);
    expect(decoded).toBeDefined();
    expect(decoded?.version).toBe(1);
    expect(decoded?.codec).toBe(SCREEN_AUDIO_CODEC_OPUS);
    expect(decoded?.seq).toBe(0x1234);
    expect(decoded?.timestampMs).toBe(0x01020304);
    expect(Array.from(decoded!.payload)).toEqual(Array.from(payload));

    const pcmEncoded = encodeScreenAudioPacket({
      codec: SCREEN_AUDIO_CODEC_PCM16,
      seq: 65537,
      timestampMs: 42,
      payload: new Uint8Array([0x10, 0x20]),
    });
    const pcmDecoded = decodeScreenAudioPacket(pcmEncoded);
    expect(pcmDecoded?.codec).toBe(SCREEN_AUDIO_CODEC_PCM16);
    expect(pcmDecoded?.seq).toBe(1);
    expect(pcmDecoded?.timestampMs).toBe(42);
  });

  it("rejects truncated frames, unknown versions, and unknown codecs", () => {
    expect(decodeScreenAudioPacket(new Uint8Array(7))).toBeUndefined();
    expect(decodeScreenAudioPacket(new Uint8Array([2, 1, 0, 1, 0, 0, 0, 1, 0xff]))).toBeUndefined();
    expect(decodeScreenAudioPacket(new Uint8Array([1, 9, 0, 1, 0, 0, 0, 1, 0xff]))).toBeUndefined();
  });
});
