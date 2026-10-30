import { describe, expect, it } from "vitest";
import { modelToCreate } from "../src/live/agent-models";

const listed = {
  models: [
    { value: "gpt-big", name: "GPT Big" },
    { value: "gpt-mini", name: "GPT Mini" },
  ],
  current: "gpt-big",
};

describe("the model a new session is created with", () => {
  it("preserves an explicit selection even when it matches a cached default", () => {
    expect(modelToCreate(listed, "gpt-mini")).toBe("gpt-mini");
    // Only an untouched picker follows the new project's own default.
    expect(modelToCreate(listed, undefined)).toBeUndefined();
    expect(modelToCreate(listed, "gpt-big")).toBe("gpt-big");
  });

  it("is dropped when the list no longer has it, or there is no list", () => {
    expect(modelToCreate(listed, "gpt-gone")).toBeUndefined();
    expect(modelToCreate({ models: [] }, "gpt-mini")).toBeUndefined();
    expect(modelToCreate(undefined, "gpt-mini")).toBeUndefined();
  });
});
