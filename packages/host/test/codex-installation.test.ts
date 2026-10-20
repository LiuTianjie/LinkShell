import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsDesktopCodexCandidates } from "../src/drivers/codex/installation.js";
import { findCodex } from "../src/drivers/codex/app-server.js";
import { probeAgent } from "../src/process.js";

vi.mock("../src/process.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/process.js")>(),
  probeAgent: vi.fn(),
}));

describe("Codex desktop installation discovery", () => {
  const temporary: string[] = [];
  afterEach(() => {
    vi.resetAllMocks();
    for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function installation() {
    const root = mkdtempSync(join(tmpdir(), "linkshell-codex-中文 空格-"));
    temporary.push(root);
    const bin = join(root, "OpenAI", "Codex", "bin");
    const old = join(bin, "old", "codex.exe"), latest = join(bin, "latest", "codex.exe");
    for (const directory of ["old", "latest", "ripgrep", "incomplete"]) mkdirSync(join(bin, directory), { recursive: true });
    writeFileSync(old, "fixture"); writeFileSync(latest, "fixture");
    writeFileSync(join(bin, "ripgrep", "rg.exe"), "fixture");
    mkdirSync(join(bin, "incomplete", "codex.exe"));
    utimesSync(old, 1000, 1000); utimesSync(latest, 2000, 2000);
    return { root, old, latest, env: { LocalAppData: root, CODEX_HOME: join(root, "custom-state") } };
  }
  it("finds only executables, newest first, independently of the Codex state directory", () => {
    const { env, latest, old } = installation();
    expect(windowsDesktopCodexCandidates(env)).toEqual([latest, old]);
    expect(windowsDesktopCodexCandidates({ LOCALAPPDATA: join(env.LocalAppData, "missing") })).toEqual([]);
    expect(windowsDesktopCodexCandidates({ LOCALAPPDATA: "relative-directory" })).toEqual([]);
  });
  it("preserves an explicitly selected command and never falls back from it", async () => {
    const { env } = installation();
    vi.mocked(probeAgent).mockRejectedValue(new Error("missing"));
    expect(await findCodex("custom-codex", env)).toBeUndefined();
    expect(probeAgent).toHaveBeenCalledTimes(1);
    expect(probeAgent).toHaveBeenCalledWith("custom-codex", ["--version"], { env, timeout: 10_000 });
  });
  it("prefers an existing CLI on PATH", async () => {
    const { env } = installation();
    vi.mocked(probeAgent).mockResolvedValue({ stdout: "codex-cli 1.2.3\n", stderr: "" });
    expect(await findCodex(undefined, env)).toEqual({ command: "codex", version: "1.2.3" });
    expect(probeAgent).toHaveBeenCalledTimes(1);
  });
  it.skipIf(process.platform !== "win32")("falls back from absent PATH and an unusable desktop binary to a working version", async () => {
    const { env, latest, old } = installation();
    vi.mocked(probeAgent).mockRejectedValueOnce(new Error("ENOENT"))
      .mockRejectedValueOnce(new Error("invalid executable"))
      .mockResolvedValueOnce({ stdout: "codex-cli 0.163.0\r\n", stderr: "" });
    expect(await findCodex(undefined, env)).toEqual({ command: old, version: "0.163.0" });
    expect(vi.mocked(probeAgent).mock.calls.map(call => call[0])).toEqual(["codex", latest, old]);
    expect(vi.mocked(probeAgent).mock.calls.every(call => call[2]?.env === env)).toBe(true);
  });
  it.skipIf(process.platform !== "win32")("reports unavailable when neither installation works", async () => {
    const { env } = installation();
    vi.mocked(probeAgent).mockRejectedValue(new Error("unavailable"));
    expect(await findCodex(undefined, env)).toBeUndefined();
  });
});
