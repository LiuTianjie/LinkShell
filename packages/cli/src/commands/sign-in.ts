import * as http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { saveAuth, SUPABASE_ANON_KEY, SUPABASE_URL, type AuthTokens } from "../auth.js";
import { cacheMembership, type DesktopMembership } from "../pro-membership.js";
import { fetchProMembership } from "../../../client-core/src/pro-membership.js";
import { isDefinitiveAccountError, oauthErrorCode, tokenErrorCode } from "../../../client-core/src/account-errors.js";
import { LoginError } from "./login-error.js";

/**
 * Signing in without iTool's authorization page: email and password, or GitHub / Google through
 * the system browser. Every way ends in `completeLogin`, which writes `~/.linkshell/auth.json`
 * (the Host, the CLI and the desktop all read that one file); nothing here hands a refresh
 * token to a browser or a renderer.
 */

export interface LoginResult {
  success: boolean;
  plan: "pro" | "free";
  email: string;
  userId: string;
  accessToken: string;
}

/** A Supabase session, as `/auth/v1/token` (and itool.tech's proxy of it) returns it. */
export interface SessionGrant {
  accessToken: string;
  refreshToken: string;
  /** Seconds. */
  expiresIn: number;
  /** Present for the password and PKCE grants; the authorization page's tokens come without it. */
  user?: { id: string; email?: string };
}

export type OAuthProvider = "github" | "google";
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ["github", "google"];

// itool.tech forwards the exchange for places where supabase.co is blocked but itool.tech is
// not, as it does for refreshes. LINKSHELL_TOKEN_PROXY=off skips it (the same kill switch).
export const AUTH_PROXY_URL = "https://itool.tech/api/linkshell/auth";
// Must match the Supabase redirect allowlist entry `http://127.0.0.1:*/linkshell/callback`.
// An IP literal rather than `localhost` (RFC 8252 §7.3): nothing can resolve it elsewhere.
export const OAUTH_CALLBACK_PATH = "/linkshell/callback";
const OAUTH_DONE_PATH = "/linkshell/done";
export const OAUTH_TIMEOUT_MS = 5 * 60_000;
const EXCHANGE_TIMEOUT_MS = 10_000;
const USER_TIMEOUT_MS = 10_000;

type Grant =
  | { grant_type: "password"; email: string; password: string }
  | { grant_type: "pkce"; auth_code: string; code_verifier: string };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bounded(signal: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchUser(accessToken: string, signal?: AbortSignal): Promise<{ id: string; email?: string }> {
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: SUPABASE_ANON_KEY },
      signal: bounded(signal, AbortSignal.timeout(USER_TIMEOUT_MS)),
    });
  } catch {
    throw new LoginError(signal?.aborted ? "cancelled" : "unverified");
  }
  const user = record(await response.json().catch(() => undefined));
  if (!response.ok || typeof user.id !== "string" || !user.id) throw new LoginError("unverified");
  return { id: user.id, email: typeof user.email === "string" ? user.email : undefined };
}

/**
 * What every sign-in does once it holds a session: learn whose it is, save it, and note the
 * plan. A membership lookup that fails leaves the plan unknown rather than failing the login;
 * the desktop asks again on its next account refresh.
 */
export async function completeLogin(grant: SessionGrant, options: { signal?: AbortSignal } = {}): Promise<LoginResult> {
  if (options.signal?.aborted) throw new LoginError("cancelled");
  const user = grant.user ?? await fetchUser(grant.accessToken, options.signal);
  let membership: DesktopMembership = { plan: "unknown", planExpiresAt: null };
  try {
    const profile = await fetchProMembership({ userId: user.id, accessToken: grant.accessToken, supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, signal: options.signal });
    membership = { plan: profile.plan, planExpiresAt: profile.expiresAt ?? null };
  } catch { /* Unknown until the next refresh. */ }
  // The owner gave up while this was in flight: an existing login must stay as it was.
  if (options.signal?.aborted) throw new LoginError("cancelled");
  const email = user.email ?? "";
  const tokens: AuthTokens = {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: Date.now() + (Number.isFinite(grant.expiresIn) && grant.expiresIn > 0 ? grant.expiresIn : 3600) * 1000,
    userId: user.id,
    email,
  };
  saveAuth(tokens);
  try { cacheMembership(user.id, membership); } catch { /* A cache write cannot invalidate a completed login. */ }
  return { success: true, plan: membership.plan === "pro" ? "pro" : "free", email, userId: user.id, accessToken: grant.accessToken };
}

