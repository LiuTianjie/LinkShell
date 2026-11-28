// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type Identity } from "@linkshell/wire";
import {
  gatewayDeployment,
  hasDesktopSidecar,
  initialBrowserGateway,
} from "../src/bridge/desktop-bridge";
import {
  DesktopEngine,
  I18nProvider,
  STORAGE_KEYS,
  WEB_ACCOUNT_STORAGE_KEY,
  accountClient,
  accountMembership,
  bootstrapDesktopStorage,
  engine,
  handleAccountOAuthCallback,
  loadDeviceIdentity,
  management,
  readLocal,
  resetDesktopStorageForTests,
  resetManagementStoreForTests,
  resetWebAccountClientForTests,
  routerStore,
  saveLocal,
  setDesktopLocalePreference,
  signInWithAccountOAuth,
  type Computer,
  type WebAccountAuth,
} from "../src/core";
import { DesktopAppShell } from "../src/features/shell";
import { SignInPairModal, SystemHostModal } from "../src/features/system";
import { DialogProvider, Popover, PopoverContent, PopoverTrigger } from "../src/primitives";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage?: (event: MessageEvent) => void;
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  postMessage = vi.fn((data: unknown) => {
    for (const peer of FakeChannel.all) {
      if (peer === this || peer.name !== this.name) continue;
      const evt = { data } as MessageEvent;
      peer.onmessage?.(evt);
      for (const fn of peer.listeners) fn(evt);
    }
  });
  close = vi.fn(() => {
    const idx = FakeChannel.all.indexOf(this);
    if (idx >= 0) FakeChannel.all.splice(idx, 1);
  });
  constructor(readonly name: string) {
    FakeChannel.all.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === "message") this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === "message") this.listeners.delete(listener);
  }
}

