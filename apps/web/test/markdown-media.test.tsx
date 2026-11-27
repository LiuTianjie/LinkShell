// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Runtime } from "../src/live/common";
import { RichText, TimelineNavigation } from "../src/live/Timeline";
import type { Connection } from "../src/live/engine";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("web markdown host GIF images and Windows file links", () => {
  it("loads a Windows file:// GIF via fs.read and strips #fragment from HTML file links", async () => {
    const gifBase64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const call = vi.fn(async (method: string, params: unknown) => {
      if (method === "fs.read") {
        expect(params).toMatchObject({ path: "D:/DEV/xian/_artifacts/slash.gif" });
        return {
          path: "D:/DEV/xian/_artifacts/slash.gif",
          size: 42,
          modifiedAt: Date.now(),
          kind: "image" as const,
          data: gifBase64,
          mimeType: "image/gif",
          truncated: false,
        };
      }
      return {};
    });
    const connection = {
      computer: { key: "win-1" },
      link: { call },
    } as unknown as Connection;
    const opened: { path: string; line?: number }[] = [];

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <Runtime.Provider value={connection}>
            <TimelineNavigation.Provider
              value={{
                cwd: "D:\\DEV\\xian",
                open: (path, line) => opened.push({ path, line }),
              }}
            >
              <RichText
                text={[
                  "![剑气动图](file:///D:/DEV/xian/_artifacts/slash.gif)",
                  "",
                  "[attack-effects-v82.html#weapons-001](file:///D:/DEV/xian/_artifacts/attack-effects-v82.html#weapons-001)",
                ].join("\n")}
              />
            </TimelineNavigation.Provider>
          </Runtime.Provider>,
        );
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const img = container.querySelector<HTMLImageElement>("img.message-image");
      expect(img).not.toBeNull();
      expect(img?.getAttribute("src")).toBe(`data:image/gif;base64,${gifBase64}`);
      expect(img?.getAttribute("alt")).toBe("剑气动图");

      const link = container.querySelector<HTMLAnchorElement>("a");
      expect(link).not.toBeNull();
      await act(async () => {
        link!.click();
      });
      expect(opened).toEqual([{ path: "D:/DEV/xian/_artifacts/attack-effects-v82.html", line: undefined }]);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
