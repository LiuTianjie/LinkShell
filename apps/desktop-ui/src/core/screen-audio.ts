import {
  SCREEN_AUDIO_CHANNELS,
  SCREEN_AUDIO_CODEC_OPUS,
  SCREEN_AUDIO_CODEC_PCM16,
  SCREEN_AUDIO_SAMPLE_RATE,
  decodeScreenAudioPacket,
} from "@linkshell/wire";

export interface ScreenAudioContextLike {
  readonly state: AudioContextState | string;
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly destination: AudioNode;
  resume(): Promise<void> | void;
  close(): Promise<void> | void;
  createGain(): GainNode;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
}

export interface ScreenAudioPlayerDeps {
  createAudioContext?: (sampleRate: number) => ScreenAudioContextLike | undefined;
  AudioDecoderCtor?: typeof AudioDecoder;
  EncodedAudioChunkCtor?: typeof EncodedAudioChunk;
}

function defaultCreateAudioContext(sampleRate: number): ScreenAudioContextLike | undefined {
  if (typeof window === "undefined") return undefined;
  const win = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor =
    win.AudioContext ??
    (typeof AudioContext !== "undefined" ? AudioContext : undefined) ??
    win.webkitAudioContext;
  if (!Ctor) return undefined;
  try {
    return new Ctor({ sampleRate });
  } catch {
    return new Ctor();
  }
}

function toUint8Array(raw: unknown): Uint8Array | undefined {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return undefined;
}

/**
 * Remote screen `"audio"` WebRTC DataChannel player.
 * Parses `@linkshell/wire` 8-byte binary packets and renders Opus (via WebCodecs
 * `AudioDecoder`) or interleaved 48 kHz stereo PCM16 through jitter-buffered
 * `AudioContext` + `GainNode` scheduling.
 */
export class ScreenAudioPlayer {
  private readonly createAudioContext: (sampleRate: number) => ScreenAudioContextLike | undefined;
  private readonly AudioDecoderCtor?: typeof AudioDecoder;
  private readonly EncodedAudioChunkCtor?: typeof EncodedAudioChunk;

  private enabled = false;
  private ctx?: ScreenAudioContextLike;
  private gainNode?: GainNode;
  private nextTime = 0;
  private opusDecoder?: AudioDecoder;
  private opusFailed = false;
  private disposed = false;

  constructor(deps: ScreenAudioPlayerDeps = {}) {
    this.createAudioContext = deps.createAudioContext ?? defaultCreateAudioContext;
    this.AudioDecoderCtor =
      deps.AudioDecoderCtor ?? (typeof AudioDecoder !== "undefined" ? AudioDecoder : undefined);
    this.EncodedAudioChunkCtor =
      deps.EncodedAudioChunkCtor ??
      (typeof EncodedAudioChunk !== "undefined" ? EncodedAudioChunk : undefined);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private ensureContext(): ScreenAudioContextLike | undefined {
    if (this.disposed) return undefined;
    if (this.ctx) return this.ctx;
    const created = this.createAudioContext(SCREEN_AUDIO_SAMPLE_RATE);
    if (!created) return undefined;
    this.ctx = created;
    this.gainNode = created.createGain();
    this.gainNode.gain.value = this.enabled ? 1 : 0;
    this.gainNode.connect(created.destination);
    return created;
  }

  /** Synchronously creates/resumes AudioContext; invoke inside the user's toggle click handler. */
  unlock(): ScreenAudioContextLike | undefined {
    const ctx = this.ensureContext();
    if (!ctx) return undefined;
    if (this.gainNode) {
      this.gainNode.gain.value = this.enabled ? 1 : 0;
    }
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      try {
        void Promise.resolve(ctx.resume()).catch(() => {});
      } catch {
        // Ignore resume errors in headless environments.
      }
    }
    return ctx;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    if (enabled) {
      this.nextTime = 0;
      this.unlock();
      return;
    }
    if (this.gainNode) {
      this.gainNode.gain.value = 0;
    }
    this.resetPlayback();
  }

  handleMessage(raw: unknown): void {
    if (this.disposed || !this.enabled) return;
    if (typeof Blob !== "undefined" && raw instanceof Blob) {
      void raw
        .arrayBuffer()
        .then((buf) => this.handleMessage(buf))
        .catch(() => {});
      return;
    }
    const bytes = toUint8Array(raw);
    if (!bytes) return;
    const packet = decodeScreenAudioPacket(bytes);
    if (!packet || packet.payload.byteLength === 0) return;

    if (packet.codec === SCREEN_AUDIO_CODEC_PCM16) {
      this.decodePcm16(packet.payload);
      return;
    }
    if (packet.codec === SCREEN_AUDIO_CODEC_OPUS) {
      const dec = this.ensureOpusDecoder();
      if (!dec || dec.state !== "configured" || !this.EncodedAudioChunkCtor) return;
      try {
        dec.decode(
          new this.EncodedAudioChunkCtor({
            type: "key",
            timestamp: packet.timestampMs * 1000,
            data: packet.payload,
          }),
        );
      } catch {
        // Drop invalid/corrupt Opus packet cleanly.
      }
    }
  }

  private scheduleChannels(channelArrays: Float32Array[], sampleRate: number): void {
    if (this.disposed || !this.enabled || channelArrays.length === 0) return;
    const frames = channelArrays[0]?.length ?? 0;
    if (frames === 0) return;
    const ctx = this.ensureContext();
    if (!ctx || ctx.state === "closed") return;
    if (ctx.state !== "running") {
      this.nextTime = 0;
      return;
    }

    const chCount = Math.max(1, channelArrays.length);
    const rate = sampleRate || ctx.sampleRate || SCREEN_AUDIO_SAMPLE_RATE;
    const buffer = ctx.createBuffer(chCount, frames, rate);
    for (let ch = 0; ch < chCount; ch++) {
      buffer.getChannelData(ch).set(channelArrays[ch]!);
    }

    const now = ctx.currentTime;
    if (this.nextTime < now + 0.015 || this.nextTime - now > 0.25) {
      this.nextTime = now + 0.04;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode ?? ctx.destination);
    source.start(this.nextTime);
    this.nextTime += frames / rate;
  }

  private decodePcm16(payload: Uint8Array): void {
    const frames = Math.floor(payload.byteLength / (SCREEN_AUDIO_CHANNELS * 2));
    if (frames <= 0) return;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset,
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

  private handleDecodedAudioData = (audioData: AudioData): void => {
    try {
      if (this.disposed || !this.enabled) return;
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
        return;
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
        // Ignore double-close.
      }
    }
  };

  private ensureOpusDecoder(): AudioDecoder | undefined {
    if (this.opusDecoder || this.opusFailed) return this.opusDecoder;
    if (!this.AudioDecoderCtor || !this.EncodedAudioChunkCtor) {
      this.opusFailed = true;
      return undefined;
    }
    try {
      const decoder = new this.AudioDecoderCtor({
        output: this.handleDecodedAudioData,
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

  private resetPlayback(): void {
    this.nextTime = 0;
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.resetPlayback();
    try {
      this.gainNode?.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
    this.gainNode = undefined;
    const ctx = this.ctx;
    this.ctx = undefined;
    if (ctx && ctx.state !== "closed") {
      try {
        void Promise.resolve(ctx.close()).catch(() => {});
      } catch {
        // Ignore close failure.
      }
    }
  }
}
