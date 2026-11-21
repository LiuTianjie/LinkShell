import { describe, expect, it } from "vitest";
import { agentCapabilityTags, agentLook } from "@/theme/agents";
import { agentMarks } from "@/theme/agent-marks";

const BUILTIN_AGENT_IDS = [
  "codex",
  "claude",
  "gemini",
  "antigravity",
  "agy",
  "copilot",
  "grok",
  "opencode",
  "cursor",
  "cline",
  "kilo",
  "qwen",
  "kimi",
  "codebuddy",
  "qoder",
  "minimax",
  "trae",
  "deepseek",
  "glm",
  "iflow",
  "comate",
] as const;

describe("built-in agent theme parity", () => {
  it("provides official marks and look metadata for every built-in agent including Chinese coding agents", () => {
    for (const id of BUILTIN_AGENT_IDS) {
      const mark = agentMarks[id];
      expect(mark, `missing agentMarks entry for ${id}`).toBeDefined();
      expect(mark!.svg).toContain("<svg");
      expect(mark!.svg).toContain("</svg>");

      const look = agentLook(id);
      expect(look.name).toBeTruthy();
      expect(look.short).toBeTruthy();
      expect(look.name).not.toBe(id);
      expect(look.group).toMatch(/^(domestic|global)$/);
    }

    expect(agentCapabilityTags({ capabilities: { acp: true, interrupt: true, permissions: true, images: true, models: true, modes: true, steer: true, fork: true } })).toEqual([
      "支持插话",
      "图片",
      "分叉",
      "ACP",
    ]);
  });
});
