import { describe, expect, it, vi } from "vitest";
import { viewerPage } from "../src/screen-viewer.js";

function jpegViewer() {
  const page = viewerPage("win32");
  const source = page.slice(page.indexOf("const jpegStats"), page.indexOf("// Only a keyframe"));
  const decodes: ((value: unknown) => void)[] = [];
  const drawn = vi.fn(), ack = vi.fn(), error = vi.fn();
  const scope = {
    ws: { readyState: 1 }, content: { w: 0, h: 0 }, canvas: {}, live: false,
    ctx: { drawImage: drawn }, layout: vi.fn(), shownUpTo: ack, say: error,
    createImageBitmap: () => new Promise(resolve => decodes.push(resolve)),
  };
  const viewer = new Function("scope", `
    const { ws, content, canvas, live, ctx, layout, shownUpTo, say, createImageBitmap } = scope;
    ${source}
    return {
      frame(seq) { jpegPending = { seq, unit: new Uint8Array([255, 216]) }; return drawJpeg(); },
      restart() { jpegGeneration++; jpegPending = null; },
      close() { jpegGeneration++; jpegPending = null; ws.readyState = 3; },
    };
  `)(scope) as { frame(seq: number): Promise<void>; restart(): void; close(): void };
  const bitmap = () => ({ width: 640, height: 360, close: vi.fn() });
  return { ...viewer, decodes, drawn, ack, error, bitmap };
}

describe("Windows JPEG viewer", () => {
  it("acknowledges Windows pictures immediately without changing the Mac batching", () => {
    const page = viewerPage("win32");
    const source = page.slice(page.indexOf("function shownUpTo"), page.indexOf("let lighterAt"));
    for (const windowsHost of [true, false]) {
      const send = vi.fn(), schedule = vi.fn();
      const ack = new Function("windowsHost", "send", "setTimeout", `let lastShown = 0, telling = 0, lag = 0; ${source}; return shownUpTo;`)(windowsHost, send, schedule);
      ack(42);
      if (windowsHost) { expect(send).toHaveBeenCalledWith({ t: "ack", n: 42 }); expect(schedule).not.toHaveBeenCalled(); }
      else { expect(send).not.toHaveBeenCalled(); expect(schedule).toHaveBeenCalledWith(expect.any(Function), 40); }
    }
  });
  it("keeps one decode in flight, drops intermediate frames, and acknowledges rendered frames", async () => {
    const view = jpegViewer();
    const pending = view.frame(1);
    void view.frame(2); void view.frame(3);
    expect(view.decodes).toHaveLength(1);
    const first = view.bitmap(); view.decodes[0]!(first);
    await vi.waitFor(() => expect(view.decodes).toHaveLength(2));
    const latest = view.bitmap(); view.decodes[1]!(latest);
    await pending;
    expect(view.ack.mock.calls).toEqual([[1], [3]]);
    expect(view.drawn).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledOnce(); expect(latest.close).toHaveBeenCalledOnce();
  });
  it("closes stale bitmaps without painting them after restart or disconnect", async () => {
    const view = jpegViewer();
    const pending = view.frame(1);
    view.restart(); void view.frame(2);
    const first = view.bitmap(); view.decodes[0]!(first);
    await vi.waitFor(() => expect(view.decodes).toHaveLength(2));
    view.close(); const second = view.bitmap(); view.decodes[1]!(second);
    await pending;
    expect(view.drawn).not.toHaveBeenCalled(); expect(view.ack).not.toHaveBeenCalled();
    expect(first.close).toHaveBeenCalledOnce(); expect(second.close).toHaveBeenCalledOnce();
  });
  it("selects Windows shortcuts while preserving Mac shortcuts", () => {
    const page = viewerPage("win32");
    expect(page).toContain('data-platform="win32"'); expect(page).toContain('data-mod="cmd">Win');
    const source = page.slice(page.indexOf("const QUICK ="), page.indexOf("const F_KEYS ="));
    const shortcuts = (windows: boolean) => (new Function("windowsHost", `${source}; return QUICK;`)(windows) as [string, string[][]][]).flatMap(([, keys]) => keys);
    expect(shortcuts(true)).toContainEqual(["复制", "c", "ctrl"]);
    expect(shortcuts(true)).toContainEqual(["切换应用", "tab", "alt", "again"]);
    expect(shortcuts(false)).toContainEqual(["复制", "c", "cmd"]);
  });
});
