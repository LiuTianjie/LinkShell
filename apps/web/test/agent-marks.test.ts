import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMark, agentLabel, normalizeAgentKey } from "../src/live/common";

describe("Agent marks & Chinese coding agent coverage", () => {
  const registrySource = readFileSync(
    new URL("../../../packages/host/src/drivers/registry.ts", import.meta.url),
    "utf8",
  );
  const acpIds = [...registrySource.matchAll(/\{\s*id:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]!);
  const builtInIds = ["codex", "claude", "antigravity", "agy", ...acpIds];

  it("covers every built-in agent from packages/host registry (including all Chinese agents, cline, and kilo)", () => {
    expect(builtInIds).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(new Set(builtInIds).size).toBe(21);

    for (const id of builtInIds) {
      const label = agentLabel(id);
      expect(label).toBeTruthy();
      expect(label.toLowerCase()).not.toBe("agent");

      const html = renderToStaticMarkup(createElement(AgentMark, { agent: id, size: "md" }));
      expect(html).toContain(`data-agent="${id}"`);
      expect(html).toContain("<img");
      expect(html).toContain("data:image/svg+xml,");
    }
  });

  it("normalizes CLI/ACP aliases cleanly and falls back gracefully for custom ACP agents", () => {
    const aliases: Array<[string, string, string]> = [
      ["claude-code", "claude", "Claude Code"],
      ["codex-cli", "codex", "Codex"],
      ["qwen-code", "qwen", "Qwen Code"],
      ["kimi-code", "kimi", "Kimi Code"],
      ["codebuddy-code", "codebuddy", "CodeBuddy"],
      ["qodercli", "qoder", "Qoder"],
      ["mcode", "minimax", "MiniMax Code"],
      ["traecli", "trae", "TRAE"],
      ["dsh", "deepseek", "DeepSeek"],
      ["glm-acp-agent", "glm", "GLM"],
      ["iflow-cli", "iflow", "iFlow"],
      ["comate-acp", "comate", "Comate"],
      ["kilocode", "kilo", "Kilo Code"],
      ["antigravity-cli", "agy", "AGY"],
    ];

    for (const [alias, canonical, expectedLabel] of aliases) {
      expect(normalizeAgentKey(alias)).toBe(canonical);
      expect(agentLabel(alias)).toBe(expectedLabel);
      const html = renderToStaticMarkup(createElement(AgentMark, { agent: alias }));
      expect(html).toContain(`data-agent="${canonical}"`);
      expect(html).toContain("data:image/svg+xml,");
    }

    const customHtml = renderToStaticMarkup(createElement(AgentMark, { agent: "my-custom-acp" }));
    expect(customHtml).toContain('data-agent="my-custom-acp"');
    expect(customHtml).toContain(">M</span>");
    expect(agentLabel("my-custom-acp")).toBe("my-custom-acp");
    expect(agentLabel("my-custom-acp", "我的助手")).toBe("我的助手");
  });

  it("renders dual-tone marks for light/dark tile contrast where defined", () => {
    const clineHtml = renderToStaticMarkup(createElement(AgentMark, { agent: "cline" }));
    expect(clineHtml).toContain("--agent-mark-bg-light:#18181B");
    expect(clineHtml).toContain("--agent-mark-bg-dark:#F4F4F5");
    expect(clineHtml).toContain('class="agent-mark-light"');
    expect(clineHtml).toContain('class="agent-mark-dark"');
  });
});
