import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// The module reads LINKSHELL_HOME once, as it loads.
const home = mkdtempSync(join(tmpdir(), "lsh-auth-"));
process.env.LINKSHELL_HOME = home;
const auth = await import("../src/auth.js");
afterAll(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

const file = join(home, "auth.json");
const tokens = (expiresAt: number) => ({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt, userId: "u1", email: "me@example.com" });

describe("the account on this computer", () => {
  it("is kept in a file only its owner can read", () => {
    auth.saveAuth(tokens(Date.now() + 3_600_000));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(auth.loadAuth()).toMatchObject({ userId: "u1", email: "me@example.com" });
    expect(auth.isLoggedIn()).toBe(true);
  });

  it("is gone after logging out, and the file stays private", () => {
    auth.saveAuth(tokens(Date.now() + 3_600_000));
    auth.clearAuth();
    expect(auth.loadAuth()).toBeNull();
    expect(auth.isLoggedIn()).toBe(false);
    expect(readFileSync(file, "utf8")).not.toContain("access-1");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("hands out a token that is still good without asking anyone", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    auth.saveAuth(tokens(Date.now() + 3_600_000));
    expect(await auth.getValidToken()).toBe("access-1");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes a token about to expire, and keeps the new one", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, user: { id: "u1", email: "me@example.com" } }),
    );
    vi.stubGlobal("fetch", fetch);
    auth.saveAuth(tokens(Date.now() + 30_000));
    expect(await auth.getValidToken()).toBe("access-2");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ refresh_token: "refresh-1" });
    expect(auth.loadAuth()).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("has no token when the refresh is refused or the network is down", async () => {
    auth.saveAuth(tokens(Date.now() - 1));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 400 })));
    expect(await auth.getValidToken()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    expect(await auth.getValidToken()).toBeNull();
    // The old tokens stay: the next attempt may succeed.
    expect(auth.loadAuth()).toMatchObject({ refreshToken: "refresh-1" });
  });

  it("has no token when nobody is logged in", async () => {
    auth.clearAuth();
    expect(await auth.getValidToken()).toBeNull();
  });
});
