import {
  SCREEN_AUDIO_CHANNELS,
  SCREEN_AUDIO_CODEC_OPUS,
  SCREEN_AUDIO_CODEC_PCM16,
  SCREEN_AUDIO_HEADER_BYTES,
  SCREEN_AUDIO_SAMPLE_RATE,
  SCREEN_AUDIO_VERSION,
} from "@linkshell/wire";

/**
 * Browser-side audio receiver for the "audio" WebRTC DataChannel.
 * Parses `@linkshell/wire` 8-byte binary audio frames and plays Opus (via WebCodecs)
 * or interleaved PCM16 via jitter-buffered AudioContext scheduling at 48 kHz stereo.
 */
export const AUDIO_SCRIPT = String.raw`
const AUDIO_VERSION = ${SCREEN_AUDIO_VERSION};
const AUDIO_CODEC_OPUS = ${SCREEN_AUDIO_CODEC_OPUS};
const AUDIO_CODEC_PCM16 = ${SCREEN_AUDIO_CODEC_PCM16};
const AUDIO_SAMPLE_RATE = ${SCREEN_AUDIO_SAMPLE_RATE};
const AUDIO_CHANNELS = ${SCREEN_AUDIO_CHANNELS};
const AUDIO_HEADER_BYTES = ${SCREEN_AUDIO_HEADER_BYTES};

const audioRequested = query.get("audio") === "1";
let audioEnabled = audioRequested;
let audioCtx = null;
let audioGainNode = null;
let audioNextTime = 0;
let opusDecoder = null;
let opusFailed = false;

function ensureAudioContext() {
  if (audioCtx) return audioCtx;
  const Ctor = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  if (!Ctor) return null;
  try {
    audioCtx = new Ctor({ sampleRate: AUDIO_SAMPLE_RATE });
  } catch {
    audioCtx = new Ctor();
  }
  audioGainNode = audioCtx.createGain();
  audioGainNode.gain.value = audioEnabled ? 1 : 0;
  audioGainNode.connect(audioCtx.destination);
  return audioCtx;
}

function unlockScreenAudio() {
  const ctx = ensureAudioContext();
  if (!ctx) return null;
  if (audioGainNode) audioGainNode.gain.value = audioEnabled ? 1 : 0;
  if (ctx.state === "suspended" && typeof ctx.resume === "function") {
    Promise.resolve(ctx.resume()).catch(() => {});
  }
  return ctx;
}

function parseScreenAudioPacket(raw) {
  let bytes = null;
  if (raw instanceof Uint8Array) bytes = raw;
  else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
  else if (ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (!bytes || bytes.byteLength < AUDIO_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== AUDIO_VERSION) return null;
  const codec = view.getUint8(1);
  if (codec !== AUDIO_CODEC_OPUS && codec !== AUDIO_CODEC_PCM16) return null;
  const seq = view.getUint16(2, false);
  const timestampMs = view.getUint32(4, false);
  const payload = bytes.subarray(AUDIO_HEADER_BYTES);
  return { version, codec, seq, timestampMs, payload };
}

function scheduleAudioChannels(channelArrays, sampleRate) {
  if (!audioEnabled || !channelArrays.length || !channelArrays[0].length) return;
  const ctx = ensureAudioContext();
  if (!ctx || ctx.state === "closed") return;
  // Drop audio frames while AudioContext is suspended/interrupted so AudioBufferSourceNodes
  // never pile up at a frozen currentTime and blast on resume.
  if (ctx.state !== "running") {
    audioNextTime = 0;
    return;
  }
  const frames = channelArrays[0].length;
  const chCount = Math.max(1, channelArrays.length);
  const rate = sampleRate || ctx.sampleRate || AUDIO_SAMPLE_RATE;
  const buffer = ctx.createBuffer(chCount, frames, rate);
  for (let ch = 0; ch < chCount; ch++) {
    const target = buffer.getChannelData(ch);
    target.set(channelArrays[ch]);
  }
  const now = ctx.currentTime;
  if (audioNextTime < now + 0.015 || audioNextTime - now > 0.25) {
    audioNextTime = now + 0.04;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioGainNode || ctx.destination);
  source.start(audioNextTime);
  audioNextTime += frames / rate;
}

function decodePcm16Packet(payload) {
  const frames = Math.floor(payload.byteLength / (AUDIO_CHANNELS * 2));
  if (frames <= 0) return;
  const view = new DataView(payload.buffer, payload.byteOffset, frames * AUDIO_CHANNELS * 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const offset = i * 4;
    left[i] = view.getInt16(offset, true) / 32768;
    right[i] = view.getInt16(offset + 2, true) / 32768;
  }
  scheduleAudioChannels([left, right], AUDIO_SAMPLE_RATE);
}

function handleDecodedAudioData(audioData) {
  try {
    if (!audioEnabled) return;
    const frames = audioData.numberOfFrames;
    const channels = Math.max(1, Math.min(AUDIO_CHANNELS, audioData.numberOfChannels || AUDIO_CHANNELS));
    if (!frames) return;
    const planar = [];
    try {
      for (let ch = 0; ch < channels; ch++) {
        const out = new Float32Array(frames);
        audioData.copyTo(out, { planeIndex: ch, format: "f32-planar" });
        planar.push(out);
      }
      scheduleAudioChannels(planar, audioData.sampleRate || AUDIO_SAMPLE_RATE);
      return;
    } catch {
      const interleaved = new Float32Array(frames * channels);
      audioData.copyTo(interleaved, { planeIndex: 0 });
      for (let ch = 0; ch < channels; ch++) planar.push(new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let ch = 0; ch < channels; ch++) planar[ch][i] = interleaved[i * channels + ch];
      }
      scheduleAudioChannels(planar, audioData.sampleRate || AUDIO_SAMPLE_RATE);
    }
  } finally {
    try { audioData.close(); } catch {}
  }
}

function ensureOpusDecoder() {
  if (opusDecoder || opusFailed) return opusDecoder;
  if (typeof AudioDecoder === "undefined" || typeof EncodedAudioChunk === "undefined") {
    opusFailed = true;
    return null;
  }
  try {
    opusDecoder = new AudioDecoder({
      output: handleDecodedAudioData,
      error: () => {
        try { opusDecoder && opusDecoder.close(); } catch {}
        opusDecoder = null;
        opusFailed = true;
      },
    });
    opusDecoder.configure({
      codec: "opus",
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: AUDIO_CHANNELS,
    });
    return opusDecoder;
  } catch {
    opusDecoder = null;
    opusFailed = true;
    return null;
  }
}

function handleAudioMessage(raw) {
  if (!audioEnabled) return;
  if (typeof Blob !== "undefined" && raw instanceof Blob) {
    raw.arrayBuffer().then((buf) => handleAudioMessage(buf)).catch(() => {});
    return;
  }
  const packet = parseScreenAudioPacket(raw);
  if (!packet || !packet.payload.byteLength) return;
  if (packet.codec === AUDIO_CODEC_PCM16) {
    decodePcm16Packet(packet.payload);
    return;
  }
  if (packet.codec === AUDIO_CODEC_OPUS) {
    const dec = ensureOpusDecoder();
    if (!dec || dec.state !== "configured") return;
    try {
      dec.decode(new EncodedAudioChunk({ type: "key", timestamp: packet.timestampMs * 1000, data: packet.payload }));
    } catch {}
  }
}

function resetAudioPlayback() {
  audioNextTime = 0;
  if (opusDecoder) {
    try { opusDecoder.close(); } catch {}
    opusDecoder = null;
  }
  opusFailed = false;
}

function refreshAudioButton() {
  const el = $("audiobar");
  if (!el) return;
  const copy = L();
  el.classList.toggle("on", audioEnabled);
  el.setAttribute("aria-pressed", String(audioEnabled));
  el.setAttribute("aria-label", audioEnabled ? copy.barAudioMuted : copy.barAudioOn);
  if (typeof ICON === "object" && ICON) {
    el.innerHTML = audioEnabled ? ICON.soundOn : ICON.soundOff;
  }
}

function toggleAudio() {
  audioEnabled = !audioEnabled;
  if (audioEnabled) {
    unlockScreenAudio();
    audioNextTime = 0;
    hint(L().audioOnHint, 1800);
  } else {
    if (audioGainNode) audioGainNode.gain.value = 0;
    resetAudioPlayback();
    hint(L().audioMutedHint, 1800);
  }
  refreshAudioButton();
  send({ t: "audio", enabled: audioEnabled });
  if (typeof window !== "undefined" && !window.__linkshellSyncingAudio && window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === "function") {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "audio", enabled: audioEnabled }));
  }
}

if (audioEnabled && typeof addEventListener === "function") {
  for (const ev of ["pointerdown", "touchstart", "click", "keydown"]) {
    addEventListener(ev, () => {
      if (audioEnabled && (!audioCtx || audioCtx.state === "suspended")) unlockScreenAudio();
    }, { capture: true, passive: true });
  }
}
`;
