import { describe, expect, it, vi } from "vitest";
import {
  buildScreenViewerQuery,
  initialScreenPlayback,
  isScreenAudioAvailable,
  resolveScreenPlaybackFailure,
  screenAudioBridgeInstallScript,
  screenAudioControlMessage,
  screenAudioInjectScript,
  screenPlayback,
} from "../src/lib/screen-playback";

const SCREEN_TAKEN = "屏幕画面被另一台设备接手了";
const SCREEN_IDLE = "长时间没有操作，画面已断开";

describe("screen 3-layer fallback & audio controls (iOS and Android)", () => {
  it("transitions native -> standard WebView -> RPC byte relay uniformly across platforms", () => {
    let state = initialScreenPlayback(true);
    expect(state.mode).toBe("native");

    const step1 = resolveScreenPlaybackFailure({
      failedPlayback: state.mode,
      takenMessage: SCREEN_TAKEN,
      idleMessage: SCREEN_IDLE,
    });
    expect(step1).toEqual({ nextPlayback: "standard" });
    state = screenPlayback(state, { type: "unavailable", mode: "native", generation: 0 });
    expect(state.mode).toBe("standard");

    const step2 = resolveScreenPlaybackFailure({
      failedPlayback: state.mode,
      takenMessage: SCREEN_TAKEN,
      idleMessage: SCREEN_IDLE,
    });
    expect(step2).toEqual({ nextPlayback: "relay" });
    state = screenPlayback(state, { type: "unavailable", mode: "standard", generation: 0 });
    expect(state.mode).toBe("relay");

    const step3 = resolveScreenPlaybackFailure({
      failedPlayback: state.mode,
      description: "连接超时",
      takenMessage: SCREEN_TAKEN,
      idleMessage: SCREEN_IDLE,
    });
    expect(step3).toEqual({ failure: "连接超时" });

    // Manual retry resets back to native.
    const retried = screenPlayback(state, { type: "restart", nativeAvailable: true });
    expect(retried).toEqual({ mode: "native", generation: 1 });
  });

  it("stops falling back immediately when taken over by another device or ended idle", () => {
    expect(
      resolveScreenPlaybackFailure({
        failedPlayback: "native",
        description: SCREEN_TAKEN,
        takenMessage: SCREEN_TAKEN,
        idleMessage: SCREEN_IDLE,
      }),
    ).toEqual({ failure: SCREEN_TAKEN });

    expect(
      resolveScreenPlaybackFailure({
        failedPlayback: "standard",
        description: SCREEN_IDLE,
        takenMessage: SCREEN_TAKEN,
        idleMessage: SCREEN_IDLE,
      }),
    ).toEqual({ failure: SCREEN_IDLE });
  });

  it("sets fallback=relay in standard/native URLs and ?audio=1 only in WebView modes", () => {
    const nativeWithAudio = buildScreenViewerQuery({
      token: "tok",
      playback: "native",
      display: 0,
      width: "1920",
      mode: "view",
      via: "direct",
      isDirectComputer: false,
      pacing: "immediate",
      audio: true,
    });
    expect(nativeWithAudio.get("fallback")).toBe("relay");
    expect(nativeWithAudio.get("video")).toBe("1");
    expect(nativeWithAudio.get("audio")).toBeNull();

    const standardWithAudio = buildScreenViewerQuery({
      token: "tok",
      playback: "standard",
      display: 1,
      width: "1920",
      mode: "trackpad",
      via: "relay",
      isDirectComputer: false,
      pacing: "smooth",
      audio: true,
    });
    expect(standardWithAudio.get("fallback")).toBe("relay");
    expect(standardWithAudio.get("video")).toBe("1");
    expect(standardWithAudio.get("audio")).toBe("1");
    expect(standardWithAudio.get("q")).toBe("low");
    expect(standardWithAudio.get("pacing")).toBe("smooth");

    const relayMuted = buildScreenViewerQuery({
      token: "tok",
      playback: "relay",
      display: 0,
      width: "1280",
      mode: "view",
      via: "relay",
      isDirectComputer: true,
      pacing: "immediate",
      audio: false,
    });
    expect(relayMuted.get("fallback")).toBeNull();
    expect(relayMuted.get("video")).toBe("0");
    expect(relayMuted.get("audio")).toBeNull();
  });

  it("builds WS audio control messages and WebView unlock/sync scripts cleanly", () => {
    expect(screenAudioControlMessage(true)).toEqual({ t: "audio", enabled: true });
    expect(screenAudioControlMessage(false)).toEqual({ t: "audio", enabled: false });

    const unlockScreenAudio = vi.fn();
    const send = vi.fn();
    const listeners = new Map<string, () => void>();
    const fakeWindow: Record<string, unknown> = {};
    let audioEnabled = false;
    const toggleAudio = vi.fn(() => {
      audioEnabled = !audioEnabled;
      if (audioEnabled) unlockScreenAudio();
      send({ t: "audio", enabled: audioEnabled });
    });
    const addEventListener = vi.fn((ev: string, fn: () => void) => {
      listeners.set(ev, fn);
    });

    const run = new Function(
      "window",
      "addEventListener",
      "toggleAudio",
      "unlockScreenAudio",
      "send",
      "getAudio",
      `
      let audioEnabled = getAudio();
      ${screenAudioBridgeInstallScript()}
      ${screenAudioInjectScript(true)}
      return getAudio();
      `,
    );

    const postMessage = vi.fn();
    fakeWindow.ReactNativeWebView = { postMessage };
    const nextEnabled = run(
      fakeWindow,
      addEventListener,
      toggleAudio,
      unlockScreenAudio,
      send,
      () => audioEnabled,
    );

    expect(nextEnabled).toBe(true);
    expect(toggleAudio).toHaveBeenCalledTimes(1);
    expect(unlockScreenAudio).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ t: "audio", enabled: true });
    expect(postMessage).not.toHaveBeenCalled(); // Avoids echoing RN-initiated sync back to RN.
    expect(listeners.has("pointerdown")).toBe(true);
  });

  it("gates native audio availability cleanly when native reports audioAvailable=false", () => {
    expect(isScreenAudioAvailable("native", undefined)).toBe(true);
    expect(isScreenAudioAvailable("native", true)).toBe(true);
    expect(isScreenAudioAvailable("native", false)).toBe(false);
    expect(isScreenAudioAvailable("standard", false)).toBe(true);
    expect(isScreenAudioAvailable("relay", false)).toBe(true);
  });
});
