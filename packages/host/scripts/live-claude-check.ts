// Live acceptance check for Claude handoff against the real Claude Code CLI
// and the bundled ACP adapter. Costs a few tiny turns on your Claude account.
// Run it from your own terminal (it needs your `claude /login`):
//   pnpm --filter @linkshell/host live:claude
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@linkshell/wire";
import { ClaudeDriver } from "../src/drivers/claude/driver.js";
import { connectHost } from "../src/rpc/client.js";
import { startHost } from "../src/host.js";

const home = realpathSync(mkdtempSync("/tmp/lsh-live-claude-"));
const workspace = realpathSync(mkdtempSync(join(home, "ws-")));
const REPORT = "/tmp/linkshell-live-claude.txt";
writeFileSync(REPORT, `LinkShell live Claude check — ${new Date().toISOString()}\n`);
/** Synchronous, so nothing is lost if the process exits or the terminal capture ends early. */
function out(line: string): void {
  writeSync(1, `${line}\n`);
  appendFileSync(REPORT, `${line}\n`);
}
const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push([name, ok, detail]);
  out(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
async function waitFor<T>(probe: () => T | undefined | false, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}
/** Runs the Claude CLI without blocking the event loop (the host keeps working meanwhile). */
function claude(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: workspace, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output.trim());
    });
  });
}

const host = await startHost({
  home,
  version: "live-check",
  env: process.env,
  // Short busy window: the desktop step below is a finished `claude -p`, not a running TUI.
  drivers: () => [new ClaudeDriver({ env: process.env, hostVersion: "live-check", busyWindowMs: 1500 })],
  discoveryIntervalMs: 0,
  log: (m) => process.stderr.write(`${m}\n`),
});
try {
  await host.hub.refreshAuthIfStale(0);
  const agent = host.machineInfo().agents[0]!;
  check("claude and the ACP adapter start", agent.installed && !agent.problem, agent.problem ?? `claude ${agent.version}`);
  check("claude is logged in", agent.auth?.state === "ok", JSON.stringify(agent.auth));
  if (agent.auth?.state !== "ok" || agent.problem) {
    throw new Error("Claude isn't usable from this process. Run this check in Terminal/iTerm (not from the Claude app), where `claude` is logged in.");
  }

  // 1. Desktop: a session made by the Claude CLI.
  const nativeId = randomUUID();
  const first = await claude(["-p", "--session-id", nativeId, "Remember the code word PELICAN-42. Reply only: stored"]);
  check("desktop session created with claude -p", /stored/i.test(first), first.slice(0, 60));
  const sessionId = `claude:${nativeId}`;
  await host.hub.refreshDiscovery();
  const found = await waitFor(() => host.hub.listSessions({ limit: 100 }).sessions.find((s) => s.id === sessionId), 10_000);
  check("host discovers the new session", Boolean(found), found?.title);

  // 2. Phone: history from the real transcript, then take over and ask.
  const client = await connectHost(host.paths.hostSocket);
  const events: SessionEvent[] = [];
  client.on("session.event", (event) => events.push(event));
  // Chunks of one message are joined as-is (they're token fragments); messages by newline.
  const texts = (kind: "agent_message_chunk" | "user_message_chunk") => {
    const byMessage = new Map<string, string>();
    for (const { update: u } of events) {
      if ((u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "user_message_chunk") && u.sessionUpdate === kind && u.content.type === "text") {
        const key = u.messageId ?? "";
        byMessage.set(key, (byMessage.get(key) ?? "") + u.content.text);
      }
    }
    return [...byMessage.values()].join("\n");
  };
  await client.call("sessions.subscribe", { sessionId, fromSeq: 0 });
  check("real transcript imported", texts("user_message_chunk").includes("PELICAN-42") && /stored/i.test(texts("agent_message_chunk")));
  await new Promise((resolve) => setTimeout(resolve, 1600)); // past the busy window
  const delivery = await client.call("sessions.prompt", {
    sessionId,
    clientMessageId: "live-phone-1",
    content: [{ type: "text", text: "What is the code word? Reply with just the word." }],
  });
  check("phone takes over and sends", delivery.delivery === "started");
  // The imported history only says "stored"; the code word can only come from the new turn.
  const answered = await waitFor(() => /PELICAN-42/.test(texts("agent_message_chunk")), 120_000);
  check("context continues on the phone (answers PELICAN-42)", Boolean(answered), texts("agent_message_chunk").slice(-60));
  const ended = await waitFor(() => events.some((e) => e.update.sessionUpdate === "ls_turn" && e.update.state === "ended"), 60_000);
  check("remote turn ends", Boolean(ended));
  check("models reported for the session", events.some((e) => e.update.sessionUpdate === "ls_config"));

  // 3. Back to the desktop: the CLI sees the phone's turn, and the phone sees the CLI's.
  const reclaim = await client.call("desktop.reclaim", { sessionId });
  check("reclaim returns claude --resume", reclaim.args.join(" ") === `--resume ${nativeId}`, `${reclaim.command} ${reclaim.args.join(" ")}`);
  const back = await claude(["-p", "--resume", nativeId, "What did I ask you in my previous message? Reply in under 12 words."]);
  check("desktop sees the phone's turn", /code word/i.test(back), back.slice(0, 80));
  const mirrored = await waitFor(() => texts("user_message_chunk").includes("What did I ask you"), 15_000);
  check("phone sees the desktop's next turn", Boolean(mirrored));
  const userLines = events.filter((e) => e.update.sessionUpdate === "user_message_chunk").length;
  check("no message imported twice", userLines === 3, `${userLines} user messages`);
  client.close();
} catch (error) {
  out(`stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await host.stop();
  rmSync(home, { recursive: true, force: true });
}
const failed = results.filter(([, ok]) => !ok).length;
out(`\n${results.length - failed}/${results.length} checks passed  (report: ${REPORT})`);
process.exit(failed === 0 && results.length > 0 ? 0 : 1);
