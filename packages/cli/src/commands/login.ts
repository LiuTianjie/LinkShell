import * as http from "node:http";
import { execSync } from "node:child_process";
import { saveAuth, SUPABASE_URL, SUPABASE_ANON_KEY } from "../auth.js";
import type { AuthTokens } from "../auth.js";

/**
 * CLI login via browser-based OAuth flow.
 *
 * 1. Start a temporary local HTTP server to receive the callback
 * 2. Open the Supabase Auth URL in the browser
 * 3. User logs in, Supabase redirects back to localhost with tokens
 * 4. Save tokens to ~/.linkshell/auth.json
 */
export async function runLogin(): Promise<void> {
  process.stderr.write("\n  LinkShell Login\n\n");

  return new Promise<void>((resolve) => {
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
    document.body.innerHTML = '<h2>No auth data received. Please try again.</h2>';
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

        // Fetch user info
        let userId = "";
        let email = "";
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

        process.stderr.write(`  \x1b[32m✓\x1b[0m Logged in as ${email || userId}\n\n`);

        // Close server after a short delay
        setTimeout(() => {
          server.close();
          resolve();
        }, 500);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    // Listen on a random available port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        process.stderr.write("  \x1b[31m✗\x1b[0m Failed to start local server\n\n");
        resolve();
        return;
      }

      const port = addr.port;
      const redirectUrl = `http://localhost:${port}/callback`;
      const authUrl =
        `${SUPABASE_URL}/auth/v1/authorize?provider=github` +
        `&redirect_to=${encodeURIComponent(redirectUrl)}`;

      process.stderr.write(`  Opening browser for login...\n`);
      process.stderr.write(`  If the browser doesn't open, visit:\n`);
      process.stderr.write(`  ${authUrl}\n\n`);

      // Open browser
      try {
        const cmd =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
        execSync(`${cmd} "${authUrl}"`, { stdio: "ignore" });
      } catch {
        // User will need to open manually
      }

      // Timeout after 5 minutes
      setTimeout(() => {
        process.stderr.write("  Login timed out.\n\n");
        server.close();
        resolve();
      }, 5 * 60 * 1000);
    });
  });
}
