import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { LayoutMetrics } from "../modules/link-layout";

vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "18.2", isPad: true, select: (obj: Record<string, unknown>) => obj.ios ?? obj.default },
  PixelRatio: { getFontScale: () => 1 },
  Dimensions: { get: () => ({ width: 669, height: 951 }) },
  AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Appearance: { getColorScheme: () => "light" },
  DynamicColorIOS: (v: unknown) => v,
  View: "View",
}));

vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: () => null,
    setItemSync: () => {},
  },
}));
vi.mock("expo-router", () => ({
  Color: { ios: new Proxy({}, { get: (_, prop) => String(prop) }) },
}));
vi.mock("react-native-reanimated", () => ({ default: { View: "Animated.View" } }));
vi.mock("react-native-webview", () => ({ WebView: "WebView" }));
vi.mock("../src/components/native-screen-pane", () => ({ NativeScreenPane: "NativeScreenPane" }));
vi.mock("../src/components/screen-connection-loading", () => ({ ScreenConnectionLoading: "ScreenConnectionLoading" }));
vi.mock("../modules/link-screen", () => ({ nativeScreenAvailable: false }));
vi.mock("../src/lib/account", () => ({ useAccount: vi.fn() }));
vi.mock("../src/lib/client", () => ({ useClient: vi.fn(), useConnection: vi.fn(), useStreamPath: vi.fn() }));
vi.mock("../src/lib/preview", () => ({ forwardPort: vi.fn() }));
vi.mock("../src/lib/settings", () => ({
  isScreenPacing: vi.fn(),
  isScreenWidth: vi.fn(),
  loadScreenAudio: vi.fn(() => false),
  loadScreenMode: vi.fn(() => "trackpad"),
  loadScreenPacing: vi.fn(() => "low"),
  loadScreenWidth: vi.fn(() => "native"),
  saveScreenAudio: vi.fn(),
  saveScreenMode: vi.fn(),
  saveScreenPacing: vi.fn(),
  saveScreenWidth: vi.fn(),
}));

const { isTransientMetricsCompatible, resolveLayoutMetrics } = await import("../src/lib/use-layout-geometry");
const { workspaceLayout } = await import("../src/lib/workspace-layout");
const { sheetBottom } = await import("../src/lib/sheet-bottom");
const { fixedHeaderFontSize } = await import("../src/components/headers");
const { advanceScreenConnectStage, screenAppStateAction } = await import("../src/lib/screen-session");
const {
  chunkRawTerminalData,
  encodeTerminalKeySequence,
  terminalKeyNameFromInput,
} = await import("../src/lib/terminal-paste");
const { WEBRTC_SCRIPT } = await import("../../../packages/host/src/screen-viewer/webrtc-script");

const CLIENT_ROOT = resolve(__dirname, "..");

describe("Duo transient layout metrics preservation", () => {
  const halfFoldedPortrait: LayoutMetrics = {
    revision: "1:669x869",
    width: 669,
    height: 869,
    insets: { top: 0, right: 0, bottom: 34, left: 0 },
    occlusions: [],
    divisions: [{ x: 0, y: 372.5, width: 669, height: 40, active: true }],
  };

  it("preserves last matched horizontal hinge briefly during same-orientation height shift", () => {
    const shiftedFrame = { width: 669, height: 951 };
    expect(isTransientMetricsCompatible(halfFoldedPortrait, shiftedFrame)).toBe(true);
    const held = resolveLayoutMetrics(halfFoldedPortrait, shiftedFrame, "2:669x951", true);
    expect(held.pending).toBe(true);
    expect(held.metrics?.divisions).toEqual(halfFoldedPortrait.divisions);
    const layout = workspaceLayout(shiftedFrame.width, 1, held.metrics?.divisions, shiftedFrame.height);
    expect(layout.folded).toBe(true);
    expect(layout.axis).toBe("column");
    // Chat/detail pane constrained below horizontal hinge (`before + gap`).
    expect(layout.before + layout.gap).toBe(412.5);
  });

  it("drops stale metrics immediately on grace expiry, orientation flip, or fold to cover screen", () => {
    expect(resolveLayoutMetrics(halfFoldedPortrait, { width: 669, height: 951 }, "2:669x951", false)).toEqual({
      metrics: null,
      pending: false,
    });
    // Orientation flip: portrait -> landscape must never retain portrait hinge.
    expect(resolveLayoutMetrics(halfFoldedPortrait, { width: 951, height: 669 }, "2:951x669", true)).toEqual({
      metrics: null,
      pending: false,
    });
    // Physical fold from inner display (669px) to cover screen (390px) exceeds delta threshold.
    expect(resolveLayoutMetrics(halfFoldedPortrait, { width: 390, height: 844 }, "2:390x844", true)).toEqual({
      metrics: null,
      pending: false,
    });
  });

  it("returns exact matched metrics with pending=false once native revision catches up", () => {
    const exact = resolveLayoutMetrics(halfFoldedPortrait, { width: 669, height: 869 }, "1:669x869", true);
    expect(exact).toEqual({ metrics: halfFoldedPortrait, pending: false });
  });
});

