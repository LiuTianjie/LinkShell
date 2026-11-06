import { afterEach, describe, expect, it, vi } from "vitest";
import { RPC_METHOD_NOT_FOUND, RpcError, type SessionSummary } from "@linkshell/wire";
import { HostLink } from "../src/host-link.js";
import { createClientStore, type ClientStoreOptions } from "../src/store.js";
import { createSessionPreferences } from "../src/session-preferences.js";

const session: SessionSummary = { id: "codex:one", nativeId: "one", agent: "codex", cwd: "/work", state: "idle", pendingPermissions: 0, createdAt: 1, updatedAt: 1, lastSeq: 0, archived: false };

function setup(options: ClientStoreOptions = {}) {
  const link = new HostLink({ url: "ws://unused" });
  const call = vi.spyOn(link, "call");
  const store = createClientStore(link, options);
  return { store, call };
}

afterEach(() => vi.restoreAllMocks());

describe("models for a new session", () => {
  it("asks the host for the agent's models in the directory", async () => {
    const { store, call } = setup();
    const listed = { models: [{ value: "gpt-big", name: "GPT Big" }], current: "gpt-big" };
    call.mockResolvedValue(listed);
    expect(await store.getState().agentModels("codex", "/work")).toEqual(listed);
    expect(call).toHaveBeenCalledWith("agents.models", { agent: "codex", cwd: "/work" });
  });

  it("falls back only on a host without the method and preserves actionable agent failures", async () => {
    const { store, call } = setup();
    call.mockRejectedValueOnce(new RpcError(RPC_METHOD_NOT_FOUND, "unknown method agents.models"));
    expect(await store.getState().agentModels("codex")).toEqual({ models: [] });
    call.mockRejectedValueOnce(RpcError.app("host_outdated", "update host", { method: "agents.models" }));
    expect(await store.getState().agentModels("codex")).toEqual({ models: [] });
    call.mockRejectedValueOnce(RpcError.app("agent_unavailable", "Codex is not running"));
    await expect(store.getState().agentModels("codex")).rejects.toMatchObject({ appCode: "agent_unavailable" });
  });

  it("previews a picked model's settings and sends explicit initial configuration with creation", async () => {
    const { store, call } = setup();
    call.mockResolvedValue({ models: [] });
    await store.getState().agentModels("codex", "/work", "gpt-mini");
    expect(call).toHaveBeenLastCalledWith("agents.models", { agent: "codex", cwd: "/work", model: "gpt-mini" });
    call.mockResolvedValue({ session });
    await store.getState().createSession({ agent: "codex", cwd: "/work", config: { permissions: "read-only", effort: "high" } });
    expect(call).toHaveBeenLastCalledWith("sessions.create", expect.objectContaining({ config: { permissions: "read-only", effort: "high" } }), 60_000);
  });

  it("creates the session on the model given, and on the agent's default without one", async () => {
    const { store, call } = setup();
    call.mockResolvedValue({ session });
    await store.getState().createSession({ agent: "codex", cwd: "/work", model: "gpt-mini" });
    expect(call).toHaveBeenLastCalledWith("sessions.create", { agent: "codex", cwd: "/work", worktree: undefined, model: "gpt-mini" }, 60_000);
    await store.getState().createSession({ agent: "codex", cwd: "/work" });
    expect(call.mock.lastCall?.[1]).toMatchObject({ model: undefined });
  });

  it("restores validated preferences for shortcut creation and gives explicit settings priority", async () => {
    const saved = new Map<string, string>();
    const preferences = createSessionPreferences({ getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); } });
    preferences.remember("mac", "codex", { model: "gpt-big", config: { effort: "high", permissions: "read-only", removed: "on" } });
    const { store, call } = setup({ sessionPreferences: preferences });
    store.setState({ machine: { machineId: "mac", hostname: "Mac", platform: "darwin", hostVersion: "test", agents: [] } });
    const listed = {
      models: [{ value: "gpt-big", name: "GPT Big" }, { value: "gpt-mini", name: "GPT Mini" }],
      config: [
        { id: "effort", name: "Effort", category: "effort", current: "low", values: [{ value: "high", name: "High" }, { value: "low", name: "Low" }] },
        { id: "permissions", name: "Permissions", category: "mode", current: "auto", values: [{ value: "read-only", name: "Read only" }] },
      ],
    };
    call.mockImplementation(async (method) => method === "agents.models" ? listed : { session });
    await store.getState().createSession({ agent: "codex", cwd: "/work" });
    expect(call).toHaveBeenLastCalledWith("sessions.create", expect.objectContaining({ model: "gpt-big", config: { effort: "high", permissions: "read-only" } }), 60_000);
    await store.getState().createSession({ agent: "codex", cwd: "/work", model: "gpt-mini", config: { effort: "low" } });
    expect(call).toHaveBeenCalledWith("agents.models", { agent: "codex", cwd: "/work", model: "gpt-mini" });
    expect(call).toHaveBeenLastCalledWith("sessions.create", expect.objectContaining({ model: "gpt-mini", config: { effort: "low", permissions: "read-only" } }), 60_000);
    preferences.remember("mac", "codex", { model: "gone", config: { effort: "ultra", permissions: "removed" } });
    await store.getState().createSession({ agent: "codex", cwd: "/work" });
    expect(call).toHaveBeenLastCalledWith("sessions.create", { agent: "codex", cwd: "/work", worktree: undefined, model: undefined }, 60_000);
  });

  it("creates with explicit input or defaults when remembered choices cannot be checked", async () => {
    const saved = new Map<string, string>();
    const preferences = createSessionPreferences({ getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); } });
    preferences.remember("mac", "codex", { model: "gpt-big", config: { effort: "high", permissions: "full-access" } });
    const { store, call } = setup({ sessionPreferences: preferences });
    store.setState({ machine: { machineId: "mac", hostname: "Mac", platform: "darwin", hostVersion: "test", agents: [] } });
    call.mockImplementation(async (method) => {
      if (method === "agents.models") throw RpcError.app("model_list_failed", "模型列表暂时不可用");
      return { session };
    });
    await expect(store.getState().createSession({ agent: "codex", cwd: "/work" })).resolves.toEqual(session);
    expect(call).toHaveBeenLastCalledWith("sessions.create", { agent: "codex", cwd: "/work", worktree: undefined, model: undefined }, 60_000);
    await store.getState().createSession({ agent: "codex", cwd: "/work", model: "gpt-mini", config: { effort: "low" } });
    expect(call).toHaveBeenLastCalledWith("sessions.create", { agent: "codex", cwd: "/work", worktree: undefined, model: "gpt-mini", config: { effort: "low" } }, 60_000);
  });
});
