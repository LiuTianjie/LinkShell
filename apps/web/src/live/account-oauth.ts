import type { SupabaseClient } from "@supabase/supabase-js";

const CALLBACK_PARAM = "linkshell-auth-callback";
const POPUP_REQUEST_KEY = "linkshell.web.oauth.popup.v1";
const LOGIN_TIMEOUT = 5 * 60_000;
type OAuthResult = { type: "result"; code?: string; error?: string };

function callbackURL() {
  const url = new URL(window.location.origin);
  // Reuse the project's existing loopback allowlist for local browser verification.
  if (url.hostname === "127.0.0.1") url.pathname = "/linkshell/callback";
  else url.searchParams.set(CALLBACK_PARAM, "1");
  return url.href;
}

function panel(target: Window, message: string) {
  target.document.title = "LinkShell 登录";
  const main = target.document.createElement("main");
  main.style.cssText = "max-width:400px;margin:18vh auto;padding:32px;font:15px system-ui;line-height:1.65";
  const title = target.document.createElement("h1");
  title.textContent = "LinkShell 登录";
  const text = target.document.createElement("p");
  text.textContent = message;
  const close = target.document.createElement("button");
  close.textContent = "关闭窗口";
  close.style.cssText = "padding:8px 18px;border-radius:9px;cursor:pointer";
  close.onclick = () => target.close();
  main.append(title, text, close);
  target.document.body.replaceChildren(main);
}

/** Call inside the click handler, before awaiting any connection or authentication work. */
export async function signInWithAccountOAuth(
  auth: SupabaseClient["auth"],
  provider: "github" | "google",
  options: { signal: AbortSignal; onExchanging?: () => void },
): Promise<void> {
  if (options.signal.aborted) throw new Error("已取消登录");
  if (typeof BroadcastChannel === "undefined")
    throw new Error("此浏览器不支持登录窗口，请升级浏览器或使用邮箱登录。");
  const popup = window.open("about:blank", "_blank", "popup,width=520,height=720");
  if (!popup) throw new Error("登录窗口被浏览器拦截，请允许弹出窗口后重试。");
  const requestId = crypto.randomUUID();
  let channel: BroadcastChannel;
  try {
    // This storage belongs to the popup's origin and survives the provider round trip.
    // The URL stays fixed so production can allow precisely one callback, without wildcards.
    popup.sessionStorage.setItem(POPUP_REQUEST_KEY, requestId);
    popup.opener = null;
    panel(popup, `正在打开 ${provider === "google" ? "Google" : "GitHub"} 登录…`);
    channel = new BroadcastChannel(`linkshell.oauth.${requestId}`);
  } catch (error) {
    popup.close();
    throw error;
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let exchanging = false;
    let flowId: string | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", cancel);
      channel.close();
      popup.close();
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => {
      // Supabase's code exchange persists the session; it cannot be undone by aborting UI work.
      if (!exchanging) finish(new Error("已取消登录"));
    };
    const timeout = setTimeout(() => finish(new Error("等待登录超时，请重试。")), LOGIN_TIMEOUT);
    // COOP can make a live provider popup report closed. Only cancellation, a callback or
    // the deadline ends the wait; BroadcastChannel still works after that isolation change.
    options.signal.addEventListener("abort", cancel, { once: true });
    channel.onmessage = (event: MessageEvent<OAuthResult>) => {
      const result = event.data;
      if (settled || exchanging || !result || result.type !== "result") return;
      // BroadcastChannel is same-origin; a random, per-popup channel binds the result to this
      // attempt even when the provider's isolation policy has removed window.opener.
      if (typeof result.error === "string") {
        channel.postMessage({ type: "received" });
        finish(new Error(result.error));
        return;
      }
      if (typeof result.code !== "string" || !result.code || !flowId) return;
      exchanging = true;
      clearTimeout(timeout);
      channel.postMessage({ type: "received" });
      options.onExchanging?.();
      void auth.exchangeCodeForSession(result.code, { flowId }).then(({ data, error }) => {
        if (error) finish(error);
        else if (!data.session) finish(new Error("登录未完成，请重试。"));
        else finish();
      }, finish);
    };
    void auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: callbackURL(),
        skipBrowserRedirect: true,
      },
    }).then(({ data, error }) => {
      if (settled) return;
      if (error) { finish(error); return; }
      if (!data.url) { finish(new Error("无法打开登录页面，请重试。")); return; }
      if (!data.flowId) { finish(new Error("无法验证登录请求，请重试。")); return; }
      flowId = data.flowId;
      popup.location.replace(data.url);
    }).catch(finish);
  });
}

/** Run before the workspace boots: the popup must never claim its connection or exchange PKCE. */
export function handleAccountOAuthCallback(): boolean {
  const url = new URL(window.location.href);
  const officialCallback = url.pathname === "/" && url.searchParams.get(CALLBACK_PARAM) === "1";
  const localCallback = url.hostname === "127.0.0.1" && url.pathname === "/linkshell/callback";
  if (!officialCallback && !localCallback) return false;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error") ?? fragment.get("error");
  // No authorization code or provider error remains in the address bar or referrer.
  window.history.replaceState(null, "", "/");
  const requestId = window.sessionStorage.getItem(POPUP_REQUEST_KEY);
  window.sessionStorage.removeItem(POPUP_REQUEST_KEY);
  if (!requestId || !/^[0-9a-f-]{36}$/.test(requestId) || typeof BroadcastChannel === "undefined") {
    panel(window, "登录请求已失效，请关闭此窗口，返回工作台重试。");
    return true;
  }
  const channel = new BroadcastChannel(`linkshell.oauth.${requestId}`);
  panel(window, "正在返回工作台…");
  const timeout = setTimeout(() => {
    channel.close();
    panel(window, "工作台未响应，请关闭此窗口，返回工作台重新登录。");
  }, 10_000);
  channel.onmessage = (event: MessageEvent) => {
    if (event.data?.type !== "received") return;
    clearTimeout(timeout);
    channel.close();
    panel(window, "已返回工作台，可以关闭此窗口。");
    window.close();
  };
  const result: OAuthResult = error
    ? { type: "result", error: error === "access_denied" ? "登录已取消，请重试。" : "登录未完成，请重试。" }
    : code ? { type: "result", code } : { type: "result", error: "登录回调不完整，请重试。" };
  channel.postMessage(result);
  return true;
}
