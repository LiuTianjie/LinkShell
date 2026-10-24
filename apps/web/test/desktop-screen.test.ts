import { describe, expect, it } from "vitest";
import { leaveScreenFullscreen, nativeScreenQuery, screenSignal, windowFullscreenChanged, type ScreenFullscreen } from "../src/live/desktop-screen";

describe("native desktop screen transport", () => {
  it("requests a native video track without loading the browser viewer", () => {
    const url = new URL(nativeScreenQuery("a+b&c", 2, "native", "60"), "http://localhost");
    expect(url.pathname).toBe("/stream");
    expect(url.searchParams.get("video")).toBe("1");
    expect(url.searchParams.get("token")).toBe("a+b&c");
    expect(url.searchParams.get("display")).toBe("2");
    expect(url.searchParams.get("width")).toBe("native");
    expect(url.searchParams.has("codec")).toBe(false);
    expect(new URL(nativeScreenQuery("t", 0, "1920", "120", true), "http://localhost").searchParams.get("codec")).toBe("hevc");
  });
  it("rejects byte-stream video instead of falling back to browser decoding", () => {
    expect(() => screenSignal(new ArrayBuffer(8))).toThrow("原生视频直连");
  });
  it("accepts bounded signalling and rejects malformed or oversized messages", () => {
    expect(screenSignal('{"rtc":{"t":"offer","sdp":"test"}}')).toEqual({ rtc: { t: "offer", sdp: "test" } });
    for (const value of ["null", "[]", "42", "invalid"]) expect(() => screenSignal(value)).toThrow();
    expect(() => screenSignal('"' + "x".repeat(262_144) + '"')).toThrow("过大");
  });
  it("surfaces host configuration and capture failures instead of leaving input locked", () => {
    expect(() => screenSignal('{"session":{"t":"error","requestId":1,"message":"显示器已断开"}}')).toThrow("显示器已断开");
    expect(() => screenSignal('{"error":"屏幕捕获失败"}')).toThrow("屏幕捕获失败");
  });
});

describe("remote screen full screen", () => {
  const idle: ScreenFullscreen = { owns: false, fullscreen: false };
  const entered = (): ScreenFullscreen => {
    const asked = { ...idle, owns: true };
    const answer = windowFullscreenChanged(asked, true)!;
    expect(answer).toEqual({ owns: true, fullscreen: true, focused: true });
    return { owns: answer.owns, fullscreen: answer.fullscreen };
  };

  it("shows the toolbar again when Esc leaves full screen, before and after the window answers", () => {
    const left = leaveScreenFullscreen(entered())!;
    expect(left.fullscreen).toBe(false);
    // The window's answer comes after the screen stopped owning the full screen: nothing to undo.
    expect(windowFullscreenChanged(left, false)).toBeUndefined();
  });

  it("shows the toolbar again when the window leaves full screen on its own (green button)", () => {
    expect(windowFullscreenChanged(entered(), false)).toEqual({ owns: false, fullscreen: false, focused: false });
  });

  it("brings back a screen still showing only the picture even if it no longer owns the full screen", () => {
    expect(windowFullscreenChanged({ owns: false, fullscreen: true }, false)).toEqual({ owns: false, fullscreen: false, focused: false });
  });

  it("leaves other screens alone", () => {
    expect(windowFullscreenChanged(idle, true)).toBeUndefined();
    expect(windowFullscreenChanged(idle, false)).toBeUndefined();
    expect(leaveScreenFullscreen(idle)).toBeUndefined();
  });
});
