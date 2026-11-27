import {
  SCREEN_AUDIO_CHANNELS,
  SCREEN_AUDIO_CODEC_OPUS,
  SCREEN_AUDIO_CODEC_PCM16,
  SCREEN_AUDIO_SAMPLE_RATE,
  decodeScreenAudioPacket,
  type ScreenAudioPacket,
} from "@linkshell/wire";

type AudioContextCtor = new (contextOptions?: AudioContextOptions) => AudioContext;

function audioContextConstructor(): AudioContextCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const host = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  const Ctor = host.AudioContext ?? host.webkitAudioContext;
  return typeof Ctor === "function" ? Ctor : undefined;
}

export function supportsScreenAudio(): boolean {
  return Boolean(audioContextConstructor());
}

export function supportsOpusAudio(): boolean {
  return typeof AudioDecoder === "function" && typeof EncodedAudioChunk === "function";
}

function toBytes(raw: unknown): Uint8Array | undefined {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return undefined;
}

/**
 * Plays binary audio frames arriving over the screen `"audio"` WebRTC DataChannel.
 * Supports `@linkshell/wire` PCM16 (48 kHz stereo) and Opus via WebCodecs `AudioDecoder`.
 */
export class ScreenAudioPlayer {
  private enabled: boolean;
  private closed = false;
  private context: AudioContext | undefined;
  private gain: GainNode | undefined;
  private nextTime = 0;
  private lastSeq: number | null = null;
  private opusDecoder: AudioDecoder | undefined;
  private opusFailed = false;

  constructor(options?: { enabled?: boolean }) {
    this.enabled = options?.enabled === true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Call synchronously inside a user gesture to unlock and resume Web Audio output. */
  unlock(): void {
    if (this.closed) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (this.gain) this.gain.gain.value = this.enabled ? 1 : 0;
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      void Promise.resolve(ctx.resume()).catch(() => {});
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.closed) return;
    this.enabled = enabled;
    if (enabled) {
      this.nextTime = 0;
      this.lastSeq = null;
      this.unlock();
      return;
    }
    if (this.gain) this.gain.gain.value = 0;
    this.reset();
  }

  reset(): void {
    this.nextTime = 0;
    this.lastSeq = null;
    if (this.opusDecoder) {
      try {
        this.opusDecoder.close();
      } catch {
        // Ignore already-closed decoder.
      }
      this.opusDecoder = undefined;
    }
    this.opusFailed = false;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.enabled = false;
    this.reset();
    const ctx = this.context;
    this.context = undefined;
    this.gain = undefined;
    if (ctx && typeof ctx.close === "function") {
      void Promise.resolve(ctx.close()).catch(() => {});
    }
  }

  handlePacket(raw: unknown): void {
    if (this.closed || !this.enabled) return;
    if (typeof Blob !== "undefined" && raw instanceof Blob) {
      void raw
        .arrayBuffer()
        .then((buffer) => this.handlePacket(buffer))
        .catch(() => {});
      return;
    }
    const bytes = toBytes(raw);
    if (!bytes) return;
    const packet = decodeScreenAudioPacket(bytes);
    if (!packet || !packet.payload.byteLength) return;
    if (!this.acceptSeq(packet.seq)) return;

    if (packet.codec === SCREEN_AUDIO_CODEC_PCM16) {
      this.playPcm16(packet);
      return;
    }
    if (packet.codec === SCREEN_AUDIO_CODEC_OPUS) {
      this.playOpus(packet);
    }
  }

  private acceptSeq(seq: number): boolean {
    if (this.lastSeq === null) {
      this.lastSeq = seq;
      return true;
    }
    const diff = (seq - this.lastSeq) & 0xffff;
    // Allow large sequence jumps after reconnect/restart while filtering immediate stale duplicates.
    if (diff === 0 || (diff > 0x8000 && diff < 0xfff8)) return false;
    this.lastSeq = seq;
    return true;
  }

