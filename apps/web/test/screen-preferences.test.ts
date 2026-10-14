import { describe, expect, it } from "vitest";
import { autoScreenWidth, screenPreferences, screenQuery } from "../src/live/screen-preferences";

describe("browser screen negotiation", () => {
  it("fits the stage and keeps a smooth rate rather than asking for every pixel", () => {
    const view = screenPreferences(() => undefined);
    expect(view.width).toBe("auto");
    const width = autoScreenWidth({ width: 960, ratio: 2 });
    const query = new URLSearchParams(screenQuery("a+b&c", 2, { ...view, width }, [{ mimeType: "video/H264" }]));
    expect(Object.fromEntries(query)).toEqual({ token: "a+b&c", display: "2", width: "1920", maxFps: "60", mode: "view" });
  });

  it("requests HEVC only when the browser can receive its RTP format", () => {
    const view = screenPreferences(() => undefined);
    expect(screenQuery("token", 0, view, [{ mimeType: "video/H265" }])).toContain("codec=hevc");
    expect(screenQuery("token", 0, view, [{ mimeType: "video/mp4" }])).not.toContain("codec=");
    expect(screenQuery("token", 0, { ...view, codec: "h264" }, [{ mimeType: "video/H265" }])).not.toContain("codec=");
  });

  it("keeps explicit preferences and rejects invalid stored values", () => {
    const values: Record<string, string> = { "linkshell.screen.width": "1280", "linkshell.screen.maxFps": "30", "linkshell.screen.codec": "h264", "linkshell.screen.mode": "touch" };
    expect(screenPreferences((key) => values[key])).toEqual({ width: "1280", maxFps: "30", codec: "h264", mode: "touch" });
    expect(screenPreferences(() => "invalid")).toEqual({ width: "auto", maxFps: "60", codec: "auto", mode: "view" });
    expect(screenPreferences((key) => (key === "linkshell.screen.width" ? "native" : undefined)).width).toBe("native");
  });

  it("asks only for the width the stage can show, and never beyond the viewer's ladder", () => {
    // A narrow pane on a plain display: the smallest rung covers it.
    expect(autoScreenWidth({ width: 640, ratio: 1 })).toBe("1280");
    // 2× is the most a stage is credited with: past it the bits cost more than the detail returns.
    expect(autoScreenWidth({ width: 700, ratio: 3 })).toBe("1920");
    expect(autoScreenWidth({ width: 1280, ratio: 2 })).toBe("2560");
    // Wider than every rung: the widest one, not a value the viewer page would reject.
    expect(autoScreenWidth({ width: 3000, ratio: 2 })).toBe("2560");
    // A stage not laid out yet (clientWidth 0) still names a rung.
    expect(autoScreenWidth({ width: 0, ratio: 0 })).toBe("1280");
  });
});
