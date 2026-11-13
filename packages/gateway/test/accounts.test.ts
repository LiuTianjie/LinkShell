import { afterEach, describe, expect, it, vi } from "vitest";
import { supabaseVerifier } from "../src/accounts.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supabaseVerifier", () => {
  it("coalesces concurrent in-flight verification requests for the same token", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const verify = supabaseVerifier("https://auth.example", "anon");
    const first = verify("jwt-same");
    const second = verify("jwt-same");
    const third = verify("jwt-same");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(Response.json({ id: "user-1", email: "user@example.com" }));

    const results = await Promise.all([first, second, third]);
    expect(results).toEqual([
      { userId: "user-1", email: "user@example.com" },
      { userId: "user-1", email: "user@example.com" },
      { userId: "user-1", email: "user@example.com" },
    ]);

    // Subsequent call hits the 45s cache without calling fetch again.
    await expect(verify("jwt-same")).resolves.toEqual({ userId: "user-1", email: "user@example.com" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches verified results for 45s TTL and does not cache failures", async () => {
    let now = 0;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ id: "user-2", email: "two@example.com" }))
      .mockResolvedValueOnce(Response.json({ id: "user-2", email: "two-refreshed@example.com" }));
    vi.stubGlobal("fetch", fetchMock);

    const verify = supabaseVerifier("https://auth.example", "anon", { now: () => now });

    // Failures are not cached.
    await expect(verify("tok")).resolves.toBeUndefined();
    await expect(verify("tok")).resolves.toEqual({ userId: "user-2", email: "two@example.com" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Within 45s TTL, returns cached account.
    now = 44_999;
    await expect(verify("tok")).resolves.toEqual({ userId: "user-2", email: "two@example.com" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // At/past 45s TTL, re-fetches.
    now = 45_000;
    await expect(verify("tok")).resolves.toEqual({ userId: "user-2", email: "two-refreshed@example.com" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("bounds the SHA-256 token cache to maxEntries", async () => {
    const now = 0;
    let calls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      return Response.json({ id: `u-${auth}`, email: `${calls}@example.com` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verify = supabaseVerifier("https://auth.example", "anon", { now: () => now, maxEntries: 2, ttlMs: 45_000 });
    await verify("tok-a");
    await verify("tok-b");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Accessing tok-a refreshes it so tok-b becomes the oldest entry.
    await verify("tok-a");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Inserting tok-c evicts tok-b while keeping tok-a cached.
    await verify("tok-c");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await verify("tok-a");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await verify("tok-b");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
