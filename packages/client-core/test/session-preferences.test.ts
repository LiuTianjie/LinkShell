import { describe, expect, it } from "vitest";
import { createSessionPreferences } from "../src/session-preferences.js";

describe("new-session preferences", () => {
  it("restores explicit choices across launches, separately for each computer and agent", () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
    const first = createSessionPreferences(storage);
    first.remember("mac", "codex", { model: "gpt-pro", config: { effort: "high", mode: "plan" } });
    first.remember("mac", "claude", { model: "opus", config: { mode: "default" } });
    first.remember("windows", "codex", { model: "gpt-mini" });
    const next = createSessionPreferences(storage);
    expect(next.read("mac")).toEqual({ agent: "claude", agents: {
      codex: { model: "gpt-pro", config: { effort: "high", mode: "plan" } },
      claude: { model: "opus", config: { mode: "default" } },
    } });
    next.remember("mac", "codex", { config: { effort: "medium" } });
    expect(next.read("mac").agents.codex).toEqual({ model: "gpt-pro", config: { effort: "medium", mode: "plan" } });
    expect(next.read("windows").agents.codex?.model).toBe("gpt-mini");
    expect(next.read(undefined)).toEqual({ agents: {} });
  });

  it("ignores damaged storage and never blocks the session when persistence is unavailable", () => {
    const preferences = createSessionPreferences({ getItem: () => "{", setItem: () => { throw new Error("storage full"); } });
    expect(preferences.read("mac")).toEqual({ agents: {} });
    expect(() => preferences.remember("mac", "codex", { model: "gpt-pro" })).not.toThrow();
  });
});
