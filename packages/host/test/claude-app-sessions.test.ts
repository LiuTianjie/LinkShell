import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAppSessions, claudeAppSessionRoots, parseAppSession } from "../src/drivers/claude/app-sessions.js";
import { ClaudeDriver } from "../src/drivers/claude/driver.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

const PARENT = "5d28e526-894f-49bd-ad9e-1ab0a427a1a1";
const CHILD = "dc64a33b-196a-4b6c-8c70-520f820f7a1c";

/** A HOME with the desktop app's session records, laid out as the app lays them out on a Mac. */
function fixture(variant: "Claude" | "Claude-3p" = "Claude-3p") {
  const home = mkdtempSync(join(tmpdir(), "linkshell-claude-app-"));
  directories.push(home);
  const roots = claudeAppSessionRoots({ HOME: home }, "darwin");
  const dir = join(home, "Library", "Application Support", variant, "claude-code-sessions", "3991b394-f5d5-49ff-bc9e-c133283ebcda", "00000000-0000-4000-8000-000000000001");
  mkdirSync(dir, { recursive: true });
  let tick = 0;
  const write = (id: string, data: object | string) => {
    const path = join(dir, `local_${id}.json`);
    writeFileSync(path, typeof data === "string" ? data : JSON.stringify({ sessionId: `local_${id}`, cwd: "/w", title: id, isArchived: false, ...data }));
    // A rewrite within the same millisecond must still read as a change.
    const at = new Date(Date.now() + ++tick * 1000);
    utimesSync(path, at, at);
  };
  const tombstone = (id: string) => writeFileSync(join(dir, `deleted_${id}`), "1792749361566");
  return { home, roots, dir, write, tombstone };
}

const startedBy = (parent: string) => ({ spawnedFrom: { sessionId: `local_${parent}`, taskId: "task_7d4cc6c6", title: "成片评分表", sideSession: true, sharedFolder: true, name: "session" } });

