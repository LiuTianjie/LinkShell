import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountMembership, redeemAccountProCode } from "../src/live/account";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  fetchProMembership: vi.fn(),
  redeemProCode: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getSession: mocks.getSession,
      refreshSession: mocks.refreshSession,
    },
  }),
}));
vi.mock("@linkshell/client-core", () => ({
  fetchProMembership: mocks.fetchProMembership,
  redeemProCode: mocks.redeemProCode,
}));

const now = Date.parse("2026-10-19T00:00:00Z");
const accountConfig = {
  url: "https://account.example",
  anonKey: "public-test-key",
};
const session = (accessToken: string, userId: string, secondsLeft = 3600) => ({
  access_token: accessToken,
  expires_at: now / 1000 + secondsLeft,
  user: { id: userId },
});
const result = (value: ReturnType<typeof session> | null) => ({
  data: { session: value },
  error: null,
});
const accountChanged = "账号已切换，请在当前账户下重新操作";
const signedOut = "登录已失效，请重新登录";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const operations = [
  {
    name: "membership lookup",
    run: () => accountMembership("user-a"),
    request: mocks.fetchProMembership,
    response: { plan: "free" },
    requestArguments: (accessToken: string) => [
      {
        supabaseUrl: accountConfig.url,
        anonKey: accountConfig.anonKey,
        accessToken,
        userId: "user-a",
      },
    ],
  },
  {
    name: "redemption",
    run: () => redeemAccountProCode("user-a", "TEST-CODE"),
    request: mocks.redeemProCode,
    response: { expiresAt: "2027-10-19T00:00:00Z", idempotent: false },
    requestArguments: (accessToken: string) => [accessToken, "TEST-CODE"],
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("window", { __LINKSHELL_CONFIG__: { account: accountConfig } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(operations)("$name", (operation) => {
  it("rejects an action from a signed-out account", async () => {
    mocks.getSession.mockResolvedValue(result(null));

    await expect(operation.run()).rejects.toThrow(signedOut);

    expect(mocks.refreshSession).not.toHaveBeenCalled();
    expect(operation.request).not.toHaveBeenCalled();
  });

  it("rejects an action whose initiating account is no longer signed in", async () => {
    mocks.getSession.mockResolvedValue(result(session("token-b", "user-b")));

    await expect(operation.run()).rejects.toThrow(accountChanged);

    expect(mocks.refreshSession).not.toHaveBeenCalled();
    expect(operation.request).not.toHaveBeenCalled();
  });

  it("uses the initiating account's valid token and returns the response", async () => {
    mocks.getSession.mockResolvedValue(
      result(session("valid-token", "user-a")),
    );
    operation.request.mockResolvedValue(operation.response);

    await expect(operation.run()).resolves.toBe(operation.response);

    expect(mocks.refreshSession).not.toHaveBeenCalled();
    expect(operation.request).toHaveBeenCalledExactlyOnceWith(
      ...operation.requestArguments("valid-token"),
    );
  });

  it("refreshes a nearly expired token without changing the initiating account", async () => {
    let currentSession = session("old-token", "user-a", 60);
    mocks.getSession.mockImplementation(async () => result(currentSession));
    mocks.refreshSession.mockImplementation(async () => {
      currentSession = session("refreshed-token", "user-a");
      return result(currentSession);
    });
    operation.request.mockResolvedValue(operation.response);

    await expect(operation.run()).resolves.toBe(operation.response);

    expect(mocks.refreshSession).toHaveBeenCalledOnce();
    expect(operation.request).toHaveBeenCalledExactlyOnceWith(
      ...operation.requestArguments("refreshed-token"),
    );
  });

  it("does not send a request when refresh returns another account", async () => {
    let currentSession = session("old-token", "user-a", 60);
    mocks.getSession.mockImplementation(async () => result(currentSession));
    mocks.refreshSession.mockImplementation(async () => {
      currentSession = session("token-b", "user-b");
      return result(currentSession);
    });

    await expect(operation.run()).rejects.toThrow(accountChanged);

    expect(operation.request).not.toHaveBeenCalled();
  });

  it("does not send a request when another account signs in after refresh", async () => {
    mocks.getSession
      .mockResolvedValueOnce(result(session("old-token", "user-a", 60)))
      .mockResolvedValue(result(session("token-b", "user-b")));
    mocks.refreshSession.mockResolvedValue(
      result(session("refreshed-token", "user-a")),
    );

    await expect(operation.run()).rejects.toThrow(accountChanged);

    expect(operation.request).not.toHaveBeenCalled();
  });

  it("does not use a token that changed before the request was sent", async () => {
    mocks.getSession
      .mockResolvedValueOnce(result(session("first-token", "user-a")))
      .mockResolvedValue(result(session("second-token", "user-a")));

    await expect(operation.run()).rejects.toThrow("账号状态已更新，请重试");

    expect(operation.request).not.toHaveBeenCalled();
  });

  it("discards a response that arrives after another account signs in", async () => {
    let currentSession = session("token-a", "user-a");
    mocks.getSession.mockImplementation(async () => result(currentSession));
    const started = deferred<void>();
    const response = deferred<typeof operation.response>();
    operation.request.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });

    const pending = operation.run();
    await started.promise;
    currentSession = session("token-b", "user-b");
    response.resolve(operation.response);

    await expect(pending).rejects.toThrow(accountChanged);
    expect(operation.request).toHaveBeenCalledExactlyOnceWith(
      ...operation.requestArguments("token-a"),
    );
  });

  it("stops without sending a request when refreshing the session fails", async () => {
    mocks.getSession.mockResolvedValue(
      result(session("old-token", "user-a", 60)),
    );
    const error = new Error("Session refresh failed");
    mocks.refreshSession.mockResolvedValue({ data: { session: null }, error });

    await expect(operation.run()).rejects.toBe(error);

    expect(operation.request).not.toHaveBeenCalled();
  });
});