describe("sheetBottom safe-area handling", () => {
  it("reserves safe-area bottom inset on iOS 16–18 even for floating sheets", () => {
    expect(sheetBottom(34, { platformOS: "ios", iosMajorVersion: 16, floating: true })).toBe(50);
    expect(sheetBottom(34, { platformOS: "ios", iosMajorVersion: 17, floating: true })).toBe(50);
    expect(sheetBottom(34, { platformOS: "ios", iosMajorVersion: 18, floating: true })).toBe(50);
  });

  it("reserves safe-area bottom inset on iOS 26+ when sheet can reach full-height detent 1", () => {
    expect(sheetBottom(34, { platformOS: "ios", iosMajorVersion: 26, fullHeight: true })).toBe(50);
    expect(sheetBottom(34, { platformOS: "ios", iosMajorVersion: 26, floating: true, fullHeight: true })).toBe(50);
    expect(sheetBottom(34, { platformOS: "ios", iosMajorVersion: 26 })).toBe(50);
  });

  it("uses compact 8pt bottom padding only for floating compact sheets on iOS 26+", () => {
    expect(sheetBottom(34, { platformOS: "ios", iosMajorVersion: 26, floating: true })).toBe(8);
    expect(sheetBottom(0, { platformOS: "ios", iosMajorVersion: 27, floating: true })).toBe(8);
  });

  it("always reserves bottom inset on Android", () => {
    expect(sheetBottom(24, { platformOS: "android", floating: true })).toBe(40);
    expect(sheetBottom(0, { platformOS: "android" })).toBe(16);
  });
});

describe("Android header font scaling consistency", () => {
  it("normalizes Android sp header sizes to match fixed-text unscaled dp typography", () => {
    expect(fixedHeaderFontSize(22, 1)).toBe(22);
    expect(fixedHeaderFontSize(22, 1.3)).toBe(17);
    expect(fixedHeaderFontSize(22, 1.5)).toBe(15);
    expect(fixedHeaderFontSize(20, 2.0)).toBe(12);
    expect(fixedHeaderFontSize(20, Number.NaN)).toBe(20);
  });
});

describe("ScreenSessionProvider AppState lifecycle & connecting UX invariants", () => {
  it("pauses on transient inactive states and only resets on background", () => {
    expect(screenAppStateAction("active")).toBe("resume");
    expect(screenAppStateAction("inactive")).toBe("pause");
    expect(screenAppStateAction("extension")).toBe("pause");
    expect(screenAppStateAction("unknown")).toBe("pause");
    expect(screenAppStateAction("background")).toBe("reset");
  });

  it("advances connecting stage strictly monotonically so users never see backwards jumps", () => {
    expect(advanceScreenConnectStage("connecting", "connecting")).toBe("connecting");
    expect(advanceScreenConnectStage("connecting", "receiving")).toBe("receiving");
    expect(advanceScreenConnectStage("receiving", "connecting")).toBe("receiving");
    expect(advanceScreenConnectStage("receiving", "live")).toBe("live");
    expect(advanceScreenConnectStage("live", "connecting")).toBe("live");
    expect(advanceScreenConnectStage("live", "receiving")).toBe("live");
  });

  it("never stalls 3 seconds on bulk stream setup and keeps exit/back always reachable while connecting", () => {
    const sessionSource = readFileSync(resolve(CLIENT_ROOT, "src/lib/screen-session.tsx"), "utf8");
    const screenSource = readFileSync(resolve(CLIENT_ROOT, "src/screens/screen-screen.tsx"), "utf8");
    const loadingSource = readFileSync(resolve(CLIENT_ROOT, "src/components/screen-connection-loading.tsx"), "utf8");
    expect(sessionSource).not.toMatch(/setTimeout\(start,\s*3000\)/);
    expect(screenSource).toContain("resolveScreenHeaderInset");
    expect(screenSource).toContain("screenGestureEnabled");
    expect(screenSource).toContain("nativeLoading: true");
    expect(loadingSource).toContain("onCancel");
  });
});

