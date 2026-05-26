import { describe, expect, it } from "vitest";
import { canReadSessionDetail, extractAuthToken } from "../src/auth-middleware.js";

describe("auth token extraction", () => {
  it("prefers auth_token query over Authorization so device tokens can coexist", () => {
    const req = {
      url: "/sessions/session-1?auth_token=supabase-jwt",
      headers: {
        authorization: "Bearer device-token",
      },
    };

    expect(extractAuthToken(req as any)).toBe("supabase-jwt");
  });

  it("falls back to Authorization when auth_token is absent", () => {
    const req = {
      url: "/sessions/session-1",
      headers: {
        authorization: "Bearer supabase-jwt",
      },
    };

    expect(extractAuthToken(req as any)).toBe("supabase-jwt");
  });
});

describe("session detail authorization", () => {
  it("allows device-token owners on self-hosted and official gateways", () => {
    expect(canReadSessionDetail({
      authRequired: false,
      tokenOwns: true,
    })).toBe(true);
    expect(canReadSessionDetail({
      authRequired: true,
      authenticatedUserId: "user-2",
      sessionUserId: "user-1",
      tokenOwns: true,
    })).toBe(true);
  });

  it("allows Supabase owners on official gateways even before device token binding", () => {
    expect(canReadSessionDetail({
      authRequired: true,
      authenticatedUserId: "user-1",
      sessionUserId: "user-1",
      tokenOwns: false,
    })).toBe(true);
  });

  it("rejects non-owners and ignores Supabase ownership on self-hosted gateways", () => {
    expect(canReadSessionDetail({
      authRequired: true,
      authenticatedUserId: "user-2",
      sessionUserId: "user-1",
      tokenOwns: false,
    })).toBe(false);
    expect(canReadSessionDetail({
      authRequired: false,
      authenticatedUserId: "user-1",
      sessionUserId: "user-1",
      tokenOwns: false,
    })).toBe(false);
  });
});
