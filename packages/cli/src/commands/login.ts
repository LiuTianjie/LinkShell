import * as http from "node:http";
import { execFileSync } from "node:child_process";
import { saveAuth, SUPABASE_URL, SUPABASE_ANON_KEY } from "../auth.js";
import type { AuthTokens } from "../auth.js";
import { cacheMembership, type DesktopMembership } from "../pro-membership.js";
import { fetchProMembership } from "../../../client-core/src/pro-membership.js";

const ITOOL_AUTH_URL = "https://itool.tech/en/auth/linkshell";

// Served from the CLI's loopback server, so it has to carry its own styles and
// copy: it can't load anything from itool.tech.
const CALLBACK_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LinkShell</title>
<style>
  :root { color-scheme: dark; --canvas:#09090A; --surface:#111113; --border:#1E1E22; --text:#F4F4F2; --muted:#A8A8AF; --dots:rgba(244,244,242,.12);
    --brand:#34D399; --brand-bg:#0E1A15; --error:#F87171; --error-bg:#2A1212; }
  @media (prefers-color-scheme: light) {
    :root { color-scheme: light; --canvas:#F2F2EF; --surface:#FFFFFF; --border:#E2E2DD; --text:#0A0A0A; --muted:#52525B; --dots:rgba(10,10,10,.1);
      --brand:#047857; --brand-bg:#ECFDF5; --error:#B91C1C; --error-bg:#FEF0F0; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--canvas); color: var(--text);
    background-image: radial-gradient(var(--dots) 1.6px, transparent 1.6px); background-size: 24px 24px;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 380px; padding: 36px 32px 28px; text-align: center; background: var(--surface); border-radius: 24px;
    box-shadow: inset 0 0 0 1px var(--border), 0 24px 64px -16px rgba(0,0,0,.35); }
  .icon { width: 56px; height: 56px; margin: 0 auto 22px; display: flex; align-items: center; justify-content: center; border-radius: 999px;
    background: var(--brand-bg); color: var(--brand); }
  [data-state="error"] .icon { background: var(--error-bg); color: var(--error); }
  .icon svg { width: 26px; height: 26px; }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -.02em; }
  p { margin: 0; color: var(--muted); }
  code { padding: 2px 6px; border-radius: 6px; font: 13px ui-monospace, "SF Mono", Menlo, monospace; color: var(--text); box-shadow: inset 0 0 0 1px var(--border); }
  footer { margin-top: 28px; padding-top: 16px; font-size: 13px; color: var(--muted); box-shadow: inset 0 1px 0 var(--border); }
  .spin { animation: spin 900ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
</head>
<body>
<main id="card" data-state="busy" aria-live="polite">
  <div class="icon" id="icon"></div>
  <h1 id="title"></h1>
  <p id="body"></p>
  <footer>LinkShell</footer>
</main>
<script>
  var zh = /^zh/i.test(navigator.language || '');
  document.documentElement.lang = zh ? 'zh-CN' : 'en';
  var retry = zh ? '请回到终端重新运行 <code>linkshell login</code>。' : 'Run <code>linkshell login</code> again in your terminal.';
  var copy = {
    busy: zh ? ['正在完成登录', '正在把账号交给 LinkShell，请稍候。'] : ['Finishing sign-in', 'Handing your account to LinkShell.'],
    done: zh ? ['登录成功', '可以关闭这个标签页，回到终端继续。'] : ['Signed in', 'You can close this tab and return to your terminal.'],
    error: zh ? ['登录失败', retry] : ['Sign-in failed', retry],
    empty: zh ? ['没有收到登录信息', retry] : ['No sign-in details received', retry]
  };
  var icons = {
    busy: '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>',
    done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>'
  };
  function show(state) {
    var card = document.getElementById('card');
    card.setAttribute('data-state', state === 'empty' ? 'error' : state);
    document.getElementById('icon').innerHTML = icons[state === 'empty' ? 'error' : state];
    document.getElementById('title').textContent = copy[state][0];
    document.getElementById('body').innerHTML = copy[state][1];
    document.title = copy[state][0] + ' · LinkShell';
  }
  // The result is shown on iTool so it follows the site's design; this card
  // stays as the fallback if itool.tech can't be reached.
  function finish(state) {
    show(state);
    var status = state === 'done' ? 'ok' : state === 'empty' ? 'empty' : 'failed';
    window.location.replace('https://itool.tech/' + (zh ? 'zh' : 'en') + '/auth/linkshell/done?status=' + status);
  }
  show('busy');
  // iTool returns the tokens in the fragment; older redirects used the query string.
  var data = window.location.hash.substring(1) || window.location.search.substring(1);
  // Drop the tokens from the address bar and history before leaving the page.
  history.replaceState(null, '', '/callback');
  if (data) {
    fetch('/token?' + data, { method: 'POST' })
      .then(function (response) { if (!response.ok) throw new Error('failed'); finish('done'); })
      .catch(function () { finish('error'); });
  } else {
    finish('empty');
  }
</script>
</body>
</html>`;

/**
 * CLI login via iTool OAuth flow.
 *
 * 1. Start a temporary local HTTP server to receive the callback
 * 2. Open browser to iTool's LinkShell auth page
 * 3. User logs in/registers on iTool
 * 4. iTool redirects back to localhost with Supabase tokens
 * 5. Save tokens to ~/.linkshell/auth.json
 */
export interface LoginResult {
  success: boolean;
  plan: "pro" | "free";
  email: string;
  userId: string;
  accessToken: string;
}

export async function runLogin(options: { signal?: AbortSignal } = {}): Promise<LoginResult | null> {
  if (options.signal?.aborted) return null;
  process.stderr.write("\n  LinkShell Login\n\n");

  return new Promise<LoginResult | null>((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let completion: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (result: LoginResult | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(completion);
      options.signal?.removeEventListener("abort", abort);
      server.closeAllConnections();
      server.close();
      resolve(result);
    };
    const abort = () => finish(null);
    const server = http.createServer(async (req, res) => {
      if (finished) { res.destroy(); return; }
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/callback") {
        // Serve a page that extracts the hash fragment and sends it back
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(CALLBACK_PAGE);
        return;
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const accessToken = url.searchParams.get("access_token");
        const refreshToken = url.searchParams.get("refresh_token");
        const expiresIn = Number(url.searchParams.get("expires_in") ?? "3600");

        if (!accessToken || !refreshToken) {
          res.writeHead(400);
          res.end("Missing tokens");
          return;
        }

        // Fetch user info + plan
        let userId = "";
        let email = "";
        let plan = "free";
        let membership: DesktopMembership = { plan: "unknown", planExpiresAt: null };
        try {
          const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              apikey: SUPABASE_ANON_KEY,
            },
            signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
          });
          if (userRes.ok) {
            const user = (await userRes.json()) as {
              id: string;
              email?: string;
            };
            userId = user.id;
            email = user.email ?? "";

            const profile = await fetchProMembership({ userId, accessToken, supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, signal: options.signal });
            plan = profile.plan;
            membership = { plan: profile.plan, planExpiresAt: profile.expiresAt ?? null };
          }
        } catch {}

        if (finished || options.signal?.aborted) { res.destroy(); return; }

        if (!userId) {
          res.writeHead(401);
          res.end("无法验证账号，请重新登录。");
          return;
        }

        const tokens: AuthTokens = {
          accessToken,
          refreshToken,
          expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
          userId,
          email,
        };
        saveAuth(tokens);
        try { cacheMembership(userId, membership); } catch { /* A cache write cannot invalidate a completed login. */ }

        res.writeHead(200);
        res.end("ok");

        const planLabel = plan === "pro" ? "\x1b[32mPro\x1b[0m" : "Free";
        process.stderr.write(
          `  \x1b[32m✓\x1b[0m Logged in as ${email || userId} (${planLabel})\n\n`,
        );

        // Left pending, the five-minute limit would keep the command alive long after the login.
        clearTimeout(timeout);
        completion = setTimeout(() => {
          finish({
            success: true,
            plan: plan as "pro" | "free",
            email,
            userId,
            accessToken,
          });
        }, 500);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.on("error", () => finish(null));
    options.signal?.addEventListener("abort", abort, { once: true });

    server.listen(0, "127.0.0.1", () => {
      if (finished) return;
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        process.stderr.write(
          "  \x1b[31m✗\x1b[0m Failed to start local server\n\n",
        );
        finish(null);
        return;
      }

      const port = addr.port;
      const callbackUrl = `http://localhost:${port}/callback`;
      const authUrl = `${ITOOL_AUTH_URL}?callback=${encodeURIComponent(callbackUrl)}`;

      process.stderr.write("  Opening browser for login...\n");
      process.stderr.write("  If the browser doesn't open, visit:\n");
      process.stderr.write(`  ${authUrl}\n\n`);

      try {
        if (process.platform === "win32") execFileSync("rundll32.exe", ["url.dll,FileProtocolHandler", authUrl], { windowsHide: true, stdio: "ignore" });
        else execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [authUrl], { stdio: "ignore" });
      } catch {}

      // Timeout after 5 minutes
      timeout = setTimeout(() => {
        process.stderr.write("  Login timed out.\n\n");
        finish(null);
      }, 5 * 60 * 1000);
    });
  });
}
