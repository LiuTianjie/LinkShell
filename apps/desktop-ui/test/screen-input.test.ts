import { describe, expect, it } from "vitest";
import { ClickCounter, SCREEN_IDLE, SCREEN_TAKEN, nativeSessionPolicy } from "../src/core/screen-client";
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
