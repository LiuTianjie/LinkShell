import { describe, expect, it, vi } from "vitest";

const attentionHarness = vi.hoisted(() => ({
  loaded: true,
  terminalsLoaded: true,
  online: true,
  attentionArgs: undefined as undefined | unknown[],
  watchArgs: undefined as undefined | unknown[],
  pushCalled: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useMemo: <T>(fn: () => T) => fn(),
  };
});

vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  View: "View",
  Platform: { OS: "ios", select: <T>(map: { ios?: T; default?: T }) => map.ios ?? map.default },
  StyleSheet: { create: <T>(s: T) => s },
}));
vi.mock("@/components/fixed-text", () => ({ Text: "Text" }));
vi.mock("../src/components/icon", () => ({ Icon: "Icon" }));
vi.mock("../src/components/pressable-feedback", () => ({ PressableFeedback: "PressableFeedback" }));
vi.mock("@/theme/colors", () => ({
  colors: { card: "#111", label: "#fff", secondaryLabel: "#aaa", tertiaryLabel: "#666", danger: "#f00" },
}));
vi.mock("@/theme/type", () => ({ radius: { card: 12 }, type: { subhead: {}, footnote: {} } }));

vi.mock("@/lib/client", () => ({
  useConnection: () => ({
    computer: { key: "relay:https://gateway.itool.tech#mac-qr", kind: "direct", url: "ws://192.168.1.5:7878", name: "MacBook" },
    link: { reconnectNow: vi.fn(), call: vi.fn() },
  }),
  useActions: () => ({}),
  useSessionSubscriber: () => () => () => {},
  useConnectionStatus: () => "reconnecting",
  useClient: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      sessions: {},
      sessionsLoaded: attentionHarness.loaded,
      status: attentionHarness.online ? "online" : "reconnecting",
      views: {},
      promptProgress: {},
      machine: { home: "/Users/test", agents: [] },
      projects: [],
    }),
}));
vi.mock("@/lib/computers", () => ({
  listComputers: () => [],
  reconnectRelays: vi.fn(),
  useComputers: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ saved: {}, live: {}, relayStatus: {} }),
    { getState: () => ({ select: vi.fn() }) },
  ),
}));
vi.mock("@/lib/computer-names", () => ({
  computerDisplayName: () => "MacBook",
  useComputerNames: (selector: (state: { names: Record<string, string> }) => unknown) => selector({ names: {} }),
}));
vi.mock("@/lib/terminals", () => ({
  useTerminals: () => ({ terminals: [], loaded: attentionHarness.terminalsLoaded }),
}));
vi.mock("@/lib/session-attention", () => ({
  useIOSAttentionSync: (...args: unknown[]) => {
    attentionHarness.attentionArgs = args;
  },
}));
vi.mock("@/lib/watch-sync", () => ({
  useIOSWatchSync: (...args: unknown[]) => {
    attentionHarness.watchArgs = args;
  },
}));
vi.mock("@/lib/live-activity-push", () => ({
  useLiveActivityPush: () => {
    attentionHarness.pushCalled += 1;
  },
}));

const { formatConnectionDetail, needsRepairing } = await import("../src/components/connection-banner");
const { IOSAttentionSync } = await import("../src/components/ios-attention-sync");

describe("ConnectionBanner Chinese error formatting & QR-paired IOSAttentionSync", () => {
  it("translates raw OS, WebSocket, LAN, relay, and iOS NWError strings into Chinese without English socket noise", () => {
    const cases: Array<[string, string]> = [
      ["connect ECONNREFUSED 192.168.1.20:7878", "连接被拒绝，请确认电脑上的 LinkShell 正在运行"],
      ["connect ETIMEDOUT 10.0.0.5:7878", "连接电脑超时，请检查网络连接"],
      ["lan_timeout", "连接电脑超时，请检查网络连接"],
      ["read ECONNRESET", "网络连接意外中断"],
      ["Network request failed", "网络请求失败，请检查网络连接"],
      ["WebSocket was closed before the connection was established", "连接已断开"],
      ["not_paired", "这台电脑不再信任这台设备，请重新配对"],
      ["bad_identity", "电脑的身份校验没有通过，请重新配对"],
      ["not_allowed", "没有权限连接这台电脑"],
      ["invalid_lan_frame", "局域网加密握手失败，正在重连"],
      ["The operation couldn’t be completed. (NWError error -1009.)", "网络连接异常，请检查网络设置"],
      ["unexpected internal frame 0x7f", "网络连接异常，请检查网络设置"],
    ];

    for (const [raw, expected] of cases) {
      const result = formatConnectionDetail(raw);
      expect(result).toBe(expected);
      expect(result).toMatch(/[\u4e00-\u9fff]/);
      // App Store 3.1.1: mobile UI copy never includes purchase links.
      expect(result).not.toContain("itool.tech/pro");
    }

    // The RPC layer names the method and its limit; the banner says what it means.
    expect(formatConnectionDetail("请求超时（machine.info，10000 ms）")).toBe("电脑没有响应");
    expect(formatConnectionDetail("连接已断开 (machine.info)")).toBe("连接已断开");
    expect(needsRepairing(formatConnectionDetail("not_paired"))).toBe(true);
    expect(needsRepairing(formatConnectionDetail("bad_identity"))).toBe(true);
    expect(needsRepairing(formatConnectionDetail("ECONNREFUSED"))).toBe(false);
    expect(formatConnectionDetail(undefined)).toBeUndefined();
    expect(formatConnectionDetail("   ")).toBeUndefined();
    // Already-clean Chinese refusal copy passes through intact.
    expect(formatConnectionDetail("这台电脑不再信任这台设备，请重新配对")).toBe("这台电脑不再信任这台设备，请重新配对");
  });

  it("enables local Live Activities & Quick Actions once sessions and terminals load even without an account", () => {
    attentionHarness.loaded = false;
    attentionHarness.terminalsLoaded = true;
    const tree1 = IOSAttentionSync() as unknown as { type: () => unknown };
    tree1.type();
    expect(attentionHarness.attentionArgs?.[7]).toBe(false);

    attentionHarness.loaded = true;
    attentionHarness.terminalsLoaded = false;
    const tree2 = IOSAttentionSync() as unknown as { type: () => unknown };
    tree2.type();
    expect(attentionHarness.attentionArgs?.[7]).toBe(false);

    // Both loaded -> enabled is true without requiring account sign-in!
    attentionHarness.loaded = true;
    attentionHarness.terminalsLoaded = true;
    const tree3 = IOSAttentionSync() as unknown as { type: () => unknown };
    tree3.type();
    expect(attentionHarness.attentionArgs?.[7]).toBe(true);
  });
});
