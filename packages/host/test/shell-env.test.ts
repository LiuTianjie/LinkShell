import { describe, expect, it } from "vitest";
import { withoutClaudeSession } from "../src/shell-env.js";

describe("withoutClaudeSession", () => {
  it("drops what a surrounding Claude Code session added, and keeps the user's settings", () => {
    const env = withoutClaudeSession({
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_EFFORT: "low",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CLAUDE_CONFIG_DIR: "/me/.claude",
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    expect(env).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/me/.claude", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_BEDROCK: "1" });
  });

  it("leaves an environment alone outside a Claude Code session", () => {
    const outside = { PATH: "/usr/bin", CLAUDE_EFFORT: "high" };
    expect(withoutClaudeSession(outside)).toBe(outside);
  });
});
