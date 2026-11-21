import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCREEN_AUDIO_CHANNELS,
  SCREEN_AUDIO_CODEC_OPUS,
  SCREEN_AUDIO_CODEC_PCM16,
  SCREEN_AUDIO_SAMPLE_RATE,
  encodeScreenAudioPacket,
} from "@linkshell/wire";

type Events = { open(): void; data(value: string | ArrayBuffer): void; close(reason?: string): void };
const sockets = vi.hoisted(() => [] as { path: string; events: Events; sent: string[] }[]);

vi.mock("../src/live/transport", () => ({
  openWebSocket: async (_streams: unknown, _port: number, path: string, events: Events) => {
    const socket = { path, events, sent: [] as string[], send(text: string) { socket.sent.push(text); }, close() {} };
    sockets.push(socket);
    queueMicrotask(() => events.open());
    return socket;
  },
}));

import { SCREEN_IDLE, ScreenReceiver, type ReceiverState } from "../src/live/screen-receiver";

class FakeVideo extends EventTarget {
  muted = false;
  playsInline = false;
  srcObject: unknown = null;
}

class FakeAudioContext {
  state: AudioContextState = "suspended";
  sampleRate = SCREEN_AUDIO_SAMPLE_RATE;
  currentTime = 1;
  destination = {};
  gainNode = { gain: { value: 0 }, connect: vi.fn() };
  scheduled: Array<{ buffer: { channels: Float32Array[]; sampleRate: number }; at: number }> = [];
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createGain = () => this.gainNode;
  createBuffer = (channels: number, frames: number, sampleRate: number) => {
    const channelData = Array.from({ length: channels }, () => new Float32Array(frames));
    return {
      channels: channelData,
      sampleRate,
      getChannelData: (index: number) => channelData[index]!,
    };
  };
  createBufferSource = () => {
    const source = {
      buffer: null as unknown as { channels: Float32Array[]; sampleRate: number },
      connect: vi.fn(),
      start: (at: number) => {
        this.scheduled.push({ buffer: source.buffer, at });
      },
    };
    return source;
  };
}

class FakeDataChannel {
  label: string;
  binaryType = "blob";
  readyState: RTCDataChannelState = "open";
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(label: string) {
    this.label = label;
  }
  send = vi.fn();
  close = () => {
    this.closed = true;
  };
}