describe("Unified Browser Workspace (@linkshell/desktop-ui in data-shell='browser')", () => {
  let host: HTMLDivElement;
  let root: Root;

  const mount = (node: ReactNode) => {
    act(() => {
      root.render(
        <I18nProvider>
          <DialogProvider>{node}</DialogProvider>
        </I18nProvider>,
      );
    });
  };

  beforeEach(() => {
    FakeChannel.all = [];
    delete window.linkshellDesktop;
    window.__LINKSHELL_CONFIG__ = { deployment: "official" };
    resetDesktopStorageForTests();
    resetManagementStoreForTests();
    setDesktopLocalePreference("zh");
    routerStore.getState().navigate({ kind: "home" });
    routerStore.getState().closeSystemModal();
    routerStore.getState().setConnectModalOpen(false);
    routerStore.getState().setCommandCenterOpen(false);
    engine.state.setState({
      source: "official",
      gateway: "wss://gateway.itool.tech",
      computers: [],
      localComputer: undefined,
      connection: undefined,
      relayStatus: {},
      account: undefined,
      accountUserId: undefined,
      locked: false,
      ready: true,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    delete window.__LINKSHELL_CONFIG__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("migrates legacy apps/web localStorage keys and IndexedDB identity without unpairing", async () => {
    const legacyPaired: Computer[] = [
      {
        key: "wss://gateway.itool.tech#mac-1",
        gateway: "wss://gateway.itool.tech",
        machine: {
          id: "mac-1",
          name: "Legacy Paired Mac",
          signKey: "sign-1",
          boxKey: "box-1",
          online: true,
          via: "paired",
        },
      },
    ];
    window.localStorage.clear();
    window.localStorage.setItem("linkshell.web.paired", JSON.stringify(legacyPaired));
    window.localStorage.setItem("linkshell.web.selected", JSON.stringify("wss://gateway.itool.tech#mac-1"));
    window.localStorage.setItem("linkshell.web.theme", JSON.stringify("dark"));
    window.localStorage.setItem(
      "linkshell.web.accessToken.wss://gateway.itool.tech#mac-1",
      JSON.stringify("legacy-access-token"),
    );

    const persistedIdentity: Identity = createIdentity();
    const putSpy = vi.fn();
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => {
        const req: {
          result?: unknown;
          onupgradeneeded?: () => void;
          onsuccess?: () => void;
          onerror?: () => void;
        } = {};
        queueMicrotask(() => {
          const tx: { oncomplete?: () => void; onerror?: () => void; objectStore: () => unknown } = {
            objectStore: () => ({
              get: () => {
                const getReq: { result?: Identity; onsuccess?: () => void } = {
                  result: persistedIdentity,
                };
                queueMicrotask(() => {
                  getReq.onsuccess?.();
                  tx.oncomplete?.();
                });
                return getReq;
              },
              put: putSpy,
            }),
          };
          req.result = {
            objectStoreNames: { contains: () => true },
            transaction: () => tx,
            close: vi.fn(),
          };
          req.onsuccess?.();
        });
        return req;
      }),
    });

    // Simulate cold browser startup (no pre-populated in-memory bootstrap).
    resetDesktopStorageForTests();
    // Clear bootstrapState's empty test map by reading keys not in initialStorage:
    window.localStorage.setItem("linkshell.web.paired", JSON.stringify(legacyPaired));
    window.localStorage.setItem("linkshell.web.selected", JSON.stringify("wss://gateway.itool.tech#mac-1"));
    window.localStorage.setItem("linkshell.web.theme", JSON.stringify("dark"));
    window.localStorage.setItem(
      "linkshell.web.accessToken.wss://gateway.itool.tech#mac-1",
      JSON.stringify("legacy-access-token"),
    );

    expect(readLocal<Computer[]>(STORAGE_KEYS.paired, [])).toEqual(legacyPaired);
    expect(readLocal<string>(STORAGE_KEYS.selected, "")).toBe("wss://gateway.itool.tech#mac-1");
    expect(readLocal<string>(STORAGE_KEYS.appearance, "system")).toBe("dark");
    expect(
      readLocal<string>(STORAGE_KEYS.accessToken("wss://gateway.itool.tech#mac-1"), ""),
    ).toBe("legacy-access-token");

    // Clearing an access token removes both desktop and legacy web keys so forgotten machines stay forgotten.
    saveLocal(STORAGE_KEYS.accessToken("wss://gateway.itool.tech#mac-1"), undefined);
    expect(
      readLocal<string>(STORAGE_KEYS.accessToken("wss://gateway.itool.tech#mac-1"), ""),
    ).toBe("");

    await bootstrapDesktopStorage();
    expect(await loadDeviceIdentity()).toBeDefined();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("handles browser OAuth PKCE popup synchronously and scrubs callback URLs via BroadcastChannel", async () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const popupSession = new Map<string, string>();
    const popup = {
      sessionStorage: {
        getItem: (k: string) => popupSession.get(k) ?? null,
        setItem: (k: string, v: string) => {
          popupSession.set(k, v);
        },
        removeItem: (k: string) => {
          popupSession.delete(k);
        },
      },
      document: {
        title: "",
        body: { replaceChildren: vi.fn() },
        createElement: () => ({ style: { cssText: "" }, textContent: "", append: vi.fn() }),
      },
      location: { replace: vi.fn() },
      close: vi.fn(),
      closed: false,
      opener: {} as object | null,
    };

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
    const signInWithOAuth = vi.fn(async () => ({
      data: { url: "https://api.itool.tech/auth/v1/authorize?provider=github", flowId: "flow-42" },
      error: null,
    }));
    const exchangeCodeForSession = vi.fn(async () => ({
      data: {
        session: {
          access_token: "acc-1",
          refresh_token: "ref-1",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: "user-42", email: "dev@example.com" },
        },
      },
      error: null,
    }));

    const controller = new AbortController();
    let seenUrl: string | undefined;
    const pending = signInWithAccountOAuth(
      { signInWithOAuth, exchangeCodeForSession } as unknown as WebAccountAuth,
      "github",
      {
        signal: controller.signal,
        onAuthorizeUrl: (url) => {
          seenUrl = url;
        },
      },
    );

    // Popup opens synchronously before any async call completes.
    expect(openSpy).toHaveBeenCalledOnce();
    expect(popup.opener).toBeNull();
    await Promise.resolve();
    expect(seenUrl).toBe("https://api.itool.tech/auth/v1/authorize?provider=github");
    expect(popup.location.replace).toHaveBeenCalledWith(seenUrl);

    const requestId = popupSession.get("linkshell.web.oauth.popup.v1")!;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    // Simulate the OAuth popup landing back on `/?linkshell-auth-callback=1&code=pkce-code`.
    const prevHref = window.location.href;
    window.history.replaceState(
      null,
      "",
      "/?linkshell-auth-callback=1&code=pkce-code#access_token=never-forwarded",
    );
    window.sessionStorage.setItem("linkshell.web.oauth.popup.v1", requestId);
    const closeSelfSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    expect(handleAccountOAuthCallback()).toBe(true);
    expect(window.location.search).toBe("");
    expect(window.sessionStorage.getItem("linkshell.web.oauth.popup.v1")).toBeNull();

    await pending;
    expect(exchangeCodeForSession).toHaveBeenCalledWith("pkce-code", { flowId: "flow-42" });
    expect(popup.close).toHaveBeenCalledOnce();
    expect(closeSelfSpy).toHaveBeenCalledOnce();
    window.history.replaceState(null, "", prevHref);
  });

  it("coordinates browser token refresh across tabs and guards membership lookups against account switches", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    window.__LINKSHELL_CONFIG__ = {
      deployment: "official",
      account: { url: "https://account.example", anonKey: "anon-test" },
    };
    resetWebAccountClientForTests();

    window.localStorage.setItem(
      WEB_ACCOUNT_STORAGE_KEY,
      JSON.stringify({
        access_token: "expired-token",
        refresh_token: "old-refresh",
        expires_at: nowSec - 30,
        user: { id: "user-1", email: "u1@example.com" },
      }),
    );

    // Another tab rotates the token while our refresh gets 401: must adopt the fresh session instead of signing out!
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      window.localStorage.setItem(
        WEB_ACCOUNT_STORAGE_KEY,
        JSON.stringify({
          access_token: "rotated-token",
          refresh_token: "rotated-refresh",
          expires_at: nowSec + 3600,
          user: { id: "user-1", email: "u1@example.com" },
        }),
      );
      return Response.json(
        { error: { code: "invalid_refresh_token", message: "rotated" } },
        { status: 401 },
      );
    });

    const refreshed = await accountClient().auth.refreshSession();
    expect(refreshed.error).toBeNull();
    expect(refreshed.data.session?.access_token).toBe("rotated-token");
    expect(fetchSpy).toHaveBeenCalledOnce();

    // Asking for membership of a different user (`user-2`) rejects immediately without network calls.
    await expect(accountMembership("user-2")).rejects.toThrow("账号已切换");
  });

  it("adapts to self-hosted /config.js deployment and hides Account Sign-In tab", async () => {
    window.__LINKSHELL_CONFIG__ = { deployment: "self-hosted" };
    expect(hasDesktopSidecar()).toBe(false);
    expect(gatewayDeployment()).toBe("self-hosted");
    expect(initialBrowserGateway()).toMatch(/^ws/);

    const selfHostedEngine = new DesktopEngine({ attachWindowListeners: false });
    expect(selfHostedEngine.state.getState().source).toBe("self-hosted");
    await expect(selfHostedEngine.connectAccount()).rejects.toThrow("私有部署使用设备配对");
    selfHostedEngine.stop();

    mount(<SignInPairModal open initialTab="account" onOpenChange={() => {}} />);
    const dialog = document.body.querySelector(".ls-signin-pair-dialog");
    expect(dialog).not.toBeNull();
    // Self-hosted browser mode omits the Account Sign-In tab bar and shows 6-digit / QR pairing directly.
    expect(dialog?.querySelector(".ls-signin-pair-tabs-bar")).toBeNull();
    expect(dialog?.textContent).toContain("6 位数字配对码");
  });

  it("enforces multi-tab navigator.locks ownership and renders browser shell & preferences cleanly", async () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    let heldRelease: (() => void) | undefined;

    vi.stubGlobal("navigator", {
      ...window.navigator,
      locks: {
        request: vi.fn(
          async (
            _name: string,
            options: { ifAvailable?: boolean },
            cb: (lock: object | null) => Promise<void>,
          ) => {
            if (heldRelease && options.ifAvailable) {
              await cb(null);
              return;
            }
            let releaseLock!: () => void;
            const held = new Promise<void>((resolve) => {
              releaseLock = resolve;
            });
            heldRelease = releaseLock;
            await cb({});
            await held;
            if (heldRelease === releaseLock) heldRelease = undefined;
          },
        ),
      },
    });

    const tab1 = new DesktopEngine();
    const tab2 = new DesktopEngine();
    await tab1.start();
    await tab2.start();

    expect(tab1.state.getState().locked).toBe(false);
    expect(tab2.state.getState().locked).toBe(true);

    // Tab 2 claims the connection -> Tab 1 yields and locks, Tab 2 becomes active.
    await tab2.claim();
    expect(tab1.state.getState().locked).toBe(true);
    expect(tab2.state.getState().locked).toBe(false);
    tab1.stop();
    tab2.stop();

    // Verify Browser Shell (`data-shell="browser"`):
    // 1. Empty browser home renders Connect Computer onboarding, NEVER "本机服务已停止".
    management.setState({ starting: false, snapshot: undefined, problem: undefined });
    mount(
      <>
        <DesktopAppShell platformOverride="macos" />
        <SystemHostModal />
      </>,
    );

    const rootEl = host.querySelector(".desktop-root") as HTMLElement;
    expect(rootEl.dataset.shell).toBe("browser");
    expect(host.querySelector(".desktop-main")?.textContent).toContain("连接电脑");
    expect(host.querySelector(".desktop-main")?.textContent).not.toContain("本机服务已停止");

    // 2. Clicking Settings in browser mode opens the lightweight BrowserPreferencesDialog (not 7 local daemon tabs).
    const settingsBtn = host.querySelector(".local-host-capsule__status") as HTMLButtonElement;
    act(() => {
      settingsBtn.click();
    });
    expect(routerStore.getState().systemModal.open).toBe(true);
    expect(document.body.querySelectorAll(".management-nav-item").length).toBe(0);
    expect(document.body.textContent).toContain("偏好设置");

    // 3. Multi-tab locked state renders Use in This Tab CTA.
    act(() => {
      routerStore.getState().closeSystemModal();
      engine.state.setState({ locked: true, connection: undefined });
    });
    expect(host.querySelector(".desktop-main")?.textContent).toContain("已在其他标签页打开工作台");
    expect(host.querySelector(".desktop-main")?.textContent).toContain("在此标签页使用");
  });

  it("computes fixed viewport coordinates for Popover when CSS Anchor Positioning is unsupported", () => {
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });
    mount(
      <Popover defaultOpen>
        <PopoverTrigger>
          <button type="button">Open</button>
        </PopoverTrigger>
        <PopoverContent placement="bottom-start">Hello Browser</PopoverContent>
      </Popover>,
    );
    const content = document.body.querySelector(".ls-popover") as HTMLElement;
    expect(content).not.toBeNull();
    expect(content.style.position).toBe("fixed");
    expect(content.style.left).toMatch(/^\d+px$/);
    expect(content.style.top).toMatch(/^\d+px$/);
  });
});
