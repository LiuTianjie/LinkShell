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
  it("is only one picked that isn't the agent's own default", () => {
    expect(modelToCreate(listed, "gpt-mini")).toBe("gpt-mini");
    // Untouched, or the default picked again: the agent chooses as it would without a picker.
    expect(modelToCreate(listed, undefined)).toBeUndefined();
    expect(modelToCreate(listed, "gpt-big")).toBeUndefined();
  });

  it("is dropped when the list no longer has it, or there is no list", () => {
    expect(modelToCreate(listed, "gpt-gone")).toBeUndefined();
    expect(modelToCreate({ models: [] }, "gpt-mini")).toBeUndefined();
    expect(modelToCreate(undefined, "gpt-mini")).toBeUndefined();
  });
});
