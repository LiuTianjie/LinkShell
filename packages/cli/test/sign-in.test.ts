import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Nothing here may open a browser.
vi.mock("node:child_process", () => ({ execFile: vi.fn(), execFileSync: vi.fn(), execSync: vi.fn() }));

// The account module reads LINKSHELL_HOME once, as it loads.
const home = mkdtempSync(join(tmpdir(), "lsh-sign-in-"));
process.env.LINKSHELL_HOME = home;
const signIn = await import("../src/commands/sign-in.js");
const { LoginError } = await import("../src/commands/login-error.js");
const auth = await import("../src/auth.js");
afterAll(() => rmSync(home, { recursive: true, force: true }));

const PROXY = "https://itool.tech/api/linkshell/auth";
const SUPABASE = "https://mkbeusztkzffnzjdwmqk.supabase.co";
const realFetch = globalThis.fetch;
const existing = { accessToken: "existing", refreshToken: "existing-refresh", userId: "existing-user", expiresAt: Date.now() + 3_600_000 };
const session = (access = "access-new") => ({
  access_token: access, refresh_token: `refresh-for-${access}`, expires_in: 3600, token_type: "bearer",
  user: { id: "u-new", email: "new@example.com" },
});

beforeEach(() => {
  delete process.env.LINKSHELL_TOKEN_PROXY;
  auth.saveAuth(existing);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.LINKSHELL_TOKEN_PROXY;
});

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
/** Remote requests go to `handler`; the loopback stays real. Profiles answer "free" unless the handler does. */
function remote(handler: Handler) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.includes("/rest/v1/profiles")) return Response.json([{ plan: "pro", plan_expires_at: new Date(Date.now() + 86_400_000).toISOString() }]);
    return handler(url, init);
  });
  return calls;
}

