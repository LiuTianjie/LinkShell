import { describe, expect, it } from "vitest";
import { parseClaudeAuthStatus, parseCodexLoginStatus } from "../src/drivers/auth.js";

describe("agent auth status parsing", () => {
  it("reads claude auth status without touching secrets", () => {
    expect(parseClaudeAuthStatus('{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}')).toMatchObject({
      state: "missing",
      hint: expect.stringContaining("claude /login"),
    });
    expect(parseClaudeAuthStatus('{"loggedIn": true, "authMethod": "api_key", "apiProvider": "firstParty", "apiKeySource": "ANTHROPIC_API_KEY"}')).toEqual({
      state: "ok",
      method: "api_key",
    });
    expect(parseClaudeAuthStatus('{"loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty"}')).toEqual({ state: "ok", method: "oauth_token" });
    expect(parseClaudeAuthStatus('{"loggedIn": true, "authMethod": "api_key", "apiProvider": "bedrock"}')).toEqual({ state: "ok", method: "bedrock" });
    expect(parseClaudeAuthStatus("garbage")).toEqual({ state: "unknown" });
    expect(parseClaudeAuthStatus(undefined)).toEqual({ state: "unknown" });
  });

  it("reads codex login status", () => {
    expect(parseCodexLoginStatus("Logged in using ChatGPT")).toEqual({ state: "ok", method: "chatgpt" });
    expect(parseCodexLoginStatus("Logged in using an API key - sk-proj-***")).toEqual({ state: "ok", method: "api_key" });
    expect(parseCodexLoginStatus("Not logged in")).toMatchObject({ state: "missing", hint: expect.stringContaining("codex login") });
    expect(parseCodexLoginStatus("")).toEqual({ state: "unknown" });
  });
});
