import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asyncQuestionReply } from "@linkshell/wire";
import { CodexDriver } from "../src/drivers/codex/driver.js";
import type { CodexThread } from "../src/drivers/codex/mapper.js";
import { rolloutAttention } from "../src/drivers/codex/attention.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const line = (type: string, payload: unknown) => JSON.stringify({ type, payload });
const start = line("event_msg", { type: "task_started", turn_id: "t" });
const end = line("event_msg", { type: "task_complete", turn_id: "t" });
const questions = [{ title: "体验任务怎么做？", options: ["先不做", "一起接通"] }, { title: "补充说明？" }];
const ask = line("response_item", { type: "function_call", name: "request_user_input_async", call_id: "call-q", arguments: JSON.stringify({ questions }) });
const q = { id: JSON.stringify(["request_user_input_async", "call-q", 0]), ...questions[0]! };
const q2 = { id: JSON.stringify(["request_user_input_async", "call-q", 1]), title: questions[1]!.title, options: [] };
function file(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ls-attention-")); dirs.push(dir);
  const path = join(dir, "rollout.jsonl"); writeFileSync(path, lines.join("\n") + "\n"); return path;
}

describe("desktop question attention without opening a session", () => {
  it("reads the current turn across byte boundaries and ignores completed turns", () => {
    const path = file([start, ask, end, start, ask, line("response_item", { type: "message", role: "assistant", content: [{ text: "继续工作".repeat(300) }] })]);
    expect(rolloutAttention(path, 37)).toEqual({ running: true, questions: [q, q2] });
  });
  it("removes only questions actually answered on the computer, including skipped ones", () => {
    const answer = (question: typeof q2, value: string) => line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: asyncQuestionReply([{ question, answer: value }]) }] });
    expect(rolloutAttention(file([start, ask, answer(q, "自己的回答")]), 53)).toEqual({ running: true, questions: [q2] });
    expect(rolloutAttention(file([start, ask, answer(q, "自己的回答"), answer(q2, "")]), 53)).toEqual({ running: true, questions: [] });
    expect(rolloutAttention(file([start, ask, end]), 53)).toEqual({ running: false, questions: [] });
  });
  it("discovers and clears input badges without attaching to a desktop thread", async () => {
    const path = file([start, ask]);
    const driver = new CodexDriver({ socketPath: path + ".sock", hostVersion: "test", desktopBusPath: false });
    const rpc = vi.spyOn(driver as unknown as { rpc: () => Promise<{ data: CodexThread[] }> }, "rpc");
    rpc.mockResolvedValue({ data: [{ id: "desktop", cwd: "/w", path, createdAt: 1, updatedAt: 2, status: { type: "notLoaded" } }] });
    expect((await driver.listSessions(50))[0]).toMatchObject({ state: "running", asyncQuestions: [q, q2] });
    writeFileSync(path, [start, ask, end, ""].join("\n"));
    expect((await driver.listSessions(50))[0]).toMatchObject({ state: "idle", asyncQuestions: [] });
    expect(rpc.mock.calls).toHaveLength(2);
    rpc.mockRestore();
  });
  it("does not claim an incomplete or bounded read proves there are no questions", () => {
    const path = file([start, ask]);
    expect(rolloutAttention(path, 30, 30)).toBeUndefined();
    expect(rolloutAttention(path + "-missing")).toBeUndefined();
    writeFileSync(path, start + "\n" + ask.slice(0, -10));
    expect(rolloutAttention(path, 37)).toEqual({ running: true, questions: [] });
  });
});
