import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The SDK's query, played: what the driver starts it with, and the side questions it is asked.
const started: { options: Record<string, unknown>; asked: { question: string; options: unknown }[]; closed: boolean }[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    const record = { options, asked: [] as { question: string; options: unknown }[], closed: false };
    started.push(record);
    return {
      async *[Symbol.asyncIterator]() { /* no messages */ },
      askSideQuestion: async (question: string, options: unknown) => {
        record.asked.push({ question, options });
        return { response: `answer to ${question}`, synthetic: false };
      },
      close: () => { record.closed = true; },
    };
  },
}));

const { ClaudeDriver } = await import("../src/drivers/claude/driver.js");

describe("Claude side questions (/btw)", () => {
  it("asks a Claude of its own on the transcript, writing nothing, reused for follow-ups and closed with the side conversation", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lsh-claude-side-"));
    const cwd = "/work/project";
    const folder = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "s1.jsonl"), `${JSON.stringify({ type: "user", sessionId: "s1", message: { content: "hi" } })}\n`);
    const driver = new ClaudeDriver({ env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, hostVersion: "test", adapter: { command: process.execPath, args: [] } });
    const text: string[] = [];
    const out = { text: (delta: string) => text.push(delta), activity: () => {} };

    await expect(driver.sideAsk("missing", { sideId: "a", cwd, question: "q", history: [] }, out, new AbortController().signal)).rejects.toMatchObject({ appCode: "not_ready" });

    await driver.sideAsk("s1", { sideId: "a", cwd, question: "first", history: [] }, out, new AbortController().signal);
    await driver.sideAsk("s1", { sideId: "a", cwd, question: "second", history: [{ question: "first", answer: "answer to first" }] }, out, new AbortController().signal);
    expect(text).toEqual(["answer to first", "answer to second"]);
    expect(started).toHaveLength(1);
    expect(started[0]!.options).toMatchObject({ cwd, resume: "s1", persistSession: false, strictMcpConfig: true, mcpServers: {} });
    expect(started[0]!.asked[1]).toEqual({ question: "second", options: { history: [{ question: "first", response: "answer to first" }] } });

    await driver.sideClose("s1", "a");
    expect(started[0]!.closed).toBe(true);
    expect(driver.capabilities.side).toBe(true);
  });
});
