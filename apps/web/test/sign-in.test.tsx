import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCompositionEnter, SignIn, signInProblem, type SignInProps } from "../src/live/SignIn";

const noop = () => {};
const render = (props: Partial<SignInProps> = {}) =>
  renderToStaticMarkup(createElement(SignIn, { onPassword: noop, onProvider: noop, onBrowser: noop, onCancel: noop, ...props }));

describe("desktop sign-in panel", () => {
  it("offers GitHub, Google, email and password, and the ways that stay on the web", () => {
    const markup = render();
    expect(markup).toContain("使用 GitHub 继续");
    expect(markup).toContain("使用 Google 继续");
    // HTML attribute names are case-insensitive; React's server markup keeps the prop's case.
    expect(markup).toMatch(/type="email"[^>]*autocomplete="username"/i);
    expect(markup).toMatch(/type="password"[^>]*autocomplete="current-password"/i);
    expect(markup).toContain('type="submit"');
    expect(markup).toContain('href="https://itool.tech/zh/forgot-password"');
    expect(markup).toContain('href="https://itool.tech/zh/register"');
    expect(markup).toContain("在浏览器中授权");
    // The marks are drawn inline, in the text's colour.
    expect(markup.match(/<svg[^>]*fill="currentColor"/g)).toHaveLength(2);
  });

  it("shows a refusal under the form and keeps the form", () => {
    const markup = render({ error: "邮箱或密码不正确。" });
    expect(markup).toMatch(/role="alert"[^>]*>邮箱或密码不正确。/);
    expect(markup).toContain('aria-describedby="');
  });

  it("disables everything while a password sign-in runs, and says so on its button", () => {
    const markup = render({ pending: "password" });
    expect(markup).toContain("正在登录…");
    expect(markup).toContain('aria-busy="true"');
    expect(markup.match(/disabled=""/g)!.length).toBeGreaterThanOrEqual(6);
  });

  it("waits on the browser with the provider's name, and a way to reopen, copy and cancel", () => {
    const waiting = render({ pending: "github", link: "https://example.supabase.co/auth/v1/authorize?provider=github" });
    expect(waiting).toContain("请在浏览器中完成 GitHub 登录");
    expect(waiting).toContain("重新打开浏览器");
    expect(waiting).toContain("复制链接");
    expect(waiting).toContain("取消");
    expect(waiting).not.toContain("使用 GitHub 继续");
    // Until the computer listens, there is nothing to reopen or copy yet.
    const early = render({ pending: "google" });
    expect(early).toContain("请在浏览器中完成 Google 登录");
    expect(early.match(/disabled=""/g)).toHaveLength(2);
    const web = render({ pending: "web" });
    expect(web).toContain("请在浏览器中完成授权");
    expect(web).not.toContain("复制链接");
  });

  it("asks for what is missing before asking the account service", () => {
    expect(signInProblem("", "pw")).toEqual({ field: "email", message: "请输入邮箱。" });
    expect(signInProblem("me", "pw")).toEqual({ field: "email", message: "邮箱格式不正确。" });
    expect(signInProblem(" me@example.com ", "")).toEqual({ field: "password", message: "请输入密码。" });
    expect(signInProblem(" me@example.com ", "pw")).toBeUndefined();
  });

  it("doesn't submit on the Enter that confirms an input method's candidate", () => {
    expect(isCompositionEnter({ key: "Enter", isComposing: true })).toBe(true);
    expect(isCompositionEnter({ key: "Enter", isComposing: false, keyCode: 229 })).toBe(true);
    expect(isCompositionEnter({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(false);
    expect(isCompositionEnter({ key: "a", isComposing: true })).toBe(false);
  });
});

describe("the workspace service's sign-in requests", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  async function desktop() {
    // desktop.ts decides whether it runs in the desktop as it loads.
    vi.resetModules();
    const location = { hash: "#desktop=capability-value", pathname: "/", search: "", origin: "http://127.0.0.1:41414", protocol: "http:" };
    vi.stubGlobal("window", Object.assign(new EventTarget(), { __LINKSHELL_CONFIG__: { desktop: true } }));
    vi.stubGlobal("document", Object.assign(new EventTarget(), { documentElement: { dataset: {} } }));
    vi.stubGlobal("location", location);
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
    const requests: { path: string; method: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", async (path: string, init: RequestInit = {}) => {
      requests.push({ path, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
      const value = path === "/desktop/bootstrap" ? { identity: {}, storage: {} }
        : path === "/desktop/login" && (init.method ?? "GET") === "GET" ? { pending: { method: "github", url: "https://example.supabase.co/auth/v1/authorize" } }
        : path === "/desktop/account" ? { userId: "u1" } : {};
      return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    });
    const module = await import("../src/live/desktop");
    await module.bootstrapDesktop();
    requests.length = 0;
    return { module, requests };
  }

  it("names the way to sign in, reads the link it waits on, and cancels with DELETE", async () => {
    const { module, requests } = await desktop();
    await module.desktopLogin({ method: "password", email: "me@example.com", password: "pw" });
    await module.desktopLogin();
    expect(await module.desktopLoginState()).toEqual({ method: "github", url: "https://example.supabase.co/auth/v1/authorize" });
    await module.cancelDesktopLogin();
    expect(requests.filter(({ path }) => path === "/desktop/login")).toEqual([
      { path: "/desktop/login", method: "POST", body: { method: "password", email: "me@example.com", password: "pw" } },
      { path: "/desktop/login", method: "POST", body: { method: "web" } },
      { path: "/desktop/login", method: "GET", body: undefined },
      { path: "/desktop/login", method: "DELETE", body: undefined },
    ]);
  });
});
