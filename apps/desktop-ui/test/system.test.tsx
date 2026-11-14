import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePairingLink } from "@linkshell/wire";

const bridgeSpies = vi.hoisted(() => {
  const handlerRef: {
    invoke: (
      method: string,
      params: Record<string, unknown>,
    ) => unknown | Promise<unknown>;
    messages: Record<string, unknown>[];
  } = {
    invoke: () => ({}),
    messages: [],
  };

  if (typeof window !== "undefined") {
    window.linkshellDesktop = {
      shell: "electron",
      platform: "darwin",
      appearance: () => window.__LINKSHELL_DESKTOP_APPEARANCE__ ?? "dark",
      visible: () => true,
      postMessage(message: Record<string, unknown>) {
        handlerRef.messages.push(message);
        if (message.action === "invoke" && typeof message.id === "string") {
          const id = message.id;
          const method = String(message.method ?? "");
          const params = (message.params as Record<string, unknown>) ?? {};
          void Promise.resolve()
            .then(() => handlerRef.invoke(method, params))
            .then(
              (result) => {
                window.dispatchEvent(
                  new CustomEvent("linkshell-desktop-reply", {
                    detail: { id, result },
                  }),
                );
              },
              (err: unknown) => {
                window.dispatchEvent(
                  new CustomEvent("linkshell-desktop-reply", {
                    detail: {
                      id,
                      error: err instanceof Error ? err.message : String(err),
                    },
                  }),
                );
              },
            );
        }
      },
    };
  }

  return handlerRef;
});

import { DESKTOP_LOCAL } from "../src/bridge/desktop-bridge";
import {
  I18nProvider,
  engine,
  managementStore,
  resetManagementStoreForTests,
  routerStore,
  setDesktopLocalePreference,
  type DesktopSnapshot,
  type PairingOffer,
  type UsageReport,
} from "../src/core";
import {
  LocalPairingQrDialog,
  SignInPairModal,
  SystemHostModal,
} from "../src/features/system";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsync(ticks = 4): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function makeBaseSnapshot(overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return {
    status: "running",
    cliVersion: "2.4.0",
    source: "standalone",
    home: "/Users/test/.linkshell",
    access: { password: false },
    account: { state: "signed-out" },
    machine: { hostname: "MacBook-Pro.local", hostVersion: "2.4.0" },
    gateway: {
      status: "online",
      url: "wss://gateway.itool.tech",
      devices: [
        {
          id: "dev-iphone",
          name: "iPhone 16 Pro",
          online: true,
          pairedAt: Date.UTC(2026, 10, 10),
        },
        {
          id: "dev-pixel",
          name: "Pixel 9",
          online: false,
          pairedAt: Date.UTC(2026, 10, 11),
        },
      ],
    },
    sessions: [{ id: "sess-1", state: "idle", pendingPermissions: 0 }],
    ...overrides,
  };
}

function makeSampleQr(size = 21): boolean[][] {
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => (x + y) % 2 === 0),
  );
}

function makeUsageReport(records = 12): UsageReport {
  if (records === 0) {
    return {
      generatedAt: Date.now(),
      days: 7,
      agent: "all",
      timezone: "Asia/Shanghai",
      totals: {
        records: 0,
        sessions: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      },
      daily: [],
      models: [],
      agents: [],
      estimatedCostUsd: 0,
      remoteStats: { remoteTurns: 0, remoteApprovals: 0 },
      warnings: [],
    };
  }
  return {
    generatedAt: Date.now(),
    days: 7,
    agent: "all",
    timezone: "Asia/Shanghai",
    totals: {
      records,
      sessions: 4,
      inputTokens: 120_000,
      outputTokens: 45_000,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 10_000,
      totalTokens: 255_000,
      estimatedCostUsd: 3.42,
    },
    daily: [
      {
        date: "2026-11-12",
        records: 5,
        sessions: 2,
        inputTokens: 50_000,
        outputTokens: 20_000,
        cacheReadTokens: 30_000,
        cacheWriteTokens: 5_000,
        totalTokens: 105_000,
        estimatedCostUsd: 1.4,
      },
      {
        date: "2026-11-13",
        records: 7,
        sessions: 2,
        inputTokens: 70_000,
        outputTokens: 25_000,
        cacheReadTokens: 50_000,
        cacheWriteTokens: 5_000,
        totalTokens: 150_000,
        estimatedCostUsd: 2.02,
      },
    ],
    models: [
      {
        agent: "codex",
        model: "gpt-5.4",
        records: 7,
        sessions: 2,
        inputTokens: 70_000,
        outputTokens: 25_000,
        cacheReadTokens: 50_000,
        cacheWriteTokens: 5_000,
        totalTokens: 150_000,
        estimatedCostUsd: 2.02,
      },
      {
        agent: "claude",
        model: "claude-sonnet-4-6",
        records: 5,
        sessions: 2,
        inputTokens: 50_000,
        outputTokens: 20_000,
        cacheReadTokens: 30_000,
        cacheWriteTokens: 5_000,
        totalTokens: 105_000,
        estimatedCostUsd: 1.4,
      },
    ],
    agents: [
      {
        id: "codex",
        label: "Codex",
        source: "native",
        status: "available",
        records: 7,
        totalTokens: 150_000,
        note: "",
        estimatedCostUsd: 2.02,
      },
      {
        id: "claude",
        label: "Claude Code",
        source: "native",
        status: "available",
        records: 5,
        totalTokens: 105_000,
        note: "",
        estimatedCostUsd: 1.4,
      },
    ],
    estimatedCostUsd: 3.42,
    remoteStats: { remoteTurns: 9, remoteApprovals: 5 },
    warnings: [],
  };
}

