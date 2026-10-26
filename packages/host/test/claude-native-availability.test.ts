import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpDriver } from "../src/drivers/acp/driver.js";
import { ClaudeDriver } from "../src/drivers/claude/driver.js";
import { ClaudeTranscriptIndex, encodeProjectDir } from "../src/drivers/claude/transcript.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync) };
});

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

class InspectableClaude extends ClaudeDriver {
  seedSession(nativeId: string, cwd: string, turnActive: boolean): void {
    const state = this.stateFor(nativeId, cwd);
    state.loaded = true;
    state.turnActive = turnActive;
  }
}

function fixture() {
  const config = mkdtempSync(join(tmpdir(), "linkshell-claude-availability-"));
  directories.push(config);
  const cwd = join(config, "work");
  const transcript = (id: string, project = cwd) => join(config, "projects", encodeProjectDir(project), `${id}.jsonl`);
  const write = (id: string, project = cwd) => {
    const path = transcript(id, project);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}\n");
    return path;
  };
  const driver = new InspectableClaude({
    hostVersion: "test", env: { ...process.env, CLAUDE_CONFIG_DIR: config },
    adapter: { command: process.execPath, args: [] },
  });
  return { config, cwd, driver, transcript, write, index: new ClaudeTranscriptIndex(config) };
}

describe("Claude native session availability", () => {
  it("finds a moved transcript and notices its removal even while the directory index is cached", () => {
    const f = fixture();
    const original = f.write("old");
    expect(f.index.locate("old", f.cwd)).toEqual({ status: "available", path: original });
    expect(f.index.locate("missing", f.cwd).status).toBe("missing");
    const moved = f.transcript("old", join(f.config, "moved-work"));
    mkdirSync(dirname(moved), { recursive: true });
    renameSync(original, moved);
    expect(f.index.locate("old", f.cwd)).toEqual({ status: "available", path: moved });
    unlinkSync(moved);
    expect(f.index.locate("old", f.cwd)).toEqual({ status: "missing" });
  });

  it("does not infer deletion from an unreadable project store or an invalid transcript path", () => {
    const f = fixture();
    vi.mocked(readdirSync).mockImplementationOnce(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    expect(f.index.locate("old", f.cwd)).toEqual({ status: "unknown" });
    mkdirSync(f.transcript("old"), { recursive: true });
    f.index.invalidate();
    expect(f.index.locate("old", f.cwd)).toEqual({ status: "unknown" });
  });

  it("scans project directories once for a batch of missing sessions and refreshes restored files", () => {
    const f = fixture();
    f.write("other", join(f.config, "other-work"));
    vi.mocked(readdirSync).mockClear();
    for (let i = 0; i < 20; i++) expect(f.index.locate(`missing-${i}`, f.cwd).status).toBe("missing");
    expect(readdirSync).toHaveBeenCalledTimes(2);
    f.write("missing-0", join(f.config, "other-work"));
    f.index.invalidate();
    expect(f.index.locate("missing-0", f.cwd).status).toBe("available");
  });

  it("keeps failed attaches and old idle driver state from proving that a deleted session exists", async () => {
    const f = fixture();
    await expect(f.driver.attach("old", { cwd: f.cwd })).rejects.toMatchObject({ appCode: "history_unavailable" });
    expect(f.driver.nativeSessionAvailability("old", f.cwd)).toBe("missing");
    f.driver.seedSession("old", f.cwd, false);
    await f.driver.desktopLaunch(["--resume", "old"], undefined, { cwd: f.cwd });
    expect(f.driver.nativeSessionAvailability("old", f.cwd)).toBe("missing");
    await expect(f.driver.attach("old", { cwd: f.cwd })).rejects.toMatchObject({ appCode: "history_unavailable" });
  });

  it("protects a real writer or active turn, then recognizes the missing record after they end", () => {
    const f = fixture();
    mkdirSync(join(f.config, "sessions"));
    const holder = join(f.config, "sessions", `${process.pid}.json`);
    writeFileSync(holder, JSON.stringify({ sessionId: "old", pid: process.pid }));
    expect(f.driver.nativeSessionAvailability("old", f.cwd)).toBe("available");
    unlinkSync(holder);
    expect(f.driver.nativeSessionAvailability("old", f.cwd)).toBe("missing");
    f.driver.seedSession("old", f.cwd, true);
    expect(f.driver.nativeSessionAvailability("old", f.cwd)).toBe("available");
    f.driver.seedSession("old", f.cwd, false);
    expect(f.driver.nativeSessionAvailability("old", f.cwd)).toBe("missing");
  });

  it("protects newly created empty sessions only until their transcript is observed", async () => {
    const f = fixture();
    vi.spyOn(AcpDriver.prototype, "createSession").mockResolvedValue({ nativeId: "new", cwd: f.cwd, createdAt: 1, updatedAt: 1 });
    await f.driver.createSession({ cwd: f.cwd });
    expect(f.driver.nativeSessionAvailability("new", f.cwd)).toBe("available");
    const path = f.write("new");
    expect(f.driver.nativeSessionAvailability("new", f.cwd)).toBe("available");
    unlinkSync(path);
    expect(f.driver.nativeSessionAvailability("new", f.cwd)).toBe("missing");
  });
});