class FakePeerConnection {
  static latest: FakePeerConnection | undefined;
  ontrack: ((event: unknown) => void) | null = null;
  ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null = null;
  onicecandidate: ((event: unknown) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = "new";
  iceConnectionState = "new";
  constructor() {
    FakePeerConnection.latest = this;
  }
  getTransceivers = () => [];
  setRemoteDescription = vi.fn(async () => {});
  createAnswer = vi.fn(async () => ({ type: "answer", sdp: "v=0" }));
  setLocalDescription = vi.fn(async () => {});
  addIceCandidate = vi.fn(async () => {});
  close = vi.fn();
}

async function settle() {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

function receiver(options: { videoTrack?: boolean; audio?: boolean } = {}) {
  const states: ReceiverState[] = [];
  const created = new ScreenReceiver({
    link: { call: async () => ({ port: 5000, token: "t", displays: [{ index: 0, name: "A" }] }) } as never,
    streams: {} as never,
    target: { display: 0, width: 1920, maxFps: 60 },
    active: true,
    control: false,
    hevc: false,
    relayed: true,
    ...options,
    video: new FakeVideo() as unknown as HTMLVideoElement,
    canvas: { getContext: () => null } as unknown as HTMLCanvasElement,
    onState: (state) => states.push(state),
    onCursor: () => {},
  });
  return { created, states };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  sockets.length = 0;
  FakePeerConnection.latest = undefined;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("screen receiver signaling & audio", () => {
  it("says it takes a TURN login, and asks for a video track unless told to go straight to the socket", async () => {
    receiver();
    receiver({ videoTrack: false });
    await settle();
    const [track, socket] = sockets.map((entry) => new URL(entry.path, "http://localhost").searchParams);
    expect(track!.get("turn")).toBe("1");
    expect(track!.get("video")).toBe("1");
    expect(socket!.get("video")).toBe("0");
  });

  it("says someone uses the picture at most every 15 s", async () => {
    const { created } = receiver();
    await settle();
    const said = () => sockets[0]!.sent.filter((text) => JSON.parse(text).t === "activity").length;
    created.used();
    created.used();
    expect(said()).toBe(1);
    vi.advanceTimersByTime(15_000);
    created.used();
    expect(said()).toBe(2);
    created.stop();
  });

  it("ends for good when the host ended an unused relayed picture: no other path is tried", async () => {
    const { created, states } = receiver();
    await settle();
    sockets[0]!.events.data(JSON.stringify({ error: SCREEN_IDLE }));
    expect(states.at(-1)).toMatchObject({ phase: "error", idle: true, taken: false });
    expect(sockets[0]!.sent.some((text) => JSON.parse(text).t === "rtc.failed")).toBe(false);
    expect(created.state.idle).toBe(true);
  });

  it("passes audio=1 when audio is supported or requested, resumes AudioContext, and sends { t: 'audio', enabled }", async () => {
    const contexts: FakeAudioContext[] = [];
    vi.stubGlobal("window", {
      AudioContext: class extends FakeAudioContext {
        constructor() {
          super();
          contexts.push(this);
        }
      },
    });
    const { created, states } = receiver({ audio: false });
    await settle();

    const params = new URL(sockets[0]!.path, "http://localhost").searchParams;
    expect(params.get("audio")).toBe("1");
    expect(sockets[0]!.sent.some((raw) => raw === JSON.stringify({ t: "audio", enabled: false }))).toBe(true);

    created.setAudio(true);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.resume).toHaveBeenCalledTimes(1);
    expect(contexts[0]!.gainNode.gain.value).toBe(1);
    expect(states.at(-1)?.audio).toBe(true);
    expect(sockets[0]!.sent.at(-1)).toBe(JSON.stringify({ t: "audio", enabled: true }));

    created.setAudio(false);
    expect(contexts[0]!.gainNode.gain.value).toBe(0);
    expect(states.at(-1)?.audio).toBe(false);
    expect(sockets[0]!.sent.at(-1)).toBe(JSON.stringify({ t: "audio", enabled: false }));
    created.stop();
    expect(contexts[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("decodes PCM16 and Opus frames received over the 'audio' DataChannel", async () => {
    const contexts: FakeAudioContext[] = [];
    const decodedChunks: unknown[] = [];
    vi.stubGlobal("window", {
      AudioContext: class extends FakeAudioContext {
        constructor() {
          super();
          contexts.push(this);
        }
      },
    });
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal("EncodedAudioChunk", class {
      init: unknown;
      constructor(init: unknown) {
        this.init = init;
      }
    });
    vi.stubGlobal("AudioDecoder", class {
      state = "unconfigured";
      private output: (data: unknown) => void;
      constructor(init: { output: (data: unknown) => void }) {
        this.output = init.output;
      }
      configure = vi.fn(() => {
        this.state = "configured";
      });
      decode = vi.fn((chunk: unknown) => {
        decodedChunks.push(chunk);
        const closed = vi.fn();
        this.output({
          numberOfFrames: 2,
          numberOfChannels: SCREEN_AUDIO_CHANNELS,
          sampleRate: SCREEN_AUDIO_SAMPLE_RATE,
          copyTo: (dest: Float32Array, opts: { planeIndex: number }) => {
            dest.fill(opts.planeIndex === 0 ? 0.25 : -0.25);
          },
          close: closed,
        });
        expect(closed).toHaveBeenCalledTimes(1);
      });
      close = vi.fn();
    });

    const { created } = receiver({ audio: true });
    await settle();
    created.setAudio(true);

    sockets[0]!.events.data(JSON.stringify({ rtc: { t: "config", iceServers: [] } }));
    const pc = FakePeerConnection.latest!;
    const audioChannel = new FakeDataChannel("audio");
    pc.ondatachannel?.({ channel: audioChannel });
    expect(audioChannel.binaryType).toBe("arraybuffer");

    // 1. PCM16 stereo frame (two stereo samples: [16384, -16384], [8192, -8192])
    const pcmPayload = new Uint8Array(8);
    const view = new DataView(pcmPayload.buffer);
    view.setInt16(0, 16384, true);
    view.setInt16(2, -16384, true);
    view.setInt16(4, 8192, true);
    view.setInt16(6, -8192, true);
    const pcmPacket = encodeScreenAudioPacket({
      codec: SCREEN_AUDIO_CODEC_PCM16,
      seq: 1,
      timestampMs: 20,
      payload: pcmPayload,
    });
    audioChannel.onmessage?.(new MessageEvent("message", { data: pcmPacket.buffer }));
    // Duplicate seq should be ignored cleanly.
    audioChannel.onmessage?.(new MessageEvent("message", { data: pcmPacket.buffer }));

    expect(contexts[0]!.scheduled).toHaveLength(1);
    expect(contexts[0]!.scheduled[0]!.buffer.channels[0]![0]).toBeCloseTo(0.5, 4);
    expect(contexts[0]!.scheduled[0]!.buffer.channels[1]![0]).toBeCloseTo(-0.5, 4);

    // 2. Opus frame via WebCodecs AudioDecoder
    const opusPacket = encodeScreenAudioPacket({
      codec: SCREEN_AUDIO_CODEC_OPUS,
      seq: 2,
      timestampMs: 40,
      payload: new Uint8Array([0xfc, 0x01, 0x02]),
    });
    audioChannel.onmessage?.(new MessageEvent("message", { data: opusPacket }));

    expect(decodedChunks).toHaveLength(1);
    expect(contexts[0]!.scheduled).toHaveLength(2);
    expect(contexts[0]!.scheduled[1]!.buffer.channels[0]![0]).toBeCloseTo(0.25, 4);
    expect(contexts[0]!.scheduled[1]!.buffer.channels[1]![0]).toBeCloseTo(-0.25, 4);

    created.stop();
  });
});
