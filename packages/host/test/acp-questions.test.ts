import { describe, expect, it } from "vitest";
import { mapAcpQuestions, questionMethod } from "../src/drivers/acp/questions.js";

const cursor = {
  toolCallId: "tool", title: "Choose features",
  questions: [
    { id: "db", prompt: "Database?", options: [{ id: "pg", label: "Postgres" }, { id: "lite", label: "SQLite" }] },
    { id: "checks", prompt: "Checks?", allowMultiple: true, options: [{ id: "unit", label: "Unit tests" }, { id: "types", label: "Typecheck" }] },
  ],
};
const grok = {
  sessionId: "s", toolCallId: "tool", mode: "default",
  questions: [
    { question: "Database?", options: [{ label: "Postgres", description: "Default", preview: "Plan preview" }, { label: "SQLite", description: "Local" }] },
    { question: "Checks?", multiSelect: true, options: [{ label: "lint, strict" }, { label: "tests" }] },
    { question: "Anything else?", options: [] },
  ],
};

describe("ACP agent question adapters", () => {
  it("keeps Cursor option ids distinct from their displayed labels", () => {
    const request = mapAcpQuestions("cursor", "cursor/ask_question", cursor, "r");
    expect(request.update).toMatchObject({ title: "Choose features", questions: [
      { id: "db", kind: "choice", options: [{ value: "pg", label: "Postgres" }, { value: "lite", label: "SQLite" }] },
      { id: "checks", kind: "choices" },
    ] });
    expect(request.update.questions![0]).not.toHaveProperty("other");
    expect(request.answer([{ id: "db", values: ["pg"] }, { id: "checks", values: ["unit", "types"] }])).toEqual({ outcome: { outcome: "answered", answers: [
      { questionId: "db", selectedOptionIds: ["pg"] }, { questionId: "checks", selectedOptionIds: ["unit", "types"] },
    ] } });
    expect(request.respond("skip")).toEqual({ outcome: { outcome: "skipped" } });
    expect(request.respond("cancel")).toEqual({ outcome: { outcome: "cancelled" } });
  });
  it("keeps Grok arrays, freeform notes and visible previews in its native response", () => {
    const request = mapAcpQuestions("grok", "_x.ai/ask_user_question", grok, "r");
    expect(request.update.questions).toMatchObject([
      { kind: "choice", other: true, options: [{ description: "Default\n\nPlan preview" }, { label: "SQLite" }] },
      { kind: "choices", other: true }, { kind: "text" },
    ]);
    expect(request.answer([
      { id: "question_0", values: ["Postgres"], other: "Use managed hosting" },
      { id: "question_1", values: ["lint, strict", "tests"] },
      { id: "question_2", values: ["My own answer"] },
    ])).toEqual({ outcome: "accepted", answers: {
      "Database?": ["Postgres"], "Checks?": ["lint, strict", "tests"], "Anything else?": ["Other"],
    }, annotations: {
      "Database?": { notes: "Use managed hosting", preview: "Plan preview" }, "Anything else?": { notes: "My own answer" },
    } });
    expect(request.answer([{ id: "question_0", values: [], other: "MySQL" }])).toEqual({ outcome: "accepted", answers: { "Database?": ["Other"] }, annotations: { "Database?": { notes: "MySQL" } } });
    expect(request.respond("skip")).toEqual({ outcome: "cancelled" });
    expect(request.respond("cancel")).toEqual({ outcome: "cancelled" });
  });
  it("uses outcome for Grok MCP forms and action for standard ACP elicitation", () => {
    const form = { mode: "form", sessionId: "s", message: "Settings", requestedSchema: { type: "object", properties: { enabled: { type: "boolean" } } } };
    const grokForm = mapAcpQuestions("grok", "_x.ai/mcp/elicit", form, "r");
    const standard = mapAcpQuestions("anything", "elicitation/create", form, "r");
    expect(grokForm.answer([{ id: "enabled", values: ["false"] }])).toEqual({ outcome: "accept", content: { enabled: false } });
    expect(standard.answer([{ id: "enabled", values: ["false"] }])).toEqual({ action: "accept", content: { enabled: false } });
    expect(grokForm.respond("skip")).toEqual({ outcome: "decline" });
    expect(standard.respond("cancel")).toEqual({ action: "cancel" });
  });
  it("does not misidentify another agent's request or silently accept malformed questions", () => {
    expect(questionMethod("other", "cursor/ask_question")).toBeUndefined();
    expect(questionMethod("other", "x.ai/ask_user_question")).toBeUndefined();
    expect(questionMethod("cursor", "_cursor/ask_question")).toBe("cursor");
    expect(questionMethod("grok", "x.ai/ask_user_question")).toBe("grok");
    expect(() => mapAcpQuestions("cursor", "cursor/ask_question", { ...cursor, questions: [...cursor.questions, cursor.questions[0]] }, "r")).toThrow();
    expect(() => mapAcpQuestions("grok", "x.ai/ask_user_question", { ...grok, questions: [{ question: "Invalid" }] }, "r")).toThrow();
    expect(() => mapAcpQuestions("grok", "x.ai/mcp/elicit", { mode: "url", url: "https://example.com" }, "r")).toThrow();
  });
});
