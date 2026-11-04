import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackgroundTask } from "@linkshell/wire";
import { ClaudeTasks } from "../src/drivers/claude/tasks.js";
import { canFindTaskProcesses, stdoutWriters, stopTaskGroup } from "../src/drivers/claude/task-process.js";
import { outputRange } from "../src/task-output.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const line = (extra: object) => JSON.stringify({ timestamp: 1000, ...extra });
function fixture() {
  const updates: BackgroundTask[] = [];
  const tasks = new ClaudeTasks((task) => updates.push(task));
  const start = (id = "b1", call = "call1", name = "Bash", path?: string) => {
    tasks.observe(line({ type: "assistant", message: { content: [{ type: "tool_use", id: call, name, input: { command: "sleep 60", description: "test" } }] } }));
    tasks.observe(line({ type: "user", toolUseResult: name === "Monitor" ? { taskId: id } : { backgroundTaskId: id }, message: { content: [{ type: "tool_result", tool_use_id: call, content: path ? `Output is being written to: ${path}. You will be notified.` : "started" }] } }));
  };
  return { tasks, updates, start };
}
const notification = (id: string, status = "completed", summary = "exit code 0") => `<task-notification><task-id>${id}</task-id>${status ? `<status>${status}</status>` : ""}<summary>${summary}</summary></task-notification>`;
describe("Claude shell task records", () => {
  it.each([["completed", "completed", 0], ["failed", "failed", 144], ["killed", "stopped", undefined], ["stopped", "stopped", undefined]] as const)("maps %s once across all notification containers", (status, expected, code) => {
    const f = fixture(); f.start();
    const text = notification("b1", status, code === undefined ? "stopped" : `exit code ${code}`);
    f.tasks.observe(line({ type: "queue-operation", content: text }));
    f.tasks.observe(line({ type: "attachment", attachment: { prompt: text } }));
    f.tasks.observe(line({ type: "user", message: { content: [{ type: "text", text }] } }));
    expect(f.updates).toHaveLength(2);
    expect(f.updates.at(-1)).toMatchObject({ id: "b1", state: expected, ...(code === undefined ? {} : { exitCode: code }) });
  });
  it("keeps identical commands separate and folds early completion into the first record", () => {
    const f = fixture();
    f.tasks.observe(line({ content: notification("b1") })); f.start(); f.start("b2", "call2");
    expect(f.tasks.records.size).toBe(2);
    expect(f.updates[0]?.state).toBe("completed");
    expect(f.tasks.records.get("b2")?.state).toBe("running");
  });
  it("does not confuse monitor events, workflows or child agents with completed shell tasks", () => {
    const f = fixture(); f.start("b-monitor", "monitor", "Monitor");
    f.tasks.observe(line({ content: notification("b-monitor", "", "Monitor event") }));
    f.start("a1", "agent", "Agent"); f.start("w1", "workflow", "Workflow");
    f.tasks.observe(line({ content: notification("a1") }));
    expect(f.tasks.records.size).toBe(1);
    expect(f.tasks.records.get("b-monitor")).toMatchObject({ kind: "monitor", state: "running", summary: "Monitor event" });
    f.tasks.observe(line({ content: notification("b-monitor", "completed", "stream ended") }));
    expect(f.tasks.records.get("b-monitor")?.state).toBe("completed");
  });
  it("records TaskStop, orphan summaries and loss of the session process without claiming success", () => {
    const f = fixture(); f.start(); f.start("b2", "c2"); f.start("b3", "c3");
    f.tasks.observe(line({ toolUseResult: { task_id: "b1", task_type: "local_bash" } }));
    f.tasks.observe(line({ content: notification("__orphan_summary__:shell", "stopped", "Task ids: b2") }));
    expect(f.tasks.records.get("b1")?.state).toBe("stopped");
    expect(f.tasks.records.get("b2")?.state).toBe("unknown");
    f.tasks.lostHolder(); expect(f.tasks.records.get("b3")?.state).toBe("unknown");
  });
  it("reads only the exact recorded session task file, rejecting traversal and symlink escape", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-output-")); dirs.push(dir);
    const root = join(dir, "claude-501", "project", "session", "tasks"); mkdirSync(root, { recursive: true });
    const path = join(root, "b1.output"); writeFileSync(path, "hello 世界\n");
    const f = fixture(); f.start("b1", "c1", "Bash", path);
    const output = f.tasks.output("session", "b1", undefined, 7)!;
    expect(output.text).toBe("世界\n"); expect(output.size).toBe(13);
    expect(f.tasks.output("another", "b1", undefined, 64)).toBeUndefined();
    expect(f.tasks.output("session", "../b1", undefined, 64)).toBeUndefined();
    const outside = join(dir, "secret"); writeFileSync(outside, "secret"); rmSync(path); symlinkSync(outside, path);
    expect(f.tasks.output("session", "b1", undefined, 64)).toBeUndefined();
  });
  it("offers a stop only for a running shell whose output file is known, and keeps a stop made here", () => {
    const updates: BackgroundTask[] = [];
    const tasks = new ClaudeTasks((task) => updates.push(task), true);
    const launch = (id: string, path?: string) => {
      tasks.observe(line({ type: "assistant", message: { content: [{ type: "tool_use", id: `c-${id}`, name: "Bash", input: { command: "sleep 60" } }] } }));
      tasks.observe(line({ type: "user", toolUseResult: { backgroundTaskId: id }, message: { content: [{ type: "tool_result", tool_use_id: `c-${id}`, content: path ? `Output is being written to: ${path}. ok` : "started" }] } }));
    };
    launch("b1", "/tmp/claude-501/p/s/tasks/b1.output"); launch("b2");
    expect(tasks.records.get("b1")?.canStop).toBe(true);
    expect(tasks.records.get("b2")?.canStop).toBe(false);
    tasks.stopped("b1");
    expect(tasks.records.get("b1")).toMatchObject({ state: "stopped", canStop: false });
    // Claude then reports the killed shell as failed; it was stopped.
    tasks.observe(line({ content: notification("b1", "failed", "exit code 143") }));
    expect(tasks.records.get("b1")).toMatchObject({ state: "stopped", canStop: false });
    expect(tasks.records.get("b1")?.exitCode).toBeUndefined();
    // Without a way to find the process, nothing offers a stop.
    const blind = new ClaudeTasks(() => {}, false);
    blind.observe(line({ type: "assistant", message: { content: [{ type: "tool_use", id: "c", name: "Bash", input: { command: "x" } }] } }));
    blind.observe(line({ type: "user", toolUseResult: { backgroundTaskId: "b9" }, message: { content: [{ type: "tool_result", tool_use_id: "c", content: "Output is being written to: /tmp/claude-1/p/s/tasks/b9.output. ok" }] } }));
    expect(blind.records.get("b9")?.canStop).toBe(false);
  });
  it.runIf(canFindTaskProcesses)("ends only the process group writing the task file, and only under the given parent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-stop-")); dirs.push(dir);
    const path = join(dir, "b1.output"); writeFileSync(path, "");
    const out = openSync(path, "a");
    // Like Claude's background shell: its own group, stdout and stderr on the task file.
    const shell = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: ["ignore", out, out] });
    closeSync(out);
    const exited = new Promise((resolve) => shell.once("exit", resolve));
    const deadline = Date.now() + 3000;
    while ((await stdoutWriters(path)).length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    // Some other process as the parent: nothing is signalled.
    expect(await stopTaskGroup(path, new Set([1]), { graceMs: 200 })).toBe(false);
    expect(shell.exitCode).toBeNull();
    expect(await stopTaskGroup(path, new Set([process.pid]), { graceMs: 2000 })).toBe(true);
    await exited;
    expect(await stdoutWriters(path)).toEqual([]);
  });
  it("paginates UTF-8 output backwards without duplication or broken characters", () => {
    const text = "前缀 hello 世界\n"; const bytes = Buffer.from(text);
    let before: number | undefined; let result = "";
    do { const page = outputRange(bytes, before, 7); result = page.text + result; before = page.start; } while (before);
    expect(result).toBe(text);
    expect(outputRange(Buffer.from("你好").subarray(0, 5), undefined, 64).text).toBe("你");
  });
});