describe("PKCE", () => {
  it("derives the S256 challenge of RFC 7636's test vector", () => {
    expect(signIn.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("makes a fresh 43-character verifier each time, with its own challenge", () => {
    const a = signIn.pkcePair();
    const b = signIn.pkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(signIn.pkceChallenge(a.verifier));
  });

  it("asks Supabase for the provider with the loopback the allowlist names", () => {
    const github = new URL(signIn.authorizeURL("github", "http://127.0.0.1:5123/linkshell/callback", "challenge"));
    expect(`${github.origin}${github.pathname}`).toBe(`${SUPABASE}/auth/v1/authorize`);
    expect(Object.fromEntries(github.searchParams)).toEqual({
      provider: "github", redirect_to: "http://127.0.0.1:5123/linkshell/callback",
      code_challenge: "challenge", code_challenge_method: "s256", scopes: "read:user user:email",
    });
    expect(new URL(signIn.authorizeURL("google", "http://127.0.0.1:1/linkshell/callback", "c")).searchParams.has("scopes")).toBe(false);
  });
});

describe("email and password", () => {
  it("signs in through the proxy and keeps the session in a private auth.json, without asking who the user is", async () => {
    const calls = remote(() => Response.json(session()));
    const result = await signIn.loginWithPassword({ email: "  new@example.com ", password: "secret pw" });
    expect(result).toEqual({ success: true, plan: "pro", email: "new@example.com", userId: "u-new", accessToken: "access-new" });
    expect(calls[0]).toEqual({ url: PROXY, body: { grant_type: "password", email: "new@example.com", password: "secret pw" } });
    expect(calls.some(({ url }) => url.includes("/auth/v1/user"))).toBe(false);
    const file = join(home, "auth.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ accessToken: "access-new", refreshToken: "refresh-for-access-new", userId: "u-new", email: "new@example.com" });
    expect(saved.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(Object.keys(saved).sort()).toEqual(["accessToken", "email", "expiresAt", "refreshToken", "userId"]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(home, "account-pro.json"), "utf8"))).toMatchObject({ userId: "u-new", plan: "pro" });
  });

  it("goes to Supabase directly when the proxy is unreachable, missing or temporarily unavailable", async () => {
    for (const proxy of [
      () => Promise.reject(new TypeError("fetch failed")),
      () => new Response("Not Found", { status: 404 }),
      () => Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
      () => Response.json({ ok: false, code: "invalid_request" }, { status: 400 }),
    ]) {
      const calls = remote((url) => url === PROXY ? proxy() : Response.json(session("direct")));
      expect((await signIn.loginWithPassword({ email: "new@example.com", password: "pw" })).accessToken).toBe("direct");
      expect(calls.map(({ url }) => url).slice(0, 2)).toEqual([PROXY, `${SUPABASE}/auth/v1/token?grant_type=password`]);
      expect(calls[1]!.body).toEqual({ email: "new@example.com", password: "pw" });
    }
  });

  it("never retries a refusal from the proxy directly, and keeps the existing login", async () => {
    for (const [error, code] of [["invalid_credentials", "invalid_credentials"], ["email_not_confirmed", "email_not_confirmed"], ["invalid_grant", "invalid_credentials"]] as const) {
      const calls = remote(() => Response.json({ error }, { status: 400 }));
      const failure = await signIn.loginWithPassword({ email: "new@example.com", password: "wrong" }).catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(LoginError);
      expect((failure as InstanceType<typeof LoginError>).code).toBe(code);
      expect(calls.map(({ url }) => url)).toEqual([PROXY]);
      expect(auth.loadAuth()?.userId).toBe("existing-user");
    }
  });

  it("skips the proxy entirely with the kill switch", async () => {
    process.env.LINKSHELL_TOKEN_PROXY = "off";
    const calls = remote(() => Response.json(session("direct")));
    await signIn.loginWithPassword({ email: "new@example.com", password: "pw" });
    expect(calls.filter(({ url }) => !url.includes("/rest/v1/")).map(({ url }) => url)).toEqual([`${SUPABASE}/auth/v1/token?grant_type=password`]);
  });

  it("explains Supabase's refusals in Chinese, in both of its answer shapes", async () => {
    process.env.LINKSHELL_TOKEN_PROXY = "off";
    const cases: [Response | Error, string][] = [
      [Response.json({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 }), "用 GitHub 或 Google 注册的账号没有密码"],
      [Response.json({ error: "invalid_grant", error_description: "Email not confirmed" }, { status: 400 }), "邮箱还没有验证"],
      [Response.json({ error_code: "over_request_rate_limit" }, { status: 429 }), "尝试次数过多"],
      [Response.json({ msg: "boom" }, { status: 500 }), "登录服务暂时不可用"],
      [new TypeError("fetch failed"), "无法连接登录服务"],
    ];
    for (const [answer, message] of cases) {
      remote(() => answer instanceof Error ? Promise.reject(answer) : answer);
      await expect(signIn.loginWithPassword({ email: "new@example.com", password: "pw" })).rejects.toThrow(message);
    }
    await expect(signIn.loginWithPassword({ email: " ", password: "pw" })).rejects.toThrow("请输入邮箱和密码");
    expect(auth.loadAuth()?.userId).toBe("existing-user");
  });

  it("saves nothing when the owner cancels while the account is being checked", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === PROXY) return Response.json(session());
      // The plan lookup is in flight when the person cancels.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        controller.abort();
      });
    });
    await expect(signIn.loginWithPassword({ email: "new@example.com", password: "pw", signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(auth.loadAuth()?.userId).toBe("existing-user");
  });
});

