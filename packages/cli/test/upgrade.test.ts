import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUpgrade } from "../src/commands/upgrade.js";
import { runUpgradeWorker } from "../src/commands/upgrade-worker.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ realpathSync: vi.fn() }));
vi.mock("../src/commands/upgrade-worker.js", () => ({ runUpgradeWorker: vi.fn() }));

const exec = vi.mocked(execFileSync);
let output: string;
const exitCode = process.exitCode;

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  output = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ version: "2.0.0" })));
  vi.mocked(realpathSync).mockReturnValue("/usr/local/lib/node_modules/linkshell-cli/dist/cli/src/index.js");
  vi.mocked(runUpgradeWorker).mockResolvedValue("  Host is ready.\n");
  exec.mockImplementation((_command, args) => {
    if (args?.includes("--version")) return "2.0.0\n";
    if (args?.[0] === "root") return "/npm prefix with spaces/lib/node_modules\n";
    if (args?.[0] === "--prefix") return "/opt/homebrew/opt/linkshell\n";
    return "";
  });
});

afterEach(() => {
  process.exitCode = exitCode;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const hostCalls = () => vi.mocked(runUpgradeWorker).mock.calls;

describe("linkshell upgrade", () => {
  it("installs with npm, then verifies and runs the newly installed CLI", async () => {
    await runUpgrade("1.0.0");
    expect(exec.mock.calls[0]?.slice(0, 2)).toEqual(["npm", ["install", "-g", "linkshell-cli@latest"]]);
    const entry = "/npm prefix with spaces/lib/node_modules/linkshell-cli/dist/cli/src/index.js";
    expect(exec).toHaveBeenCalledWith(process.execPath, [entry, "--version"], expect.anything());
    expect(hostCalls()[0]?.[0]).toEqual({ command: process.execPath, args: [entry] });
    expect(output).toContain("LinkShell 2.0.0 is ready");
    expect(process.exitCode).toBeUndefined();
  });

  it("uses Homebrew's new opt path after the old Cellar path has been removed", async () => {
    vi.mocked(realpathSync).mockReturnValue("/opt/homebrew/Cellar/linkshell/1.0.0/libexec/lib/node_modules/linkshell-cli/dist/cli/src/index.js");
    await runUpgrade("1.0.0");
    expect(exec.mock.calls[0]?.slice(0, 2)).toEqual(["brew", ["upgrade", "linkshell"]]);
    expect(hostCalls()[0]?.[0]).toEqual({ command: "/opt/homebrew/opt/linkshell/bin/linkshell", args: [] });
  });

  it("still updates an older host when the CLI is already current", async () => {
    await runUpgrade("2.0.0");
    expect(exec.mock.calls.some(([command]) => command === "npm" || command === "brew")).toBe(false);
    expect(hostCalls()).toHaveLength(1);
    expect(output).toContain("Checking the host");
  });

  it("leaves the host alone when installation fails", async () => {
    exec.mockImplementationOnce(() => { throw new Error("installation failed"); });
    await runUpgrade("1.0.0");
    expect(hostCalls()).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(output).not.toContain("is ready");
  });

  it("does not stop the host if the package manager left an old executable", async () => {
    exec.mockImplementation((_command, args) => args?.[0] === "root" ? "/npm/lib/node_modules" : args?.includes("--version") ? "1.0.0\n" : "");
    await runUpgrade("1.0.0");
    expect(hostCalls()).toEqual([]);
    expect(output).toContain("Expected CLI 2.0.0");
    expect(process.exitCode).toBe(1);
  });

  it("does not report success when the new host fails verification", async () => {
    vi.mocked(runUpgradeWorker).mockRejectedValue(new Error("host did not start"));
    await runUpgrade("2.0.0");
    expect(process.exitCode).toBe(1);
    expect(output).not.toContain("is ready");
  });

  it("makes no installation or host changes when the registry is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await runUpgrade("1.0.0");
    expect(exec).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
