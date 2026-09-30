import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "@linkshell/wire";
import { matchModel } from "../src/drivers/claude/driver.js";

// Claude's model option as the adapter reports it (Claude Code 2.1.2xx).
const model: SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  current: "default",
  values: [
    { value: "default", name: "Default (recommended)", description: "Opus 5.5" },
    { value: "opus", name: "Opus 5.5", description: "Best for everyday, complex tasks" },
    { value: "sonnet", name: "Sonnet 5.5", description: "Efficient for routine tasks" },
    { value: "haiku", name: "Haiku 4.5", description: "Fastest for quick answers" },
    { value: "claude-opus-5", name: "Opus 5" },
  ],
};

describe("matchModel", () => {
  it("maps a transcript's model id to the option Claude would show", () => {
    expect(matchModel(model, "claude-opus-5-5")).toBe("default");
    expect(matchModel(model, "claude-sonnet-5-5")).toBe("sonnet");
    expect(matchModel(model, "claude-haiku-4-5-20251001")).toBe("haiku");
    expect(matchModel(model, "claude-opus-5")).toBe("claude-opus-5");
    expect(matchModel(model, "claude-unknown-9")).toBeUndefined();
  });
});
