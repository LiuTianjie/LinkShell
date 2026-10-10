import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archivedThreadIds } from "../src/drivers/codex/archives.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";
import { HostStore } from "../src/store.js";
import { SessionHub } from "../src/hub.js";
import type { SessionEvent } from "@linkshell/wire";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function home() {
  const dir = mkdtempSync(join(tmpdir(), "ls-codex-archives-"));
  dirs.push(dir);
  return dir;
}
const id = "01a125ca-04f5-70f0-9a01-c45fa2bfebbc";

describe("Codex archives", () => {
  it("finds old native archives without reading rollout contents or depending on recent-list pagination", async () => {
    const dir = home();
    expect(await archivedThreadIds(dir)).toEqual([]);
    const archives = join(dir, "archived_sessions");
    mkdirSync(archives);
    writeFileSync(join(archives, `rollout-2026-10-10T20-29-18-${id}.jsonl`), "not needed for archive discovery");
    writeFileSync(join(archives, "notes.jsonl"), "");
    mkdirSync(join(archives, "rollout-2026-10-10T20-29-18-01a1255f-1c58-7ce1-ad61-72d2ae1c131e.jsonl"));
    expect(await archivedThreadIds(dir)).toEqual([id]);
    const driver = new CodexDriver({ socketPath: join(dir, "codex.sock"), hostVersion: "test", env: { CODEX_HOME: dir } });
    expect(await driver.archivedSessions()).toEqual([id]);
  });

  it("imports archived history without unarchiving or starting an observer, and retries after restoration", async () => {
    const dir = home();
    const driver = new CodexDriver({ socketPath: join(dir, "codex.sock"), hostVersion: "test", env: { CODEX_HOME: dir }, sharedSocketPath: false });
    const store = new HostStore(join(dir, "state.db"));
    const hub = new SessionHub(store, [driver]);
    Object.assign(driver, { host: hub.driverHost });
    vi.spyOn(driver, "status").mockReturnValue({ installed: true });
    const resume = vi.spyOn(driver as unknown as { resume: (id: string) => Promise<unknown> }, "resume")
      .mockRejectedValue(new Error(`session ${id} is archived. Run codex unarchive to unarchive it first.`));
    const rpc = vi.spyOn(driver as unknown as { rpc: (method: string, params: unknown) => Promise<unknown> }, "rpc");
    rpc.mockResolvedValue({ thread: {
      id, cwd: dir, name: "Archived task", createdAt: 1, updatedAt: 2, status: { type: "notLoaded" },
      turns: [{ id: "turn", status: "interrupted", completedAt: 2, items: [
        { id: "user", type: "userMessage", content: [{ type: "text", text: "old question" }] },
        { id: "reply", type: "agentMessage", text: "old answer" },
      ] }],
    } });
    const sessionId = `codex:${id}`;
    hub.driverHost.sessionSeen("codex", { nativeId: id, cwd: dir, createdAt: 1000, updatedAt: 2000, state: "running" });
    const events: SessionEvent[] = [];
    try {
      const result = await hub.subscribe(sessionId, 0, { event: (event) => events.push(event) });
      expect(result.session).toMatchObject({ archived: true, state: "idle", updatedAt: 2000 });
      expect(events.map((event) => event.update)).toContainEqual(expect.objectContaining({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old answer" } }));
      expect(rpc.mock.calls).toEqual([["thread/read", { threadId: id, includeTurns: true }]]);
      expect((driver as unknown as { observed: Map<string, unknown> }).observed.size).toBe(0);
      expect(hub.listSessions({}).sessions).toEqual([]);

      hub.driverHost.sessionSeen("codex", { nativeId: id, cwd: dir, createdAt: 1000, updatedAt: 2000, state: "idle", archived: false });
      await hub.subscribe(sessionId, result.session.lastSeq, { event: () => {} });
      expect(resume).toHaveBeenCalledTimes(2);
    } finally {
      await hub.stop();
      store.close();
    }
  });
});
