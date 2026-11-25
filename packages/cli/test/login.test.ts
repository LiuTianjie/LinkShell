import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Nothing here may open a browser.
const spawnMock = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
vi.mock("node:child_process", () => ({ execSync: vi.fn(), spawn: spawnMock }));

// The account module reads LINKSHELL_HOME once, as it loads.
const home = mkdtempSync(join(tmpdir(), "lsh-login-"));
process.env.LINKSHELL_HOME = home;
const { openBrowserNonBlocking, parseCallbackInput, runLogin } = await import("../src/commands/login.js");
const auth = await import("../src/auth.js");
afterAll(() => rmSync(home, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Starts `linkshell login`; resolves the address of its callback server once it says where the browser should go. */
function startLogin(signal?: AbortSignal) {
  let said = "";
  let found!: (callback: string) => void;
  const callback = new Promise<string>((resolve) => (found = resolve));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    said += String(chunk);
    const match = /callback=([^\s&]+)/.exec(said);
    if (match) found(decodeURIComponent(match[1]!).replace(/\/callback$/, ""));
    return true;
  });
  return { result: runLogin({ signal }), callback, said: () => said };
}

/** The account service: who the token belongs to, and their plan. */
function accountService(plan: { plan: string; plan_expires_at: string | null } | undefined) {
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://localhost:")) return realFetch(input, init);
    if (url.includes("/auth/v1/user")) return Promise.resolve(Response.json({ id: "u1", email: "me@example.com" }));
    if (url.includes("/rest/v1/rpc/itool_entitlement")) {
      const until = plan?.plan === "pro" ? plan.plan_expires_at : null;
      const active = !!until && Date.parse(until) > Date.now();
      return Promise.resolve(Response.json({ ok: true, product: "linkshell", required_tier: "monthly", active, valid_until: until, tier: active ? "monthly" : "free", server_time: new Date().toISOString() }));
    }
    return Promise.reject(new Error(`unexpected request to ${url}`));
  });
}

