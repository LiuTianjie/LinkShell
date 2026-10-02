import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Nothing here may open a browser.
vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

// The account module reads LINKSHELL_HOME once, as it loads.
const home = mkdtempSync(join(tmpdir(), "lsh-login-"));
process.env.LINKSHELL_HOME = home;
const { runLogin } = await import("../src/commands/login.js");
const auth = await import("../src/auth.js");
afterAll(() => rmSync(home, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Starts `linkshell login`; resolves the address of its callback server once it says where the browser should go. */
function startLogin() {
  let said = "";
  let found!: (callback: string) => void;
  const callback = new Promise<string>((resolve) => (found = resolve));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    said += String(chunk);
    const match = /callback=([^\s&]+)/.exec(said);
    if (match) found(decodeURIComponent(match[1]!).replace(/\/callback$/, ""));
    return true;
  });
  return { result: runLogin(), callback, said: () => said };
}

/** The account service: who the token belongs to, and their plan. */
function accountService(plan: { plan: string; plan_expires_at: string | null } | undefined) {
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://localhost:")) return realFetch(input, init);
    if (url.includes("/auth/v1/user")) return Promise.resolve(Response.json({ id: "u1", email: "me@example.com" }));
    if (url.includes("/rest/v1/profiles")) return Promise.resolve(Response.json(plan ? [plan] : []));
    return Promise.reject(new Error(`unexpected request to ${url}`));
  });
}

describe("linkshell login", () => {
  it("keeps the tokens the browser hands back, and says which plan the account has", async () => {
    accountService({ plan: "pro", plan_expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    const started = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const login = startLogin();
    const base = await login.callback;

    expect((await realFetch(`${base}/token?access_token=only-one`, { method: "POST" })).status).toBe(400);
    expect((await realFetch(`${base}/callback`)).status).toBe(200);
    expect((await realFetch(`${base}/token?access_token=a1&refresh_token=r1&expires_in=3600`, { method: "POST" })).status).toBe(200);

    expect(await login.result).toMatchObject({ success: true, plan: "pro", email: "me@example.com", userId: "u1", accessToken: "a1" });
    expect(auth.loadAuth()).toMatchObject({ accessToken: "a1", refreshToken: "r1", userId: "u1" });
    expect(login.said()).toContain("Logged in as me@example.com");
    // The five-minute limit must not outlive the login: it would keep the command running.
    const limit = started.mock.results[started.mock.calls.findIndex(([, delay]) => delay === 5 * 60 * 1000)]?.value;
    expect(limit).toBeDefined();
    expect(cleared).toHaveBeenCalledWith(limit);
  });

  it("takes an expired Pro plan, or none, for Free", async () => {
    accountService({ plan: "pro", plan_expires_at: new Date(Date.now() - 86_400_000).toISOString() });
    const login = startLogin();
    const base = await login.callback;
    await realFetch(`${base}/token?access_token=a2&refresh_token=r2`, { method: "POST" });
    expect(await login.result).toMatchObject({ plan: "free" });
  });
});
