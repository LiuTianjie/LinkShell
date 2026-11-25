import * as http from "node:http";
import * as readline from "node:readline";
import { spawn } from "node:child_process";
import {
  createStyle,
  formatSshTunnelHint,
  isHeadlessSession,
  isSshSession,
  readHidden,
  readPromptLine,
  type TtyReadable,
} from "../utils/format.js";
import { completeLogin, loginWithPassword, type LoginResult } from "./sign-in.js";

export type { LoginResult } from "./sign-in.js";

const ITOOL_AUTH_URL = "https://itool.tech/en/auth/linkshell";

export interface RunLoginOptions {
  signal?: AbortSignal;
  /** Sign in with email and password instead of a browser. Pass `true` to prompt interactively. */
  email?: string | boolean;
  /** Read password from stdin without prompting (for scripts/SSH). */
  passwordStdin?: boolean;
  /** Print the sign-in URL without attempting to launch a local browser. */
  noBrowser?: boolean;
  /** Injectable runtime hooks for testing. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  stdin?: TtyReadable;
  stderr?: NodeJS.WritableStream & { isTTY?: boolean };
  readLine?: (prompt: string) => Promise<string | null>;
  readPassword?: (prompt: string) => Promise<string | null>;
}

export type ParsedCallbackInput =
  | { kind: "tokens"; accessToken: string; refreshToken: string; expiresIn: number }
  | { kind: "code"; code: string }
  | { kind: "error"; message: string };

/**
 * Parses a pasted callback URL (fragment or query string) from an SSH/headless browser login.
 * Supports full URLs (`http://127.0.0.1:<port>/callback#access_token=...`) and raw param strings.
 */
export function parseCallbackInput(raw: string): ParsedCallbackInput | null {
  let trimmed = raw.trim();
  if (!trimmed) return null;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed) return null;

  const paramSources: URLSearchParams[] = [];
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.hash.length > 1) paramSources.push(new URLSearchParams(parsed.hash.slice(1)));
      if (parsed.search.length > 1) paramSources.push(new URLSearchParams(parsed.search.slice(1)));
    } catch {
      return null;
    }
  } else {
    const hashIdx = trimmed.indexOf("#");
    const queryIdx = trimmed.indexOf("?");
    if (hashIdx >= 0) paramSources.push(new URLSearchParams(trimmed.slice(hashIdx + 1)));
    if (queryIdx >= 0) {
      const end = hashIdx > queryIdx ? hashIdx : trimmed.length;
      paramSources.push(new URLSearchParams(trimmed.slice(queryIdx + 1, end)));
    }
    if (paramSources.length === 0 && trimmed.includes("=")) {
      paramSources.push(new URLSearchParams(trimmed));
    }
  }

  for (const params of paramSources) {
    const error = params.get("error_description") || params.get("error");
    if (error) return { kind: "error", message: error };
    const accessToken = params.get("access_token")?.trim();
    const refreshToken = params.get("refresh_token")?.trim();
    if (accessToken && refreshToken) {
      const parsedExp = Number(params.get("expires_in") ?? "3600");
      return {
        kind: "tokens",
        accessToken,
        refreshToken,
        expiresIn: Number.isFinite(parsedExp) && parsedExp > 0 ? parsedExp : 3600,
      };
    }
    const code = params.get("code")?.trim();
    if (code) return { kind: "code", code };
  }

  return null;
}

/** Launches the system browser without blocking the CLI event loop (never uses execFileSync). */
export function openBrowserNonBlocking(url: string, platform: NodeJS.Platform = process.platform): void {
  const [command, args] =
    platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : [platform === "darwin" ? "open" : "xdg-open", [url]];
  try {
    const child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.on?.("error", () => {});
    child.unref?.();
  } catch {
    // URL is already printed so the user can open it manually.
  }
}

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

