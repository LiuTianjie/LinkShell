import { describe, expect, it } from "vitest";
import { transcriptLine } from "../src/drivers/claude/transcript.js";

// What Claude writes around a person's words in its transcript: kept or dropped the way the Claude
// app shows it.

const user = (content: unknown) => JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-10-28T00:00:00Z", message: { role: "user", content } });
const queued = (prompt: unknown, origin?: unknown) =>
  JSON.stringify({ type: "attachment", uuid: "q1", timestamp: "2026-10-28T00:00:00Z", attachment: { type: "queued_command", prompt, source_uuid: "src1", commandMode: "prompt", origin } });
const kinds = (result: { updates: { sessionUpdate: string }[] }) => result.updates.map((update) => update.sessionUpdate);

describe("Claude transcript: user envelopes", () => {
  it("keeps the words after a reminder in the same block, without the reminder", () => {
    const result = transcriptLine(user("<system-reminder>\nLinked sessions now: top = local_1 (idle)\n</system-reminder>\nBackground (from the session that started this one): fix it."));
    expect(result.updates[0]).toMatchObject({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Background (from the session that started this one): fix it." } });
    expect(kinds(result)).toEqual(["user_message_chunk", "ls_turn"]);
  });

  it("drops a block that is only for the model", () => {
    expect(transcriptLine(user("<system-reminder>The user forked this session.</system-reminder>")).updates).toEqual([]);
    expect(transcriptLine(user("<local-command-caveat>Caveat: run directly.</local-command-caveat>")).updates).toEqual([]);
  });

  it("hides /model and /compact as the Claude app does, and keeps other commands", () => {
    expect(transcriptLine(user("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>")).updates).toEqual([]);
    expect(transcriptLine(user("<command-name>/compact</command-name>")).updates).toEqual([]);
    expect(transcriptLine(user("<local-command-stdout>Set model to `opus`</local-command-stdout>")).updates).toEqual([]);
    expect(transcriptLine(user("<command-name>/review</command-name><command-args>src</command-args>")).updates[0]).toMatchObject({ content: { text: "/review src" } });
  });

  it("keeps a shell command from the prompt and a command's output without starting a turn", () => {
    expect(kinds(transcriptLine(user("<bash-input>git status</bash-input>")))).toEqual(["user_message_chunk"]);
    expect(kinds(transcriptLine(user("<local-command-stdout>Total cost: $0.10</local-command-stdout>")))).toEqual(["user_message_chunk"]);
  });

  it("keeps mail from another session and a sub-agent's hand-back", () => {
    const mail = '<cross-session-message from="local_44b1" name="Live phone tab">\nThe user selected a device.\n</cross-session-message>';
    expect(transcriptLine(queued(mail, { kind: "peer", from: "local_44b1" })).updates).toEqual([{ sessionUpdate: "user_message_chunk", messageId: "src1", content: { type: "text", text: mail } }]);
    const handBack = '<agent-message from="a4517a">\n[Subagent hand-back] The report follows:\n  Done.\n</agent-message>';
    expect(transcriptLine(queued(handBack, { kind: "peer", from: "a4517a", handback: true })).updates).toHaveLength(1);
    const withReminder = transcriptLine(user(`<system-reminder>Linked sessions now: x</system-reminder>${mail}`));
    expect(withReminder.updates[0]).toMatchObject({ content: { text: mail } });
  });

  it("filters a queued prompt like a typed one", () => {
    expect(transcriptLine(queued("<system-reminder>only this</system-reminder>", { kind: "human" })).updates).toEqual([]);
    expect(transcriptLine(queued([{ type: "text", text: "<system-reminder>x</system-reminder>再看看" }], { kind: "human" })).updates[0]).toMatchObject({ content: { text: "再看看" } });
  });
});
