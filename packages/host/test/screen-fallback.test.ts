import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { viewerPage } from "../src/screen-viewer.js";

// Exercise the shipped page's negotiation/fallback callbacks without a screen or browser.
function receiver({ nativeApp = true, supportsRTC = true, video = "1" } = {}) {
  const page = viewerPage();
  const messages: unknown[] = [];
  const signals: unknown[] = [];
  const settings = page.slice(page.indexOf("const wantVideo ="), page.indexOf("const unseeable ="));
  const start = page.indexOf("let rtc = null"), end = page.indexOf("// ---- The pointer in a video");
  if (start < 0 || end < start) throw new Error("The viewer negotiation section was not found");
  const source = page.slice(start, end);
  const peer = class { constructor() { throw new Error("receiver unavailable"); } };
  const handlers = new Script(`${settings}\n${source}\n({ signal, giveUp, fallBack });`).runInNewContext({
    app: nativeApp ? {} : undefined,
    window: supportsRTC ? { RTCPeerConnection: peer, VideoDecoder: {} } : { VideoDecoder: {} },
    RTCPeerConnection: peer,
    chrome: { video: true },
    query: new URLSearchParams({ video, ...(nativeApp ? { fallback: "relay" } : {}) }),
    tellApp: (message: unknown) => messages.push(message),
    send: (message: unknown) => signals.push(message),
    video: { addEventListener() {} },
    addEventListener() {},
    clearTimeout() {},
    say() {},
    hint() {},
    unseeable() {},
  }) as { signal(message: { t: string }): void; giveUp(reason: string): void; fallBack(): void };
  return { ...handlers, messages, signals };
}

describe("screen video fallback", () => {
  it("asks iOS for a relay immediately when the standard receiver is missing", () => {
    expect(receiver({ supportsRTC: false }).messages).toEqual([{ type: "screenFallback" }]);
  });

  it("handles a failing WebRTC constructor and reports the fallback only once", () => {
    const page = receiver();
    page.signal({ t: "config" });
    page.giveUp("late failure");
    page.fallBack();
    expect(page.messages).toEqual([{ type: "screenFallback" }]);
    expect(page.signals).toEqual([]);
  });

  it("does not fall back again once the app has selected its relay route", () => {
    const page = receiver({ supportsRTC: false, video: "0" });
    page.fallBack();
    expect(page.messages).toEqual([]);
  });

  it("keeps the existing socket fallback for a normal browser", () => {
    const page = receiver({ nativeApp: false });
    page.signal({ t: "config" });
    expect(page.messages).toEqual([]);
    expect(page.signals).toEqual([{ t: "rtc.failed", reason: "the receiver could not start: receiver unavailable" }]);
  });
});
