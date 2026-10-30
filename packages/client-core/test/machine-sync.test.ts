import { afterEach, expect, it, vi } from "vitest";
import type { MachineInfo } from "@linkshell/wire";
import { HostLink } from "../src/host-link.js";
import { createClientStore } from "../src/store.js";

afterEach(() => vi.restoreAllMocks());

it("keeps a live rename when an earlier metadata refresh finishes loading projects", async () => {
  const link = new HostLink({ url: "ws://unused" });
  const notifications = new Map<string, (params: unknown) => void>();
  vi.spyOn(link, "on").mockImplementation((name, listener) => {
    notifications.set(name, listener as (params: unknown) => void);
    return () => {};
  });
  const before: MachineInfo = { machineId: "host-a", hostname: "Old name", platform: "darwin", hostVersion: "test", agents: [] };
  const renamed: MachineInfo = { ...before, hostname: "Shared name", naming: { defaultName: "Mac", customName: "Shared name", configured: true } };
  let releaseProjects!: (value: { projects: [] }) => void;
  const projects = new Promise<{ projects: [] }>((resolve) => { releaseProjects = resolve; });
  vi.spyOn(link, "call").mockImplementation((method) => {
    if (method === "machine.info") return Promise.resolve(before);
    if (method === "projects.list") return projects;
    if (method === "agents.pending") return Promise.resolve({ interactions: [] });
    return Promise.resolve({ sessions: [] });
  });
  const store = createClientStore(link);
  store.setState({ machine: before });
  const refresh = store.getState().refresh();
  await Promise.resolve();
  notifications.get("machine.changed")!(renamed);
  releaseProjects({ projects: [] });
  await refresh;
  expect(store.getState().machine).toBe(renamed);
  expect(store.getState().sessionsLoaded).toBe(true);
});
