import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLinuxCapturePlan,
  buildLinuxInputCommands,
  buildWaylandFfmpegMjpegArgs,
  buildWaylandGstArgs,
  buildWaylandWfRecorderArgs,
  buildX11CaptureArgs,
  detectLinuxDisplayServer,
  JpegFrameSplitter,
  LinuxInputControl,
  listLinuxDisplays,
  parseWlrRandrJson,
  parseXdpyinfoDimensions,
  probeLinuxScreen,
} from "../src/linux-screen.js";

function mockRunner(availableBins: Set<string>, options: { gstPlugins?: Set<string>; stdout?: Record<string, string> } = {}) {
  return async (cmd: string, args: string[]) => {
    if (cmd === "which") {
      const bin = args[0] ?? "";
      if (availableBins.has(bin)) return { stdout: `/usr/bin/${bin}\n`, stderr: "" };
      throw new Error(`not found: ${bin}`);
    }
    if (cmd === "gst-inspect-1.0") {
      const plugin = args[0] ?? "";
      if (options.gstPlugins?.has(plugin)) return { stdout: plugin, stderr: "" };
      throw new Error(`missing plugin: ${plugin}`);
    }
    if (options.stdout?.[cmd] !== undefined) {
      return { stdout: options.stdout[cmd]!, stderr: "" };
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
}

describe("linux-screen detection, probing, and capture builders", () => {
  it("detects X11 vs Wayland from XDG_SESSION_TYPE and WAYLAND_DISPLAY", () => {
    expect(detectLinuxDisplayServer({})).toBe("x11");
    expect(detectLinuxDisplayServer({ XDG_SESSION_TYPE: "x11" })).toBe("x11");
    expect(detectLinuxDisplayServer({ XDG_SESSION_TYPE: "wayland" })).toBe("wayland");
    expect(detectLinuxDisplayServer({ WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland");
  });

  it("reports structured diagnostics for X11 with and without ffmpeg/xdotool", async () => {
    const ok = await probeLinuxScreen({
      env: { XDG_SESSION_TYPE: "x11" },
      runCommand: mockRunner(new Set(["ffmpeg", "xdpyinfo", "xdotool"])),
    });
    expect(ok).toMatchObject({
      displayServer: "x11",
      captureBackend: "x11-ffmpeg",
      captureFormat: "h264",
      inputBackend: "xdotool",
      recording: true,
      control: true,
    });
    expect(ok.problem).toBeUndefined();

    const missing = await probeLinuxScreen({
      env: { XDG_SESSION_TYPE: "x11" },
      runCommand: mockRunner(new Set()),
    });
    expect(missing).toMatchObject({
      displayServer: "x11",
      captureBackend: null,
      inputBackend: null,
      recording: false,
      control: false,
      missingCapture: ["ffmpeg"],
      missingInput: ["xdotool"],
    });
    expect(missing.problem).toContain("ffmpeg");
    expect(missing.problem).toContain("xdotool");
  });

  it("selects Wayland capture & input backends by priority with structured fallbacks", async () => {
    // 1. wf-recorder + dotool
    const wf = await probeLinuxScreen({
      env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1" },
      runCommand: mockRunner(new Set(["wf-recorder", "ffmpeg", "dotool"])),
    });
    expect(wf).toMatchObject({
      displayServer: "wayland",
      captureBackend: "wayland-wf-recorder",
      captureFormat: "h264",
      inputBackend: "dotool",
      recording: true,
      control: true,
    });
    const wfPlan = buildLinuxCapturePlan(wf, 0, { width: 1920, fps: 30, bitrate: 3_000_000, ceiling: 4_000_000 });
    expect(wfPlan?.command).toBe("wf-recorder");
    expect(wfPlan?.pipeTo?.command).toBe("ffmpeg");

    // 2. gst-launch-1.0 pipewiresrc + vaapih264enc + ydotool
    const vaapi = await probeLinuxScreen({
      env: { WAYLAND_DISPLAY: "wayland-0", YDOTOOL_SOCKET: "/tmp/.ydotool_socket" },
      runCommand: mockRunner(new Set(["gst-launch-1.0", "ydotool"]), {
        gstPlugins: new Set(["pipewiresrc", "vaapih264enc", "x264enc"]),
      }),
      fileExists: (p) => p === "/tmp/.ydotool_socket",
    });
    expect(vaapi).toMatchObject({
      captureBackend: "wayland-gst-vaapi",
      captureFormat: "h264",
      inputBackend: "ydotool",
      recording: true,
      control: true,
    });
    expect(vaapi.problem).toBeUndefined();

    // 3. gst-launch-1.0 pipewiresrc + x264enc + wtype only (keyboard-only advisory note)
    const x264 = await probeLinuxScreen({
      env: { WAYLAND_DISPLAY: "wayland-0" },
      runCommand: mockRunner(new Set(["gst-launch-1.0", "wtype"]), {
        gstPlugins: new Set(["pipewiresrc", "x264enc"]),
      }),
    });
    expect(x264).toMatchObject({
      captureBackend: "wayland-gst-x264",
      inputBackend: "wtype",
      control: true,
    });
    expect(x264.problem).toContain("wtype");

    // 4. gst-launch-1.0 pipewiresrc + ffmpeg MJPEG fallback when no gst H.264/jpegenc plugin exists
    const mjpeg = await probeLinuxScreen({
      env: { WAYLAND_DISPLAY: "wayland-0" },
      runCommand: mockRunner(new Set(["gst-launch-1.0", "ffmpeg"]), {
        gstPlugins: new Set(["pipewiresrc"]),
      }),
    });
    expect(mjpeg).toMatchObject({
      captureBackend: "wayland-ffmpeg-mjpeg",
      captureFormat: "jpeg",
      recording: true,
      control: false,
    });
    const mjpegPlan = buildLinuxCapturePlan(mjpeg, 1, { width: 1280, fps: 24, bitrate: 1_500_000, ceiling: 2_000_000 });
    expect(mjpegPlan?.command).toBe("gst-launch-1.0");
    expect(mjpegPlan?.pipeTo?.command).toBe("ffmpeg");
    expect(mjpegPlan?.format).toBe("jpeg");

    // 5. Nothing installed on Wayland -> clear diagnostics, no crash
    const empty = await probeLinuxScreen({
      env: { WAYLAND_DISPLAY: "wayland-0" },
      runCommand: mockRunner(new Set()),
    });
    expect(empty.recording).toBe(false);
    expect(empty.control).toBe(false);
    expect(empty.missingCapture).toContain("wf-recorder");
  });

  it("parses display dimensions and constructs capture args cleanly", async () => {
    expect(parseXdpyinfoDimensions("  dimensions:    2560x1440 pixels (677x381 millimeters)\n")).toEqual({ w: 2560, h: 1440 });
    expect(parseWlrRandrJson(JSON.stringify([
      { name: "DP-1", description: "Dell 4K", enabled: true, modes: [{ width: 3840, height: 2160, current: true }] },
      { name: "HDMI-1", enabled: false, modes: [] },
    ]))).toEqual([{ index: 0, screen: 0, name: "Dell 4K", output: "DP-1", w: 3840, h: 2160 }]);

    const x11Displays = await listLinuxDisplays({
      env: { XDG_SESSION_TYPE: "x11" },
      runCommand: mockRunner(new Set(["xdpyinfo"]), { stdout: { xdpyinfo: "dimensions: 1920x1080 pixels" } }),
    });
    expect(x11Displays).toEqual([{ index: 0, screen: 0, name: "屏幕", w: 1920, h: 1080 }]);

    const profile = { width: 1280, fps: 30, bitrate: 1_800_000, ceiling: 2_500_000 };
    expect(buildX11CaptureArgs(0, profile, ":99")).toContain(":99");
    expect(buildWaylandWfRecorderArgs(profile, { mode: "nut", output: "DP-1" })).toContain("nut");
    expect(buildWaylandGstArgs("x264", profile)).toContain("x264enc");
    expect(buildWaylandFfmpegMjpegArgs(profile)).toContain("mjpeg");
  });

  it("splits concatenated MJPEG frames across chunk boundaries", () => {
    const splitter = new JpegFrameSplitter();
    const frame1 = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const frame2 = Buffer.from([0xff, 0xd8, 9, 8, 7, 6, 0xff, 0xd9]);
    const combined = Buffer.concat([Buffer.from([0, 0]), frame1, frame2]);
    const frames: Buffer[] = [];
    splitter.push(combined.subarray(0, 5), (f) => frames.push(Buffer.from(f)));
    splitter.push(combined.subarray(5, 11), (f) => frames.push(Buffer.from(f)));
    splitter.push(combined.subarray(11), (f) => frames.push(Buffer.from(f)));
    expect(frames).toEqual([frame1, frame2]);
  });
});

describe("Linux pointer & keyboard input commands and control readiness", () => {
  it("maps move, down/up, click, scroll, key, and text across xdotool, ydotool, dotool, and wtype", () => {
    const size = { w: 1001, h: 501 };

    expect(buildLinuxInputCommands({ t: "move", x: 0.5, y: 0.5 }, "xdotool", size)).toEqual([
      { command: "xdotool", args: ["mousemove", "500", "250"] },
    ]);
    expect(buildLinuxInputCommands({ t: "down", b: "left", m: ["shift"] }, "xdotool", size)).toEqual([
      { command: "xdotool", args: ["keydown", "Shift_L"] },
      { command: "xdotool", args: ["mousedown", "1"] },
    ]);
    expect(buildLinuxInputCommands({ t: "click", b: "right", n: 2 }, "xdotool", size)).toEqual([
      { command: "xdotool", args: ["click", "--repeat", "2", "--delay", "25", "3"] },
    ]);
    expect(buildLinuxInputCommands({ t: "scroll", dx: 0, dy: 3 }, "xdotool", size)).toEqual([
      { command: "xdotool", args: ["click", "--repeat", "3", "--delay", "0", "4"] },
    ]);
    expect(buildLinuxInputCommands({ t: "key", k: "c", m: ["ctrl"] }, "xdotool", size)).toEqual([
      { command: "xdotool", args: ["key", "Control_L+c"] },
    ]);

    expect(buildLinuxInputCommands({ t: "move", x: 0.5, y: 0.5 }, "ydotool", size)).toEqual([
      { command: "ydotool", args: ["mousemove", "--absolute", "-x", "500", "-y", "250"] },
    ]);
    expect(buildLinuxInputCommands({ t: "down", b: "right" }, "ydotool", size)).toEqual([
      { command: "ydotool", args: ["click", "0x41"] },
    ]);
    expect(buildLinuxInputCommands({ t: "key", k: "c", m: ["ctrl"] }, "ydotool", size)).toEqual([
      { command: "ydotool", args: ["key", "29:1", "46:1", "46:0", "29:0"] },
    ]);

    expect(buildLinuxInputCommands({ t: "move", x: 0.25, y: 0.75 }, "dotool", size)).toEqual([
      { command: "dotool", args: [], stdin: "mouseto 0.2500 0.7500\n" },
    ]);
    expect(buildLinuxInputCommands({ t: "text", s: "hi\nbye" }, "dotool", size)).toEqual([
      { command: "dotool", args: [], stdin: "type hi\nkey Return\ntype bye\n" },
    ]);

    expect(buildLinuxInputCommands({ t: "key", k: "Return", m: ["cmd"] }, "wtype", size)).toEqual([
      { command: "wtype", args: ["-M", "logo", "-k", "Return"] },
    ]);
    expect(buildLinuxInputCommands({ t: "move", x: 0.1, y: 0.2 }, "wtype", size)).toEqual([]);
  });

  it("reports control readiness and executes/coalesces input commands via LinuxInputControl", async () => {
    const states: unknown[] = [];
    const executed: Array<{ cmd: string; args: string[] }> = [];
    let releaseExec!: () => void;
    let blockNext = true;

    const control = new LinuxInputControl(
      { state: (s) => states.push(s), cursor: () => {} },
      () => {},
      {
        env: { XDG_SESSION_TYPE: "x11" },
        runCommand: async (cmd, args) => {
          if (cmd === "which") {
            if (args[0] === "xdotool" || args[0] === "xdpyinfo") return { stdout: `/usr/bin/${args[0]}`, stderr: "" };
            throw new Error("missing");
          }
          if (cmd === "xdpyinfo") return { stdout: "dimensions: 1001x501 pixels", stderr: "" };
          executed.push({ cmd, args });
          if (blockNext) {
            blockNext = false;
            await new Promise<void>((resolve) => { releaseExec = resolve; });
          }
          return { stdout: "", stderr: "" };
        },
      },
    );

    await control.start(0);
    expect(states).toEqual([{ available: true, trusted: true, app: "xdotool" }]);

    // First move blocks; two subsequent moves coalesce into only the latest coordinate.
    control.send({ t: "move", x: 0.1, y: 0.1 });
    control.send({ t: "move", x: 0.2, y: 0.2 });
    control.send({ t: "move", x: 0.9, y: 0.9 });
    await vi.waitFor(() => expect(executed).toHaveLength(1));
    releaseExec();
    await vi.waitFor(() => expect(executed).toHaveLength(2));
    expect(executed[1]?.args).toEqual(["mousemove", "900", "450"]);
    control.stop();
  });
});

describe("ScreenShare.access integration on Linux", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("reports recording and control booleans accurately when Linux tools are probed", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
    vi.doMock("../src/linux-screen.js", async (original) => {
      const mod = await original<typeof import("../src/linux-screen.js")>();
      return {
        ...mod,
        probeLinuxScreen: vi.fn(async () => ({
          displayServer: "wayland" as const,
          captureBackend: "wayland-wf-recorder" as const,
          captureFormat: "h264" as const,
          inputBackend: "dotool" as const,
          recording: true,
          control: true,
          missingCapture: [],
          missingInput: [],
          captureTools: { ffmpeg: false, wfRecorder: true, gstLaunch: false, gstPipewire: false, gstVaapiH264: false, gstX264: false, gstJpeg: false, xdpyinfo: false, wlrRandr: true },
          inputTools: { xdotool: false, ydotool: false, ydotoolSocket: false, dotool: true, wtype: false },
        })),
      };
    });
    const { ScreenShare } = await import("../src/screen.js");
    const access = await new ScreenShare(() => {}).access(false);
    expect(access).toEqual({
      supported: true,
      ffmpeg: true,
      recording: true,
      control: true,
      app: "dotool",
    });
  });
});