describe("linkshell login", () => {
  it("closes its callback listener and timeout when the owning desktop app exits", async () => {
    const controller = new AbortController();
    const login = startLogin(controller.signal);
    const base = await login.callback;
    expect((await realFetch(`${base}/callback`)).status).toBe(200);
    controller.abort();
    expect(await login.result).toBeNull();
    await expect(realFetch(`${base}/callback`)).rejects.toThrow();
  });

  it("aborts account verification without replacing credentials after the owner cancels", async () => {
    auth.saveAuth({ accessToken: "existing", refreshToken: "existing-refresh", userId: "existing-user", expiresAt: Date.now() + 3600000 });
    let verificationSignal: AbortSignal | undefined;
    let verifying!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { verifying = resolve; });
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://localhost:")) return realFetch(input, init);
      if (url.includes("/auth/v1/user")) return Promise.resolve(Response.json({ id: "new-user", email: "new@example.com" }));
      verificationSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        verificationSignal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        verifying();
      });
    });
    const controller = new AbortController();
    const login = startLogin(controller.signal);
    const base = await login.callback;
    const callback = realFetch(`${base}/token?access_token=new-access&refresh_token=new-refresh`, { method: "POST" }).catch(() => undefined);
    await verificationStarted;
    controller.abort();
    expect(await login.result).toBeNull();
    await callback;
    expect(verificationSignal?.aborted).toBe(true);
    expect(auth.loadAuth()?.userId).toBe("existing-user");
  });

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
    expect(login.said()).toContain("LinkShell member");
    // The five-minute limit must not outlive the login: it would keep the command running.
    const limit = started.mock.results[started.mock.calls.findIndex(([, delay]) => delay === 5 * 60 * 1000)]?.value;
    expect(limit).toBeDefined();
    expect(cleared).toHaveBeenCalledWith(limit);
  });

  it("rejects invalid credentials without replacing an existing login", async () => {
    auth.saveAuth({ accessToken: "existing", refreshToken: "existing-refresh", userId: "existing-user", expiresAt: Date.now() + 3600000 });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("Unauthorized", { status: 401 })));
    const login = startLogin();
    const base = await login.callback;
    expect((await realFetch(`${base}/token?access_token=bad&refresh_token=bad`, { method: "POST" })).status).toBe(401);
    expect(auth.loadAuth()?.userId).toBe("existing-user");
    accountService(undefined);
    await realFetch(`${base}/token?access_token=good&refresh_token=good`, { method: "POST" });
    expect(await login.result).toMatchObject({ success: true });
  });

  it("takes an ended membership, or none, for Free", async () => {
    accountService({ plan: "pro", plan_expires_at: new Date(Date.now() - 86_400_000).toISOString() });
    const login = startLogin();
    const base = await login.callback;
    await realFetch(`${base}/token?access_token=a2&refresh_token=r2`, { method: "POST" });
    expect(await login.result).toMatchObject({ plan: "free" });
  });

  it("announces LinkShell member without trial copy when signing in with an active entitlement", async () => {
    const validUntil = new Date(Date.now() + 7 * 86_400_000).toISOString();
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://localhost:")) return realFetch(input, init);
      if (url.includes("/auth/v1/user")) return Promise.resolve(Response.json({ id: "u-active", email: "active@example.com" }));
      if (url.includes("/rest/v1/rpc/itool_entitlement")) {
        return Promise.resolve(Response.json({
          ok: true,
          product: "linkshell",
          required_tier: "monthly",
          active: true,
          valid_until: validUntil,
          tier: "yearly",
          trial_ends_at: validUntil,
          is_trial: true,
          server_time: new Date().toISOString(),
        }));
      }
      return Promise.reject(new Error(`unexpected request to ${url}`));
    });
    const login = startLogin();
    const base = await login.callback;
    await realFetch(`${base}/token?access_token=at&refresh_token=rt`, { method: "POST" });
    expect(await login.result).toMatchObject({
      success: true,
      plan: "pro",
      tier: "yearly",
      email: "active@example.com",
    });
    expect(login.said()).toContain("LinkShell member");
    expect(login.said()).not.toMatch(/7-day|trial/i);
  });

  it("uses literal 127.0.0.1 callback URL and non-blocking detached spawn (never execFileSync)", async () => {
    spawnMock.mockClear();
    const controller = new AbortController();
    const login = startLogin(controller.signal);
    const base = await login.callback;
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    controller.abort();
    expect(await login.result).toBeNull();

    spawnMock.mockClear();
    openBrowserNonBlocking("https://itool.tech/test", "linux");
    expect(spawnMock).toHaveBeenCalledWith("xdg-open", ["https://itool.tech/test"], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
  });

  it("skips browser launch on headless/SSH sessions, prints SSH port-forward hint, and accepts a pasted callback URL", async () => {
    spawnMock.mockClear();
    accountService({ plan: "pro", plan_expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    const fakeStdin = new PassThrough();
    let said = "";
    const fakeStderr = new PassThrough();
    fakeStderr.on("data", (chunk) => { said += String(chunk); });

    const promise = runLogin({
      noBrowser: true,
      env: { SSH_CONNECTION: "10.0.0.5 52000 10.0.0.99 22", USER: "ubuntu" },
      platform: "linux",
      stdin: fakeStdin,
      stderr: fakeStderr,
    });

    await vi.waitFor(() => expect(said).toContain("ssh -L "));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(said).toContain("ubuntu@10.0.0.99");

    fakeStdin.write("http://127.0.0.1:45678/callback#access_token=pasted-at&refresh_token=pasted-rt&expires_in=3600\n");
    const result = await promise;
    expect(result).toMatchObject({ success: true, plan: "pro", accessToken: "pasted-at" });
    expect(auth.loadAuth()).toMatchObject({ accessToken: "pasted-at", refreshToken: "pasted-rt" });
  });

  it("authenticates directly over SSH with --email and --password-stdin without launching a browser", async () => {
    spawnMock.mockClear();
    vi.stubGlobal("fetch", (input: string | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/token?grant_type=password")) {
        return Promise.resolve(
          Response.json({
            access_token: "pw-at",
            refresh_token: "pw-rt",
            expires_in: 3600,
            user: { id: "u-ssh", email: "ssh@example.com" },
          }),
        );
      }
      if (url.includes("/rest/v1/rpc/itool_entitlement")) {
        return Promise.resolve(
          Response.json({ ok: true, product: "linkshell", active: true, tier: "monthly", valid_until: new Date(Date.now() + 86_400_000).toISOString() }),
        );
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });

    const fakeStdin = new PassThrough();
    fakeStdin.end("super-secret-pw\n");
    let said = "";
    const fakeStderr = new PassThrough();
    fakeStderr.on("data", (chunk) => { said += String(chunk); });

    const result = await runLogin({
      email: "ssh@example.com",
      passwordStdin: true,
      stdin: fakeStdin,
      stderr: fakeStderr,
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, plan: "pro", email: "ssh@example.com", accessToken: "pw-at" });
    expect(said).toContain("Logged in as ssh@example.com");
  });

  it("parses pasted callback URLs in fragment, query, code, error, and quoted formats", () => {
    expect(parseCallbackInput("http://127.0.0.1:8123/callback#access_token=a1&refresh_token=r1&expires_in=1800")).toEqual({
      kind: "tokens",
      accessToken: "a1",
      refreshToken: "r1",
      expiresIn: 1800,
    });
    expect(parseCallbackInput("'http://127.0.0.1:8123/callback?access_token=a2&refresh_token=r2'")).toEqual({
      kind: "tokens",
      accessToken: "a2",
      refreshToken: "r2",
      expiresIn: 3600,
    });
    expect(parseCallbackInput("http://127.0.0.1:8123/linkshell/callback?code=pkce-code")).toEqual({
      kind: "code",
      code: "pkce-code",
    });
    expect(parseCallbackInput("http://127.0.0.1:8123/callback#error=access_denied&error_description=Cancelled")).toEqual({
      kind: "error",
      message: "Cancelled",
    });
    expect(parseCallbackInput("not-a-callback")).toBeNull();
  });
});