async function runPasswordLogin(options: RunLoginOptions): Promise<LoginResult | null> {
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? (process.stdin as TtyReadable);
  const stderr = options.stderr ?? process.stderr;
  const style = createStyle(stderr, env);

  const askLine =
    options.readLine ??
    ((prompt: string) => readPromptLine(prompt, { stdin, output: stderr }));
  const askPassword =
    options.readPassword ??
    (async (prompt: string) => {
      try {
        return await readHidden(prompt, { stdin, output: stderr });
      } catch {
        return null;
      }
    });

  let email = typeof options.email === "string" ? options.email.trim() : "";
  if (!email) {
    if (options.passwordStdin && !stdin.isTTY && !options.readLine) {
      stderr.write(`  ${style.red("✗")} --password-stdin requires --email <address> when stdin is not interactive.\n\n`);
      return null;
    }
    const entered = await askLine("  Email: ");
    if (!entered) {
      stderr.write("  Login cancelled.\n\n");
      return null;
    }
    email = entered.trim();
  }

  let password: string | null;
  if (options.passwordStdin) {
    password = await readHidden("", { stdin, output: stderr });
  } else {
    password = await askPassword("  Password: ");
  }
  if (!password) {
    stderr.write("  Login cancelled.\n\n");
    return null;
  }

  try {
    const result = await loginWithPassword({ email, password, signal: options.signal });
    const planLabel = result.plan === "pro" ? style.green("LinkShell member") : "Free";
    stderr.write(`  ${style.green("✓")} Logged in as ${result.email || result.userId} (${planLabel})\n\n`);
    return result;
  } catch (error) {
    stderr.write(`  ${style.red("✗")} ${error instanceof Error ? error.message : String(error)}\n\n`);
    return null;
  }
}

/**
 * CLI login via email/password (ideal for headless Linux & SSH) or iTool OAuth flow.
 *
 * 1. When `--email` / `--password-stdin` is passed (or chosen interactively in a headless/SSH session),
 *    signs in directly with `loginWithPassword()` without needing any browser.
 * 2. Otherwise starts a temporary `127.0.0.1` loopback HTTP server, launches a non-blocking browser
 *    when local GUI is available, and on SSH/headless sessions prints an SSH port-forward command
 *    while concurrently accepting a pasted callback URL in the terminal.
 */
