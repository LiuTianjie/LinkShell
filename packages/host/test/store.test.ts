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
      { cwd: "/b", name: "b", lastActiveAt: 1004, sessionCount: 2 },
      { cwd: "/a", name: "a", lastActiveAt: 1002, sessionCount: 3 },
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
