// Live acceptance check against the real Codex CLI (costs a few tiny turns).
//   pnpm --filter @linkshell/host live:codex
// Verifies: create + stream, approvals answered through the host, a thread
// opened by another client (the desktop TUI path) is followed live, and
// desktop.launch attaches the real TUI.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { ABANDON, RpcPeer, type SessionEvent } from "@linkshell/wire";
import { connectHost } from "../src/rpc/client.js";
import { startHost } from "../src/host.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";

const home = mkdtempSync("/tmp/lsh-live-");
const workspace = mkdtempSync(join(home, "ws-"));
const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push([name, ok, detail]);
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}\n`);
};

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

const host = await startHost({
  home,
  version: "live-check",
  env: process.env,
  drivers: (paths) => [new CodexDriver({ socketPath: paths.codexSocket, env: process.env, hostVersion: "live-check" })],
  log: (m) => process.stderr.write(`${m}\n`),
});
try {
  const info = host.machineInfo();
  const codex = info.agents.find((agent) => agent.id === "codex");
  check("codex detected and app-server running", Boolean(codex?.installed && !codex.problem), codex?.version ?? codex?.problem);

  const client = await connectHost(host.paths.hostSocket);
  const events: SessionEvent[] = [];
  client.on("session.event", (event) => events.push(event));
  const of = (id: string) => events.filter((e) => e.sessionId === id);
  const text = (id: string) =>
    of(id)
      .map((e) => (e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text" ? e.update.content.text : ""))
      .join("");
  const ended = (id: string) => of(id).filter((e) => e.update.sessionUpdate === "ls_turn" && e.update.state === "ended");

  // 1. Create from the "phone" and stream.
  const { session } = await client.call("sessions.create", { agent: "codex", cwd: workspace });
  await client.call("sessions.subscribe", { sessionId: session.id, fromSeq: 0 });
  await client.call("sessions.prompt", {
    sessionId: session.id,
    clientMessageId: "live-1",
    content: [{ type: "text", text: "Reply with exactly: LIVE-OK. Do not use tools." }],
  });
  await waitFor(() => ended(session.id).length >= 1, 120_000);
  const chunks = of(session.id).filter((e) => e.update.sessionUpdate === "agent_message_chunk").length;
  check("reply streamed through the host", text(session.id).includes("LIVE-OK"), `${chunks} chunks, text=${JSON.stringify(text(session.id).slice(0, 40))}`);
  check("summary has title and preview", Boolean(host.hub.getSession(session.id).title && host.hub.getSession(session.id).preview));

  // 2. A thread started by another app-server client with approvals on (the TUI path), driven from the host.
  const socket = new WebSocket(`ws+unix://${host.paths.codexSocket}:/`, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  // Like a real TUI waiting on its user: it sees approval requests but doesn't answer them.
  const tui = new RpcPeer({ send: (t) => socket.send(t), onRequest: () => ABANDON });
  socket.on("message", (data) => tui.receive(data.toString()));
  await tui.request("initialize", { clientInfo: { name: "live-tui", title: null, version: "0" }, capabilities: null });
  const started = await tui.request<{ thread: { id: string } }>("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    sandbox: "read-only",
  });
  const tuiSession = `codex:${started.thread.id}`;
  const seen = await waitFor(() => host.hub.listSessions({}).sessions.find((s) => s.id === tuiSession), 10_000);
  check("thread opened by another client appears on the host", Boolean(seen));
  await client.call("sessions.subscribe", { sessionId: tuiSession, fromSeq: 0 });
  await client.call("sessions.prompt", {
    sessionId: tuiSession,
    clientMessageId: "live-2",
    content: [{ type: "text", text: "Run the shell command `touch approved.txt` in the current directory, then reply DONE." }],
  });
  const permission = await waitFor(() => of(tuiSession).find((e) => e.update.sessionUpdate === "ls_permission"), 120_000);
  check("real approval request reached the client", Boolean(permission), permission ? JSON.stringify(permission.update).slice(0, 160) : undefined);
  if (permission && permission.update.sessionUpdate === "ls_permission") {
    await client.call("sessions.permission", { sessionId: tuiSession, requestId: permission.update.requestId, optionId: "accept" });
    const resolved = await waitFor(
      () => of(tuiSession).find((e) => e.update.sessionUpdate === "ls_permission_resolved"),
      30_000,
    );
    check("approval resolved", Boolean(resolved));
  }
  await waitFor(() => ended(tuiSession).length >= 1, 180_000);
  const tool = of(tuiSession).find((e) => e.update.sessionUpdate === "tool_call");
  check("tool call mapped", Boolean(tool), tool ? JSON.stringify(tool.update).slice(0, 120) : undefined);
  socket.close();

  // 3. How the desktop shim would attach the TUI.
  const launch = await client.call("desktop.launch", { agent: "codex", sessionId: session.id, args: [] });
  check("desktop.launch points the TUI at the shared socket", launch.args.includes(`unix://${host.paths.codexSocket}`), `${launch.command} ${launch.args.join(" ")}`);
  process.stdout.write(`\nTUI attach command (run it to watch the same thread):\n  ${launch.command} ${launch.args.join(" ")}\n`);
  client.close();
} finally {
  await host.stop();
  rmSync(home, { recursive: true, force: true });
}
const failed = results.filter(([, ok]) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