  private ensureContext(): AudioContext | undefined {
    if (this.context || this.closed) return this.context;
    const Ctor = audioContextConstructor();
    if (!Ctor) return undefined;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ sampleRate: SCREEN_AUDIO_SAMPLE_RATE });
    } catch {
      ctx = new Ctor();
    }
    const gain = typeof ctx.createGain === "function" ? ctx.createGain() : undefined;
    if (gain) {
      gain.gain.value = this.enabled ? 1 : 0;
      gain.connect(ctx.destination);
    }
    this.context = ctx;
    this.gain = gain;
    return ctx;
  }

  private scheduleChannels(channels: Float32Array[], sampleRate: number): void {
    if (this.closed || !this.enabled || !channels.length || !channels[0]?.length) return;
    const ctx = this.ensureContext();
    if (!ctx || ctx.state === "closed") return;
    if (ctx.state !== "running") {
      this.nextTime = 0;
      return;
    }
    const frames = channels[0].length;
    const rate = sampleRate || ctx.sampleRate || SCREEN_AUDIO_SAMPLE_RATE;
    const buffer = ctx.createBuffer(channels.length, frames, rate);
    for (let ch = 0; ch < channels.length; ch++) {
      buffer.getChannelData(ch).set(channels[ch]!);
    }
    const now = ctx.currentTime;
    if (this.nextTime < now + 0.015 || this.nextTime - now > 0.25) {
      this.nextTime = now + 0.04;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain ?? ctx.destination);
    source.start(this.nextTime);
    this.nextTime += frames / rate;
  }

  private playPcm16(packet: ScreenAudioPacket): void {
    const frames = Math.floor(packet.payload.byteLength / (SCREEN_AUDIO_CHANNELS * 2));
    if (frames <= 0) return;
    const view = new DataView(
      packet.payload.buffer,
      packet.payload.byteOffset,
      frames * SCREEN_AUDIO_CHANNELS * 2,
    );
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      const offset = i * 4;
      left[i] = view.getInt16(offset, true) / 32768;
      right[i] = view.getInt16(offset + 2, true) / 32768;
    }
    this.scheduleChannels([left, right], SCREEN_AUDIO_SAMPLE_RATE);
  }

  private ensureOpusDecoder(): AudioDecoder | undefined {
    if (this.opusDecoder || this.opusFailed || this.closed) return this.opusDecoder;
    if (!supportsOpusAudio()) {
      this.opusFailed = true;
      return undefined;
    }
    try {
      const decoder = new AudioDecoder({
        output: (audioData) => this.handleDecodedOpus(audioData),
        error: () => {
          try {
            decoder.close();
          } catch {
            // Ignore close failure after error.
          }
          if (this.opusDecoder === decoder) this.opusDecoder = undefined;
          this.opusFailed = true;
        },
      });
      decoder.configure({
        codec: "opus",
        sampleRate: SCREEN_AUDIO_SAMPLE_RATE,
        numberOfChannels: SCREEN_AUDIO_CHANNELS,
      });
      this.opusDecoder = decoder;
      return decoder;
    } catch {
      this.opusDecoder = undefined;
      this.opusFailed = true;
      return undefined;
    }
  }

  private handleDecodedOpus(audioData: AudioData): void {
    try {
      if (this.closed || !this.enabled) return;
      const frames = audioData.numberOfFrames;
      const channels = Math.max(
        1,
        Math.min(SCREEN_AUDIO_CHANNELS, audioData.numberOfChannels || SCREEN_AUDIO_CHANNELS),
      );
      if (!frames) return;
      const planar: Float32Array[] = [];
      try {
        for (let ch = 0; ch < channels; ch++) {
          const out = new Float32Array(frames);
          audioData.copyTo(out, { planeIndex: ch, format: "f32-planar" });
          planar.push(out);
        }
        this.scheduleChannels(planar, audioData.sampleRate || SCREEN_AUDIO_SAMPLE_RATE);
      } catch {
        const interleaved = new Float32Array(frames * channels);
        audioData.copyTo(interleaved, { planeIndex: 0 });
        for (let ch = 0; ch < channels; ch++) planar.push(new Float32Array(frames));
        for (let i = 0; i < frames; i++) {
          for (let ch = 0; ch < channels; ch++) {
            planar[ch]![i] = interleaved[i * channels + ch]!;
          }
        }
        this.scheduleChannels(planar, audioData.sampleRate || SCREEN_AUDIO_SAMPLE_RATE);
      }
    } finally {
      try {
        audioData.close();
      } catch {
        // Ignore close failure.
      }
    }
  }

  private playOpus(packet: ScreenAudioPacket): void {
    const decoder = this.ensureOpusDecoder();
    if (!decoder || decoder.state !== "configured") return;
    try {
      decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: packet.timestampMs * 1000,
          data: packet.payload,
        }),
      );
    } catch {
      // Ignore individual bad frames; stream continues on subsequent frames.
    }
  }
}
