import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "linkshell.web.account.v2";

function makeStorage(initial?: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

describe("web account refresh coordination", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the newer session rotated by another tab even when its own refresh gets 401", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const localStorage = makeStorage({
      [STORAGE_KEY]: JSON.stringify({
        access_token: "old-access",
        refresh_token: "old-refresh",
        expires_at: nowSec - 10,
        user: { id: "user-1", email: "u@example.com" },
      }),
    });
    vi.stubGlobal("window", {
      __LINKSHELL_CONFIG__: { account: { url: "https://api.example" } },
      localStorage,
    });
    const fetchMock = vi.fn(async () => {
      // Simulate another tab winning the rotation while our request was in flight.
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          access_token: "tab2-access",
          refresh_token: "tab2-refresh",
          expires_at: nowSec + 3600,
          user: { id: "user-1", email: "u@example.com" },
        }),
      );
      return Response.json({ error: { code: "invalid_refresh_token", message: "会话已失效" } }, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { accountClient } = await import("../src/live/account");
    const res = await accountClient().auth.refreshSession();
    expect(res.error).toBeNull();
    expect(res.data.session?.refresh_token).toBe("tab2-refresh");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").refresh_token).toBe("tab2-refresh");
  });

  it("reuses a fresh session updated by another tab while waiting on navigator.locks", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const localStorage = makeStorage({
      [STORAGE_KEY]: JSON.stringify({
        access_token: "old-access",
        refresh_token: "old-refresh",
        expires_at: nowSec - 10,
        user: { id: "user-1", email: "u@example.com" },
      }),
    });
    vi.stubGlobal("window", {
      __LINKSHELL_CONFIG__: { account: { url: "https://api.example" } },
      localStorage,
    });
    vi.stubGlobal("navigator", {
      locks: {
        request: vi.fn(async (_name: string, fn: () => Promise<unknown>) => {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              access_token: "locked-access",
              refresh_token: "locked-refresh",
              expires_at: nowSec + 3600,
              user: { id: "user-1", email: "u@example.com" },
            }),
          );
          return fn();
        }),
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { accountClient } = await import("../src/live/account");
    const res = await accountClient().auth.refreshSession();
    expect(res.error).toBeNull();
    expect(res.data.session?.access_token).toBe("locked-access");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
