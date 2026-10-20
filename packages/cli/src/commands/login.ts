import * as http from "node:http";
import { execFileSync } from "node:child_process";
import { saveAuth, SUPABASE_URL, SUPABASE_ANON_KEY } from "../auth.js";
import type { AuthTokens } from "../auth.js";
import { cacheMembership, type DesktopMembership } from "../pro-membership.js";
import { fetchProMembership } from "../../../client-core/src/pro-membership.js";

const ITOOL_AUTH_URL = "https://itool.tech/en/auth/linkshell";

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
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
<head><title>LinkShell Login</title></head>
<body>
<p>Processing login...</p>
<script>
  const hash = window.location.hash.substring(1);
  if (hash) {
    fetch('/token?' + hash, { method: 'POST' })
      .then(response => { if (!response.ok) throw new Error('Login failed'); document.body.innerHTML = '<h2>Login successful! You can close this tab.</h2>'; })
      .catch(() => { document.body.innerHTML = '<h2>Login failed. Please try again.</h2>'; });
  } else {
    // Try query params (iTool may pass tokens as query params)
    const params = window.location.search.substring(1);
    if (params) {
      fetch('/token?' + params, { method: 'POST' })
        .then(response => { if (!response.ok) throw new Error('Login failed'); document.body.innerHTML = '<h2>Login successful! You can close this tab.</h2>'; })
        .catch(() => { document.body.innerHTML = '<h2>Login failed. Please try again.</h2>'; });
    } else {
      document.body.innerHTML = '<h2>No auth data received. Please try again.</h2>';
    }
  }
</script>
</body>
</html>`);
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