describe("GitHub and Google through the loopback", () => {
  /** Starts the sign-in; resolves the authorize URL the browser would have been sent to. */
  function start(options: { provider?: "github" | "google"; signal?: AbortSignal; timeoutMs?: number } = {}) {
    let opened!: (url: URL) => void;
    const authorize = new Promise<URL>((resolve) => { opened = resolve; });
    const result = signIn.loginWithOAuth({ provider: options.provider ?? "github", signal: options.signal, timeoutMs: options.timeoutMs, open: (url) => opened(new URL(url)) });
    result.catch(() => undefined);
    return { result, authorize, callback: authorize.then((url) => new URL(url.searchParams.get("redirect_to")!)) };
  }

  it("listens on 127.0.0.1 at /linkshell/callback and trades the code with its own verifier", async () => {
    const calls = remote(() => Response.json(session("oauth")));
    const login = start();
    const authorize = await login.authorize;
    const callback = await login.callback;
    expect(callback.hostname).toBe("127.0.0.1");
    expect(callback.pathname).toBe("/linkshell/callback");
    expect(Number(callback.port)).toBeGreaterThan(0);

    const answer = await realFetch(`${callback}?code=one-time-code`, { redirect: "manual" });
    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBe("/linkshell/done?status=ok");
    expect(await login.result).toMatchObject({ success: true, userId: "u-new", accessToken: "oauth" });

    const exchange = calls.find(({ url }) => url === PROXY)!.body as { grant_type: string; auth_code: string; code_verifier: string };
    expect(exchange.grant_type).toBe("pkce");
    expect(exchange.auth_code).toBe("one-time-code");
    expect(signIn.pkceChallenge(exchange.code_verifier)).toBe(authorize.searchParams.get("code_challenge"));
    expect(auth.loadAuth()).toMatchObject({ accessToken: "oauth", userId: "u-new" });

    // The outcome page is the loopback's own, and holds no token.
    const page = await realFetch(new URL("/linkshell/done?status=ok", callback));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('var state = "ok"');
    expect(html).not.toContain("refresh-for");
    await vi.waitFor(() => expect(realFetch(callback)).rejects.toThrow());
  });

  it("falls back to Supabase's own PKCE grant when the proxy has no verdict", async () => {
    const calls = remote((url) => url === PROXY ? Promise.reject(new TypeError("fetch failed")) : Response.json(session("direct")));
    const login = start({ provider: "google" });
    const callback = await login.callback;
    await realFetch(`${callback}?code=c1`, { redirect: "manual" });
    expect((await login.result).accessToken).toBe("direct");
    const direct = calls.find(({ url }) => url === `${SUPABASE}/auth/v1/token?grant_type=pkce`)!;
    expect(direct.body).toMatchObject({ auth_code: "c1" });
  });

  it("reports the provider's refusal and keeps the existing login", async () => {
    const calls = remote(() => { throw new Error("no request expected"); });
    const login = start();
    const callback = await login.callback;
    const answer = await realFetch(`${callback}?error=access_denied&error_code=access_denied&error_description=The+user+denied`, { redirect: "manual" });
    expect(answer.headers.get("location")).toBe("/linkshell/done?status=failed");
    await expect(login.result).rejects.toMatchObject({ code: "oauth_denied", message: "已在浏览器中取消授权。" });
    expect(calls).toEqual([]);
    expect(auth.loadAuth()?.userId).toBe("existing-user");
  });

  it("explains an account registered another way", async () => {
    remote(() => { throw new Error("no request expected"); });
    const login = start();
    const callback = await login.callback;
    await realFetch(`${callback}?error=server_error&error_description=Multiple+accounts+with+the+same+email+address+in+the+same+linking+domain+detected`, { redirect: "manual" });
    await expect(login.result).rejects.toThrow("这个邮箱已经用另一种方式注册过");
  });

  it("passes an error Supabase put in the fragment on, and nothing else from it", async () => {
    remote(() => { throw new Error("no request expected"); });
    const login = start();
    const callback = await login.callback;
    const page = await realFetch(callback);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('["error", "error_code", "error_description"]');
    expect(html).not.toMatch(/access_token/);
    // A bare callback decides nothing: the sign-in is still waiting.
    const pending = await Promise.race([login.result.then(() => "settled", () => "settled"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 50))]);
    expect(pending).toBe("waiting");
    await realFetch(`${callback}?error=access_denied`, { redirect: "manual" });
    await expect(login.result).rejects.toMatchObject({ code: "oauth_denied" });
  });

  it("gives up after its time limit and stops listening", async () => {
    remote(() => { throw new Error("no request expected"); });
    const login = start({ timeoutMs: 40 });
    const callback = await login.callback;
    await expect(login.result).rejects.toMatchObject({ code: "browser_timeout" });
    await expect(realFetch(callback)).rejects.toThrow();
  });

  it("stops listening at once when the owner cancels", async () => {
    remote(() => { throw new Error("no request expected"); });
    const controller = new AbortController();
    const login = start({ signal: controller.signal });
    const callback = await login.callback;
    controller.abort();
    await expect(login.result).rejects.toMatchObject({ code: "cancelled", message: "已取消登录。" });
    await expect(realFetch(callback)).rejects.toThrow();
    expect(auth.loadAuth()?.userId).toBe("existing-user");
  });

  it("refuses a provider it doesn't know before listening", async () => {
    await expect(signIn.loginWithOAuth({ provider: "gitlab" as never, open: () => { throw new Error("must not open"); } })).rejects.toMatchObject({ code: "provider_disabled" });
  });

  it("answers an expired code with a retry, and a second callback with the first one's outcome", async () => {
    remote(() => Response.json({ error_code: "flow_state_not_found", msg: "invalid flow state, no valid flow state found" }, { status: 404 }));
    const login = start();
    const callback = await login.callback;
    // The proxy's 404 is "no such route": the direct answer decides.
    expect((await realFetch(`${callback}?code=stale`, { redirect: "manual" })).headers.get("location")).toBe("/linkshell/done?status=failed");
    await expect(login.result).rejects.toMatchObject({ code: "oauth_expired" });
    // A reload of the callback page decides nothing new.
    expect((await realFetch(`${callback}?code=again`, { redirect: "manual" })).headers.get("location")).toBe("/linkshell/done?status=failed");
  });
});
