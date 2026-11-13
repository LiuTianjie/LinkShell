import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostStore } from "../src/store.js";

let dir: string;
let store: HostStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lsh-store-"));
  store = new HostStore(join(dir, "state.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = { agent: "codex", cwd: "/work/app", createdAt: 1000, updatedAt: 1000 };

describe("HostStore", () => {
  it("assigns consecutive per-session seqs and reads after a cursor", () => {
    store.upsertSession({ ...base, id: "codex:a", nativeId: "a" });
    store.upsertSession({ ...base, id: "codex:b", nativeId: "b" });
    const e1 = store.appendEvent("codex:a", { sessionUpdate: "ls_status", state: "running" }, 2000);
    const e2 = store.appendEvent("codex:a", { sessionUpdate: "ls_status", state: "idle" }, 2001);
    const other = store.appendEvent("codex:b", { sessionUpdate: "ls_status", state: "idle" }, 2002);
    expect([e1.seq, e2.seq, other.seq]).toEqual([1, 2, 1]);
    expect(store.readEvents("codex:a", 1).map((e) => e.seq)).toEqual([2]);
    expect(store.getSession("codex:a")?.lastSeq).toBe(2);
    expect(store.getSession("codex:a")?.updatedAt).toBe(2001);
  });

  it("survives reopening", () => {
    store.upsertSession({ ...base, id: "codex:a", nativeId: "a" });
    store.appendEvent("codex:a", { sessionUpdate: "ls_status", state: "running" });
    store.close();
    store = new HostStore(join(dir, "state.db"));
    expect(store.readEvents("codex:a", 0)).toHaveLength(1);
    expect(store.appendEvent("codex:a", { sessionUpdate: "ls_status", state: "idle" }).seq).toBe(2);
  });

  it("upsert refreshes discovery fields without clobbering a preview", () => {
    store.upsertSession({ ...base, id: "codex:a", nativeId: "a", preview: "first" });
    const { summary, created } = store.upsertSession({
      ...base,
      id: "codex:a",
      nativeId: "a",
      title: "Fix login",
      preview: "second",
      updatedAt: 5000,
    });
    expect(created).toBe(false);
    expect(summary.title).toBe("Fix login");
    expect(summary.preview).toBe("first");
    expect(summary.updatedAt).toBe(5000);
  });

  it("pages sessions by updatedAt and groups projects by cwd", () => {
    for (let i = 0; i < 5; i += 1) {
      store.upsertSession({ ...base, id: `codex:${i}`, nativeId: `${i}`, cwd: i < 3 ? "/a" : "/b", updatedAt: 1000 + i });
    }
    const page = store.listSessions({ limit: 2 });
    expect(page.map((s) => s.id)).toEqual(["codex:4", "codex:3"]);
    expect(store.listSessions({ limit: 2, before: page[1]!.updatedAt }).map((s) => s.id)).toEqual(["codex:2", "codex:1"]);
    expect(store.listProjects()).toEqual([
      { cwd: "/b", name: "b", createdAt: 1000, lastActiveAt: 1004, sessionCount: 2 },
      { cwd: "/a", name: "a", createdAt: 1000, lastActiveAt: 1002, sessionCount: 3 },
    ]);
  });

  it("keeps project creation anchored across activity, worktrees, archives and reloads", () => {
    store.saveWorktree({ path: "/trees/old", branch: "old", source: "/work/app", sourceCwd: "/work/app", base: "main", createdAt: 100 });
    store.upsertSession({ ...base, id: "codex:old", nativeId: "old", cwd: "/trees/old", createdAt: 100, updatedAt: 100 });
    store.upsertSession({ ...base, id: "codex:new", nativeId: "new" });
    store.upsertSession({ ...base, id: "codex:archived", nativeId: "archived", cwd: "/archived" });
    store.patchSession("codex:archived", { archived: true });
    expect(store.listProjects()).toEqual([
      { cwd: "/work/app", name: "app", createdAt: 100, lastActiveAt: 1000, sessionCount: 2 },
    ]);

    store.appendEvent("codex:new", { sessionUpdate: "ls_status", state: "running" }, 5000);
    store.patchSession("codex:old", { archived: true });
    store.close();
    store = new HostStore(join(dir, "state.db"));
    expect(store.listProjects()).toEqual([
      { cwd: "/work/app", name: "app", createdAt: 100, lastActiveAt: 5000, sessionCount: 1 },
    ]);
  });

  it("dedups client messages and logged items", () => {
    store.upsertSession({ ...base, id: "codex:a", nativeId: "a" });
    expect(store.claimClientMessage("codex:a", "m1")).toBe(true);
    expect(store.claimClientMessage("codex:a", "m1")).toBe(false);
    store.releaseClientMessage("codex:a", "m1");
    expect(store.claimClientMessage("codex:a", "m1")).toBe(true);
    expect(store.markItemLogged("codex:a", "item-1")).toBe(true);
    expect(store.markItemLogged("codex:a", "item-1")).toBe(false);
    expect(store.isItemLogged("codex:a", "item-1")).toBe(true);
  });

  it("pages tied updatedAt sessions deterministically with composite (before, beforeId) cursor", () => {
    for (const id of ["codex:a", "codex:b", "codex:c", "codex:d"]) {
      store.upsertSession({ ...base, id, nativeId: id, updatedAt: 5000 });
    }
    store.upsertSession({ ...base, id: "codex:older", nativeId: "older", updatedAt: 4000 });

    const page1 = store.listSessions({ limit: 2 });
    expect(page1.map((s) => s.id)).toEqual(["codex:d", "codex:c"]);

    const page2 = store.listSessions({ limit: 2, before: page1[1]!.updatedAt, beforeId: page1[1]!.id });
    expect(page2.map((s) => s.id)).toEqual(["codex:b", "codex:a"]);

    const page3 = store.listSessions({ limit: 2, before: page2[1]!.updatedAt, beforeId: page2[1]!.id });
    expect(page3.map((s) => s.id)).toEqual(["codex:older"]);
  });

  it("resolves orphaned ls_permission events on resetLiveSessions() and guards writes after close()", () => {
    store.upsertSession({ ...base, id: "codex:perm", nativeId: "perm", state: "waiting", pendingPermissions: 2 });
    store.appendEvent(
      "codex:perm",
      {
        sessionUpdate: "ls_permission",
        requestId: "req-open",
        title: "Run git push",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
      2000,
    );
    store.appendEvent(
      "codex:perm",
      {
        sessionUpdate: "ls_permission",
        requestId: "req-done",
        title: "Read file",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
      2001,
    );
    store.appendEvent("codex:perm", { sessionUpdate: "ls_permission_resolved", requestId: "req-done", optionId: "allow" }, 2002);

    store.resetLiveSessions();
    const summary = store.getSession("codex:perm")!;
    expect(summary.state).toBe("offline");
    expect(summary.pendingPermissions).toBe(0);
    // Activity timestamp is not artificially bumped by restart cleanup.
    expect(summary.updatedAt).toBe(2002);

    const resolutions = store
      .readEvents("codex:perm", 0, 20)
      .filter((e) => e.update.sessionUpdate === "ls_permission_resolved")
      .map((e) => e.update);
    expect(resolutions).toEqual([
      { sessionUpdate: "ls_permission_resolved", requestId: "req-done", optionId: "allow" },
      { sessionUpdate: "ls_permission_resolved", requestId: "req-open" },
    ]);

    // Late async callbacks after close() do not throw ERR_INVALID_STATE.
    store.close();
    expect(store.isClosed).toBe(true);
    expect(() => store.appendEvent("codex:perm", { sessionUpdate: "ls_status", state: "idle" })).not.toThrow();
    expect(() => store.appendTerminalFrames("t1", [{ frame: 1, cols: 80, rows: 24, data: "x" }])).not.toThrow();
    expect(() => store.setDriverState("codex:perm", "k", "v")).not.toThrow();
  });
});

describe("terminal recording storage", () => {
  it("batches small frames by bytes and keeps oversized individual frames intact", () => {
    for (let i=1;i<=300;i++) store.appendTerminalFrame("tiny",i,80,24,"x");
    expect(store.terminalFrames("tiny",0,300)).toHaveLength(256);
    store.appendTerminalFrame("large",1,80,24,"a".repeat(400000));
    store.appendTerminalFrame("large",2,80,24,"b".repeat(400000));
    expect(store.terminalFrames("large",0,2).map(f=>f.frame)).toEqual([1]);
    store.appendTerminalFrame("oversize",1,80,24,"a".repeat(600000));
    expect(store.terminalFrames("oversize",0,1)[0]!.data).toHaveLength(600000);
  });
  it("persists and removes a bounded checkpoint with its recording", () => {
    const snapshot = { frame: 100, cols: 80, rows: 24, data: "state" };
    store.saveTerminalSnapshot("terminal",snapshot); store.close(); store = new HostStore(join(dir,"state.db"));
    expect(store.terminalSnapshot("terminal")).toEqual(snapshot);
    store.deleteTerminal("terminal"); expect(store.terminalSnapshot("terminal")).toBeUndefined();
  });
});
