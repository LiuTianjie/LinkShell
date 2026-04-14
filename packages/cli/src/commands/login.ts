import * as http from "node:http";
import { execSync } from "node:child_process";
import { saveAuth, SUPABASE_URL, SUPABASE_ANON_KEY } from "../auth.js";
import type { AuthTokens } from "../auth.js";

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

export async function runLogin(): Promise<LoginResult | null> {
  process.stderr.write("\n  LinkShell Login\n\n");

  return new Promise<LoginResult | null>((resolve) => {
    const server = http.createServer(async (req, res) => {
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
      .then(() => { document.body.innerHTML = '<h2>Login successful! You can close this tab.</h2>'; })
      .catch(() => { document.body.innerHTML = '<h2>Login failed. Please try again.</h2>'; });
  } else {
    // Try query params (iTool may pass tokens as query params)
    const params = window.location.search.substring(1);
    if (params) {
      fetch('/token?' + params, { method: 'POST' })
        .then(() => { document.body.innerHTML = '<h2>Login successful! You can close this tab.</h2>'; })
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
        try {
          const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              apikey: SUPABASE_ANON_KEY,
            },
            signal: AbortSignal.timeout(10_000),
          });
          if (userRes.ok) {
            const user = (await userRes.json()) as {
              id: string;
              email?: string;
            };
            userId = user.id;
            email = user.email ?? "";

            // Check subscription from profiles table
            const profileRes = await fetch(
              `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan,plan_expires_at&limit=1`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  apikey: SUPABASE_ANON_KEY,
                },
                signal: AbortSignal.timeout(5_000),
              },
            );
            if (profileRes.ok) {
              const profiles = (await profileRes.json()) as {
                plan: string;
                plan_expires_at: string | null;
              }[];
              if (
                profiles.length > 0 &&
                profiles[0]!.plan === "pro" &&
                profiles[0]!.plan_expires_at &&
                new Date(profiles[0]!.plan_expires_at) > new Date()
              ) {
                plan = "pro";
              }
            }
          }
        } catch {}

        const tokens: AuthTokens = {
          accessToken,
          refreshToken,
          expiresAt: Date.now() + expiresIn * 1000,
          userId,
          email,
        };
        saveAuth(tokens);

        res.writeHead(200);
        res.end("ok");

        const planLabel = plan === "pro" ? "\x1b[32mPro\x1b[0m" : "Free";
        process.stderr.write(
          `  \x1b[32m✓\x1b[0m Logged in as ${email || userId} (${planLabel})\n\n`,
        );

        setTimeout(() => {
          server.close();
          resolve({
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

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        process.stderr.write(
          "  \x1b[31m✗\x1b[0m Failed to start local server\n\n",
        );
        resolve(null);
        return;
      }

      const port = addr.port;
      const callbackUrl = `http://localhost:${port}/callback`;
      const authUrl = `${ITOOL_AUTH_URL}?callback=${encodeURIComponent(callbackUrl)}`;

      process.stderr.write("  Opening browser for login...\n");
      process.stderr.write("  If the browser doesn't open, visit:\n");
      process.stderr.write(`  ${authUrl}\n\n`);

      try {
        const cmd =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
        execSync(`${cmd} "${authUrl}"`, { stdio: "ignore" });
      } catch {}

      // Timeout after 5 minutes
      setTimeout(() => {
        process.stderr.write("  Login timed out.\n\n");
        server.close();
        resolve(null);
      }, 5 * 60 * 1000);
    });
  });
}
