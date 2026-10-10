import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const helper = vi.hoisted(() => ({ installed: true }));
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  accessSync: () => { if (!helper.installed) throw new Error("missing helper"); },
  existsSync: () => false,
}));
vi.mock("node:module", () => ({
  createRequire: () => ({ resolve: () => "/test/@linkshell/mac/package.json" }),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
function machine(os: string, arch: string) {
  Object.defineProperty(process, "platform", { ...platform, value: os });
  Object.defineProperty(process, "arch", { ...architecture, value: arch });
}

beforeEach(() => {
  helper.installed = true;
  vi.stubEnv("LINKSHELL_INPUT_APP", "");
  vi.resetModules();
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "arch", architecture);
  vi.unstubAllEnvs();
});

describe("the universal Mac screen helper", () => {
  it.each(["arm64", "x64"])("finds the same installed app on %s", async (arch) => {
    machine("darwin", arch);
    const { shippedApp } = await import("../src/input.js");
    expect(shippedApp()).toBe("/test/@linkshell/mac/build/LinkShell.app");
  });

  it.each(["arm64", "x64"])("reports a missing package, not an unsupported Mac, on %s", async (arch) => {
    machine("darwin", arch);
    helper.installed = false;
    const { ScreenShare } = await import("../src/screen.js");
    const access = await new ScreenShare(() => {}).access(false);
    expect(access).toMatchObject({ supported: true, ffmpeg: false, recording: null, control: null });
    expect(access.problem).toContain("@linkshell/mac was not installed");
  });

  it("still honors an explicitly disabled helper on Intel", async () => {
    machine("darwin", "x64");
    vi.stubEnv("LINKSHELL_INPUT_APP", "off");
    const { shippedApp } = await import("../src/input.js");
    expect(shippedApp()).toBeUndefined();
  });

  it.each([["linux", "x64"], ["win32", "x64"], ["darwin", "ia32"]])("does not open a Mac helper on %s/%s", async (os, arch) => {
    machine(os, arch);
    const { shippedApp } = await import("../src/input.js");
    expect(shippedApp()).toBeUndefined();
  });
});