export async function runLogin(options: RunLoginOptions = {}): Promise<LoginResult | null> {
  if (options.signal?.aborted) return null;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const stdin = options.stdin ?? (process.stdin as TtyReadable);
  const stderr = options.stderr ?? process.stderr;
  const style = createStyle(stderr, env);

  stderr.write("\n  LinkShell Login\n");
  stderr.write(`  ${style.dim("Sign in with your iTool account to use the official gateway.")}\n\n`);

  if (options.email !== undefined || options.passwordStdin) {
    return runPasswordLogin(options);
  }

  const headless = isHeadlessSession(env, platform);
  if (headless && !options.noBrowser && stdin.isTTY === true) {
    const askLine =
      options.readLine ??
      ((prompt: string) => readPromptLine(prompt, { stdin, output: stderr }));
    stderr.write("  Headless/SSH session detected (no local browser available).\n");
    stderr.write("    1) Email & password (works directly over SSH)\n");
    stderr.write("    2) Browser link (SSH port forward or paste callback URL)\n");
    const choice = await askLine("  Choose sign-in method [1/2] (default 1): ");
    if (choice === null) {
      stderr.write("  Login cancelled.\n\n");
      return null;
    }
    if (choice === "" || choice === "1" || choice.toLowerCase().startsWith("e")) {
      return runPasswordLogin(options);
    }
    stderr.write("\n");
  }

  return new Promise<LoginResult | null>((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let completion: ReturnType<typeof setTimeout> | undefined;
    let rl: readline.Interface | undefined;
    let finished = false;
    let completing = false;
    // Ends an account check still in flight, so a login that timed out or was cancelled never saves.
    const stopped = new AbortController();
    const finish = (result: LoginResult | null) => {
      if (finished) return;
      finished = true;
      stopped.abort();
      clearTimeout(timeout);
      clearTimeout(completion);
      options.signal?.removeEventListener("abort", abort);
      try { rl?.close(); } catch {}
      rl = undefined;
      server.closeAllConnections();
      server.close();
      resolve(result);
    };
    const abort = () => finish(null);

    const announceSuccess = (result: LoginResult) => {
      const planLabel = result.plan === "pro" ? style.green("LinkShell member") : "Free";
      stderr.write(`  ${style.green("✓")} Logged in as ${result.email || result.userId} (${planLabel})\n\n`);
    };

    const server = http.createServer(async (req, res) => {
      if (finished) { res.destroy(); return; }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

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
        if (completing) {
          res.writeHead(409);
          res.end("Login already in progress");
          return;
        }
        completing = true;

        let result: LoginResult;
        try {
          result = await completeLogin({ accessToken, refreshToken, expiresIn }, { signal: stopped.signal });
        } catch {
          completing = false;
          if (finished || options.signal?.aborted) { res.destroy(); return; }
          res.writeHead(401);
          res.end("无法验证账号，请重新登录。");
          return;
        }

        res.writeHead(200);
        res.end("ok");
        announceSuccess(result);

        // Left pending, the five-minute limit would keep the command alive long after the login.
        clearTimeout(timeout);
        completion = setTimeout(() => finish(result), 500);
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
        stderr.write(`  ${style.red("✗")} Failed to start local server\n\n`);
        finish(null);
        return;
      }

      const port = addr.port;
      // RFC 8252 §7.3: use IPv4 literal 127.0.0.1 so Linux IPv6 localhost (::1) never mismatches.
      const callbackUrl = `http://127.0.0.1:${port}/callback`;
      const authUrl = `${ITOOL_AUTH_URL}?callback=${encodeURIComponent(callbackUrl)}`;

      if (!options.noBrowser && !headless) {
        stderr.write("  Opening browser for login...\n");
        stderr.write("  If the browser doesn't open, visit:\n");
        stderr.write(`  ${authUrl}\n\n`);
        openBrowserNonBlocking(authUrl, platform);
      } else {
        stderr.write("  Open this URL in any browser to sign in:\n");
        stderr.write(`  ${authUrl}\n\n`);
        if (isSshSession(env)) {
          stderr.write("  Over SSH, forward the callback port from your local machine:\n");
          stderr.write(`    ${formatSshTunnelHint(port, env)}\n\n`);
        }
        stderr.write(`  ${style.dim("Tip: you can also sign in directly without a browser using `linkshell login --email`.")}\n\n`);
      }

      // When interactive, also let the user paste the redirected callback URL directly into the terminal.
      if (stdin.isTTY === true || options.stdin !== undefined) {
        stderr.write(`  ${style.dim("Or paste the redirected callback URL here (Ctrl-C to cancel):")}\n`);
        rl = readline.createInterface({ input: stdin, output: stderr, terminal: stdin.isTTY === true });
        rl.on("SIGINT", () => {
          stderr.write("\n  Login cancelled.\n\n");
          finish(null);
        });
        rl.on("line", (line) => {
          if (finished || completing) return;
          const trimmed = line.trim();
          if (!trimmed) return;
          const parsed = parseCallbackInput(trimmed);
          if (!parsed) {
            stderr.write(`  ${style.yellow("!")} Could not find sign-in tokens in that input. Paste the full redirected callback URL, or press Ctrl-C to cancel.\n`);
            return;
          }
          if (parsed.kind === "error") {
            stderr.write(`  ${style.red("✗")} Sign-in error: ${parsed.message}\n`);
            return;
          }
          if (parsed.kind === "code") {
            stderr.write(
              `  ${style.yellow("!")} Received an authorization code without tokens. Complete the redirect through an SSH tunnel, or sign in with \`linkshell login --email\`.\n`,
            );
            return;
          }
          completing = true;
          void completeLogin(
            { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresIn: parsed.expiresIn },
            { signal: stopped.signal },
          ).then(
            (result) => {
              announceSuccess(result);
              finish(result);
            },
            (error: unknown) => {
              completing = false;
              if (finished) return;
              stderr.write(`  ${style.red("✗")} Could not verify pasted credentials: ${error instanceof Error ? error.message : String(error)}\n`);
            },
          );
        });
      }

      // Timeout after 5 minutes
      timeout = setTimeout(() => {
        stderr.write("  Login timed out.\n\n");
        finish(null);
      }, 5 * 60 * 1000);
    });
  });
}
