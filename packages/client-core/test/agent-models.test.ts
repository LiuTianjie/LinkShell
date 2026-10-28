import { afterEach, describe, expect, it, vi } from "vitest";
import { RPC_METHOD_NOT_FOUND, RpcError, type SessionSummary } from "@linkshell/wire";
import { HostLink } from "../src/host-link.js";
import { createClientStore } from "../src/store.js";

const session: SessionSummary = { id: "codex:one", nativeId: "one", agent: "codex", cwd: "/work", state: "idle", pendingPermissions: 0, createdAt: 1, updatedAt: 1, lastSeq: 0, archived: false };

function setup() {
  const link = new HostLink({ url: "ws://unused" });
  const call = vi.spyOn(link, "call");
  const store = createClientStore(link);
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

  it("has nothing to choose from on a host without the method, or when the agent can't be asked", async () => {
    const { store, call } = setup();
    call.mockRejectedValueOnce(new RpcError(RPC_METHOD_NOT_FOUND, "unknown method agents.models"));
    expect(await store.getState().agentModels("codex")).toEqual({ models: [] });
    call.mockRejectedValueOnce(RpcError.app("agent_unavailable", "Codex is not running"));
    expect(await store.getState().agentModels("codex")).toEqual({ models: [] });
  });

  it("creates the session on the model given, and on the agent's default without one", async () => {
    const { store, call } = setup();
    call.mockResolvedValue({ session });
    await store.getState().createSession({ agent: "codex", cwd: "/work", model: "gpt-mini" });
    expect(call).toHaveBeenLastCalledWith("sessions.create", { agent: "codex", cwd: "/work", worktree: undefined, model: "gpt-mini" }, 60_000);
    await store.getState().createSession({ agent: "codex", cwd: "/work" });
    expect(call.mock.lastCall?.[1]).toMatchObject({ model: undefined });
  });
});
