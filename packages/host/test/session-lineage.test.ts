import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentBlock, SessionSummary } from "@linkshell/wire";
import type { AgentDriver, DiscoveredSession, DriverHost, SessionLineage } from "../src/drivers/types.js";
import type { DriverBehavior } from "../src/drivers/behavior.js";
import { threadToDiscovered } from "../src/drivers/codex/mapper.js";
import { SessionHub, mergedArchive } from "../src/hub.js";
import { HostStore } from "../src/store.js";

class LineageDriver implements AgentDriver {
  readonly id = "fake";
  readonly label = "Fake";
  readonly tier = "multi_client" as const;
  readonly capabilities = { interrupt: true, steer: false, permissions: true, images: false, fork: false, models: false, modes: false };
  get behavior(): DriverBehavior {
    return { desktop: "multi_client", history: "native-snapshot", turnCompletion: "native-events", busyInput: "queue", fork: "context", detach: "local-only" };
  }
  host!: DriverHost;
  sessions: DiscoveredSession[] = [];
  lineages = new Map<string, SessionLineage>();
  appArchives = new Map<string, { archived: boolean; at: number }>();
  created = 0;
  async start(host: DriverHost) { this.host = host; return { installed: true, version: "1.0" }; }
  async stop() {}
  status() { return { installed: true, version: "1.0" }; }
  async listSessions() { return this.sessions; }
  lineage(nativeId: string) { return this.lineages.get(nativeId); }
  appArchive(nativeId: string) { return this.appArchives.get(nativeId); }
  async createSession(options: { cwd: string }) { return { nativeId: `made-${++this.created}`, cwd: options.cwd, createdAt: 5, updatedAt: 5 }; }
  async attach() { return []; }
  async detach() {}
  async prompt(_nativeId: string, _content: ContentBlock[], _clientMessageId: string) { return "started" as const; }
  async cancel() {}
  async respondPermission() {}
}

const session = (nativeId: string, updatedAt = 1): DiscoveredSession => ({ nativeId, cwd: "/w", createdAt: 1, updatedAt });

let dir: string;
let store: HostStore;
let driver: LineageDriver;
let hub: SessionHub;
let summaries: SessionSummary[];

async function startHub(): Promise<void> {
  hub = new SessionHub(store, [driver]);
  summaries = [];
  hub.onSummary((summary) => summaries.push(summary));
  await hub.start({ discoveryIntervalMs: 0 });
}

const listed = (id: string) => hub.listSessions({ includeArchived: true }).sessions.find((entry) => entry.id === id);
const lastSent = (id: string) => summaries.filter((entry) => entry.id === id).at(-1);
const active = () => hub.listSessions({}).sessions.map((entry) => entry.id).sort();
const appSays = (nativeId: string, archived: boolean, at: number) => {
  driver.appArchives.set(nativeId, { archived, at });
  driver.host.nativeRecordsChanged?.("fake", [nativeId]);
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "lsh-lineage-"));
  store = new HostStore(join(dir, "state.db"));
  driver = new LineageDriver();
});

