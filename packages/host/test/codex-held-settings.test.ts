import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lastTurnContext } from "../src/drivers/codex/driver.js";
import { configOptions, settingsFromTurnContext } from "../src/drivers/codex/settings.js";

const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: "2026-10-09T00:00:00Z", type, payload });

describe("settings of a thread another Codex holds", () => {
  it("finds the last turn_context, even far from the end and across read chunks", () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-codex-"));
    const path = join(dir, "rollout.jsonl");
    const filler = Array.from({ length: 400 }, (_, index) => line("response_item", { text: "x".repeat(200), index }));
    writeFileSync(path, [
      line("turn_context", { model: "old", effort: "low" }),
      ...filler,
      line("turn_context", { model: "gpt-6-astra", effort: "high", approval_policy: "never", sandbox_policy: { type: "danger-full-access" } }),
      ...filler,
      "",
    ].join("\n"));
    expect(lastTurnContext(path, 1000)).toMatchObject({ model: "gpt-6-astra", effort: "high" });
    expect(lastTurnContext(join(dir, "missing.jsonl"))).toBeUndefined();
  });

  it("reads the rollout's spelling into the options the app shows", () => {
    const settings = settingsFromTurnContext({ model: "gpt-6-astra", effort: "high", approval_policy: "never", sandbox_policy: { type: "danger-full-access" } });
    const options = configOptions(settings, {}, [{ id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }]);
    expect(options.map((option) => [option.id, option.current])).toEqual([
      ["model", "gpt-6-astra"],
      ["effort", "high"],
      ["permissions", "full-access"],
      ["plan", "off"],
    ]);
  });
});
