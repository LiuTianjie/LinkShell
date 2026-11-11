import { afterEach, beforeEach, expect, it, vi } from "vitest";

const secrets = vi.hoisted(() => ({ write: vi.fn(), remove: vi.fn() }));
vi.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: {}, CryptoEncoding: {}, digestStringAsync: vi.fn(), getRandomBytes: vi.fn() }));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock("../src/lib/secure", () => ({ readSecret: () => undefined, writeSecret: secrets.write, deleteSecret: secrets.remove }));

import { useAccount, type AccountSession } from "../src/lib/account";

const expired: AccountSession = { userId: "account-a", accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  useAccount.setState({ session: { ...expired } });
});
afterEach(() => vi.unstubAllGlobals());

it.each(["sign-out", "account-switch"])("does not resurrect an account when its token refresh finishes after %s", async (action) => {
  let respond!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
  const pending = useAccount.getState().token();
  const other = { ...expired, userId: "account-b", refreshToken: "b-refresh" };
  if (action === "sign-out") await useAccount.getState().signOut();
  else useAccount.setState({ session: other });
  respond(new Response(JSON.stringify({ access_token: "refreshed-a", refresh_token: "next-a", user: { id: "account-a" } })));

  await expect(pending).resolves.toBeUndefined();
  expect(useAccount.getState().session).toEqual(action === "sign-out" ? undefined : other);
  expect(secrets.write).not.toHaveBeenCalled();
});

it("signs out when the server says the session is over", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: 400, error_code: "refresh_token_already_used", msg: "Invalid Refresh Token: Already Used" }, { status: 400 })));
  await expect(useAccount.getState().token()).resolves.toBeUndefined();
  expect(useAccount.getState().session).toBeUndefined();
  expect(secrets.remove).toHaveBeenCalledOnce();
});

it("stays signed in when the refresh fails for another reason", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error_code: "over_request_rate_limit" }, { status: 429 })));
  await expect(useAccount.getState().token()).resolves.toBeUndefined();
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
  await expect(useAccount.getState().token()).resolves.toBeUndefined();
  expect(useAccount.getState().session).toEqual(expired);
  expect(secrets.remove).not.toHaveBeenCalled();
});

it("uses the domestic refresh proxy without retrying a token after an ambiguous failure", async () => {
  const fetch = vi.fn(async (url: string) => {
    expect(url).toBe("https://www.itool.tech/api/linkshell/token");
    return Response.json({ code: "temporarily_unavailable" }, { status: 503 });
  });
  vi.stubGlobal("fetch", fetch);
  await expect(useAccount.getState().token()).resolves.toBeUndefined();
  expect(fetch).toHaveBeenCalledOnce();
  expect(useAccount.getState().session).toEqual(expired);
});

it("can refresh against an older deployment that has no token proxy", async () => {
  const fetch = vi.fn(async (url: string) => url.includes("itool.tech")
    ? new Response("Not Found", { status: 404 })
    : Response.json({ access_token: "fresh", refresh_token: "rotated", user: { id: expired.userId } }));
  vi.stubGlobal("fetch", fetch);
  await expect(useAccount.getState().token()).resolves.toBe("fresh");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(useAccount.getState().session?.refreshToken).toBe("rotated");
});

it("renews a still-valid token in the background instead of delaying the gateway handshake", async () => {
  useAccount.setState({ session: { ...expired, expiresAt: Date.now() + 90_000 } });
  let respond!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
  await expect(useAccount.getState().token()).resolves.toBe("old-access");
  respond(Response.json({ access_token: "fresh", refresh_token: "rotated", user: { id: expired.userId } }));
  await vi.waitFor(() => expect(useAccount.getState().session?.accessToken).toBe("fresh"));
});
