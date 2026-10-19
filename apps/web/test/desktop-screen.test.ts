import { describe, expect, it } from "vitest";
import { nativeScreenQuery, screenSignal } from "../src/live/desktop-screen";

describe("native desktop screen transport", () => {
  it("requests a native video track without loading the browser viewer", () => {
    const url = new URL(nativeScreenQuery("a+b&c", 2, "native", "60"), "http://localhost");
    expect(url.pathname).toBe("/stream");
    expect(url.searchParams.get("video")).toBe("1");
    expect(url.searchParams.get("token")).toBe("a+b&c");
    expect(url.searchParams.get("display")).toBe("2");
    expect(url.searchParams.get("width")).toBe("native");
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
