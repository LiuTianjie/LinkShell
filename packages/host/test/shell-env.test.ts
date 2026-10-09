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

  it("lets standalone Claude use the user's provider instead of a parent host's auth", () => {
    const provider = {
      CLAUDE_CONFIG_DIR: "/me/.claude",
      ANTHROPIC_AUTH_TOKEN: "user-token",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
      ANTHROPIC_MODEL: "user-model",
    };
    const inherited = {
      ...provider,
      CLAUDECODE: "1",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_HOST_AUTH_ENV_VAR: "PARENT_HOST_TOKEN",
    };

    expect(withoutClaudeSession(inherited)).toEqual(provider);
    expect(inherited.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
    expect(inherited.CLAUDE_CODE_HOST_AUTH_ENV_VAR).toBe("PARENT_HOST_TOKEN");
  });
});
