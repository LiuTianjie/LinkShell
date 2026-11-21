import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { runInNewContext } from "node:vm";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeScreenAudioPacket,
  SCREEN_AUDIO_CODEC_OPUS,
  SCREEN_AUDIO_CODEC_PCM16,
  SCREEN_AUDIO_SAMPLE_RATE,
} from "@linkshell/wire";

class HelperSocket extends Duplex {
  readonly messages: Record<string, unknown>[] = [];
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
      this.messages.push(JSON.parse(line));
    }
    callback();
  }
  receive(message: object) {
    this.push(`${JSON.stringify(message)}\n`);
  }
}

describe("HelperApp and ScreenShare screen audio control", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("preserves offer.audio on rtc.open and sends rtc.audio on HelperApp.setAudio", async () => {
    const { HelperApp } = await import("../src/input.js");
    const app = new HelperApp("unused-test-helper", false, () => {});
    cleanups.push(() => app.close());
    const socket = new HelperSocket();
    (app as unknown as { adopt(socket: Socket): void }).adopt(socket as unknown as Socket);

    await app.offerVideo("v1", { screen: 0, iceServers: [], audio: true }, () => {});
    await app.offerVideo("v2", { screen: 0, iceServers: [] }, () => {});
    app.setAudio("v1", true);
    app.setAudio("v1", false);
    app.setAudio("unknown", true);

    expect(socket.messages[0]).toMatchObject({ t: "rtc.open", v: "v1", audio: true });
    expect("audio" in socket.messages[1]!).toBe(false);
    expect(socket.messages.slice(2)).toEqual([
      { t: "rtc.audio", v: "v1", enabled: true },
      { t: "rtc.audio", v: "v1", enabled: false },
    ]);
  });

  it("parses ?audio=1 on viewer WS upgrade and routes { t: 'audio', enabled } to video.setAudio", async () => {
    const offerCalls: Array<{ id: string; offer: Record<string, unknown> }> = [];
    const setAudioCalls: Array<{ id: string; enabled: boolean }> = [];
    const fakeHelper = {
      access: vi.fn(async () => ({ trusted: true, recording: true, app: "LinkShell", video: true, videoReconfigure: true, keys: false, preview: false })),
      displays: vi.fn(async () => [{ index: 0, screen: 0, name: "Main", w: 1920, h: 1080 }]),
      offerVideo: vi.fn(async (id: string, offer: Record<string, unknown>, route: (m: Record<string, unknown>) => void) => {
        offerCalls.push({ id, offer });
        route({ t: "rtc.offer", v: id, sdp: "fake-sdp" });
      }),
      configureVideo: vi.fn(),
      signal: vi.fn(),
      setAudio: vi.fn((id: string, enabled: boolean) => { setAudioCalls.push({ id, enabled }); }),
      endVideo: vi.fn(),
    };

    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
    cleanups.push(() => { Object.defineProperty(process, "platform", originalPlatform); });

    vi.doMock("../src/input.js", async (original) => {
      const actual = await original<typeof import("../src/input.js")>();
      return {
        ...actual,
        inputApp: () => fakeHelper,
        closeInputApp: vi.fn(),
        macAppSupported: () => true,
        InputControl: class {
          start = vi.fn(async () => {});
          send = vi.fn();
          stop = vi.fn();
        },
      };
    });

    const { ScreenShare } = await import("../src/screen.js");
    const share = new ScreenShare(() => {});
    cleanups.push(() => share.stop());
    const { port, token } = await share.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=${encodeURIComponent(token)}&video=1&audio=1`);
    cleanups.push(() => { ws.close(); });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    await vi.waitFor(() => expect(offerCalls).toHaveLength(1));
    expect(offerCalls[0]?.offer.audio).toBe(true);

    ws.send(JSON.stringify({ t: "audio", enabled: false }));
    ws.send(JSON.stringify({ t: "audio", enabled: true }));
    await vi.waitFor(() => expect(setAudioCalls).toHaveLength(2));
    expect(setAudioCalls).toEqual([
      { id: offerCalls[0]!.id, enabled: false },
      { id: offerCalls[0]!.id, enabled: true },
    ]);
  });
});

describe("screen-viewer modular exports, ?audio=1 UI toggle, and audio DataChannel decoding", () => {
  it("exports modular symbols and includes unobtrusive Chinese audio button", async () => {
    const { SCREEN_IDLE, SCREEN_TAKEN, VIEWER_LOGIC, viewerPage } = await import("../src/screen-viewer.js");
    expect(typeof SCREEN_TAKEN).toBe("string");
    expect(typeof SCREEN_IDLE).toBe("string");
    expect(typeof VIEWER_LOGIC).toBe("string");
    const html = viewerPage();
    expect(html).toContain('id="audiobar"');
    expect(html).toContain('aria-label="声音"');
  });

  it("forwards ?audio=1, resumes AudioContext on toggle, and decodes PCM16 & Opus audio packets", async () => {
    const { viewerPage } = await import("../src/screen-viewer.js");
    const page = viewerPage("darwin", "zh");
    const scriptStart = page.lastIndexOf("<script>") + "<script>".length;
    const scriptEnd = page.lastIndexOf("</script>");
    const script = page.slice(scriptStart, scriptEnd);

    const iconsMatch = /<script type="application\/json" id="icons">([\s\S]*?)<\/script>/.exec(page)!;

    const elements = new Map<string, ReturnType<typeof makeEl>>();
    const makeEl = (id = "", tag = "DIV") => {
      const classes = new Set<string>();
      const attrs = new Map<string, string>();
      const listeners = new Map<string, Array<(ev: unknown) => void>>();
      const el: Record<string, unknown> = {
        id,
        tagName: tag,
        dataset: {} as Record<string, string>,
        style: { setProperty: () => {} } as Record<string, unknown>,
        textContent: id === "icons" ? iconsMatch[1]! : "",
        innerHTML: "",
        children: [] as unknown[],
        classList: {
          add: (...c: string[]) => c.forEach((x) => classes.add(x)),
          remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
          toggle: (c: string, force?: boolean) => (force ?? !classes.has(c) ? classes.add(c) : classes.delete(c)),
          contains: (c: string) => classes.has(c),
        },
        setAttribute: (k: string, v: string) => attrs.set(k, String(v)),
        getAttribute: (k: string) => attrs.get(k) ?? null,
        addEventListener: (ev: string, fn: (e: unknown) => void) => {
          const list = listeners.get(ev) ?? [];
          list.push(fn);
          listeners.set(ev, list);
        },
        removeEventListener: () => {},
        dispatchEvent: (ev: { type: string }) => {
          for (const fn of listeners.get(ev.type) ?? []) fn(ev);
          return true;
        },
        querySelector: () => makeEl(),
        querySelectorAll: () => [],
        append: (...c: unknown[]) => { (el.children as unknown[]).push(...c); },
        appendChild: (c: unknown) => { (el.children as unknown[]).push(c); return c; },
        insertAdjacentHTML: () => {},
        replaceChildren: (...c: unknown[]) => { el.children = c; },
        remove: () => {},
        focus: () => {},
        blur: () => {},
        setPointerCapture: () => {},
        releasePointerCapture: () => {},
        setSelectionRange: () => {},
        play: () => Promise.resolve(),
        pause: () => {},
        animate: () => ({ cancel: () => {} }),
        getContext: () => ({ drawImage: () => {}, clearRect: () => {} }),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 44, bottom: 44, width: 44, height: 44 }),
        offsetWidth: 44,
        offsetHeight: 44,
        listeners,
      };
      if (id) elements.set(id, el);
      return el;
    };

    const getEl = (id: string) => elements.get(id) ?? makeEl(id);
    for (const id of [
      "stage", "picture", "screen", "gpu", "video", "pointer", "note", "bar", "control-shell", "orb",
      "menu", "connection", "toast", "keys", "typing", "shortcut", "sheet", "actions", "maker",
      "makername", "composer", "words", "icons", "mode", "keyboard", "quick", "clipbar", "audiobar",
      "fit", "info", "full", "widths", "pacing", "langs", "makermods", "makerkey", "makersign",
      "compose", "sheetkeys", "sheetclose", "composeclose", "pasteclip", "sendreturn", "sendwords",
      "quickkey", "composekey", "hide", "makercancel", "makersave", "pastecomputer", "copycomputer",
      "privacycurtain", "lockdisconnect", "closeinfo", "connheadtext", "widthshead", "pacinghead",
      "cliphead", "privacyhead", "langhead", "status", "wordshint",
    ]) getEl(id);

    const wsSent: string[] = [];
    const openedUrls: string[] = [];
    let activeWs: { onopen?: () => void; onmessage?: (ev: unknown) => void } | undefined;
    class FakeWS {
      readyState = 1;
      binaryType = "blob";
      constructor(url: string) {
        openedUrls.push(url);
        activeWs = this as unknown as { onopen?: () => void };
      }
      send(data: string) { wsSent.push(data); }
      close() { this.readyState = 3; }
    }

    const createdPcs: Array<{ ondatachannel?: (ev: { channel: { label: string; binaryType?: string; onmessage?: (ev: { data: unknown }) => void } }) => void }> = [];
    class FakeRTCPC {
      connectionState = "new";
      iceConnectionState = "new";
      localDescription = { sdp: "ans" };
      constructor() { createdPcs.push(this); }
      async setRemoteDescription() {}
      async createAnswer() { return { type: "answer", sdp: "ans" }; }
      async setLocalDescription() {}
      async addIceCandidate() {}
      close() {}
    }

    const scheduledStarts: Array<{ when: number; length: number; sampleRate: number; left0: number; right0: number }> = [];
    const resumeCalls: number[] = [];
    class FakeAudioContext {
      state = "suspended";
      sampleRate = SCREEN_AUDIO_SAMPLE_RATE;
      currentTime = 1.0;
      destination = {};
      createGain() { return { gain: { value: 1 }, connect: () => {} }; }
      resume() {
        resumeCalls.push(1);
        this.state = "running";
        return Promise.resolve();
      }
      createBuffer(channels: number, length: number, sampleRate: number) {
        const chData = Array.from({ length: channels }, () => new Float32Array(length));
        return {
          length,
          sampleRate,
          numberOfChannels: channels,
          getChannelData: (c: number) => chData[c]!,
          _chData: chData,
        };
      }
      createBufferSource() {
        const src = {
          buffer: null as { length: number; sampleRate: number; _chData: Float32Array[] } | null,
          connect: () => {},
          start: (when = 0) => {
            if (!src.buffer) return;
            scheduledStarts.push({
              when,
              length: src.buffer.length,
              sampleRate: src.buffer.sampleRate,
              left0: src.buffer._chData[0]?.[0] ?? 0,
              right0: src.buffer._chData[1]?.[0] ?? 0,
            });
          },
        };
        return src;
      }
    }

    const opusConfigured: unknown[] = [];
    const opusDecoded: unknown[] = [];
    class FakeAudioDecoder {
      state = "unconfigured";
      private output: (data: unknown) => void;
      constructor(init: { output: (data: unknown) => void }) {
        this.output = init.output;
      }
      configure(cfg: unknown) {
        opusConfigured.push(cfg);
        this.state = "configured";
      }
      decode(chunk: unknown) {
        opusDecoded.push(chunk);
        const samples = new Float32Array(960).fill(0.25);
        this.output({
          numberOfFrames: 960,
          numberOfChannels: 2,
          sampleRate: SCREEN_AUDIO_SAMPLE_RATE,
          copyTo: (dest: Float32Array) => dest.set(samples),
          close: () => {},
        });
      }
      close() { this.state = "closed"; }
    }
    class FakeEncodedAudioChunk {
      constructor(public readonly init: Record<string, unknown>) {}
    }

    const ctxObj: Record<string, unknown> = {
      URLSearchParams,
      location: { protocol: "http:", host: "127.0.0.1:9999", pathname: "/", search: "?video=1&audio=1", replace: () => {} },
      innerWidth: 1000,
      innerHeight: 800,
      visualViewport: null,
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      navigator: { userAgent: "Mozilla/5.0" },
      document: {
        URL: "http://127.0.0.1:9999/",
        hidden: false,
        title: "",
        activeElement: null,
        fullscreenElement: null,
        fullscreenEnabled: false,
        documentElement: { style: { setProperty: () => {} }, classList: { toggle: () => {} } },
        body: { dataset: { platform: "darwin" }, style: { setProperty: () => {} }, clientWidth: 1000, clientHeight: 800 },
        getElementById: (id: string) => getEl(id),
        createElement: (tag: string) => makeEl("", tag.toUpperCase()),
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelector: () => null,
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      requestAnimationFrame: () => 0,
      performance: { now: () => 100 },
      WebSocket: FakeWS,
      RTCPeerConnection: FakeRTCPC,
      AudioContext: FakeAudioContext,
      AudioDecoder: FakeAudioDecoder,
      EncodedAudioChunk: FakeEncodedAudioChunk,
      localStorage: { getItem: () => null, setItem: () => {} },
      JSON,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Map,
      Set,
      Promise,
      Uint8Array,
      Float32Array,
      DataView,
      ArrayBuffer,
      Blob,
      Date,
      Error,
      Infinity,
      encodeURIComponent,
      decodeURIComponent,
    };
    ctxObj.window = ctxObj;
    ctxObj.self = ctxObj;
    ctxObj.globalThis = ctxObj;

    runInNewContext(script, ctxObj);

    expect(openedUrls[0]).toContain("audio=1");
    expect(getEl("audiobar").getAttribute("aria-pressed" as never)).toBe("true");

    // Trigger WS rtc config + audio DataChannel.
    activeWs?.onopen?.();
    activeWs?.onmessage?.({ data: JSON.stringify({ rtc: { t: "config", iceServers: [] } }) });
    expect(createdPcs).toHaveLength(1);

    const audioChannel: { label: string; binaryType?: string; onmessage?: (ev: { data: ArrayBuffer }) => void } = { label: "audio" };
    createdPcs[0]!.ondatachannel?.({ channel: audioChannel });
    expect(audioChannel.binaryType).toBe("arraybuffer");

    // Send a 20 ms 48 kHz stereo PCM16 packet.
    const pcm = Buffer.alloc(960 * 2 * 2);
    pcm.writeInt16LE(16384, 0); // +0.5 left
    pcm.writeInt16LE(-16384, 2); // -0.5 right
    const pcmPacket = encodeScreenAudioPacket({ codec: SCREEN_AUDIO_CODEC_PCM16, seq: 1, timestampMs: 20, payload: pcm });
    const pcmAb = pcmPacket.buffer.slice(pcmPacket.byteOffset, pcmPacket.byteOffset + pcmPacket.byteLength);
    audioChannel.onmessage?.({ data: pcmAb });

    expect(scheduledStarts).toHaveLength(1);
    expect(scheduledStarts[0]!.sampleRate).toBe(48000);
    expect(scheduledStarts[0]!.length).toBe(960);
    expect(scheduledStarts[0]!.left0).toBeCloseTo(0.5, 4);
    expect(scheduledStarts[0]!.right0).toBeCloseTo(-0.5, 4);

    // Send an Opus packet -> WebCodecs AudioDecoder configures & decodes.
    const opusPacket = encodeScreenAudioPacket({ codec: SCREEN_AUDIO_CODEC_OPUS, seq: 2, timestampMs: 40, payload: Buffer.from([1, 2, 3, 4]) });
    const opusAb = opusPacket.buffer.slice(opusPacket.byteOffset, opusPacket.byteOffset + opusPacket.byteLength);
    audioChannel.onmessage?.({ data: opusAb });

    expect(opusConfigured).toEqual([{ codec: "opus", sampleRate: 48000, numberOfChannels: 2 }]);
    expect(opusDecoded).toHaveLength(1);
    expect(scheduledStarts).toHaveLength(2);
    expect(scheduledStarts[1]!.left0).toBeCloseTo(0.25, 4);

    // Tapping #audiobar toggles audio off -> sends { t: "audio", enabled: false }, tapping again unlocks AudioContext & enables.
    const audioEl = getEl("audiobar") as { dispatchEvent: (ev: Record<string, unknown>) => void };
    const tapAudio = () => {
      audioEl.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 10, clientY: 10, stopPropagation: () => {} });
      audioEl.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 10, clientY: 10, stopPropagation: () => {} });
    };
    tapAudio();
    expect(JSON.parse(wsSent.at(-1)!)).toEqual({ t: "audio", enabled: false });
    tapAudio();
    expect(JSON.parse(wsSent.at(-1)!)).toEqual({ t: "audio", enabled: true });
    expect(resumeCalls.length).toBeGreaterThanOrEqual(1);
  });
});
