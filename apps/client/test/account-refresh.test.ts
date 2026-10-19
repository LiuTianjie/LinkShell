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
