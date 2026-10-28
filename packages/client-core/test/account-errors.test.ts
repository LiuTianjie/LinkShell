import { describe, expect, it } from "vitest";
import { accountErrorMessage, isDefinitiveAccountError, oauthErrorCode, tokenErrorCode } from "../src/account-errors.js";

describe("account sign-in refusals", () => {
  it("reads both shapes GoTrue answers a password grant in", () => {
    expect(tokenErrorCode(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" })).toBe("invalid_credentials");
    expect(tokenErrorCode(400, { error: "invalid_grant", error_description: "Invalid login credentials" })).toBe("invalid_credentials");
    expect(tokenErrorCode(400, { error_code: "email_not_confirmed", msg: "Email not confirmed" })).toBe("email_not_confirmed");
    expect(tokenErrorCode(400, { error: "invalid_grant", error_description: "Email not confirmed" })).toBe("email_not_confirmed");
  });

  it("reads itool.tech's proxy codes, under `error` or `code`", () => {
    expect(tokenErrorCode(401, { error: "invalid_credentials" })).toBe("invalid_credentials");
    expect(tokenErrorCode(400, { ok: false, code: "email_not_confirmed" })).toBe("email_not_confirmed");
    expect(tokenErrorCode(503, { error: "temporarily_unavailable" })).toBe("unavailable");
    expect(tokenErrorCode(400, { error: "invalid_grant" }, "pkce")).toBe("oauth_expired");
  });

  it("tells a stale PKCE code from a wrong password", () => {
    expect(tokenErrorCode(404, { error_code: "flow_state_not_found" }, "pkce")).toBe("oauth_expired");
    expect(tokenErrorCode(400, { error_code: "bad_code_verifier" }, "pkce")).toBe("oauth_expired");
    expect(tokenErrorCode(429, {})).toBe("rate_limited");
    expect(tokenErrorCode(500, "not json")).toBe("unavailable");
    expect(tokenErrorCode(418, { error_code: "something_new" })).toBe("unknown");
  });

  it("only lets the network and unknown answers be retried another way", () => {
    for (const code of ["invalid_credentials", "email_not_confirmed", "oauth_expired", "rate_limited"] as const) expect(isDefinitiveAccountError(code)).toBe(true);
    for (const code of ["unavailable", "network", "timeout", "unknown"] as const) expect(isDefinitiveAccountError(code)).toBe(false);
  });

  it("reads the error an OAuth redirect carries", () => {
    expect(oauthErrorCode({ error: "access_denied", errorCode: "access_denied", description: "The user denied" })).toBe("oauth_denied");
    expect(oauthErrorCode({ error: "server_error", description: "Multiple accounts with the same email address in the same linking domain detected" })).toBe("identity_conflict");
    expect(oauthErrorCode({ error: "validation_failed", description: "Unsupported provider: provider is not enabled" })).toBe("provider_disabled");
    expect(oauthErrorCode({ error: "invalid_request", errorCode: "flow_state_expired" })).toBe("oauth_expired");
    expect(oauthErrorCode({ error: "weird" })).toBe("unknown");
  });

  it("says each in Chinese, and points a password-less account at its provider", () => {
    expect(accountErrorMessage("invalid_credentials")).toContain("GitHub 或 Google");
    expect(accountErrorMessage("cancelled")).toBe("已取消登录。");
    expect(accountErrorMessage("browser_timeout")).toContain("5 分钟");
  });
});
