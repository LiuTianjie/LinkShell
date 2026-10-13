import { describe, expect, it } from "vitest";
import { screenPreferences, screenQuery } from "../src/live/screen-preferences";

describe("browser screen negotiation", () => {
  it("requests the high-refresh ceiling and clearer desktop picture without requiring HEVC", () => {
    const view = screenPreferences(() => undefined);
    const query = new URLSearchParams(screenQuery("a+b&c", 2, view, [{ mimeType: "video/H264" }]));
    expect(Object.fromEntries(query)).toEqual({ token: "a+b&c", display: "2", width: "2560", maxFps: "120", mode: "view" });
  });

  it("requests HEVC only when the browser can receive its RTP format", () => {
    const view = screenPreferences(() => undefined);
    expect(screenQuery("token", 0, view, [{ mimeType: "video/H265" }])).toContain("codec=hevc");
    expect(screenQuery("token", 0, view, [{ mimeType: "video/mp4" }])).not.toContain("codec=");
    expect(screenQuery("token", 0, { ...view, codec: "h264" }, [{ mimeType: "video/H265" }])).not.toContain("codec=");
  });

  it("keeps explicit lower-bandwidth preferences and rejects invalid stored values", () => {
    const values: Record<string, string> = { "linkshell.screen.width": "1280", "linkshell.screen.maxFps": "30", "linkshell.screen.codec": "h264", "linkshell.screen.mode": "touch" };
    expect(screenPreferences((key) => values[key])).toEqual({ width: "1280", maxFps: "30", codec: "h264", mode: "touch" });
    expect(screenPreferences(() => "invalid")).toEqual({ width: "2560", maxFps: "120", codec: "auto", mode: "view" });
  });
});
