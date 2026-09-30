import { describe, expect, it } from "vitest";
import { toConfigOptions } from "../src/drivers/acp/mapper.js";

describe("toConfigOptions", () => {
  it("lists a repeated value once (Copilot sends auto three times)", () => {
    const [model] = toConfigOptions({
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "auto",
          options: [
            { value: "auto", name: "Auto", description: "Let Copilot pick the best model" },
            { value: "auto", name: "Auto", description: "Auto" },
            { value: "gpt-6", name: "GPT-6" },
            { value: "auto", name: "Auto", description: "Auto" },
          ],
        },
      ],
    });
    expect(model!.values.map((value) => value.value)).toEqual(["auto", "gpt-6"]);
    expect(model!.values[0]!.description).toBe("Let Copilot pick the best model");
  });
});
