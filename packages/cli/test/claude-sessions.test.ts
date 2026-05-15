import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listClaudeStoredSessions } from "../src/runtime/acp/claude-sessions.js";

let homeDir: string | undefined;
const originalHome = process.env.HOME;

function useTempHome(): string {
  homeDir = mkdtempSync(join(tmpdir(), "linkshell-claude-sessions-"));
  process.env.HOME = homeDir;
  return homeDir;
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

afterEach(() => {
  process.env.HOME = originalHome;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

describe("Claude local session discovery", () => {
  it("lists sessions across Claude project directories with cwd, title, and activity time", () => {
    const home = useTempHome();
    const projectsRoot = join(home, ".claude", "projects");
    const alphaProject = join(projectsRoot, "-Users-tifenxia-Alpha");
    const betaProject = join(projectsRoot, "-Users-tifenxia-Beta");
    mkdirSync(alphaProject, { recursive: true });
    mkdirSync(betaProject, { recursive: true });

    writeJsonl(join(alphaProject, "alpha-session.jsonl"), [
      {
        type: "user",
        cwd: "/Users/tifenxia/Alpha",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Build the Alpha workspace" },
      },
      {
        type: "assistant",
        cwd: "/Users/tifenxia/Alpha",
        timestamp: "2026-01-01T00:05:00.000Z",
        message: { role: "assistant", content: "Done" },
      },
    ]);
    writeJsonl(join(betaProject, "beta-session.jsonl"), [
      {
        type: "user",
        timestamp: "2026-01-02T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Inspect Beta" }] },
      },
    ]);

    const result = listClaudeStoredSessions("/fallback");

    expect(result.sessions.map((session) => session.id)).toEqual(["beta-session", "alpha-session"]);
    expect(result.sessions[0]).toMatchObject({
      cwd: "/Users/tifenxia/Beta",
      title: "Inspect Beta",
      createdAt: Date.parse("2026-01-02T00:00:00.000Z"),
      lastModified: Date.parse("2026-01-02T00:00:00.000Z"),
    });
    expect(result.sessions[1]).toMatchObject({
      cwd: "/Users/tifenxia/Alpha",
      title: "Build the Alpha workspace",
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      lastModified: Date.parse("2026-01-01T00:05:00.000Z"),
    });
  });
});
