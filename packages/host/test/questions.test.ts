import { describe, expect, it } from "vitest";
import { formContent, formQuestions } from "../src/questions.js";

// A form (the small JSON schema MCP servers and ACP agents ask with) as
// questions for the apps, and the answers back as the form's content.

describe("forms as questions", () => {
  const schema = {
    type: "object",
    required: ["name", "plan"],
    properties: {
      name: { type: "string", title: "Project name", description: "What should the project be called?" },
      plan: { type: "string", title: "Plan", enum: ["free", "pro"], enumNames: ["Free", "Pro"] },
      seats: { type: "integer", title: "Seats" },
      notify: { type: "boolean", title: "Email me when it is ready" },
      regions: { type: "array", title: "Regions", items: { enum: ["eu", "us"] } },
      token: { type: "string", title: "Token", format: "password" },
      nested: { type: "object", title: "Not something a form field can be" },
    },
  };

  it("takes each field as a question of the right kind, in the form's order", () => {
    const form = formQuestions(schema, "Set the project up")!;
    expect(form.questions).toEqual([
      { id: "name", header: "Project name", text: "What should the project be called?", kind: "text", required: true },
      { id: "plan", text: "Plan", kind: "choice", required: true, options: [{ value: "free", label: "Free" }, { value: "pro", label: "Pro" }] },
      { id: "seats", text: "Seats", kind: "text" },
      { id: "notify", text: "Email me when it is ready", kind: "choice", options: [{ value: "true", label: "是" }, { value: "false", label: "否" }] },
      { id: "regions", text: "Regions", kind: "choices", options: [{ value: "eu", label: "eu" }, { value: "us", label: "us" }] },
      { id: "token", text: "Token", kind: "text", secret: true },
    ]);
    // One field: the form's message is the question.
    expect(formQuestions({ properties: { ok: { type: "boolean" } } }, "Deploy to production?")!.questions[0]).toMatchObject({ text: "Deploy to production?" });
    expect(formQuestions({ properties: {} })).toBeUndefined();
    expect(formQuestions(undefined)).toBeUndefined();
  });

  it("gives the answers back with each field's own type", () => {
    const form = formQuestions(schema)!;
    expect(
      formContent(form, [
        { id: "name", values: ["weather"] },
        { id: "plan", values: ["pro"] },
        { id: "seats", values: ["12"] },
        { id: "notify", values: ["false"] },
        { id: "regions", values: ["eu", "us"] },
        { id: "token", values: [""] },
      ]),
    ).toEqual({ name: "weather", plan: "pro", seats: 12, notify: false, regions: ["eu", "us"] });
    // Not a number: left out rather than sent as one.
    expect(formContent(form, [{ id: "seats", values: ["a few"] }])).toEqual({});
  });
});
