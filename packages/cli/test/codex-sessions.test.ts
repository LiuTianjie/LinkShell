import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCodexStoredSessions } from "../src/runtime/acp/codex-sessions.js";

let homeDir: string | undefined;
const originalHome = process.env.HOME;

function useTempHome(): string {
  homeDir = mkdtempSync(join(tmpdir(), "linkshell-codex-sessions-"));
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

describe("Codex local session discovery", () => {
  it("uses device-side Codex index and rollout metadata for session list", () => {
    const home = useTempHome();
    const codexRoot = join(home, ".codex");
    const activeDir = join(codexRoot, "sessions", "2026", "05", "16");
    const archivedDir = join(codexRoot, "archived_sessions");
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(archivedDir, { recursive: true });

    writeJsonl(join(codexRoot, "session_index.jsonl"), [
      {
        id: "019e-active",
        thread_name: "Active Codex Work",
        updated_at: "2026-05-16T01:00:00.000Z",
      },
      {
        id: "019e-archived",
        thread_name: "Archived Codex Work",
        updated_at: "2026-05-15T01:00:00.000Z",
      },
    ]);
    writeJsonl(join(activeDir, "rollout-2026-05-16T01-00-00-019e-active.jsonl"), [
      {
        timestamp: "2026-05-16T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019e-active",
          cwd: "/Users/tifenxia/ActiveProject",
          timestamp: "2026-05-16T00:59:00.000Z",
        },
      },
    ]);
    writeJsonl(join(archivedDir, "rollout-2026-05-15T01-00-00-019e-archived.jsonl"), [
      {
        timestamp: "2026-05-15T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019e-archived",
          cwd: "/Users/tifenxia/ArchivedProject",
          timestamp: "2026-05-15T00:59:00.000Z",
        },
      },
    ]);

    const result = listCodexStoredSessions("/fallback");

    expect(result.sessions.map((session) => session.id)).toEqual(["019e-active", "019e-archived"]);
    expect(result.sessions[0]).toMatchObject({
      cwd: "/Users/tifenxia/ActiveProject",
      title: "Active Codex Work",
      lastModified: Date.parse("2026-05-16T01:00:00.000Z"),
    });
    expect(result.sessions[1]).toMatchObject({
      cwd: "/Users/tifenxia/ArchivedProject",
      title: "Archived Codex Work",
      lastModified: Date.parse("2026-05-15T01:00:00.000Z"),
    });
  });
});