afterEach(async () => {
  await hub.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("session lineage", () => {
  it("names the session that started one only when this host has it, first of the ids it may go by", async () => {
    driver.sessions = [session("child"), session("parent-now"), session("orphan")];
    driver.lineages.set("child", { parent: ["parent-now", "parent-before"] });
    driver.lineages.set("orphan", { parent: ["never-seen"] });
    await startHub();
    expect(listed("fake:child")?.parentId).toBe("fake:parent-now");
    expect(listed("fake:child")?.forkedFrom).toBeUndefined();
    expect(listed("fake:orphan")?.parentId).toBeUndefined();
    expect(listed("fake:parent-now")?.parentId).toBeUndefined();
    expect(hub.getSession("fake:child").parentId).toBe("fake:parent-now");
  });

  it("sends the child again when its parent appears, when its lineage changes, and when its parent goes", async () => {
    driver.sessions = [session("child")];
    driver.lineages.set("child", { parent: ["parent"] });
    await startHub();
    expect(listed("fake:child")?.parentId).toBeUndefined();

    driver.sessions = [session("child"), session("parent")];
    await hub.refreshDiscovery();
    expect(lastSent("fake:child")?.parentId).toBe("fake:parent");

    driver.lineages.delete("child");
    driver.host.nativeRecordsChanged?.("fake", ["child"]);
    expect(lastSent("fake:child")).toMatchObject({ id: "fake:child" });
    expect(lastSent("fake:child")?.parentId).toBeUndefined();

    driver.lineages.set("child", { parent: ["parent"] });
    driver.host.nativeRecordsChanged?.("fake", ["child", "not-a-session"]);
    expect(lastSent("fake:child")?.parentId).toBe("fake:parent");

    driver.host.removed("fake", "parent");
    expect(lastSent("fake:child")?.parentId).toBeUndefined();
    expect(listed("fake:child")?.parentId).toBeUndefined();
  });

  it("remembers what a session made here was forked from, apart from what started it", async () => {
    driver.sessions = [session("original")];
    await startHub();
    const fork = await hub.fork("fake:original");
    expect(fork.forkedFrom).toBe("fake:original");
    expect(fork.parentId).toBeUndefined();
    expect(listed(fork.id)?.forkedFrom).toBe("fake:original");

    // Kept across a restart; gone from the row once the original is.
    await hub.stop();
    await startHub();
    expect(listed(fork.id)?.forkedFrom).toBe("fake:original");
    driver.host.removed("fake", "original");
    expect(lastSent(fork.id)?.forkedFrom).toBeUndefined();
  });

  it("takes a fork the agent records, such as Codex's forkedFromId", async () => {
    const thread = { id: "fork", cwd: "/w", createdAt: 1, updatedAt: 2, forkedFromId: "source" };
    expect(threadToDiscovered(thread).forkedFrom).toBe("source");
    expect(threadToDiscovered({ ...thread, forkedFromId: null }).forkedFrom).toBeUndefined();
    driver.sessions = [session("source"), threadToDiscovered(thread)];
    await startHub();
    expect(listed("fake:fork")?.forkedFrom).toBe("fake:source");
    expect(listed("fake:source")?.forkedFrom).toBeUndefined();
  });
});

describe("archive state from an app LinkShell only reads", () => {
  it("is archived in either place, unless unarchived here after the app archived it", () => {
    expect(mergedArchive({ archived: true, at: 5 }, undefined)).toBe(true);
    expect(mergedArchive({ archived: false, at: 5 }, undefined)).toBe(false);
    // Chosen before times were kept: never outranks the app.
    expect(mergedArchive({ archived: false, at: 0 }, { archived: true, since: 10 })).toBe(true);
    expect(mergedArchive({ archived: false, at: 20 }, { archived: true, since: 10 })).toBe(false);
    expect(mergedArchive({ archived: false, at: 20 }, { archived: true, since: 30 })).toBe(true);
    // The app unarchiving doesn't undo an archive made here.
    expect(mergedArchive({ archived: true, at: 5 }, { archived: false, since: 30 })).toBe(true);
    expect(mergedArchive({ archived: false, at: 5 }, { archived: false, since: 30 })).toBe(false);
  });

  it("starts a session the app has archived as archived, and follows the app's changes live", async () => {
    driver.sessions = [session("a"), session("b")];
    driver.appArchives.set("a", { archived: true, at: 100 });
    driver.appArchives.set("b", { archived: false, at: 100 });
    await startHub();
    expect(active()).toEqual(["fake:b"]);
    expect(listed("fake:a")?.archived).toBe(true);

    appSays("b", true, 200);
    expect(lastSent("fake:b")?.archived).toBe(true);
    expect(active()).toEqual([]);
    appSays("a", false, 300);
    expect(lastSent("fake:a")?.archived).toBe(false);
    expect(active()).toEqual(["fake:a"]);
  });

  it("lets an unarchive here outrank an older app archive, until the app archives it again", async () => {
    const now = Date.now();
    driver.sessions = [session("a")];
    driver.appArchives.set("a", { archived: true, at: now - 60_000 });
    await startHub();
    expect(listed("fake:a")?.archived).toBe(true);

    expect((await hub.archive("fake:a", false)).archived).toBe(false);
    // The app saves the record again, still archived: not an archive of it.
    appSays("a", true, now + 1000);
    await hub.refreshDiscovery();
    expect(active()).toEqual(["fake:a"]);

    appSays("a", false, now + 2000);
    expect(active()).toEqual(["fake:a"]);
    appSays("a", true, now + 3000);
    expect(lastSent("fake:a")?.archived).toBe(true);
    expect(active()).toEqual([]);

    await hub.stop();
    await startHub();
    expect(listed("fake:a")?.archived).toBe(true);
  });

  it("keeps what was archived here archived, whatever the app says", async () => {
    driver.sessions = [session("a"), session("b")];
    await startHub();
    await hub.archive("fake:a", true);
    // Archived here before the app's state was ever merged in (an older host).
    store.patchSession("fake:b", { archived: true });

    appSays("a", false, Date.now() + 1000);
    appSays("b", true, 1);
    appSays("b", false, 2);
    expect(listed("fake:a")?.archived).toBe(true);
    expect(listed("fake:b")?.archived).toBe(true);
    expect(active()).toEqual([]);
  });

  it("drops an archived child from the active list, and lets a child stand alone when its parent is archived", async () => {
    driver.sessions = [session("parent"), session("child")];
    driver.lineages.set("child", { parent: ["parent"] });
    await startHub();
    expect(listed("fake:child")?.parentId).toBe("fake:parent");

    appSays("child", true, 1);
    expect(active()).toEqual(["fake:parent"]);
    expect(listed("fake:child")).toMatchObject({ archived: true, parentId: "fake:parent" });

    appSays("child", false, 2);
    expect(active()).toEqual(["fake:child", "fake:parent"]);
    await hub.archive("fake:parent", true);
    expect(lastSent("fake:child")?.parentId).toBeUndefined();
    expect(listed("fake:child")?.parentId).toBeUndefined();

    // Both archived: under 已归档 it nests again.
    await hub.archive("fake:child", true);
    expect(listed("fake:child")?.parentId).toBe("fake:parent");
    await hub.archive("fake:parent", false);
    expect(lastSent("fake:child")).toMatchObject({ archived: true, parentId: "fake:parent" });
  });
});
