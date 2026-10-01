#!/usr/bin/env node
// Plays the Claude Code CLI for LinkShell tests: `--version`, `auth status
// --json`, and a "TUI" that reads prompts from stdin (one per line) and writes
// the session transcript the way Claude Code does
// ($CLAUDE_CONFIG_DIR/projects/<encoded cwd>/<id>.jsonl, one block per line,
// assistant blocks sharing the API message id). A prompt containing "TOOL"
// makes a Bash tool call first. Exits cleanly on SIGTERM.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("9.9.9 (Claude Code)\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) + "\n");
  process.exit(0);
}

const idFlag = args.findIndex((a) => a === "--session-id" || a === "--resume");
if (idFlag < 0) {
  process.stderr.write("fake-claude: need --session-id or --resume\n");
  process.exit(2);
}
const sessionId = args[idFlag + 1];
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const cwd = process.cwd();
const dir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
const path = join(dir, `${sessionId}.jsonl`);
let parent = null;
let titled = args[idFlag] === "--resume";

function write(entry) {
  mkdirSync(dir, { recursive: true });
  const line = { parentUuid: parent, isSidechain: false, sessionId, cwd, entrypoint: "cli", version: "9.9.9", timestamp: new Date().toISOString(), ...entry };
  if (line.uuid) parent = line.uuid;
  appendFileSync(path, JSON.stringify(line) + "\n");
}
const msgId = () => `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

function handle(text) {
  write({ type: "user", uuid: randomUUID(), message: { role: "user", content: text } });
  if (!titled) {
    write({ type: "ai-title", aiTitle: `Task: ${text}` });
    titled = true;
  }
  if (text.includes("TOOL")) {
    const toolId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const first = msgId();
    write({ type: "assistant", uuid: randomUUID(), message: { id: first, role: "assistant", content: [{ type: "thinking", thinking: "let me look" }], stop_reason: null } });
    write({
      type: "assistant",
      uuid: randomUUID(),
      message: { id: first, role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "ls", description: "List files" } }], stop_reason: "tool_use" },
    });
    write({ type: "user", uuid: randomUUID(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "a.txt" }] } });
  }
  write({
    type: "assistant",
    uuid: randomUUID(),
    message: { id: msgId(), role: "assistant", content: [{ type: "text", text: `echo: ${text}` }], stop_reason: "end_turn" },
  });
}

let buffer = "";
process.stdin.on("data", (data) => {
  buffer += data.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
// Keep running until killed, like a TUI.
setInterval(() => {}, 1 << 30);
