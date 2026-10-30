import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleAccountOAuthCallback, signInWithAccountOAuth } from "../src/live/account-oauth";

class Channel {
  static all: Channel[] = [];
  onmessage?: (event: { data: unknown }) => void;
  postMessage = vi.fn();
  close = vi.fn();
  constructor(readonly name: string) { Channel.all.push(this); }
  receive(data: unknown) { this.onmessage?.({ data }); }
}
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
}
function documentStub() {
  return {
    title: "", body: { replaceChildren: vi.fn() },
    createElement: () => ({ style: { cssText: "" }, textContent: "", append: vi.fn() }),
  };
}
const callback = "https://gateway.itool.tech/?linkshell-auth-callback=1";
let popup: ReturnType<typeof makePopup>;
function makePopup() {
  return { sessionStorage: storage(), document: documentStub(), location: { replace: vi.fn() }, close: vi.fn(), closed: false, opener: {} as object | null };
}
let controller: AbortController;
let auth: SupabaseClient["auth"];
let open: ReturnType<typeof vi.fn>;
const provider = vi.fn();
const exchange = vi.fn();
const begin = () => signInWithAccountOAuth(auth, "google", { signal: controller.signal });

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); Channel.all = [];
  popup = makePopup(); controller = new AbortController(); open = vi.fn(() => popup);
  vi.stubGlobal("window", { open, location: new URL("https://gateway.itool.tech/session/example"), document: documentStub(), sessionStorage: storage(), history: { replaceState: vi.fn() }, close: vi.fn() });
  vi.stubGlobal("BroadcastChannel", Channel);
  provider.mockResolvedValue({ data: { url: "https://example.supabase.co/auth/v1/authorize", flowId: "flow-one" }, error: null });
  exchange.mockResolvedValue({ data: { session: { user: { id: "example-user" } } }, error: null });
  auth = { signInWithOAuth: provider, exchangeCodeForSession: exchange } as unknown as SupabaseClient["auth"];
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("opens synchronously, keeps the workspace in place and exchanges only its PKCE flow", async () => {
  const pending = begin();
  expect(open).toHaveBeenCalledOnce();
  expect(popup.opener).toBeNull();
  expect(window.location.href).toBe("https://gateway.itool.tech/session/example");
  expect(provider).toHaveBeenCalledWith({ provider: "google", options: { redirectTo: callback, skipBrowserRedirect: true } });
  await Promise.resolve();
  const channel = Channel.all[0];
  expect(channel.name).toBe(`linkshell.oauth.${popup.sessionStorage.getItem("linkshell.web.oauth.popup.v1")}`);
  channel.receive({ type: "result", code: "one-time-code" });
  channel.receive({ type: "result", code: "duplicate-code" });
  await pending;
  expect(exchange).toHaveBeenCalledExactlyOnceWith("one-time-code", { flowId: "flow-one" });
  expect(channel.postMessage).toHaveBeenCalledWith({ type: "received" });
  expect(channel.close).toHaveBeenCalledOnce();
  expect(popup.close).toHaveBeenCalledOnce();
});

it("uses the already allowed loopback callback for local browser verification", async () => {
  Object.assign(window, { location: new URL("http://127.0.0.1:5199/") });
  const pending = begin(); const rejected = expect(pending).rejects.toThrow("已取消登录");
  expect(provider.mock.calls[0][0].options.redirectTo).toBe("http://127.0.0.1:5199/linkshell/callback");
  controller.abort(); await rejected;
});

it("does not treat a COOP-severed WindowProxy as a cancelled login", async () => {
  const pending = begin();
  popup.closed = true;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(Channel.all[0].close).not.toHaveBeenCalled();
  Channel.all[0].receive({ type: "result", code: "coop-code" });
  await pending;
  expect(exchange).toHaveBeenCalledOnce();
});

it("reports popup blocking without starting OAuth", async () => {
  open.mockReturnValue(null);
  await expect(begin()).rejects.toThrow("拦截");
  expect(provider).not.toHaveBeenCalled();
});

it("cancels while the OAuth URL is still being prepared and ignores the late result", async () => {
  let finish!: (value: unknown) => void;
  provider.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const pending = begin(); const rejected = expect(pending).rejects.toThrow("已取消登录");
  controller.abort(); await rejected;
  finish({ data: { url: "https://example.supabase.co/auth/v1/authorize", flowId: "late" }, error: null });
  await Promise.resolve();
  expect(popup.location.replace).not.toHaveBeenCalled();
  expect(exchange).not.toHaveBeenCalled();
});

it("keeps the real exchange as owner after the callback even if the dialog unmounts", async () => {
  let finish!: (value: unknown) => void;
  exchange.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const pending = begin(); await Promise.resolve();
  Channel.all[0].receive({ type: "result", code: "code" }); controller.abort();
  expect(Channel.all[0].close).not.toHaveBeenCalled();
  finish({ data: { session: {} }, error: null }); await pending;
});

it("surfaces provider cancellation and failed PKCE exchange without claiming success", async () => {
  const pending = begin(); const rejected = expect(pending).rejects.toThrow("登录已取消");
  Channel.all[0].receive({ type: "result", error: "登录已取消" }); await rejected;
  expect(exchange).not.toHaveBeenCalled();
  const retry = begin(); await Promise.resolve();
  exchange.mockResolvedValueOnce({ data: { session: null }, error: new Error("invalid code verifier") });
  Channel.all[1].receive({ type: "result", code: "wrong-code" });
  await expect(retry).rejects.toThrow("invalid code verifier");
});

it("bounds waiting and rejects blocked popup navigation", async () => {
  const pending = begin(); const rejected = expect(pending).rejects.toThrow("超时");
  await vi.advanceTimersByTimeAsync(5 * 60_000); await rejected;
  popup.location.replace.mockImplementationOnce(() => { throw new Error("navigation blocked"); });
  await expect(begin()).rejects.toThrow("navigation blocked");
});

it("ignores unrelated messages until its code arrives", async () => {
  const pending = begin(); await Promise.resolve();
  Channel.all[0].receive({ type: "received", code: "bad" });
  Channel.all[0].receive({ type: "result", access_token: "never-accepted" });
  expect(exchange).not.toHaveBeenCalled();
  Channel.all[0].receive({ type: "result", code: "good" }); await pending;
});

it("clears callback secrets immediately and delivers only code over the popup's channel", () => {
  const request = "035c946b-33bc-4001-90d9-b29b03e0d14f";
  window.sessionStorage.setItem("linkshell.web.oauth.popup.v1", request);
  Object.assign(window, { location: new URL(`${callback}&code=one-time-code#access_token=never-forwarded`) });
  expect(handleAccountOAuthCallback()).toBe(true);
  expect(window.history.replaceState).toHaveBeenCalledWith(null, "", "/");
  expect(window.sessionStorage.getItem("linkshell.web.oauth.popup.v1")).toBeNull();
  expect(Channel.all[0].name).toBe(`linkshell.oauth.${request}`);
  expect(Channel.all[0].postMessage).toHaveBeenCalledExactlyOnceWith({ type: "result", code: "one-time-code" });
  Channel.all[0].receive({ type: "received" });
  expect(window.close).toHaveBeenCalledOnce();
});

it("rejects unsolicited callbacks and leaves ordinary workspace URLs alone", () => {
  expect(handleAccountOAuthCallback()).toBe(false);
  Object.assign(window, { location: new URL(`${callback}&code=unsolicited`) });
  expect(handleAccountOAuthCallback()).toBe(true);
  expect(Channel.all).toHaveLength(0);
  expect(exchange).not.toHaveBeenCalled();
});