function parseGrant(body: unknown): SessionGrant | undefined {
  const json = record(body);
  const user = record(json.user);
  if (typeof json.access_token !== "string" || !json.access_token || typeof json.refresh_token !== "string" || !json.refresh_token) return undefined;
  if (typeof user.id !== "string" || !user.id) return undefined;
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    user: { id: user.id, email: typeof user.email === "string" ? user.email : undefined },
  };
}

/**
 * A session, a refusal to show (never retried directly: a wrong password stays wrong), or
 * undefined when the proxy gave no verdict (unreachable, absent, failing) and Supabase should be
 * asked directly.
 */
async function exchangeViaProxy(grant: Grant, signal?: AbortSignal): Promise<SessionGrant | LoginError | undefined> {
  let response: Response;
  try {
    response = await fetch(AUTH_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(grant),
      signal: bounded(signal, AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)),
    });
  } catch {
    return signal?.aborted ? new LoginError("cancelled") : undefined;
  }
  const body = await response.json().catch(() => undefined);
  if (response.ok) return parseGrant(body);
  // Older itool.tech deployments have no such route yet.
  if (response.status === 404) return undefined;
  const code = tokenErrorCode(response.status, body, grant.grant_type);
  return isDefinitiveAccountError(code) ? new LoginError(code) : undefined;
}

async function exchangeDirect(grant: Grant, signal?: AbortSignal): Promise<SessionGrant> {
  const { grant_type: type, ...fields } = grant;
  const timeout = AbortSignal.timeout(EXCHANGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${type}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify(fields),
      signal: bounded(signal, timeout),
    });
  } catch {
    throw new LoginError(signal?.aborted ? "cancelled" : timeout.aborted ? "timeout" : "network");
  }
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new LoginError(tokenErrorCode(response.status, body, type));
  const parsed = parseGrant(body);
  if (!parsed) throw new LoginError("unavailable");
  return parsed;
}

/** Proxy first, then Supabase directly, unless the proxy refused outright. */
export async function exchangeGrant(grant: Grant, signal?: AbortSignal): Promise<SessionGrant> {
  if (process.env.LINKSHELL_TOKEN_PROXY !== "off") {
    const viaProxy = await exchangeViaProxy(grant, signal);
    if (viaProxy instanceof LoginError) throw viaProxy;
    if (viaProxy) return viaProxy;
  }
  if (signal?.aborted) throw new LoginError("cancelled");
  return exchangeDirect(grant, signal);
}

export async function loginWithPassword(options: { email: string; password: string; signal?: AbortSignal }): Promise<LoginResult> {
  const email = options.email.trim();
  if (!email || !options.password) throw new LoginError("missing_credentials");
  const grant = await exchangeGrant({ grant_type: "password", email, password: options.password }, options.signal);
  return completeLogin(grant, { signal: options.signal });
}

// ── GitHub / Google: PKCE through the system browser, back to a loopback listener ───────────

/** RFC 7636 S256. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** 32 random bytes: a 43-character verifier, the RFC's recommendation. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function authorizeURL(provider: OAuthProvider, redirectTo: string, challenge: string): string {
  const query = new URLSearchParams({
    provider,
    redirect_to: redirectTo,
    code_challenge: challenge,
    code_challenge_method: "s256",
    // As the app asks: without user:email a GitHub account with a private email has none.
    ...(provider === "github" ? { scopes: "read:user user:email" } : {}),
  });
  return `${SUPABASE_URL}/auth/v1/authorize?${query}`;
}

export function openInBrowser(url: string): void {
  const [command, args] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  try { execFile(command, args, { windowsHide: true }, () => { /* The UI offers the link to copy. */ }); }
  catch { /* As above. */ }
}

