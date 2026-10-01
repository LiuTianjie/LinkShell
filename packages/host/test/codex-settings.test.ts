import { describe, expect, it } from "vitest";
import { enableArgs } from "../src/drivers/codex/app-server.js";
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
      ["plan", "off"],
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
  it("offers plan mode, and sets it with the model and effort the thread runs with", () => {
    const settings = { model: "gpt-5", effort: "high" };
    expect(configOptions(settings, {}, models).find((o) => o.id === "plan")).toMatchObject({ category: "other", current: "off", values: [{ value: "off" }, { value: "on" }] });
    expect(configOptions(settings, { plan: true }, models).find((o) => o.id === "plan")?.current).toBe("on");
    const current = effective(settings, { plan: true }, models);
    expect(turnOverrides({ plan: true }, current)).toEqual({ collaborationMode: { mode: "plan", settings: { model: "gpt-5", reasoning_effort: "high", developer_instructions: null } } });
    // Turned off again: said explicitly, so the thread leaves plan mode.
    expect(turnOverrides({ plan: false }, current)).toMatchObject({ collaborationMode: { mode: "default" } });
    // Never touched: nothing is sent.
    expect(turnOverrides({}, current)).toEqual({});
  });
});

describe("Codex features", () => {
  it("are turned on only when the installed Codex lists them, and hasn't removed them", () => {
    const listing = (line: string) => `apps                              stable             true\n${line}\nweb_search_request                deprecated         false\n`;
    expect(enableArgs(listing("default_mode_request_user_input   under development  false"))).toEqual(["--enable", "default_mode_request_user_input"]);
    expect(enableArgs(listing("default_mode_request_user_input   stable             true"))).toEqual(["--enable", "default_mode_request_user_input"]);
    // A Codex that retired it, or never had it, would refuse to start if asked.
    expect(enableArgs(listing("default_mode_request_user_input   removed            true"))).toEqual([]);
    expect(enableArgs(listing("something_else                    stable             true"))).toEqual([]);
    expect(enableArgs("")).toEqual([]);
  });
});