describe("WebRTC screen viewer ICE restart patience timer", () => {
  it("clears prior patience timer on ICE restart and never kills a connected stream at t=25s", async () => {
    vi.useFakeTimers();
    try {
      const sent: unknown[] = [];
      const appMessages: unknown[] = [];
      let currentPc: FakePeerConnection | null = null;

      class FakePeerConnection {
        connectionState = "new";
        iceConnectionState = "new";
        iceGatheringState = "new";
        localDescription: { sdp: string } | null = null;
        onicecandidate: ((e: unknown) => void) | null = null;
        ontrack: ((e: unknown) => void) | null = null;
        ondatachannel: ((e: unknown) => void) | null = null;
        oniceconnectionstatechange: (() => void) | null = null;
        onconnectionstatechange: (() => void) | null = null;

        constructor() {
          currentPc = this;
        }
        async setRemoteDescription() {}
        async createAnswer() {
          return { type: "answer", sdp: "v=0-answer" };
        }
        async setLocalDescription(desc: { sdp: string }) {
          this.localDescription = desc;
        }
        async addIceCandidate() {}
        async getStats() {
          return new Map();
        }
        close() {
          this.connectionState = "closed";
        }
      }

      const sandbox: Record<string, unknown> = {
        query: new URLSearchParams("patience=25"),
        pacing: "low",
        nativePicture: false,
        wantVideo: true,
        relayFallback: true,
        windowsHost: false,
        sessionError: "",
        sessionPhase: "",
        loading: { phase: "ready", set: vi.fn() },
        content: { w: 1920, h: 1080 },
        video: {
          srcObject: null,
          readyState: 4,
          videoWidth: 1920,
          videoHeight: 1080,
          classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
          addEventListener: vi.fn(),
          play: () => Promise.resolve(),
        },
        gpu: { width: 0, height: 0, classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() } },
        canvas: { classList: { toggle: vi.fn() } },
        pointer: { classList: { remove: vi.fn() } },
        session: { active: () => true },
        window: {},
        navigator: {},
        performance: { now: () => Date.now() },
        RTCPeerConnection: FakePeerConnection,
        MediaStream: class {},
        setTimeout,
        clearTimeout,
        addEventListener: vi.fn(),
        send: (msg: unknown) => sent.push(msg),
        tellApp: (msg: unknown) => appMessages.push(msg),
        showProgress: vi.fn(),
        say: vi.fn(),
        hint: vi.fn(),
        layout: vi.fn(),
        refresh: vi.fn(),
        unseeable: vi.fn(),
        told: vi.fn(),
        withoutPlayoutDelay: (sdp: string) => sdp,
      };

      const ctx = vm.createContext(sandbox);
      vm.runInContext(WEBRTC_SCRIPT, ctx);

      const signal = sandbox.signal as (msg: Record<string, unknown>) => void;
      signal({ t: "config", iceServers: [] });
      signal({ t: "offer", sdp: "v=0-initial" });
      await vi.advanceTimersByTimeAsync(100);

      // Initial connection succeeds.
      currentPc!.connectionState = "connected";
      currentPc!.iceConnectionState = "connected";
      currentPc!.onconnectionstatechange?.();

      // Trigger an ICE restart offer while already `mine.up === true`.
      signal({ t: "offer", sdp: "v=0-ice-restart" });
      await vi.advanceTimersByTimeAsync(100);

      // Connection completes ICE restart.
      currentPc!.connectionState = "connected";
      currentPc!.iceConnectionState = "connected";
      currentPc!.onconnectionstatechange?.();

      // Advance well past 25s: stream must remain alive with zero fallback/giveUp!
      await vi.advanceTimersByTimeAsync(35_000);
      expect(appMessages).toEqual([]);
      expect(sent.some((m) => (m as { t?: string }).t === "rtc.failed")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Terminal key modifiers & bracketed paste chunking", () => {
  it("preserves bracketed paste escape framing in chunkRawTerminalData without splitting surrogate pairs", () => {
    const framed = `\x1b[200~${"🚀".repeat(12)}\x1b[201~`;
    const chunks = chunkRawTerminalData(framed, 16);
    expect(chunks.join("")).toBe(framed);
    expect(chunks[0]?.startsWith("\x1b[200~")).toBe(true);
    expect(chunks[chunks.length - 1]?.endsWith("\x1b[201~")).toBe(true);
    for (const chunk of chunks) {
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
    }
  });

  it("maps raw VT backspace and arrow inputs cleanly for armed Cmd and Alt modifiers", () => {
    expect(terminalKeyNameFromInput("\x7f")).toBe("backspace");
    expect(terminalKeyNameFromInput("\x1b[D")).toBe("left");
    expect(terminalKeyNameFromInput("\x1b[C")).toBe("right");
    expect(terminalKeyNameFromInput("\x1bOD")).toBe("left");
    expect(terminalKeyNameFromInput("\x1bOC")).toBe("right");

    // Armed Cmd + raw keyboard backspace/arrows
    expect(encodeTerminalKeySequence("\x7f", { cmd: true })).toBe("\x15");
    expect(encodeTerminalKeySequence("\x1b[D", { cmd: true })).toBe("\x01");
    expect(encodeTerminalKeySequence("\x1b[C", { cmd: true })).toBe("\x05");

    // Armed Alt + arrows / page keys / backspace
    expect(encodeTerminalKeySequence("left", { alt: true })).toBe("\x1b[1;3D");
    expect(encodeTerminalKeySequence("right", { alt: true })).toBe("\x1b[1;3C");
    expect(encodeTerminalKeySequence("up", { alt: true })).toBe("\x1b[1;3A");
    expect(encodeTerminalKeySequence("down", { alt: true })).toBe("\x1b[1;3B");
    expect(encodeTerminalKeySequence("pageUp", { alt: true })).toBe("\x1b[5;3~");
    expect(encodeTerminalKeySequence("backspace", { alt: true })).toBe("\x1b\x7f");
    expect(encodeTerminalKeySequence("\x7f", { alt: true })).toBe("\x1b\x7f");
    expect(encodeTerminalKeySequence("\x1b[D", { alt: true })).toBe("\x1b[1;3D");
    expect(encodeTerminalKeySequence("left", { ctrl: true, alt: true })).toBe("\x1b[1;7D");
  });
});

describe("Mobile layout & navigation invariants", () => {
  it("never wraps root Stack in a scheme-keyed Fragment that wipes navigation state on Android theme toggle", () => {
    const source = readFileSync(resolve(CLIENT_ROOT, "src/app/_layout.tsx"), "utf8");
    expect(source).not.toMatch(/<Fragment\s+key=/);
  });

  it("does not wrap fitToContents form sheets in flex: 1 AdaptivePage containers", () => {
    const portsRoute = readFileSync(resolve(CLIENT_ROOT, "src/app/ports.tsx"), "utf8");
    const settingsRoute = readFileSync(resolve(CLIENT_ROOT, "src/app/session/[id]/settings.tsx"), "utf8");
    expect(portsRoute).not.toContain("adaptiveScreen(");
    expect(settingsRoute).not.toContain("adaptiveScreen(");
  });

  it("supports all orientations on every Modal component", () => {
    const modalFiles = [
      "src/components/app-menu.tsx",
      "src/components/session-outline-sheet.tsx",
      "src/components/composer.tsx",
      "src/components/terminal/snippet-bar.tsx",
      "src/components/text-prompt-modal.tsx",
      "src/screens/changes-screen.tsx",
      "src/components/timeline/attachments.tsx",
      "src/components/computer-use-preview.tsx",
    ];
    for (const rel of modalFiles) {
      const content = readFileSync(resolve(CLIENT_ROOT, rel), "utf8");
      expect(content, `${rel} must specify supportedOrientations`).toContain("supportedOrientations=");
    }
  });
});