describe("Slice 2B-5: Non-Unmounting SystemHostModal, SignInPairModal & LocalPairingQrDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let currentSnapshot: DesktopSnapshot;
  let currentUsage: UsageReport;
  let currentOffer: PairingOffer;
  let invokeCalls: Array<{ method: string; params: Record<string, unknown> }>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    bridgeSpies.messages.length = 0;
    invokeCalls = [];
    currentSnapshot = makeBaseSnapshot();
    currentUsage = makeUsageReport(12);
    currentOffer = {
      code: "482910",
      link: encodePairingLink({
        gateway: "wss://gateway.itool.tech",
        signKey: "sign-key-test",
        secret: "secret-test",
        code: "482910",
      }),
      gateway: "wss://gateway.itool.tech",
      expiresAt: Date.now() + 600_000,
      qr: makeSampleQr(),
    };

    bridgeSpies.invoke = (method, params) => {
      invokeCalls.push({ method, params });
      switch (method) {
        case "snapshot":
          return currentSnapshot;
        case "permissions":
          return { recording: true, control: true };
        case "usage":
          return currentUsage;
        case "log":
          return {
            path: "/Users/test/.linkshell/host.log",
            text: [
              "2026-11-13T15:00:01.000Z [host] listening on host.sock",
              "2026-11-13T15:00:02.000Z [gateway] connected to wss://gateway.itool.tech",
            ].join("\n"),
          };
        case "checkUpdates":
          return { started: true };
        case "installUpdate":
          return { ok: true };
        case "setSetting":
          return { ok: true };
        case "action": {
          const name = params.name;
          if (name === "pair-qr") return currentOffer;
          if (name === "set-gateway") {
            const gatewayInput = String(
              (params.input as { gateway?: string } | undefined)?.gateway ?? "",
            );
            currentSnapshot = {
              ...currentSnapshot,
              gateway:
                gatewayInput === "off"
                  ? {
                      status: "off",
                      devices: currentSnapshot.gateway?.devices ?? [],
                    }
                  : {
                      status: "online",
                      url: gatewayInput,
                      devices: currentSnapshot.gateway?.devices ?? [],
                    },
            };
            return currentSnapshot;
          }
          if (name === "connect-gateway") {
            currentSnapshot = {
              ...currentSnapshot,
              gateway: {
                status: "online",
                url: "wss://gateway.itool.tech",
                devices: currentSnapshot.gateway?.devices ?? [],
              },
            };
            return currentSnapshot;
          }
          if (name === "set-password") {
            currentSnapshot = {
              ...currentSnapshot,
              access: { password: true },
            };
            return currentSnapshot;
          }
          if (name === "remove-password") {
            currentSnapshot = {
              ...currentSnapshot,
              access: { password: false },
            };
            return currentSnapshot;
          }
          return currentSnapshot;
        }
        default:
          return {};
      }
    };

    setDesktopLocalePreference("zh");
    resetManagementStoreForTests();
    managementStore.setState({
      snapshot: currentSnapshot,
      about: {
        version: "2.4.0",
        standalone: true,
        home: "/Users/test/.linkshell",
      },
      permissions: { known: true, recording: true, control: true },
    });

    location.hash = "";
    routerStore.setState({
      activeRoute: {
        kind: "session",
        computerKey: DESKTOP_LOCAL,
        sessionId: "sess-1",
      },
      systemModal: { open: false, page: "overview" },
    });
  });

  afterEach(() => {
    act(() => {
      routerStore.getState().closeSystemModal();
      root.unmount();
    });
    container.remove();
    location.hash = "";
    vi.restoreAllMocks();
  });

  it("opens SystemHostModal over the active workspace without unmounting sibling workspace state across all 7 pages", async () => {
    let mounts = 0;
    let unmounts = 0;

    function LiveWorkspaceProbe() {
      const [draftCount, setDraftCount] = useState(0);
      useEffect(() => {
        mounts++;
        return () => {
          unmounts++;
        };
      }, []);
      return (
        <div id="live-workspace">
          <span id="draft-count">{draftCount}</span>
          <button
            id="bump-draft"
            type="button"
            onClick={() => setDraftCount((n) => n + 1)}
          >
            Bump
          </button>
        </div>
      );
    }

    act(() => {
      root.render(
        <I18nProvider>
          <LiveWorkspaceProbe />
          <SystemHostModal />
        </I18nProvider>,
      );
    });

    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(
      container.querySelector("dialog.ls-system-dialog[open]"),
    ).toBeNull();
    expect(container.querySelector(".ls-system-modal-shell")).toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>("#bump-draft")!.click();
    });
    expect(container.querySelector("#draft-count")!.textContent).toBe("1");

    // Open SystemHostModal via routerStore (`#view=manage`)
    act(() => {
      routerStore.getState().openSystemModal("overview");
    });
    await flushAsync();

    expect(
      container.querySelector("dialog.ls-system-dialog[open]"),
    ).not.toBeNull();
    expect(routerStore.getState().activeRoute).toEqual({
      kind: "session",
      computerKey: DESKTOP_LOCAL,
      sessionId: "sess-1",
    });

    // Navigate through every single page in the left rail
    const navButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".management-nav-item"),
    );
    expect(navButtons).toHaveLength(7);

    for (const btn of navButtons) {
      act(() => {
        btn.click();
      });
      await flushAsync();
      expect(mounts).toBe(1);
      expect(unmounts).toBe(0);
      expect(container.querySelector("#draft-count")!.textContent).toBe("1");
    }

    // Close SystemHostModal and verify workspace stayed mounted with intact state
    act(() => {
      routerStore.getState().closeSystemModal();
    });
    await flushAsync();

    expect(
      container.querySelector("dialog.ls-system-dialog[open]"),
    ).toBeNull();
    expect(container.querySelector(".ls-system-modal-shell")).toBeNull();
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    expect(container.querySelector("#draft-count")!.textContent).toBe("1");
  });

  it("preserves exact Windows/macOS E2E hooks (.management-nav-item labels, 立即检查, 下载并更新 App…) even when an update dot is visible", async () => {
    managementStore.setState({
      update: {
        checking: false,
        installing: false,
        available: true,
        version: "2.5.0",
        message: "发现新版本 2.5.0",
      },
    });

    location.hash = "#view=manage";
    act(() => {
      routerStore.getState().syncFromHash();
      root.render(
        <I18nProvider>
          <SystemHostModal />
        </I18nProvider>,
      );
    });
    await flushAsync();

    const navButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".management-nav-item"),
    );
    expect(navButtons.map((btn) => btn.textContent?.trim())).toEqual([
      "总览",
      "设备",
      "访问密码",
      "用量统计",
      "日志",
      "更新",
      "通用",
    ]);

    const updatesNav = navButtons.find(
      (btn) => btn.textContent?.trim() === "更新",
    )!;
    expect(updatesNav.querySelector(".ls-system-nav-dot")).not.toBeNull();

    act(() => {
      updatesNav.click();
    });
    await flushAsync();

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".ls-system-pane button"),
    );
    const checkBtn = buttons.find(
      (btn) => btn.textContent?.trim() === "立即检查",
    );
    const installBtn = buttons.find(
      (btn) => btn.textContent?.trim() === "下载并更新 App…",
    );

    expect(checkBtn).toBeDefined();
    expect(installBtn).toBeDefined();

    act(() => {
      checkBtn!.click();
    });
    await flushAsync();
    expect(invokeCalls.some((c) => c.method === "checkUpdates")).toBe(true);

    act(() => {
      installBtn!.click();
    });
    await flushAsync();
    expect(invokeCalls.some((c) => c.method === "installUpdate")).toBe(true);
  });

  it("expands Gateway and Account editors inline on Overview with zero stacked open modals and validates custom gateway URLs", async () => {
    act(() => {
      routerStore.getState().openSystemModal("overview");
      root.render(
        <I18nProvider>
          <SystemHostModal />
        </I18nProvider>,
      );
    });
    await flushAsync();

    expect(container.querySelectorAll("dialog[open]")).toHaveLength(1);

    // Click "更改" on Gateway row -> expands inline panel without opening a second <dialog>
    const editGatewayBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".ls-system-pane button"),
    ).find((btn) => btn.textContent?.trim() === "更改")!;
    expect(editGatewayBtn).toBeDefined();

    act(() => {
      editGatewayBtn.click();
    });
    expect(container.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(
      container.querySelector(".ls-system-inline-panel"),
    ).not.toBeNull();

    // Switch native radio input to "own" ("自建网关")
    const ownRadio = container.querySelector<HTMLInputElement>(
      'input[type="radio"][value="own"]',
    )!;
    act(() => {
      ownRadio.click();
    });

    const urlInput = container.querySelector<HTMLInputElement>(
      '.ls-system-inline-panel input[type="url"]',
    )!;
    const saveBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".ls-system-inline-panel button",
      ),
    ).find((btn) => btn.textContent?.trim() === "保存")!;

    // Invalid scheme rejected inline
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(urlInput, "ftp://bad-gateway");
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      saveBtn.click();
    });
    expect(container.textContent).toContain("wss://");

    // Valid wss:// URL saves via set-gateway and collapses inline panel
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(urlInput, "wss://relay.company.internal");
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      saveBtn.click();
    });
    await flushAsync(6);

    expect(
      invokeCalls.some(
        (c) =>
          c.method === "action" &&
          c.params.name === "set-gateway" &&
          (c.params.input as { gateway?: string })?.gateway ===
            "wss://relay.company.internal",
      ),
    ).toBe(true);
    expect(container.querySelector(".ls-system-inline-panel")).toBeNull();

    // Click "登录" on Account row -> expands SignInForm inline with zero stacked modals
    const signInBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".ls-system-pane button"),
    ).find((btn) => btn.textContent?.trim() === "登录")!;
    act(() => {
      signInBtn.click();
    });
    expect(container.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(container.querySelector(".ls-signin-form")).not.toBeNull();
  });

  it("revokes a paired phone device from SystemDevicesPage via AlertDialog confirmation and devices.revoke RPC", async () => {
    const callSpy = vi.fn().mockImplementation(async (method: string, params: { deviceId?: string }) => {
      if (method === "devices.revoke" && params.deviceId) {
        currentSnapshot = {
          ...currentSnapshot,
          gateway: {
            ...currentSnapshot.gateway!,
            devices: currentSnapshot.gateway!.devices.filter(
              (d) => d.id !== params.deviceId,
            ),
          },
        };
      }
      return {};
    });

    engine.state.setState({
      connection: {
        computer: {
          key: DESKTOP_LOCAL,
          name: "这台 Mac",
          source: "direct",
          wsUrl: "ws://127.0.0.1:7878",
        },
        link: { call: callSpy } as never,
      } as never,
    });

    act(() => {
      routerStore.getState().openSystemModal("devices");
      root.render(
        <I18nProvider>
          <SystemHostModal />
        </I18nProvider>,
      );
    });
    await flushAsync();

    expect(container.textContent).toContain("iPhone 16 Pro");
    expect(container.textContent).toContain("Pixel 9");

    const findRevokeButtons = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(".ls-system-pane button"),
      ).filter((btn) => btn.textContent?.trim() === "移除");

    expect(findRevokeButtons()).toHaveLength(2);

    // Click "移除" on iPhone 16 Pro -> opens AlertDialog
    act(() => {
      findRevokeButtons()[0]!.click();
    });
    await flushAsync();

    expect(document.body.textContent).toContain("移除配对设备「iPhone 16 Pro」？");
    expect(container.querySelectorAll("dialog[open]")).toHaveLength(2);

    // Pressing Escape dismisses ONLY AlertDialog while SystemHostModal remains open
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flushAsync();

    expect(container.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(
      container.querySelector("dialog.ls-system-dialog[open]"),
    ).not.toBeNull();
    expect(callSpy).not.toHaveBeenCalled();

    // Re-open confirmation and click "移除设备"
    act(() => {
      findRevokeButtons()[0]!.click();
    });
    await flushAsync();

    const confirmBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((btn) => btn.textContent?.trim() === "移除设备")!;
    expect(confirmBtn).toBeDefined();

    act(() => {
      confirmBtn.click();
    });
    await flushAsync(8);

    expect(callSpy).toHaveBeenCalledWith("devices.revoke", {
      deviceId: "dev-iphone",
    });
    expect(container.textContent).not.toContain("iPhone 16 Pro");
    expect(container.textContent).toContain("Pixel 9");
  });

  it("validates 4–128 char Access Password and confirmation match inline on SystemPasswordPage", async () => {
    act(() => {
      routerStore.getState().openSystemModal("password");
      root.render(
        <I18nProvider>
          <SystemHostModal />
        </I18nProvider>,
      );
    });
    await flushAsync();

    const openSetBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".ls-system-pane button"),
    ).find((btn) => btn.textContent?.trim() === "设置密码")!;
    expect(openSetBtn).toBeDefined();

    act(() => {
      openSetBtn.click();
    });

    const inputs = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        ".ls-system-inline-panel input",
      ),
    );
    expect(inputs).toHaveLength(2);
    const [pwInput, confirmInput] = inputs as [HTMLInputElement, HTMLInputElement];
    const setVal = (el: HTMLInputElement, val: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };

    const submitBtn = container.querySelector<HTMLButtonElement>(
      '.ls-system-inline-panel button[type="submit"]',
    )!;

    // Too short (< 4 chars)
    act(() => {
      setVal(pwInput, "123");
    });
    expect(container.textContent).toContain("4 到 128 个字符");
    expect(submitBtn.disabled).toBe(true);

    // Valid length, mismatched confirmation
    act(() => {
      setVal(pwInput, "correct-horse");
      setVal(confirmInput, "wrong-battery");
    });
    expect(container.textContent).toContain("两次输入的密码不一致");
    expect(submitBtn.disabled).toBe(true);

    // Matching confirmation -> enables submit & calls set-password
    act(() => {
      setVal(confirmInput, "correct-horse");
    });
    expect(submitBtn.disabled).toBe(false);

    act(() => {
      submitBtn.click();
    });
    await flushAsync(6);

    expect(
      invokeCalls.some(
        (c) =>
          c.method === "action" &&
          c.params.name === "set-password" &&
          (c.params.input as { password?: string })?.password === "correct-horse",
      ),
    ).toBe(true);
    expect(container.textContent).toContain("已开启");
  });

  it("renders Usage Analytics KPIs, SVG bar chart & honest EmptyState, Log viewer filtering, and Settings theme/locale controls", async () => {
    act(() => {
      routerStore.getState().openSystemModal("usage");
      root.render(
        <I18nProvider>
          <SystemHostModal />
        </I18nProvider>,
      );
    });
    await flushAsync(6);

    // Usage Analytics with records > 0
    expect(container.querySelectorAll(".ls-usage-kpi")).toHaveLength(5);
    expect(container.querySelector(".ls-usage-svg")).not.toBeNull();
    expect(container.textContent).toContain("gpt-5.4");
    expect(container.textContent).toContain("claude-sonnet-4-6");

    // Honest EmptyState when records === 0
    currentUsage = makeUsageReport(0);
    const days30Tab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((tab) => tab.textContent?.trim() === "近 30 天")!;
    act(() => {
      days30Tab.click();
    });
    await flushAsync(6);
    expect(container.textContent).toContain("所选范围暂无用量记录");

    // Log page parses tags and filters lines
    act(() => {
      routerStore.getState().openSystemModal("log");
    });
    await flushAsync(6);
    expect(container.querySelector(".ls-log-well")?.textContent).toContain(
      "connected to wss://gateway.itool.tech",
    );

    // Settings page toggles theme and live-switches locale to English
    act(() => {
      routerStore.getState().openSystemModal("settings");
    });
    await flushAsync();

    const lightTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((tab) => tab.textContent?.trim() === "浅色")!;
    act(() => {
      lightTab.click();
    });
    expect(document.documentElement.dataset.theme).toBe("light");

    act(() => {
      setDesktopLocalePreference("en");
    });
    await flushAsync();

    const enNavLabels = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".management-nav-item"),
    ).map((btn) => btn.textContent?.trim());
    expect(enNavLabels).toEqual([
      "Overview",
      "Devices",
      "Access Password",
      "Usage",
      "Logs",
      "Updates",
      "General",
    ]);
  });

  it("renders zero-jump SignInPairModal with single PairingCodeInput + smart linkshell://pair paste and LocalPairingQrDialog SVG QR + auto-close on pair", async () => {
    const onAuthOpenChange = vi.fn();
    const pairSpy = vi
      .spyOn(engine, "pair")
      .mockResolvedValue({ key: "machine:remote-1" } as never);

    act(() => {
      root.render(
        <I18nProvider>
          <SignInPairModal
            open
            initialTab="account"
            onOpenChange={onAuthOpenChange}
          />
        </I18nProvider>,
      );
    });
    await flushAsync();

    // Locked-height zero-jump frame + zero-login local note on Account tab
    expect(
      container.querySelector(".ls-signin-pair-panel-frame"),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "使用本机 Agent 会话与本地终端无需登录账号",
    );

    // Switch to Pair tab -> single PairingCodeInput (never 6 separate inputs)
    const pairTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((tab) => tab.textContent?.trim() === "扫码与配对")!;
    act(() => {
      pairTab.click();
    });
    await flushAsync();

    const codeInputs = container.querySelectorAll<HTMLInputElement>(
      "input.ls-pairing-code-input",
    );
    expect(codeInputs).toHaveLength(1);
    expect(codeInputs[0]!.maxLength).toBe(6);
    expect(container.querySelector(".ls-qr-dropwell")).not.toBeNull();

    // Smart paste of full linkshell://pair?... link auto-populates gateway + link banner, and submit calls engine.pair
    const pastedLink = encodePairingLink({
      gateway: "wss://relay.selfhosted.dev",
      signKey: "remote-sign-key",
      secret: "one-time-secret",
      code: "938271",
    });

    await act(async () => {
      const pasteEvent = new Event("paste", {
        bubbles: true,
        cancelable: true,
      }) as ClipboardEvent;
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: { getData: () => pastedLink },
      });
      codeInputs[0]!.dispatchEvent(pasteEvent);
    });
    await flushAsync();

    expect(container.textContent).toContain("已识别完整配对链接");

    const pairSubmitBtn = container.querySelector<HTMLButtonElement>(
      '.ls-pair-form button[type="submit"]',
    )!;
    act(() => {
      pairSubmitBtn.click();
    });
    await flushAsync(6);

    expect(pairSpy).toHaveBeenCalledWith(
      "wss://relay.selfhosted.dev",
      pastedLink,
    );
    expect(onAuthOpenChange).toHaveBeenCalledWith(false);

    // Cold-boot regression guard: LocalPairingQrDialog + SystemHostModal + SignInPairModal
    // must cache useSyncExternalStore fallback snapshots when management snapshot is initially undefined.
    const onQrOpenChange = vi.fn();
    act(() => {
      managementStore.setState({ snapshot: undefined });
      root.render(
        <I18nProvider>
          <SystemHostModal />
          <SignInPairModal open={false} onOpenChange={onAuthOpenChange} />
          <LocalPairingQrDialog open={false} onOpenChange={onQrOpenChange} />
        </I18nProvider>,
      );
    });
    act(() => {
      managementStore.setState({ snapshot: currentSnapshot });
      root.render(
        <I18nProvider>
          <LocalPairingQrDialog open onOpenChange={onQrOpenChange} />
        </I18nProvider>,
      );
    });
    await flushAsync(6);

    expect(
      invokeCalls.some(
        (c) => c.method === "action" && c.params.name === "pair-qr",
      ),
    ).toBe(true);
    expect(container.querySelector(".ls-qr-chip svg")).not.toBeNull();
    expect(container.textContent).toContain("482910");

    // Simulate newly paired phone appearing in management snapshot -> the dialog says who paired,
    // then closes itself (it used to close at once, with no word of success).
    vi.useFakeTimers();
    act(() => {
      managementStore.setState({
        snapshot: makeBaseSnapshot({
          gateway: {
            status: "online",
            url: "wss://gateway.itool.tech",
            devices: [
              ...currentSnapshot.gateway!.devices,
              { id: "dev-new-ipad", name: "iPad Pro", online: true },
            ],
          },
        }),
      });
    });
    await flushAsync();

    expect(container.textContent).toContain("「iPad Pro」已完成配对");
    expect(managementStore.getState().pairingOffer).toBeUndefined();
    expect(onQrOpenChange).not.toHaveBeenCalledWith(false);
    act(() => {
      vi.advanceTimersByTime(2_600);
    });
    vi.useRealTimers();
    expect(onQrOpenChange).toHaveBeenCalledWith(false);
  });

  it("enforces system.css Paseo/T3 obsidian-sculpted invariants (@layer components, zero !important, zero overflow:hidden, #0b0c0f rail, #111216 cards & monochrome keycaps)", () => {
    const css = readFileSync(
      resolve(__dirname, "../src/styles/system.css"),
      "utf8",
    );
    expect(css.trim().startsWith("@layer components {")).toBe(true);
    expect(css).not.toContain("!important");
    expect(css).not.toContain("overflow: hidden");
    expect(css).toContain("#0b0c0f");
    expect(css).toContain("#111216");
    expect(css).toContain("--ls-primary-bg");
    expect(css).toContain("#3fb950");
    expect(css).toContain(".ls-system-modal-shell");
    expect(css).toContain(".ls-qr-chip");
    expect(css).toContain(".ls-signin-pair-panel-frame");
  });

  it("satisfies Windows E2E selector & platform parity (.management-back, .modal-window-drag-strip, 更新 -> 立即检查 / 下载并更新 App…, and Explorer labels without Finder)", async () => {
    const prevPlatformAttr = document.documentElement.dataset.platform;
    const prevBridgePlatform = window.linkshellDesktop?.platform;
    document.documentElement.dataset.platform = "windows";
    if (window.linkshellDesktop) {
      window.linkshellDesktop.platform = "win32";
    }

    try {
      managementStore.setState({
        about: {
          version: "2.4.0",
          standalone: true,
          home: "C:\\Users\\test\\.linkshell",
        },
        update: {
          checking: false,
          installing: false,
          available: true,
          latest: "2.5.0",
          message: "发现新版本 2.5.0",
        },
      });

      act(() => {
        routerStore.getState().openSystemModal("overview");
        root.render(
          <I18nProvider>
            <SystemHostModal />
          </I18nProvider>,
        );
      });
      await flushAsync();

      const dialog = container.querySelector("dialog.ls-system-dialog[open]");
      expect(dialog).not.toBeNull();
      // Windows frameless modal includes top drag strip inside the dialog
      expect(dialog?.querySelector(".modal-window-drag-strip")).not.toBeNull();

      // Switch to `'更新'` nav item and verify exact Windows E2E button texts
      const updatesNav = Array.from(
        container.querySelectorAll<HTMLButtonElement>(".management-nav-item"),
      ).find((el) => el.textContent?.trim() === "更新");
      expect(updatesNav).toBeDefined();
      act(() => {
        updatesNav!.click();
      });
      await flushAsync();

      const updateButtons = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).map((b) => b.textContent?.trim() ?? "");
      expect(updateButtons).toContain("立即检查");
      expect(updateButtons).toContain("下载并更新 App…");

      // The modal is 设置; its preferences page is 通用. Verify Windows rows + Explorer label (`0` Finder/访达)
      const settingsNav = Array.from(
        container.querySelectorAll<HTMLButtonElement>(".management-nav-item"),
      ).find((el) => el.textContent?.trim() === "通用");
      expect(settingsNav).toBeDefined();
      act(() => {
        settingsNav!.click();
      });
      await flushAsync();

      expect(container.textContent).toContain("在资源管理器中显示");
      expect(container.textContent).toContain("复制命令路径");
      expect(container.textContent).toContain("允许远程屏幕与键鼠控制");
      expect(container.textContent).not.toContain("Finder");
      expect(container.textContent).not.toContain("访达");
      expect(container.textContent).not.toContain("不透明窗口背景");

      // Close via `.management-back` (smoke.mjs & update-e2e.mjs contract)
      const backBtn = container.querySelector<HTMLButtonElement>(".management-back");
      expect(backBtn).not.toBeNull();
      act(() => {
        backBtn!.click();
      });
      await flushAsync();

      expect(routerStore.getState().systemModal.open).toBe(false);
    } finally {
      if (prevPlatformAttr === undefined) {
        delete document.documentElement.dataset.platform;
      } else {
        document.documentElement.dataset.platform = prevPlatformAttr;
      }
      if (window.linkshellDesktop && prevBridgePlatform !== undefined) {
        window.linkshellDesktop.platform = prevBridgePlatform;
      }
    }
  });
  it("keeps the sign-in form open with its error after a failed password sign-in", async () => {
    const base = bridgeSpies.invoke;
    bridgeSpies.invoke = (method, params) => {
      if (method === "loginPassword") throw new Error("邮箱或密码不正确");
      return base(method, params);
    };
    act(() => {
      routerStore.getState().openSystemModal("overview");
      root.render(
        <I18nProvider>
          <SystemHostModal />
        </I18nProvider>,
      );
    });
    await flushAsync();

    const signInBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".ls-system-pane button"),
    ).find((btn) => btn.textContent?.trim() === "登录")!;
    act(() => signInBtn.click());

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    const password = container.querySelector<HTMLInputElement>('input[name="password"]')!;
    act(() => {
      setter.call(email, "me@example.com");
      email.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(password, "wrong-password");
      password.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      password.closest("form")!.requestSubmit();
    });
    await flushAsync(8);

    expect(managementStore.getState().signingIn).toBe(false);
    expect(container.querySelector('input[name="password"]')).not.toBeNull();
    expect(container.textContent).toContain("邮箱或密码不正确");
  });

  it("tells the person when a click lands while another action is still running", async () => {
    const { serviceAction } = await import("../src/core");
    let release!: () => void;
    const base = bridgeSpies.invoke;
    bridgeSpies.invoke = (method, params) => {
      if (method === "action" && params.name === "restart") {
        return new Promise((resolve) => {
          release = () => resolve(currentSnapshot);
        });
      }
      return base(method, params);
    };
    const first = serviceAction("restart");
    expect(managementStore.getState().busy).toBe(true);
    const second = await serviceAction("stop");
    expect(second).toBe(false);
    expect(managementStore.getState().busyNotice).toEqual({ key: "notice.busy" });

    act(() => {
      routerStore.getState().openSystemModal("overview");
      root.render(
        <I18nProvider>
          <SystemHostModal />
        </I18nProvider>,
      );
    });
    await flushAsync();
    expect(container.textContent).toContain("上一个操作仍在进行");
    release();
    expect(await first).toBe(true);
    expect(invokeCalls.filter((c) => c.method === "action" && c.params.name === "stop")).toHaveLength(0);
  });

  it("keeps the background membership check off the busy lock", async () => {
    const { refreshAccount, setAccessPassword } = await import("../src/core");
    managementStore.setState({
      snapshot: makeBaseSnapshot({ account: { state: "signed-in", userId: "u1", email: "me@example.com" } }),
    });
    let finish!: () => void;
    const base = bridgeSpies.invoke;
    bridgeSpies.invoke = (method, params) => {
      if (method === "action" && params.name === "account-refresh") {
        return new Promise((resolve) => {
          finish = () => resolve(managementStore.getState().snapshot);
        });
      }
      return base(method, params);
    };
    refreshAccount();
    expect(managementStore.getState().checkingMembership).toBe(true);
    expect(managementStore.getState().busy).toBe(false);
    expect(await setAccessPassword("1234")).toBe(true);
    finish();
    await flushAsync();
    expect(managementStore.getState().checkingMembership).toBe(false);
  });

  it("retires a pairing offer once a phone uses it, including a phone that pairs again", async () => {
    const { createLocalPairingOffer, deviceThatUsedOffer } = await import("../src/core");
    await createLocalPairingOffer();
    const offer = managementStore.getState().pairingOffer!;
    expect(offer.baseline?.ids).toEqual(["dev-iphone", "dev-pixel"]);
    expect(deviceThatUsedOffer(offer, currentSnapshot.gateway!.devices)).toBeUndefined();

    // The same iPhone pairing again keeps its id; the Host renews pairedAt.
    const repaired = currentSnapshot.gateway!.devices.map((device) =>
      device.id === "dev-iphone" ? { ...device, pairedAt: Date.now() + 1 } : device,
    );
    expect(deviceThatUsedOffer(offer, repaired)?.id).toBe("dev-iphone");

    act(() => {
      managementStore.setState({
        snapshot: makeBaseSnapshot({
          gateway: { ...currentSnapshot.gateway!, devices: repaired },
        }),
      });
    });
    expect(managementStore.getState().pairingOffer).toBeUndefined();
    expect(managementStore.getState().pairedDevice?.name).toBe("iPhone 16 Pro");
  });

  it("lands only the newest usage report when ranges are switched quickly", async () => {
    const { fetchUsageAnalytics } = await import("../src/core");
    const resolvers: Array<(report: UsageReport) => void> = [];
    const invoke = (() =>
      new Promise<UsageReport>((resolve) => resolvers.push(resolve))) as never;
    const slow = fetchUsageAnalytics(30, "all", invoke);
    const fast = fetchUsageAnalytics(1, "all", invoke);
    const newest = { ...makeUsageReport(3), days: 1 } as UsageReport;
    resolvers[1]!(newest);
    await fast;
    resolvers[0]!({ ...makeUsageReport(12), days: 30 } as UsageReport);
    expect(await slow).toBeUndefined();
    expect(managementStore.getState().usageReport?.days).toBe(1);
    expect(managementStore.getState().usageLoading).toBe(false);
  });

  it("reads and sets keep-awake through the local Host instead of a window-only setting", async () => {
    const { setKeepAwakeMode } = await import("../src/core");
    const call = vi.fn(async (method: string, params: { mode?: string }) =>
      method === "machine.keepAwake" ? { mode: params.mode ?? "smart", active: params.mode === "always" } : {},
    );
    expect(await setKeepAwakeMode("always", { localLink: { call } as never })).toBe(true);
    expect(call).toHaveBeenCalledWith("machine.keepAwake", { mode: "always" });
    expect(managementStore.getState().keepAwake).toEqual({ mode: "always", active: true });
    expect(managementStore.getState().settings.keepAwake).toBe("always");
    expect(invokeCalls.some((c) => c.method === "setSetting" && c.params.key === "keepAwake")).toBe(false);
  });

  it("words store labels in the current language", async () => {
    const { serviceLabel, gatewayLabel, managementMessageText } = await import("../src/core");
    setDesktopLocalePreference("en");
    expect(serviceLabel(currentSnapshot, undefined)).toBe("Running");
    expect(gatewayLabel(currentSnapshot, true)).toBe("Connected");
    expect(managementMessageText({ key: "notice.busy" })).toContain("Another action");
    setDesktopLocalePreference("ja");
    expect(serviceLabel(currentSnapshot, undefined)).toBe("実行中");
    setDesktopLocalePreference("zh");
  });
});
