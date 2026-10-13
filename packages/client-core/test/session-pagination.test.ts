import { afterEach, expect, it, vi } from "vitest";
import { HostLink } from "../src/host-link.js";
import { createClientStore } from "../src/store.js";
import type { SessionSummary } from "@linkshell/wire";

afterEach(() => vi.restoreAllMocks());
const session = (id: string, updatedAt: number, archived = false): SessionSummary =>
  ({ id, nativeId: id, agent: "codex", cwd: "/work", state: "idle", pendingPermissions: 0, createdAt: 1, updatedAt, lastSeq: 0, archived });

it("continues archive pages past newer active sessions", async () => {
  const link = new HostLink({ url: "ws://unused" });
  const call = vi.spyOn(link, "call")
    .mockResolvedValueOnce({ sessions: [session("new", 20)], nextBefore: 20 })
    .mockResolvedValueOnce({ sessions: [session("old", 10, true)] });
  const store = createClientStore(link);
  await store.getState().loadArchived();
  expect(store.getState().archivedNextBefore).toBe(20);
  await store.getState().loadArchived(store.getState().archivedNextBefore);
  expect(call).toHaveBeenLastCalledWith("sessions.list", { limit: 200, includeArchived: true, before: 20 });
  expect(store.getState().sessions.old?.archived).toBe(true);
  expect(store.getState().archivedNextBefore).toBeUndefined();
});

it("preserves the cursor on failure so loading more can be retried", async () => {
  const link = new HostLink({ url: "ws://unused" });
  const call = vi.spyOn(link, "call").mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ sessions: [session("old", 10)] });
  const store = createClientStore(link);
  store.setState({ sessionsNextBefore: 20 });
  await expect(store.getState().loadMoreSessions()).rejects.toThrow("offline");
  expect(store.getState().sessionsNextBefore).toBe(20);
  await store.getState().loadMoreSessions();
  expect(call).toHaveBeenLastCalledWith("sessions.list", { limit: 200, before: 20 });
  expect(store.getState().sessions.old?.updatedAt).toBe(10);
  expect(store.getState().sessionsNextBefore).toBeUndefined();
  await store.getState().loadMoreSessions();
  expect(call).toHaveBeenCalledTimes(2);
});

it("does not roll back a newer live summary when an older page arrives", async () => {
  const link = new HostLink({ url: "ws://unused" });
  vi.spyOn(link, "call").mockResolvedValue({ sessions: [session("old", 10)] });
  const store = createClientStore(link);
  store.setState({ sessionsNextBefore: 20, sessions: { old: session("old", 30, true) } });
  await store.getState().loadMoreSessions();
  expect(store.getState().sessions.old).toMatchObject({ updatedAt: 30, archived: true });
});
