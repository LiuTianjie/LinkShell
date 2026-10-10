import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { expect, it, vi } from "vitest";
import { CodexDriver, startHost } from "@linkshell/host";
import { asyncQuestionReply } from "@linkshell/wire";
import { HostLink, type SocketLike } from "../src/host-link.js";
import { createClientStore } from "../src/store.js";

async function until(probe: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error("Question state did not reach the client");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("clears desktop answers on the phone home screen without opening or refreshing the conversation", async () => {
  const home = mkdtempSync(join(tmpdir(), "linkshell-question-home-"));
  const path = join(home, "rollout.jsonl");
  const record = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + "\n";
  const questions = ["Which terminal?", "Anything else?"].map((title, index) => ({
    id: JSON.stringify(["request_user_input_async", "call-q", index]), title, options: [],
  }));
  writeFileSync(path, record("event_msg", { type: "task_started", turn_id: "turn" }) + record("response_item", {
    type: "function_call", name: "request_user_input_async", call_id: "call-q", arguments: JSON.stringify({ questions }),
  }));
  const driver = new CodexDriver({ socketPath: join(home, "codex.sock"), hostVersion: "test", desktopBusPath: false });
  vi.spyOn(driver, "start").mockImplementation(async (host) => {
    (driver as unknown as { host: typeof host }).host = host;
    return { installed: true };
  });
  vi.spyOn(driver, "status").mockReturnValue({ installed: true });
  vi.spyOn(driver, "authStatus").mockResolvedValue({ state: "unknown" });
  vi.spyOn(driver, "archivedSessions").mockResolvedValue([]);
  const catalog = vi.spyOn(driver as unknown as { rpc: () => Promise<unknown> }, "rpc").mockResolvedValue({
    data: [{ id: "desktop", cwd: home, path, createdAt: 1, updatedAt: 2 }],
  });
  const host = await startHost({ home, version: "test", tcpPort: 0, iceServers: false, discoveryIntervalMs: 0, drivers: () => [driver], log: () => {} });
  const link = new HostLink({ url: `ws://127.0.0.1:${host.server.tcpAddress()}`, createSocket: (url) => new WebSocket(url) as unknown as SocketLike, heartbeatMs: 0 });
  const store = createClientStore(link, { newId: () => "test" });
  const calls = vi.spyOn(link, "call");
  const id = "codex:desktop";
  const answer = (index: number, value: string) => appendFileSync(path, record("response_item", {
    type: "message", role: "user", content: [{ type: "input_text", text: asyncQuestionReply([{ question: questions[index]!, answer: value }]) }],
  }));
  try {
    store.getState().connect();
    await until(() => store.getState().sessionsLoaded);
    expect(store.getState().sessions[id]?.asyncQuestions).toEqual(questions);
    answer(0, "Claude Code");
    await until(() => store.getState().sessions[id]?.asyncQuestions?.length === 1);
    expect(store.getState().sessions[id]?.asyncQuestions).toEqual([questions[1]]);
    answer(1, "");
    await until(() => store.getState().sessions[id]?.asyncQuestions?.length === 0);
    expect(store.getState().sessions[id]).toMatchObject({ state: "running", pendingPermissions: 0 });
    expect(store.getState().open).toEqual({});
    expect(calls.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(1);
    expect(catalog).toHaveBeenCalledTimes(1);
    store.getState().disconnect();
    store.getState().connect();
    await until(() => store.getState().status === "online" && calls.mock.calls.filter(([method]) => method === "sessions.list").length === 2);
    expect((await link.call("sessions.list", {})).sessions[0]?.asyncQuestions).toEqual([]);
  } finally {
    store.getState().disconnect();
    await host.stop();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  }
}, 10_000);
