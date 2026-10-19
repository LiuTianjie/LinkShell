import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identity = { id: "desktop-device", signKey: "public-sign", boxKey: "public-box", signSecret: "private-sign", boxSecret: "private-box" };
const account = { userId: "account-a", email: "person@example.com", accessToken: "short-lived" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function environment(hash = "#desktop=capability-value&view=screen") {
  const storage = new Map<string, string>();
  const target = new EventTarget();
  const document = Object.assign(new EventTarget(), { documentElement: { dataset: {} } });
  const location = { hash, pathname: "/", search: "", origin: "http://127.0.0.1:41414", protocol: "http:" };
  const replaceState = vi.fn((_state, _unused, value: string) => { location.hash = value.includes("#") ? value.slice(value.indexOf("#")) : ""; });
  vi.stubGlobal("window", Object.assign(target, { __LINKSHELL_CONFIG__: { desktop: true } }));
  vi.stubGlobal("document", document);
  vi.stubGlobal("location", location);
  vi.stubGlobal("history", { replaceState });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  return { storage, document, target, replaceState };
}

beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("native workspace bootstrap", () => {
  it("removes the launch capability while retaining navigation and keeps the native identity across reloads", async () => {
    const env = environment();
    const fetch = vi.fn().mockResolvedValue(json({ identity, storage: { theme: "dark", selected: "desktop:local" } }));
    vi.stubGlobal("fetch", fetch);
    let desktop = await import("../src/live/desktop");
    await desktop.bootstrapDesktop();
    expect(env.replaceState).toHaveBeenCalledWith(null, "", "/#view=screen");
    expect(desktop.desktopIdentity()).toEqual(identity);
    expect(desktop.readDesktopStorage("theme", "light")).toBe("dark");
    expect((env.document.documentElement.dataset as { desktop?: string }).desktop).toBe("true");
    expect(new Headers(fetch.mock.calls[0][1].headers).get("authorization")).toBe("Bearer capability-value");
    vi.resetModules();
    fetch.mockResolvedValue(json({ identity, storage: { theme: "dark" } }));
    desktop = await import("../src/live/desktop");
    await desktop.bootstrapDesktop();
    expect(desktop.desktopIdentity()).toEqual(identity);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed without a native capability and never permits arbitrary fetch targets", async () => {
    environment("");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const desktop = await import("../src/live/desktop");
    await expect(desktop.bootstrapDesktop()).rejects.toThrow("尚未连接");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("only attaches authorization to its own fixed desktop paths", async () => {
    environment();
    const fetch = vi.fn().mockResolvedValue(json({ identity, storage: {} }));
    vi.stubGlobal("fetch", fetch);
    const desktop = await import("../src/live/desktop");
    await desktop.bootstrapDesktop();
    await expect(desktop.desktopRequest("https://evil.example/desktop/account")).rejects.toThrow("无效");
    await expect(desktop.desktopRequest("/desktop/../account")).rejects.toThrow("无效");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps synchronous reads current, serializes writes, and retries a visible persistence failure", async () => {
    const env = environment();
    let firstWrite: ((value: Response) => void) | undefined;
    const writes: unknown[] = [];
    let fail = false;
    const fetch = vi.fn((path: string, options?: RequestInit) => {
      if (path === "/desktop/bootstrap") return Promise.resolve(json({ identity, storage: {} }));
      writes.push(JSON.parse(options?.body as string));
      if (!firstWrite) return new Promise<Response>((resolve) => { firstWrite = resolve; });
      return Promise.resolve(fail ? json({ error: "磁盘暂不可写" }, 500) : json({ ok: true }));
    });
    vi.stubGlobal("fetch", fetch);
    const desktop = await import("../src/live/desktop");
    await desktop.bootstrapDesktop();
    const errors: string[] = [];
    env.target.addEventListener(desktop.DESKTOP_ERROR_EVENT, (event) => errors.push((event as CustomEvent<string>).detail));
    desktop.saveDesktopStorage("draft", "first");
    desktop.saveDesktopStorage("draft", "second");
    expect(desktop.readDesktopStorage("draft", "")).toBe("second");
    await vi.waitFor(() => expect(writes).toEqual([{ key: "draft", value: "first" }]));
    fail = true;
    firstWrite!(json({ ok: true }));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toContain("尚未保存");
    fail = false;
    await desktop.retryDesktopStorage();
    expect(writes).toEqual([{ key: "draft", value: "first" }, { key: "draft", value: "second" }, { key: "draft", value: "second" }]);
    expect(desktop.readDesktopStorage("draft", "")).toBe("second");
  });

  it("does not restore an account from an in-flight read after native sign-out", async () => {
    const env = environment();
    let finishRead!: (value: Response) => void;
    const fetch = vi.fn((path: string) => {
      if (path === "/desktop/bootstrap") return Promise.resolve(json({ identity, storage: {} }));
      if (path === "/desktop/account") return new Promise<Response>((resolve) => { finishRead = resolve; });
      return Promise.resolve(json({ ok: true }));
    });
    vi.stubGlobal("fetch", fetch);
    const desktop = await import("../src/live/desktop");
    await desktop.bootstrapDesktop();
    const changes: unknown[] = [];
    env.target.addEventListener(desktop.DESKTOP_ACCOUNT_EVENT, (event) => changes.push((event as CustomEvent).detail));
    const pending = desktop.desktopAccount();
    await desktop.desktopLogout();
    finishRead(json(account));
    expect(await pending).toEqual({});
    expect(changes).not.toContainEqual(account);
  });

  it("retries the latest draft when editing back to an earlier value and its write fails", async () => {
    environment();
    let finishFirst!: (value: Response) => void;
    const writes: { key: string; value: unknown }[] = [];
    const fetch = vi.fn((path: string, options?: RequestInit) => {
      if (path === "/desktop/bootstrap") return Promise.resolve(json({ identity, storage: {} }));
      writes.push(JSON.parse(options?.body as string));
      if (writes.length === 1) return new Promise<Response>((resolve) => { finishFirst = resolve; });
      return Promise.resolve(writes.length === 3 ? json({ error: "磁盘暂不可写" }, 500) : json({ ok: true }));
    });
    vi.stubGlobal("fetch", fetch);
    const desktop = await import("../src/live/desktop");
    await desktop.bootstrapDesktop();
    desktop.saveDesktopStorage("draft", "A");
    desktop.saveDesktopStorage("draft", "AB");
    desktop.saveDesktopStorage("draft", "A");
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    finishFirst(json({ ok: true }));
    await vi.waitFor(() => expect(writes).toHaveLength(3));
    await desktop.retryDesktopStorage();
    expect(writes.map((write) => write.value)).toEqual(["A", "AB", "A", "A"]);
    expect(desktop.readDesktopStorage("draft", "")).toBe("A");
  });

  it("native flush waits for writes queued during an in-flight save before acknowledging shutdown", async () => {
    environment();
    const writes: { key: string; value: unknown }[] = [];
    const completions: ((value: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn((path: string, options?: RequestInit) => {
      if (path === "/desktop/bootstrap") return Promise.resolve(json({ identity, storage: {} }));
      writes.push(JSON.parse(options?.body as string));
      return new Promise<Response>((resolve) => { completions.push(resolve); });
    }));
    const desktop = await import("../src/live/desktop");
    await desktop.bootstrapDesktop();
    const nativeFlush = (window as Window & { __LINKSHELL_DESKTOP_FLUSH__: typeof desktop.flushDesktopStorage }).__LINKSHELL_DESKTOP_FLUSH__;
    expect(nativeFlush).toBe(desktop.flushDesktopStorage);
    desktop.saveDesktopStorage("draft", "first");
    let acknowledged = false;
    const flushed = nativeFlush().then((value) => { acknowledged = true; return value; });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    desktop.saveDesktopStorage("draft", "latest");
    completions[0]!(json({ ok: true }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(acknowledged).toBe(false);
    completions[1]!(json({ ok: true }));
    expect(await flushed).toEqual({ saved: true, pending: 0 });
    expect(writes.map((write) => write.value)).toEqual(["first", "latest"]);
  });

  it("flush retries failed revisions and reports remaining unsaved data instead of false success", async () => {
    environment();
    let failing = true;
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn((path: string, options?: RequestInit) => {
      if (path === "/desktop/bootstrap") return Promise.resolve(json({ identity, storage: {} }));
      writes.push(JSON.parse(options?.body as string));
      return Promise.resolve(failing ? json({ error: "磁盘暂不可写" }, 500) : json({ ok: true }));
    }));
    const desktop = await import("../src/live/desktop");
    await desktop.bootstrapDesktop();
    desktop.saveDesktopStorage("draft", "latest");
    expect(await desktop.flushDesktopStorage()).toEqual({ saved: false, pending: 1 });
    expect(writes).toHaveLength(2);
    failing = false;
    expect(await desktop.flushDesktopStorage()).toEqual({ saved: true, pending: 0 });
    expect(writes).toHaveLength(3);
    expect(desktop.readDesktopStorage("draft", "")).toBe("latest");
  });

  it("uses the private local WebSocket proxy instead of a gateway URL", async () => {
    environment();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ identity, storage: {} })));
    const WebSocket = vi.fn();
    vi.stubGlobal("WebSocket", WebSocket);
    const desktop = await import("../src/live/desktop");
    await desktop.bootstrapDesktop();
    desktop.desktopHostSocket();
    const url = new URL(WebSocket.mock.calls[0][0]);
    expect(url.origin).toBe("ws://127.0.0.1:41414");
    expect(url.pathname).toBe("/desktop/host");
    expect(url.searchParams.get("token")).toBe("capability-value");
  });
});
