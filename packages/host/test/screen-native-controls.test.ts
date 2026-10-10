import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { viewerPage } from "../src/screen-viewer.js";

describe("the existing viewer over a native picture", () => {
  it("does not open another video connection or trigger a relay fallback", () => {
    const page = viewerPage(), commands: unknown[] = [];
    const settings = page.slice(page.indexOf("const wantVideo ="), page.indexOf("const unseeable ="));
    const socket = page.slice(page.indexOf("const ws ="), page.indexOf("ws.onopen ="));
    const result = new Script(`${settings}\n${socket}\nsend({ t: 'control' }); ({ wantVideo, relayFallback });`).runInNewContext({
      nativePicture: true, app: {}, chrome: { video: true, relayFallback: true },
      query: new URLSearchParams({ video: "1", fallback: "relay" }),
      window: { RTCPeerConnection: {} },
      nativePost: (message: unknown) => commands.push(message),
      WebSocket: class { constructor() { throw new Error("a second media session was opened"); } },
    });
    expect(result).toEqual({ wantVideo: false, relayFallback: false });
    expect(commands).toEqual([{ kind: "signal", message: { t: "control" } }]);
  });

  it("keeps input ordering decisions with the original gesture controller", () => {
    const source = /function post\(message, lane\) \{[\s\S]*?\n\}/.exec(viewerPage())![0];
    const commands: unknown[] = [];
    const post = new Script(`${source}\npost`).runInNewContext({
      nativePicture: true,
      nativePost: (message: unknown) => commands.push(message),
    }) as (message: unknown, lane: string) => void;
    post({ t: "move", x: 0.2, y: 0.4 }, "pointer");
    post({ t: "move", x: 0.3, y: 0.4 }, "input");
    post({ t: "down", b: "left", n: 1 }, "input");
    post({ t: "up", b: "left", n: 1 }, "input");
    post({ t: "key", k: "c", m: ["cmd"] }, "input");
    expect(commands).toEqual([
      { kind: "input", message: { t: "move", x: 0.2, y: 0.4 }, replaceable: true },
      { kind: "input", message: { t: "move", x: 0.3, y: 0.4 }, replaceable: false },
      { kind: "input", message: { t: "down", b: "left", n: 1 }, replaceable: false },
      { kind: "input", message: { t: "up", b: "left", n: 1 }, replaceable: false },
      { kind: "input", message: { t: "key", k: "c", m: ["cmd"] }, replaceable: false },
    ]);
  });
});