describe("Claude desktop app session records", () => {
  it("looks in both builds' places on each OS", () => {
    expect(claudeAppSessionRoots({ HOME: "/Users/u" }, "darwin")).toEqual([
      "/Users/u/Library/Application Support/Claude/claude-code-sessions",
      "/Users/u/Library/Application Support/Claude-3p/claude-code-sessions",
    ]);
    expect(claudeAppSessionRoots({ HOME: "/home/u", XDG_CONFIG_HOME: "/cfg" }, "linux")).toEqual([
      join("/cfg", "Claude", "claude-code-sessions"), join("/cfg", "Claude-3p", "claude-code-sessions"),
    ]);
    expect(claudeAppSessionRoots({ USERPROFILE: "C:/Users/u", APPDATA: "C:/Users/u/AppData/Roaming" }, "win32")[1]).toBe(join("C:/Users/u/AppData/Roaming", "Claude-3p", "claude-code-sessions"));
  });

  for (const variant of ["Claude-3p", "Claude"] as const) {
    it(`gives a session started by another that session's Claude Code ids (${variant})`, async () => {
      const f = fixture(variant);
      f.write(PARENT, { cliSessionId: "parent-now", priorCliSessionIds: ["parent-first", "parent-second"] });
      f.write(CHILD, { cliSessionId: "child-now", priorCliSessionIds: ["child-before"], ...startedBy(PARENT) });
      const index = new ClaudeAppSessions(f.roots);
      expect(index.lineage("child-now")).toBeUndefined();
      await index.refresh(true);
      const lineage = { parent: ["parent-now", "parent-second", "parent-first"] };
      expect(index.lineage("child-now")).toEqual(lineage);
      // What the child was before it was cleared was started by the parent too.
      expect(index.lineage("child-before")).toEqual(lineage);
      expect(index.lineage("parent-now")).toBeUndefined();
    });
  }

  it("ignores a deleted, malformed or missing parent, and a session moved to the top level", async () => {
    const f = fixture();
    f.write("deleted-parent", { cliSessionId: "gone" });
    f.tombstone("deleted-parent");
    f.write("child-of-deleted", { cliSessionId: "c1", ...startedBy("deleted-parent") });
    f.write("malformed-parent", "{ not json");
    f.write("child-of-malformed", { cliSessionId: "c2", ...startedBy("malformed-parent") });
    f.write("child-of-missing", { cliSessionId: "c3", ...startedBy("never-written") });
    f.write(PARENT, { cliSessionId: "p" });
    f.write("detached", { cliSessionId: "c4", lineageDetached: true, ...startedBy(PARENT) });
    f.write("malformed-child", "[1, 2");
    f.write(CHILD, { cliSessionId: "c5", ...startedBy(PARENT) });
    const index = new ClaudeAppSessions(f.roots);
    await index.refresh(true);
    for (const id of ["c1", "c2", "c3", "c4", "gone"]) expect(index.lineage(id)).toBeUndefined();
    expect(index.lineage("c5")).toEqual({ parent: ["p"] });
  });

  it("tells a fork from a session another started, as the app does", () => {
    // The user forked it: a copy, not started by the session.
    expect(parseAppSession({
      sessionId: "local_f", cliSessionId: "f", forkedFromSessionId: "local_o",
      spawnedFrom: { sessionId: "local_o", sideSession: true, userFork: true, btw: true, name: "fork" },
    })?.relation).toEqual({ kind: "forkedFrom", of: "local_o" });
    // A fork of a fork comes from the fork it was made from, not the session the first fork was taken of.
    expect(parseAppSession({
      sessionId: "local_f2", cliSessionId: "f2", forkedFromSessionId: "local_f",
      spawnedFrom: { sessionId: "local_o", sideSession: true, userFork: true, name: "fork-2" },
    })?.relation).toEqual({ kind: "forkedFrom", of: "local_f" });
    // start_session with the conversation forked in: still started by that session.
    expect(parseAppSession({
      sessionId: "local_s", cliSessionId: "s", forkedFromSessionId: "local_o",
      spawnedFrom: { sessionId: "local_o", sideSession: true, name: "task" },
    })?.relation).toEqual({ kind: "parent", of: "local_o" });
    // Its parent deleted: handed to the grandparent, still a session that one started.
    expect(parseAppSession({
      sessionId: "local_s", cliSessionId: "s", forkedFromSessionId: "local_deleted",
      spawnedFrom: { sessionId: "local_grand", sideSession: true, name: "task", deletedParent: { sessionId: "local_deleted" } },
    })?.relation).toEqual({ kind: "parent", of: "local_grand" });
    expect(parseAppSession({ sessionId: "local_x", cliSessionId: "x" })?.relation).toBeUndefined();
    expect(parseAppSession({ sessionId: "local_x" })).toBeUndefined();
    expect(parseAppSession(null)).toBeUndefined();
  });

  it("reads only what changed, and says whose lineage changed", async () => {
    const f = fixture();
    f.write(PARENT, { cliSessionId: "p" });
    f.write(CHILD, { cliSessionId: "c", ...startedBy(PARENT) });
    const changes: string[][] = [];
    const index = new ClaudeAppSessions(f.roots, (ids) => changes.push(ids), 60_000);
    await index.refresh(true);
    expect(changes).toEqual([["c"]]);
    // Within the interval asking doesn't look again.
    f.write(CHILD, { cliSessionId: "c", lineageDetached: true, ...startedBy(PARENT) });
    index.lineage("c");
    await index.refresh();
    expect(index.lineage("c")).toEqual({ parent: ["p"] });
    await index.refresh(true);
    expect(index.lineage("c")).toBeUndefined();
    expect(changes).toEqual([["c"], ["c"]]);
    await index.refresh(true);
    expect(changes).toHaveLength(2);
  });

  it("says which sessions the app has archived, and only a change of that is news", async () => {
    const f = fixture();
    f.write(PARENT, { cliSessionId: "p", isArchived: true });
    f.write(CHILD, { cliSessionId: "c", priorCliSessionIds: ["c-before"], isArchived: false });
    const changes: string[][] = [];
    const index = new ClaudeAppSessions(f.roots, (ids) => changes.push(ids), 60_000);
    expect(index.archive("p")).toBeUndefined();
    await index.refresh(true);
    const archivedAt = index.archive("p")?.at ?? 0;
    expect(index.archive("p")).toEqual({ archived: true, at: archivedAt });
    expect(archivedAt).toBeGreaterThan(0);
    expect(index.archive("c")?.archived).toBe(false);
    expect(index.archive("c-before")?.archived).toBe(false);
    expect(index.archive("not-in-the-app")).toBeUndefined();
    // First seen unarchived and from nowhere: nothing to tell.
    expect(changes).toEqual([["p"]]);

    f.write(CHILD, { cliSessionId: "c", priorCliSessionIds: ["c-before"], isArchived: true });
    await index.refresh(true);
    expect(changes.at(-1)?.sort()).toEqual(["c", "c-before"]);
    const childAt = index.archive("c")!.at;
    // Saved again for something else: the time moves, the news doesn't.
    f.write(CHILD, { cliSessionId: "c", priorCliSessionIds: ["c-before"], isArchived: true, lastActivityAt: 5 });
    await index.refresh(true);
    expect(changes).toHaveLength(2);
    expect(index.archive("c")!.at).toBeGreaterThan(childAt);
  });

  it("is what the Claude driver answers lineage and the app's archive with", async () => {
    const f = fixture();
    f.write(PARENT, { cliSessionId: "p" });
    f.write(CHILD, { cliSessionId: "c", isArchived: true, ...startedBy(PARENT) });
    const driver = new ClaudeDriver({
      hostVersion: "test", env: { ...process.env, CLAUDE_CONFIG_DIR: join(f.home, ".claude") },
      adapter: { command: process.execPath, args: [] }, appSessionRoots: f.roots,
    });
    driver.lineage("c");
    await vi.waitFor(() => expect(driver.lineage("c")).toEqual({ parent: ["p"], appId: `local_${CHILD}` }));
    // Mail between the app's sessions names the sender by this id.
    expect(driver.lineage("p")).toEqual({ appId: `local_${PARENT}` });
    expect(driver.appArchive("c")?.archived).toBe(true);
    expect(driver.appArchive("p")?.archived).toBe(false);
  });
});
