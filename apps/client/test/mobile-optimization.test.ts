import { answerTunnel, createIdentity, publicIdentity, type TunnelFrame } from "@linkshell/wire";
import type { SocketLike, TimelineItem } from "@linkshell/client-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const kvMap = new Map<string, string>();

vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: (key: string) => kvMap.get(key) ?? null,
    setItemSync: (key: string, value: string) => kvMap.set(key, value),
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios", select: (obj: Record<string, unknown>) => obj.ios ?? obj.default },
  AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Linking: { openURL: vi.fn() },
  StyleSheet: { hairlineWidth: 0.5, create: <T>(s: T) => s },
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  Pressable: () => null,
  View: () => null,
  useColorScheme: () => "dark",
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { version: "1.2.0" } },
}));

vi.mock("expo-device", () => ({
  deviceName: "Test iPhone",
  modelName: "iPhone",
}));

vi.mock("expo-router", () => ({
  useFocusEffect: vi.fn(),
}));

vi.mock("react-native-svg", () => ({
  default: () => null,
  Circle: () => null,
  G: () => null,
  Line: () => null,
  Path: () => null,
}));

vi.mock("@/components/fixed-text", () => ({ Text: () => null }));
vi.mock("@/components/button", () => ({ Button: () => null }));
vi.mock("@/components/icon", () => ({ Icon: () => null }));
vi.mock("@/components/pressable-feedback", () => ({ PressableFeedback: () => null }));
vi.mock("@/components/agent-tile", () => ({ AgentTile: () => null }));
vi.mock("@/components/segmented", () => ({ Segmented: () => null }));
vi.mock("@/theme/colors", () => ({ colors: {}, palette: { light: {}, dark: {} } }));
vi.mock("@/theme/type", () => ({ radius: {}, type: {} }));
vi.mock("@/theme/agents", () => ({ agentLook: () => ({ short: "Agent" }) }));
vi.mock("@/lib/account", () => ({
  useAccount: Object.assign(vi.fn(), {
    getState: () => ({ session: undefined, token: async () => undefined }),
    subscribe: () => () => {},
  }),
}));
vi.mock("@/lib/account-membership", () => ({ loadAccountMembership: vi.fn() }));
vi.mock("@/lib/client", () => ({ useConnection: vi.fn() }));
vi.mock("@/lib/haptics", () => ({ haptics: { tap: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/identity", () => ({ deviceIdentity: () => createIdentity() }));
vi.mock("@/lib/machine-metrics", () => ({ metricPercent: () => 50, useMachineMetrics: vi.fn() }));
vi.mock("@/lib/socket", () => ({ createSocket: vi.fn() }));

const {
  MOBILE_LOCALE_OPTIONS,
  getMobileLocale,
  getMobileLocalePreference,
  mt,
  pickLocaleText,
  setMobileLocalePreference,
} = await import("../src/lib/locale");

const { computeTrialDaysRemaining, formatMobileMembershipState } = await import(
  "../src/components/account-membership"
);

const {
  applyAtMention,
  defaultQuickPrompts,
  extractAtMention,
  extractSessionOutline,
  gitDiffFileToChange,
  isCommuterTtsEnabled,
  loadCustomQuickPrompts,
  matchSessionPorts,
  parseShortcutUrl,
  saveCustomQuickPrompts,
  setCommuterTtsEnabled,
  summarizeTurnForSpeech,
} = await import("../src/lib/coding-ux");

const {
  checkForAndroidAppUpdate,
  compareSemver,
  parseSemverTuple,
  selectLatestMobileRelease,
} = await import("../src/lib/app-update");

(globalThis as Record<string, unknown>).__DEV__ = false;

const { HybridLanGatewaySocket, LanE2eeSocket } = await import("../src/lib/lan-socket");
const { listComputers, normalizeLanUrl, useComputers } = await import("../src/lib/computers");
const { isHostLowBattery } = await import("../src/components/computer-metrics");
const { formatApiComputeValue } = await import("../src/components/usage-dashboard");

describe("Mobile Localization & App-Store-Safe Trial Status", () => {
  beforeEach(() => {
    kvMap.clear();
  });

  it("persists zh / en / ja / system preferences and translates keys", () => {
    expect(MOBILE_LOCALE_OPTIONS.map((opt) => opt.value)).toEqual(["system", "zh", "en", "ja"]);

    setMobileLocalePreference("ja");
    expect(getMobileLocalePreference()).toBe("ja");
    expect(getMobileLocale()).toBe("ja");
    expect(mt("composer.quickRunTests")).toContain("テスト");
    expect(pickLocaleText("ja", { zh: "中文", en: "English", ja: "日本語" })).toBe("日本語");

    setMobileLocalePreference("zh");
    expect(getMobileLocale()).toBe("zh");
    expect(mt("composer.quickRunTests")).toContain("测试");

    setMobileLocalePreference("en");
    expect(getMobileLocale()).toBe("en");
    expect(mt("composer.quickRunTests")).toContain("test");
  });

  it("renders 7-day trial status accurately across zh/en/ja with zero buy links or price tags", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    const trialMembership = {
      plan: "pro" as const,
      tier: "yearly" as const,
      isTrial: true,
      trialEndsAt: "2026-06-06T00:00:00Z",
      expiresAt: "2026-06-06T00:00:00Z",
    };
    expect(computeTrialDaysRemaining(trialMembership, now)).toBe(5);

    const prohibited = new RegExp(["itool\\.tech/pro", "checkout=", "\\u00a5", "\\$[0-9]"].join("|"), "i");

    for (const locale of ["zh", "en", "ja"] as const) {
      const state = formatMobileMembershipState(trialMembership, false, locale, now);
      expect(state.isTrial).toBe(true);
      expect(state.headline).toContain("5");
      // Must not mislabel trial users as paid Yearly members
      expect(state.headline.toLowerCase()).not.toContain("yearly");
      expect(state.headline).not.toContain("年度会员");
      expect(state.headline).not.toContain("年額");
      expect(`${state.headline} ${state.subtitle} ${state.freeHint ?? ""}`).not.toMatch(prohibited);

      const freeState = formatMobileMembershipState({ plan: "free" }, false, locale, now);
      expect(freeState.isTrial).toBe(false);
      expect(`${freeState.headline} ${freeState.subtitle} ${freeState.freeHint ?? ""}`).not.toMatch(prohibited);
    }
  });
});

describe("Mobile Coding UX Helpers", () => {
  beforeEach(() => {
    kvMap.clear();
  });

  it("extracts and applies @file mentions without matching email addresses", () => {
    expect(extractAtMention("check user@example.com")).toBeUndefined();
    expect(extractAtMention("please inspect @src/comp")).toEqual({
      query: "src/comp",
      start: 15,
      end: 24,
    });
    expect(applyAtMention("please inspect @src/comp", "./src/components/composer.tsx")).toBe(
      "please inspect @src/components/composer.tsx ",
    );
    expect(applyAtMention("review @app in detail", "apps/client/src/app/_layout.tsx", 11)).toBe(
      "review @apps/client/src/app/_layout.tsx in detail",
    );
  });

  it("provides localized default quick prompts and persists custom quick prompts", () => {
    const en = defaultQuickPrompts("en");
    const ja = defaultQuickPrompts("ja");
    expect(en).toHaveLength(4);
    expect(ja).toHaveLength(4);
    expect(en[0]?.id).toBe("run-tests");

    saveCustomQuickPrompts([
      { id: "c-1", label: "  Fix lint  ", prompt: "  pnpm lint --fix  ", custom: true },
      { id: "empty", label: "   ", prompt: "" },
    ]);
    const loaded = loadCustomQuickPrompts();
    expect(loaded).toEqual([{ id: "c-1", label: "Fix lint", prompt: "pnpm lint --fix", custom: true }]);
  });

  it("converts git working-tree diffs into FileChange entries", () => {
    const change = gitDiffFileToChange({
      path: "src/index.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      binary: false,
      oldText: "const a = 1;\n",
      newText: "const a = 2;\nconst b = 3;\n",
    });
    expect(change.path).toBe("src/index.ts");
    expect(change.kind).toBe("update");
    expect(change.added).toBe(2);
    expect(change.removed).toBe(1);
    expect(change.lines.length).toBeGreaterThan(0);
  });

  it("builds session outline entries and filters by category and search query", () => {
    const items: TimelineItem[] = [
      { id: "u1", kind: "user", blocks: [{ type: "text", text: "Fix login redirect bug" }], ts: 1 },
      { id: "a1", kind: "agent", text: "Investigated auth middleware and updated callback URL.", streaming: false, ts: 2 },
      {
        id: "p1",
        kind: "permission-result",
        title: "Run vitest",
        optionName: "Allow once",
        allowed: true,
        ts: 3,
      },
      { id: "e1", kind: "error", code: "timeout", message: "Connection timed out", ts: 4 },
    ];
    expect(extractSessionOutline(items, "all")).toHaveLength(4);
    expect(extractSessionOutline(items, "prompts").map((x) => x.id)).toEqual(["u1"]);
    expect(extractSessionOutline(items, "approvals").map((x) => x.id)).toEqual(["p1"]);
    expect(extractSessionOutline(items, "errors").map((x) => x.id)).toEqual(["e1"]);
    expect(extractSessionOutline(items, "all", "middleware").map((x) => x.id)).toEqual(["a1"]);
  });

  it("matches HTTP ports belonging to the session cwd or worktree source", () => {
    const ports = [
      { port: 3000, pid: 101, process: "node", cwd: "/Users/dev/repo/apps/web", http: true },
      { port: 5432, pid: 102, process: "postgres", cwd: "/Users/dev/repo", http: false },
      { port: 8080, pid: 103, process: "go", cwd: "/Users/dev/other-project", http: true },
    ];
    const matched = matchSessionPorts(ports, "/Users/dev/repo");
    expect(matched.map((p) => p.port)).toEqual([3000]);
  });

  it("persists commuter TTS toggle, summarizes turns for speech, and parses Siri shortcut URLs", () => {
    expect(isCommuterTtsEnabled()).toBe(false);
    setCommuterTtsEnabled(true);
    expect(isCommuterTtsEnabled()).toBe(true);

    const summary = summarizeTurnForSpeech(
      [
        { id: "u1", kind: "user", blocks: [{ type: "text", text: "Run tests" }], ts: 1 },
        { id: "a1", kind: "agent", text: "**All 42 unit tests passed** with zero warnings.", streaming: false, ts: 2 },
      ],
      "en",
      "LinkShell",
    );
    expect(summary).toContain("LinkShell.");
    expect(summary).toContain("All 42 unit tests passed");

    expect(parseShortcutUrl("linkshell:///quick-voice")).toBe("quick-voice");
    expect(parseShortcutUrl("linkshell://approve-latest")).toBe("approve-latest");
    expect(parseShortcutUrl("/quick-voice?source=siri")).toBe("quick-voice");
    expect(parseShortcutUrl("linkshell:///other-route")).toBeNull();
  });
});

describe("Android Update Checker, Power & Usage ROI Helpers", () => {
  it("never fetches or enables external update checks on iOS", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const iosResult = await checkForAndroidAppUpdate({
      platformOs: "ios",
      currentVersion: "1.0.0",
      fetchImpl: fetchSpy,
    });
    expect(iosResult).toEqual({ supported: false, currentVersion: "1.0.0", upToDate: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("compares mobile release semvers on Android while skipping desktop/gateway tags", async () => {
    expect(parseSemverTuple("v1.4.2")).toEqual([1, 4, 2]);
    expect(compareSemver("1.5.0", "1.4.9")).toBe(1);

    const selection = selectLatestMobileRelease(
      [
        { tag_name: "gateway-v9.9.9", html_url: "https://github.com/liutianjie/LinkShell/releases/tag/gateway-v9.9.9" },
        { tag_name: "desktop-v8.0.0", html_url: "https://github.com/liutianjie/LinkShell/releases/tag/desktop-v8.0.0" },
        {
          tag_name: "v1.3.0",
          html_url: "https://github.com/liutianjie/LinkShell/releases/tag/v1.3.0",
          assets: [{ name: "linkshell-1.3.0.apk", browser_download_url: "https://example.com/linkshell-1.3.0.apk" }],
        },
      ],
      "1.2.0",
    );
    expect(selection.upToDate).toBe(false);
    expect(selection.latestVersion).toBe("1.3.0");
    expect(selection.downloadUrl).toBe("https://example.com/linkshell-1.3.0.apk");
  });

  it("detects unplugged low battery (<20%) and formats API compute value without currency symbols", () => {
    expect(isHostLowBattery({ percent: 18, onBattery: true, charging: false })).toBe(true);
    expect(isHostLowBattery({ percent: 18, onBattery: true, charging: true })).toBe(false);
    expect(isHostLowBattery({ percent: 25, onBattery: true, charging: false })).toBe(false);
    expect(isHostLowBattery({ percent: 12, onBattery: false, charging: false })).toBe(false);

    expect(formatApiComputeValue(14.256)).toBe("USD 14.26");
    expect(formatApiComputeValue(undefined)).toBe("USD 0.00");
    expect(formatApiComputeValue(14.256)).not.toContain("$");
  });
});

describe("LAN Direct Discovery, E2EE Handshake & Seamless Gateway Fallback", () => {
  it("normalizes LAN addresses with default host port 7878 and supports non-__DEV__ direct LAN addition", () => {
    expect(normalizeLanUrl("192.168.1.42")).toBe("ws://192.168.1.42:7878");
    expect(normalizeLanUrl("http://macbook.local:7878/")).toBe("ws://macbook.local:7878");
    expect(normalizeLanUrl("wss://lan.example.local:8443/ws/")).toBe("wss://lan.example.local:8443/ws");
    expect(normalizeLanUrl("   ")).toBeUndefined();

    useComputers.getState().addDirect("192.168.1.88", "Home Studio");
    const added = listComputers(useComputers.getState()).find(
      (c) => c.kind === "direct" && c.url === "ws://192.168.1.88:7878",
    );
    expect(added).toBeDefined();
    expect(added?.kind === "direct" && added.name).toBe("Home Studio");
  });

  it("uses LAN fast-path when local Wi-Fi responds in time, and falls back seamlessly to Gateway when away", () => {
    vi.useFakeTimers();
    try {
      const makeMockSocket = () => {
        let state = 0;
        const sent: string[] = [];
        const sock: SocketLike & { sent: string[]; setOpen: () => void } = {
          get readyState() {
            return state;
          },
          onopen: null,
          onclose: null,
          onerror: null,
          onmessage: null,
          sent,
          setOpen: () => {
            state = 1;
            sock.onopen?.({});
          },
          send: (data: string) => sent.push(data),
          close: () => {
            state = 3;
          },
        };
        return sock;
      };

      // Case 1: LAN opens quickly -> Gateway is never opened
      let gwOpenedCount = 0;
      let route1: string | undefined;
      const lan1 = makeMockSocket();
      const hybrid1 = new HybridLanGatewaySocket({
        openLan: () => lan1,
        openGateway: () => {
          gwOpenedCount++;
          return makeMockSocket();
        },
        lanTimeoutMs: 1800,
        onRouteSelected: (mode) => {
          route1 = mode;
        },
      });
      lan1.setOpen();
      expect(hybrid1.readyState).toBe(1);
      expect(route1).toBe("lan");
      expect(gwOpenedCount).toBe(0);
      hybrid1.close();

      // Case 2: LAN times out (away from home Wi-Fi) -> falls back to Gateway automatically
      const lan2 = makeMockSocket();
      const gw2 = makeMockSocket();
      let route2: string | undefined;
      const received: unknown[] = [];
      const hybrid2 = new HybridLanGatewaySocket({
        openLan: () => lan2,
        openGateway: () => gw2,
        lanTimeoutMs: 1800,
        onRouteSelected: (mode) => {
          route2 = mode;
        },
      });
      hybrid2.onmessage = (ev) => received.push(ev.data);

      vi.advanceTimersByTime(1850);
      expect(lan2.readyState).toBe(3);
      gw2.setOpen();
      expect(hybrid2.readyState).toBe(1);
      expect(route2).toBe("gateway");

      gw2.onmessage?.({ data: '{"jsonrpc":"2.0"}' });
      expect(received).toEqual(['{"jsonrpc":"2.0"}']);
      hybrid2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("authenticates and encrypts RPC payloads end-to-end over LanE2eeSocket", () => {
    const device = createIdentity();
    const machine = createIdentity();
    let rawWs!: SocketLike & { setOpen: () => void; peerSend: (payload: unknown) => void };
    const outbound: Array<{ frame: TunnelFrame }> = [];

    const lanSocket = new LanE2eeSocket(
      "ws://192.168.1.42:7878",
      () => {
        let state = 0;
        const sock: SocketLike & { setOpen: () => void; peerSend: (payload: unknown) => void } = {
          get readyState() {
            return state;
          },
          onopen: null,
          onclose: null,
          onerror: null,
          onmessage: null,
          setOpen: () => {
            state = 1;
            sock.onopen?.({});
          },
          send: (data: string) => {
            outbound.push(JSON.parse(data) as { frame: TunnelFrame });
          },
          close: () => {
            state = 3;
          },
          peerSend: (payload: unknown) => {
            sock.onmessage?.({ data: JSON.stringify(payload) });
          },
        };
        rawWs = sock;
        return sock;
      },
      device,
      publicIdentity(machine),
    );

    const decrypted: unknown[] = [];
    lanSocket.onmessage = (ev) => decrypted.push(ev.data);

    rawWs.setOpen();
    expect(outbound).toHaveLength(1);
    const hello = outbound[0]!.frame;
    expect(hello.k).toBe("hello");
    if (hello.k !== "hello") throw new Error("expected hello");

    // Simulate host accepting the E2EE tunnel hello and exchanging XChaCha20-Poly1305 RPC frames:
    const hostAccepted = answerTunnel(machine, publicIdentity(device), hello);
    rawWs.peerSend({ frame: hostAccepted.welcome });
    expect(lanSocket.readyState).toBe(1);

    lanSocket.send('{"id":1,"method":"sessions.list"}');
    const dataFrame = outbound[1]!.frame;
    expect(dataFrame.k).toBe("data");
    if (dataFrame.k !== "data") throw new Error("expected data frame");
    expect(hostAccepted.channel.open(dataFrame.box)).toBe('{"id":1,"method":"sessions.list"}');

    rawWs.peerSend({
      frame: {
        k: "data",
        ch: hello.ch,
        box: hostAccepted.channel.seal('{"id":1,"result":{"sessions":[]}}'),
      },
    });
    expect(decrypted).toEqual(['{"id":1,"result":{"sessions":[]}}']);
    lanSocket.close();
    expect(lanSocket.readyState).toBe(3);
  });
});
