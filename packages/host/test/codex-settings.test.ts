import { describe, expect, it } from "vitest";
import { configOptions, effective, presetOf, turnOverrides, type CodexModel } from "../src/drivers/codex/settings.js";

const models: CodexModel[] = [
  {
    id: "gpt-5",
    model: "gpt-5",
    displayName: "GPT-5",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
  },
  { id: "mini", model: "gpt-5-mini", displayName: "GPT-5 mini", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
];

describe("Codex settings", () => {
  it("reports model, effort and permissions from the thread's settings", () => {
    const options = configOptions({ model: "gpt-5", effort: "high", sandbox: { type: "workspaceWrite" }, approvalPolicy: "on-request" }, {}, models);
    expect(options.map((o) => [o.id, o.current])).toEqual([
      ["model", "gpt-5"],
      ["effort", "high"],
      ["permissions", "auto"],
    ]);
  });

  it("applies overrides and drops an effort the new model can't do", () => {
    const state = effective({ model: "gpt-5", effort: "high" }, { model: "gpt-5-mini" }, models);
    expect(state).toMatchObject({ model: "gpt-5-mini", effort: "low" });
    // A single-effort model has nothing to choose.
    expect(configOptions({ model: "gpt-5" }, { model: "gpt-5-mini" }, models).some((o) => o.id === "effort")).toBe(false);
  });

  it("maps sandbox policies to presets and presets back to turn parameters", () => {
    expect(presetOf({ sandbox: { type: "readOnly" } })).toBe("read-only");
    expect(presetOf({ sandbox: { type: "dangerFullAccess" }, approvalPolicy: "never" })).toBe("full-access");
    expect(presetOf({ sandbox: { type: "dangerFullAccess" }, approvalPolicy: "on-request" })).toBeUndefined();
    expect(turnOverrides({ model: "gpt-5", effort: "low", permissions: "full-access" })).toEqual({
      model: "gpt-5",
      effort: "low",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    expect(configOptions({}, {}, []).find((o) => o.id === "permissions")?.current).toBe("custom");
  });
});
