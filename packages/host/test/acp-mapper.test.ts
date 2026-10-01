import { describe, expect, it } from "vitest";
import { normalizeAcpUpdate, toConfigOptions } from "../src/drivers/acp/mapper.js";

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

describe("available commands", () => {
  it("keeps each command once, with a line about it rather than the skill's whole description", () => {
    const update = normalizeAcpUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "deploy", description: `Deploys the app.\n${"Use when asked to ship. ".repeat(40)}` },
        { name: "compact", description: "Free up context", input: { hint: "what to keep" } },
        { name: "deploy", description: "Deploys the app." },
      ],
    });
    expect(update).toMatchObject({ availableCommands: [{ name: "deploy" }, { name: "compact", description: "Free up context", hint: "what to keep" }] });
    const [deploy] = update?.sessionUpdate === "available_commands_update" ? update.availableCommands : [];
    expect(deploy!.description).toHaveLength(160);
    expect(deploy!.description.startsWith("Deploys the app. Use when asked to ship.")).toBe(true);
  });
});

describe("Claude compaction over ACP", () => {
  it("is the same card as everywhere else", () => {
    const call = normalizeAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Compact conversation", kind: "think", status: "in_progress" });
    expect(call).toMatchObject({ sessionUpdate: "tool_call", detail: { type: "compaction" } });
    const other = normalizeAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "c2", title: "Thinking it over", kind: "think", status: "in_progress" });
    expect(other).toMatchObject({ sessionUpdate: "tool_call" });
    expect(other && "detail" in other ? other.detail : undefined).toBeUndefined();
  });
});
