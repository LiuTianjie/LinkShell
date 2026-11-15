import { describe, expect, it } from "vitest";
import { ClickCounter, SCREEN_IDLE, SCREEN_TAKEN, cursorCss, fusionInputMessage, nativeScreenQuery, nativeSessionPolicy, viewerScreenMatch } from "../src/core/screen-client";
import { isAltGraphCharacter, isLocalFullscreenKey } from "../src/features/remote/WebRtcScreenStage";

const key = (init: Partial<{ key: string; code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; altGraph: boolean }>) => ({
  key: init.key ?? "a",
  code: init.code ?? "KeyA",
  ctrlKey: init.ctrlKey ?? false,
  altKey: init.altKey ?? false,
  metaKey: init.metaKey ?? false,
  getModifierState: (name: "AltGraph") => name === "AltGraph" && init.altGraph === true,
});

describe("remote screen input", () => {
  it("counts double and triple clicks itself, since pointer events carry no click count", () => {
    const clicks = new ClickCounter(500, 5);
    expect(clicks.down("left", 100, 100, 0)).toBe(1);
    expect(clicks.current("left")).toBe(1);
    expect(clicks.down("left", 102, 101, 200)).toBe(2);
    expect(clicks.current("left")).toBe(2);
    expect(clicks.down("left", 101, 100, 400)).toBe(3);
    expect(clicks.down("left", 101, 100, 600)).toBe(3);
    // Too slow, too far, or another button starts over.
    expect(clicks.down("left", 101, 100, 1_200)).toBe(1);
    expect(clicks.down("left", 140, 100, 1_300)).toBe(1);
    expect(clicks.down("right", 140, 100, 1_400)).toBe(1);
  });

  it("never reconnects on its own after another device took the screen or it idled out", () => {
    const state = { paused: false, retries: 0, canFallBack: true };
    expect(nativeSessionPolicy(SCREEN_TAKEN, state)).toBe("show");
    expect(nativeSessionPolicy(SCREEN_IDLE, state)).toBe("show");
    expect(nativeSessionPolicy("网络中断", state)).toBe("retry");
  });

  it("lets AltGr characters through as text and keeps real Ctrl+Alt shortcuts", () => {
    expect(isAltGraphCharacter(key({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true }), "windows")).toBe(true);
    expect(isAltGraphCharacter(key({ key: "€", code: "KeyE", ctrlKey: true, altKey: true }), "windows")).toBe(true);
    expect(isAltGraphCharacter(key({ key: "{", code: "Digit7", ctrlKey: true, altKey: true }), "windows")).toBe(true);
    expect(isAltGraphCharacter(key({ key: "q", code: "KeyQ", ctrlKey: true, altKey: true }), "windows")).toBe(false);
    expect(isAltGraphCharacter(key({ key: "7", code: "Digit7", ctrlKey: true, altKey: true }), "windows")).toBe(false);
    expect(isAltGraphCharacter(key({ key: "Enter", code: "Enter", ctrlKey: true, altKey: true }), "windows")).toBe(false);
    expect(isAltGraphCharacter(key({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true }), "mac")).toBe(false);
    expect(isAltGraphCharacter(key({ key: "@", code: "KeyQ", altGraph: true }), "other")).toBe(true);
  });

  it("keeps the window's full-screen keys local", () => {
    expect(isLocalFullscreenKey({ key: "F11", ctrlKey: false, metaKey: false })).toBe(true);
    expect(isLocalFullscreenKey({ key: "f", ctrlKey: true, metaKey: true })).toBe(true);
    expect(isLocalFullscreenKey({ key: "f", ctrlKey: false, metaKey: true })).toBe(false);
  });
});

describe("remote messages in the viewer's language", () => {
  it("translates what the screen and Fusion code say, and leaves a host's own wording alone", async () => {
    const { localizeRemoteMessage } = await import("../src/features/remote/remote-copy");
    expect(localizeRemoteMessage(SCREEN_TAKEN, "en")).toBe("Another device took over the screen.");
    expect(localizeRemoteMessage(SCREEN_TAKEN, "zh")).toBe(SCREEN_TAKEN);
    expect(localizeRemoteMessage("融合模式多次重连失败：与远端 Mac 的融合连接已断开", "en")).toBe(
      "Fusion couldn't reconnect: The Fusion connection to the remote Mac dropped.",
    );
    expect(localizeRemoteMessage("「Studio」当前离线，无法打开融合应用", "ja")).toContain("Studio");
    expect(localizeRemoteMessage("某个主机自己的说明", "en")).toBe("某个主机自己的说明");
  });
});

describe("the remote pointer's picture", () => {
  it("is drawn at the size it has on the remote, with the hot spot in the same points", () => {
    // A Mac's arrow: 17 × 23 points, sent as a 34 × 46 pixel PNG.
    const css = cursorCss({ url: "data:image/png;base64,AAAA", w: 17, h: 23, hotX: 4, hotY: 4, scale: 2 });
    expect(css).toBe('image-set(url("data:image/png;base64,AAAA") 2x) 4 4, default');
  });

  it("keeps the hot spot inside the picture and a scale it can't use out of it", () => {
    expect(cursorCss({ url: "u", w: 16, h: 16, hotX: 40, hotY: -3, scale: 0 })).toBe('image-set(url("u") 1x) 15 0, default');
  });
});

describe("a Fusion window's input", () => {
  it("names its window in `stream`, and leaves a key its name", () => {
    expect(fusionInputMessage({ t: "key", k: "return", m: ["cmd"] }, "w12", 7)).toEqual({ t: "key", k: "return", m: ["cmd"], stream: "w12", i: 7 });
  });

  it("repeats the window in `k` for a 0.10.106 remote where the event has none of its own", () => {
    expect(fusionInputMessage({ t: "move", x: 0.5, y: 0.25 }, "w12", 8)).toEqual({ t: "move", x: 0.5, y: 0.25, stream: "w12", k: "w12", i: 8 });
    expect(fusionInputMessage({ t: "text", s: "你好" }, "d0", 9)).toEqual({ t: "text", s: "你好", stream: "d0", k: "d0", i: 9 });
  });
});

describe("asking for the desktop at this screen's resolution", () => {
  it("says the screen in its own points and their pixels", () => {
    // A Surface Go: 1920 × 1280 pixels at 150 %.
    expect(viewerScreenMatch({ screen: { width: 1280, height: 853 }, devicePixelRatio: 1.5 })).toBe("1280x853@1.5");
    expect(viewerScreenMatch({ screen: { width: 1512, height: 982 }, devicePixelRatio: 2 })).toBe("1512x982@2");
  });

  it("leaves an upright or tiny screen out", () => {
    expect(viewerScreenMatch({ screen: { width: 853, height: 1280 }, devicePixelRatio: 1.5 })).toBeUndefined();
    expect(viewerScreenMatch({ screen: { width: 640, height: 480 }, devicePixelRatio: 1 })).toBeUndefined();
    expect(viewerScreenMatch(undefined)).toBeUndefined();
  });

  it("goes in the stream's query only when wanted", () => {
    expect(nativeScreenQuery("t", 0, "1920", "60", false, "1280x853@1.5")).toContain("match=1280x853%401.5");
    expect(nativeScreenQuery("t", 0, "1920", "60")).not.toContain("match=");
  });
});