type PageState = "ok" | "failed" | "empty" | "busy";

// Served by the loopback itself, so it carries its own styles and copy. It shows only an
// outcome: the code was exchanged in this process and no token ever reaches the browser.
function loopbackPage(state: PageState | "forward"): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>LinkShell</title>
<style>
  :root { color-scheme: dark; --canvas:#09090A; --surface:#111113; --border:#1E1E22; --text:#F4F4F2; --muted:#A8A8AF;
    --brand:#34D399; --brand-bg:#0E1A15; --error:#F87171; --error-bg:#2A1212; }
  @media (prefers-color-scheme: light) {
    :root { color-scheme: light; --canvas:#F2F2EF; --surface:#FFFFFF; --border:#E2E2DD; --text:#0A0A0A; --muted:#52525B;
      --brand:#047857; --brand-bg:#ECFDF5; --error:#B91C1C; --error-bg:#FEF0F0; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--canvas); color: var(--text);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 380px; padding: 36px 32px 28px; text-align: center; background: var(--surface); border-radius: 24px;
    box-shadow: inset 0 0 0 1px var(--border), 0 24px 64px -16px rgba(0,0,0,.35); }
  .icon { width: 56px; height: 56px; margin: 0 auto 22px; display: flex; align-items: center; justify-content: center; border-radius: 999px;
    background: var(--brand-bg); color: var(--brand); }
  [data-state="failed"] .icon, [data-state="empty"] .icon { background: var(--error-bg); color: var(--error); }
  .icon svg { width: 26px; height: 26px; }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -.02em; }
  p { margin: 0; color: var(--muted); }
  footer { margin-top: 28px; padding-top: 16px; font-size: 13px; color: var(--muted); box-shadow: inset 0 1px 0 var(--border); }
  .spin { animation: spin 900ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
</head>
<body>
<main id="card" data-state="${state === "forward" ? "busy" : state}" aria-live="polite">
  <div class="icon" id="icon"></div>
  <h1 id="title"></h1>
  <p id="body"></p>
  <footer>LinkShell</footer>
</main>
<script>
  var state = ${JSON.stringify(state)};
  ${state === "forward" ? `// Supabase can put an OAuth error in the fragment, which never reaches a server: pass only
  // the error fields on to the listener, nothing else the fragment might hold.
  var fragment = new URLSearchParams(location.hash.slice(1));
  var forward = new URLSearchParams();
  ["error", "error_code", "error_description"].forEach(function (key) { var value = fragment.get(key); if (value) forward.set(key, value); });
  location.replace(forward.toString() ? ${JSON.stringify(OAUTH_CALLBACK_PATH)} + "?" + forward : ${JSON.stringify(OAUTH_DONE_PATH)} + "?status=empty");
  state = "busy";` : ""}
  var zh = /^zh/i.test(navigator.language || "");
  if (!zh) document.documentElement.lang = "en";
  var copy = {
    ok: zh ? ["已完成", "可以回到 LinkShell 了。"] : ["Signed in", "You can return to LinkShell."],
    failed: zh ? ["登录未完成", "请回到 LinkShell 查看原因并重试。"] : ["Sign-in didn't finish", "Return to LinkShell to see why and try again."],
    empty: zh ? ["没有收到登录结果", "请回到 LinkShell 重新登录。"] : ["No sign-in result received", "Return to LinkShell and sign in again."],
    busy: zh ? ["正在完成登录", "请稍候。"] : ["Finishing sign-in", "One moment."]
  };
  var icons = {
    busy: '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    failed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>'
  };
  document.getElementById("icon").innerHTML = icons[state === "empty" ? "failed" : state];
  document.getElementById("title").textContent = copy[state][0];
  document.getElementById("body").textContent = copy[state][1];
  document.title = copy[state][0] + " · LinkShell";
</script>
</body>
</html>`;
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export interface OAuthLoginOptions {
  provider: OAuthProvider;
  signal?: AbortSignal;
  /** Opens the authorize URL; the system browser by default. Also how a UI learns the URL to copy. */
  open?: (url: string) => void | Promise<void>;
  timeoutMs?: number;
}

/**
 * GitHub / Google sign-in. The browser comes back to `http://127.0.0.1:<port>/linkshell/callback`
 * with a one-time code; the code is worthless without the PKCE verifier, which never leaves this
 * process, so a page or app that sees the redirect gets nothing it can use.
 */
export function loginWithOAuth(options: OAuthLoginOptions): Promise<LoginResult> {
  if (!OAUTH_PROVIDERS.includes(options.provider)) return Promise.reject(new LoginError("provider_disabled"));
  if (options.signal?.aborted) return Promise.reject(new LoginError("cancelled"));
  const { verifier, challenge } = pkcePair();

  return new Promise<LoginResult>((resolve, reject) => {
    let phase: "waiting" | "exchanging" | "done" = "waiting";
    let outcome: PageState = "busy";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let linger: ReturnType<typeof setTimeout> | undefined;
    // Ends an exchange in flight when the owner cancels.
    const stop = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;

    const close = () => {
      clearTimeout(linger);
      server.closeAllConnections();
      server.close();
    };
    const settle = (result: LoginResult | LoginError) => {
      if (phase === "done") return;
      phase = "done";
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (result instanceof LoginError) reject(result); else resolve(result);
      // The browser still follows the redirect to the outcome page; don't keep the port for long.
      linger = setTimeout(close, 2_000);
    };
    const abort = () => {
      stop.abort();
      settle(new LoginError("cancelled"));
      close();
    };
    const redirect = (response: http.ServerResponse, state: PageState) => {
      if (response.headersSent || response.destroyed) return;
      response.writeHead(302, { Location: `${OAUTH_DONE_PATH}?status=${state}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      response.end();
    };

    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET") { response.writeHead(405).end(); return; }

      if (url.pathname === OAUTH_DONE_PATH) {
        const asked = url.searchParams.get("status");
        const state: PageState = phase === "done" ? outcome : asked === "empty" ? "empty" : "busy";
        response.writeHead(200, PAGE_HEADERS);
        response.end(loopbackPage(state));
        if (phase === "done") response.once("finish", close);
        return;
      }
      if (url.pathname !== OAUTH_CALLBACK_PATH) { response.writeHead(404).end(); return; }
      // A reload or a second tab: the first callback decides.
      if (phase !== "waiting") { redirect(response, phase === "done" ? outcome : "busy"); return; }

      const error = url.searchParams.get("error");
      const errorCode = url.searchParams.get("error_code");
      if (error || errorCode) {
        outcome = "failed";
        redirect(response, "failed");
        settle(new LoginError(oauthErrorCode({ error, errorCode, description: url.searchParams.get("error_description") })));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(200, PAGE_HEADERS);
        response.end(loopbackPage("forward"));
        return;
      }
      phase = "exchanging";
      // The browser answered: the five-minute wait is over, the exchange has its own limits.
      clearTimeout(timeout);
      void exchangeGrant({ grant_type: "pkce", auth_code: code, code_verifier: verifier }, signal)
        .then((grant) => completeLogin(grant, { signal }))
        .then((result) => {
          outcome = "ok";
          redirect(response, "ok");
          settle(result);
        }, (failure: unknown) => {
          outcome = "failed";
          redirect(response, "failed");
          settle(failure instanceof LoginError ? failure : new LoginError("unknown"));
        });
    });

    server.on("error", () => { settle(new LoginError("unavailable")); close(); });
    options.signal?.addEventListener("abort", abort, { once: true });
    server.listen(0, "127.0.0.1", () => {
      if (phase === "done") return;
      const address = server.address();
      if (!address || typeof address === "string") { settle(new LoginError("unavailable")); close(); return; }
      const url = authorizeURL(options.provider, `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}`, challenge);
      timeout = setTimeout(() => { settle(new LoginError("browser_timeout")); close(); }, options.timeoutMs ?? OAUTH_TIMEOUT_MS);
      try { void Promise.resolve((options.open ?? openInBrowser)(url)).catch(() => undefined); }
      catch { /* The UI still has the link to open or copy. */ }
    });
  });
}
