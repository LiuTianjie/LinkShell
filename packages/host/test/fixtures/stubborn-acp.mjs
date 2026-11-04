#!/usr/bin/env node
// An ACP agent that, like some real ones, outlives its client: it ignores its
// stdin closing and hangups, and has a child of its own (STUBBORN_ACP_PIDS
// receives "agent grandchild" pids). Only a signal from outside ends it.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  process.stdout.write("stubborn-acp 1.0.0\n");
  process.exit(0);
}

process.on("SIGHUP", () => {});
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGHUP', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
if (process.env.STUBBORN_ACP_PIDS) writeFileSync(process.env.STUBBORN_ACP_PIDS, `${process.pid} ${grandchild.pid}`);
setInterval(() => {}, 1000);

const send = (message) => {
  try {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  } catch {}
};
process.stdout.on("error", () => {});
let buffer = "";
process.stdin.on("data", (data) => {
  buffer += data.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined || message.method === undefined) continue;
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    else send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
});
process.stdin.on("error", () => {});
