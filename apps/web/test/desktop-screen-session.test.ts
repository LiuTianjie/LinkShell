import { describe, expect, it } from "vitest";
import { AUTO_RETRIES, nativeSessionPolicy, screenRate, targetChanged } from "../src/live/desktop-screen-session";

describe("screenRate", () => {
  it("holds the request to what this Mac's display shows, as the phone does", () => {
    expect(screenRate("120", 60)).toBe("60");
    expect(screenRate("120", 120)).toBe("120");
    expect(screenRate("120", 144)).toBe("120");
    expect(screenRate("120", 75)).toBe("60");
    expect(screenRate("60", 120)).toBe("60");
    expect(screenRate("30", 120)).toBe("30");
    expect(screenRate("120", 50)).toBe("30");
  });
  it("keeps the user's ceiling until the display is known, and reads nonsense as 60", () => {
    expect(screenRate("120", undefined)).toBe("120");
    expect(screenRate("90", undefined)).toBe("60");
  });
});

describe("nativeSessionPolicy", () => {
  const base = { paused: false, retries: 0, canFallBack: true };
  it("lets a hidden session go quietly", () => {
    expect(nativeSessionPolicy("视频直连已中断，请重新连接", { ...base, paused: true })).toBe("dormant");
  });
  it("shows what can't work on this Mac without retrying", () => {
    expect(nativeSessionPolicy("此 Mac 不支持远程桌面硬件解码", base)).toBe("show");
    expect(nativeSessionPolicy("原生屏幕组件不可用，请更新 LinkShell App", base)).toBe("show");
  });
  it("retries transient failures, then falls back for a network that blocks the video", () => {
    expect(nativeSessionPolicy("原生视频直连超时，请检查网络后重新连接", base)).toBe("retry");
    expect(nativeSessionPolicy("原生视频直连超时，请检查网络后重新连接", { ...base, retries: AUTO_RETRIES })).toBe("fallback");
    expect(nativeSessionPolicy("原生视频直连超时，请检查网络后重新连接", { ...base, retries: AUTO_RETRIES, canFallBack: false })).toBe("show");
    expect(nativeSessionPolicy("H.264 硬件解码连续失败（-12909），已停止远程画面，请重新连接。", { ...base, retries: AUTO_RETRIES })).toBe("show");
  });
});

describe("targetChanged", () => {
  const applied = { display: 0, width: "1920", maxFps: "60", paused: false };
  it("tells a change of picture from a pause", () => {
    expect(targetChanged(applied, { ...applied })).toEqual({ picture: false, any: false });
    expect(targetChanged(applied, { ...applied, paused: true })).toEqual({ picture: false, any: true });
    expect(targetChanged(applied, { ...applied, display: 1 })).toEqual({ picture: true, any: true });
    expect(targetChanged(applied, { ...applied, width: "2560" })).toEqual({ picture: true, any: true });
  });
});
