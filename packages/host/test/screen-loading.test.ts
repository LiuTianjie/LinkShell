import { Script } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCREEN_LOADING_SCRIPT } from "../src/screen-loading.js";
import { viewerPage } from "../src/screen-viewer.js";

function element() {
  const classes = new Set<string>();
  return {
    textContent: "", className: "", dataset: {} as Record<string, string>,
    classList: {
      toggle(name: string, on: boolean) { if (on) classes.add(name); else classes.delete(name); },
      remove(name: string) { classes.delete(name); },
      contains(name: string) { return classes.has(name); },
    },
    addEventListener: vi.fn(),
  };
}

function loading() {
  const elements = new Map<string, ReturnType<typeof element>>();
  const node = (id: string) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id)!;
  };
  const root = { ...element(), querySelector: node };
  const retry = vi.fn(), report = vi.fn();
  const create = new Function(`${SCREEN_LOADING_SCRIPT}; return createScreenLoading;`)();
  const controller = create(root, retry, report) as { set(phase: string, message?: string): void; dispose(): void; phase: string };
  return { root, node, retry, report, controller };
}

afterEach(() => vi.useRealTimers());

describe("screen connection feedback", () => {
  it("keeps waiting for a picture after the computer responds, without resetting the slow timer", () => {
    vi.useFakeTimers();
    const ui = loading();
    vi.advanceTimersByTime(8000);
    ui.controller.set("receiving");
    expect(ui.root.classList.contains("gone")).toBe(false);
    expect(ui.node("#screen-loading-title").textContent).toBe("正在接收画面");
    vi.advanceTimersByTime(4000);
    expect(ui.node("#screen-loading-detail").textContent).toContain("耗时较长");
    expect(ui.node("#screen-loading-retry").classList.contains("gone")).toBe(false);
    const click = ui.node("#screen-loading-retry").addEventListener.mock.calls[0]![1];
    click({ stopPropagation() {} });
    expect(ui.retry).toHaveBeenCalledOnce();
  });

  it("stops the wait on the first frame and does not update the DOM for every later frame", () => {
    vi.useFakeTimers();
    const ui = loading();
    ui.controller.set("ready");
    expect(ui.root.classList.contains("gone")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    ui.controller.set("ready");
    expect(ui.report.mock.calls).toEqual([["connecting"], ["ready"]]);
    ui.controller.set("recovering");
    expect(ui.root.classList.contains("gone")).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps failure and playback-permission messages separate from loading", () => {
    vi.useFakeTimers();
    const ui = loading();
    ui.controller.set("error", "请在电脑上允许屏幕录制。");
    expect(ui.node("#screen-loading-detail").textContent).toBe("请在电脑上允许屏幕录制。");
    expect(ui.node("#screen-loading-retry").classList.contains("gone")).toBe(false);
    vi.advanceTimersByTime(30000);
    expect(ui.node("#screen-loading-detail").textContent).not.toContain("等待");
    ui.controller.set("blocked", "轻点屏幕即可开始观看。");
    expect(ui.node("#screen-loading-retry").classList.contains("gone")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up when the viewer leaves and ignores late callbacks", () => {
    vi.useFakeTimers();
    const ui = loading();
    ui.controller.dispose();
    ui.controller.set("receiving");
    expect(vi.getTimerCount()).toBe(0);
    expect(ui.controller.phase).toBe("connecting");
  });

  it("does not dismiss loading for video metadata before a frame is available", () => {
    const page = viewerPage();
    const start = page.indexOf("function sized()");
    const end = page.indexOf("// ---- Presenting the track", start);
    const callbacks = new Map<string, () => void>();
    const video = { videoWidth: 1920, videoHeight: 1080, readyState: 1, addEventListener: (name: string, fn: () => void) => callbacks.set(name, fn) };
    const say = vi.fn();
    new Script(page.slice(start, end)).runInNewContext({
      video, rtc: {}, presenter: null, content: {}, blocked: false, live: false,
      show() {}, layout() {}, clearTimeout() {}, patience: 1, say,
    });
    callbacks.get("loadedmetadata")!();
    expect(say).not.toHaveBeenCalled();
    callbacks.get("playing")!();
    expect(say).not.toHaveBeenCalled();
    video.readyState = 2;
    callbacks.get("playing")!();
    expect(say).toHaveBeenCalledWith("");
  });
});
