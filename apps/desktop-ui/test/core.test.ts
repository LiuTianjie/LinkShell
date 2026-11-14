import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStream, HostStreamEvents } from "@linkshell/client-core";
import type { ProjectSummary, SessionSummary } from "@linkshell/wire";
import { DESKTOP_FUSION_TUNNEL_EVENT, DESKTOP_LOCAL } from "../src/bridge/desktop-bridge";
import { getOpenOverlayRects, registerOverlayOpen } from "../src/bridge/top-layer-registry";
import {
  DESKTOP_DICTIONARIES,
  FUSION_ICON_BATCH_SIZE,
  STORAGE_KEYS,
  ScreenGate,
  SmoothRelease,
  canUseFusionMode,
  clearUnsavedWorkForTests,
  createFusionController,
  createRouterStore,
  createScreenPreferencesStore,
  createTextDrafts,
  decodeFusionBase64,
  desktopSessionTree,
  effectiveNativeScreenRect,
  encodeFusionBase64,
  evaluateFusionCapability,
  finishComposerSend,
  formatWorkspaceView,
  fusionCapabilityMessage,
  management,
  markdownBlocks,
  parseWorkspaceView,
  readLocal,
  registerUnsavedWork,
  resetDesktopStorageForTests,
  resetManagementStoreForTests,
  revokePairedDevice,
  selectActiveSidebarSessions,
  sessionFamilies,
  translateDesktop,
} from "../src/core";

function makeSession(
  id: string,
  createdAt: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    agent: "codex",
    cwd: "/Users/dev/project-alpha",
    state: "idle",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeProject(
  cwd: string,
  createdAt: number,
  overrides: Partial<ProjectSummary> = {},
): ProjectSummary {
  return {
    cwd,
    name: cwd.split("/").at(-1) ?? cwd,
    createdAt,
    updatedAt: createdAt,
    sessionCount: 1,
    ...overrides,
  } as ProjectSummary;
}

describe("Slice 2A-4 Core Engine, Fusion, Management, Screen & Unified Router", () => {
  beforeEach(() => {
    resetDesktopStorageForTests();
    clearUnsavedWorkForTests();
    resetManagementStoreForTests();
  });

  describe("desktopSessionTree, selectActiveSidebarSessions & sessionFamilies recency + streaming stability invariants", () => {
    it("sorts projects and sessions by most recent activity desc, buckets running sessions by 60s, drops all-archived projects, and tiers Active working set", () => {
      const now = 1_794_630_000_000;
      const projects: ProjectSummary[] = [
        // Older created repo with fresh activity ranks ABOVE stale newer-created scratch folder
        makeProject("/Users/dev/claude-remote", now - 30 * 86_400_000, {
          lastActiveAt: now - 120_000,
          sessionCount: 3,
        }),
        makeProject("/Users/dev/tmp", now - 2 * 86_400_000, {
          lastActiveAt: now - 11 * 86_400_000,
          sessionCount: 1,
        }),
        // All-archived project (`sessionCount: 2`, 2 archived sessions) MUST be dropped!
        makeProject("/Users/dev/ws-archived", now - 5 * 86_400_000, {
          lastActiveAt: now - 60_000,
          sessionCount: 2,
        }),
      ];

      const minuteBase = Math.floor((now - 60_000) / 60_000) * 60_000;
      const initialSessions: SessionSummary[] = [
        makeSession("s-old-resumed", now - 5 * 86_400_000, {
          cwd: "/Users/dev/claude-remote",
          state: "waiting",
          updatedAt: now - 30_000,
          preview: "Waiting confirmation",
        }),
        makeSession("s-run-a", minuteBase + 5_000, {
          cwd: "/Users/dev/claude-remote",
          state: "running",
          updatedAt: minuteBase + 10_000,
          preview: "Streaming A",
        }),
        makeSession("s-run-b", minuteBase + 2_000, {
          cwd: "/Users/dev/claude-remote",
          state: "running",
          updatedAt: minuteBase + 55_000, // Later within same 60s bucket -> must NOT jump ahead of s-run-a!
          preview: "Streaming B",
        }),
        makeSession("s-recent-idle", now - 3_600_000, {
          cwd: "/Users/dev/claude-remote",
          state: "idle",
          updatedAt: now - 1_800_000,
          preview: "Finished 30m ago",
        }),
        makeSession("s-stale-tmp", now - 11 * 86_400_000, {
          cwd: "/Users/dev/tmp",
          state: "idle",
          updatedAt: now - 11 * 86_400_000,
          preview: "只回复 OK",
        }),
        makeSession("s-arch-1", now - 86_400_000, {
          cwd: "/Users/dev/ws-archived",
          archived: true,
        }),
        makeSession("s-arch-2", now - 40_000, {
          cwd: "/Users/dev/ws-archived",
          archived: true,
        }),
      ];

      const tree = desktopSessionTree(projects, initialSessions, { now });
      // 1. All-archived `ws-archived` is dropped; active `claude-remote` ranks #1 above stale `tmp`
      expect(tree.groups.map((g) => g.name)).toEqual(["claude-remote", "tmp"]);
      // `createdAt` uses Math.max (newest session in group), NEVER Math.min!
      expect(tree.groups[0]!.createdAt).toBe(minuteBase + 5_000);

      // 2. Inside `claude-remote`: resumed waiting session ranks #1, and s-run-a stays above s-run-b within the same 60s bucket!
      expect(tree.groups[0]!.sessions.map((s) => s.id)).toEqual([
        "s-old-resumed",
        "s-run-a",
        "s-run-b",
        "s-recent-idle",
      ]);

      // 3. `selectActiveSidebarSessions` / `tree.active` tiers: waiting -> running -> <6h recent (excluding >6h stale `s-stale-tmp`)
      expect(tree.active.map((s) => s.id)).toEqual([
        "s-old-resumed",
        "s-run-a",
        "s-run-b",
        "s-recent-idle",
      ]);
      expect(
        selectActiveSidebarSessions(initialSessions, now, 1).map((s) => s.id),
      ).toEqual(["s-old-resumed", "s-run-a", "s-run-b", "s-recent-idle"]);
    });

    it("nests forked and subagent children under their root ancestor and handles parent cycles safely", () => {
      const root = makeSession("root-1", 1_000);
      const forkChild = makeSession("fork-1", 1_200, { forkedFrom: "root-1" });
      const subChild = makeSession("sub-1", 1_400, { parentId: "fork-1" });
      // Artificial cycle between two sessions must terminate without throwing.
      const cycleA = makeSession("cycle-a", 800, { parentId: "cycle-b" });
      const cycleB = makeSession("cycle-b", 900, { parentId: "cycle-a" });

      const families = sessionFamilies([subChild, forkChild, root, cycleA, cycleB]);
      const rootFamily = families.find((f) => f.root.id === "root-1");
      expect(rootFamily).toBeDefined();
      expect(rootFamily!.children.map((c) => c.id)).toEqual(["sub-1", "fork-1"]);
      expect(families.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Fusion Mode capability matrix, Direct vs Tunnel bridge, -32601 & icon batching", () => {
    it("evaluates macOS-to-macOS capability matrix and localized explanations", () => {
      expect(
        evaluateFusionCapability("wss://gw::mac-remote", "darwin", {
          electron: true,
          localPlatform: "macos",
        }),
      ).toEqual({ supported: true, reason: "ok" });
      expect(
        canUseFusionMode("wss://gw::mac-remote", "darwin", {
          electron: true,
          localPlatform: "macos",
        }),
      ).toBe(true);

      const winClient = evaluateFusionCapability("wss://gw::mac-remote", "darwin", {
        electron: true,
        localPlatform: "windows",
      });
      expect(winClient).toEqual({ supported: false, reason: "windows-client" });
      expect(fusionCapabilityMessage(winClient.reason, "en")).toContain("Windows");

      const localMac = evaluateFusionCapability(DESKTOP_LOCAL, "darwin", {
        electron: true,
        localPlatform: "macos",
      });
      expect(localMac).toEqual({ supported: false, reason: "local-computer" });

      const linuxRemote = evaluateFusionCapability("wss://gw::linux-box", "linux", {
        electron: true,
        localPlatform: "macos",
      });
      expect(linuxRemote).toEqual({ supported: false, reason: "non-macos-remote" });

      const browserClient = evaluateFusionCapability("wss://gw::mac-remote", "darwin", {
        electron: false,
        localPlatform: "macos",
      });
      expect(browserClient).toEqual({ supported: false, reason: "not-electron" });
    });

    it("releases connection immediately in direct mode and translates -32601 outdated Host errors", async () => {
      const eventBus = new EventTarget();
      const invoke = vi.fn(async (method: string) => {
        if (method === "fusionStart") {
          return { mode: "direct" as const, host: "192.168.1.25", port: 9100 };
        }
        if (method === "fusionState") {
          return {
            hubRunning: true,
            connected: true,
            rttMs: 2,
            hostLabel: "Studio Mac",
            hostSlug: "studio-mac",
            appsDir: "/Users/me/Applications/LinkShell (Studio Mac)",
            activeBundles: ["com.apple.TextEdit"],
            windowCounts: { "com.apple.TextEdit": 1 },
            iconBundles: [],
            apps: [{ bundle: "com.apple.TextEdit", name: "TextEdit", running: true }],
          };
        }
        return {};
      });

      const controller = createFusionController({
        invoke: invoke as never,
        postMessage: () => true,
        eventTarget: eventBus,
      });

      const releaseDirect = vi.fn();
      const directReply = await controller.startFusion({
        computerKey: "gw::studio",
        name: "Studio Mac",
        launchBundle: "com.apple.TextEdit",
        link: {
          call: vi.fn(async () => ({
            port: 49152,
            token: "tok-123",
            hosts: ["192.168.1.25"],
          })),
        } as never,
        streams: { open: vi.fn() },
        releaseConnection: releaseDirect,
      });

      expect(directReply).toEqual({ mode: "direct", host: "192.168.1.25", port: 9100 });
      expect(releaseDirect).toHaveBeenCalledTimes(1);
      expect(controller.stateOf("gw::studio").mode).toBe("direct");
      expect(invoke).toHaveBeenCalledWith(
        "fusionStart",
        expect.objectContaining({
          computerKey: "gw::studio",
          launchBundle: "com.apple.TextEdit",
          port: 49152,
        }),
        20_000,
      );

      // Outdated remote Host returning -32601 must release connection and surface localized upgrade guidance.
      const releaseOutdated = vi.fn();
      await expect(
        controller.startFusion({
          computerKey: "gw::old-mac",
          name: "Old Mac",
          link: {
            call: vi.fn(async () => {
              throw new Error("RPC error -32601: Method not found: fusion.start");
            }),
          } as never,
          streams: { open: vi.fn() },
          releaseConnection: releaseOutdated,
        }),
      ).rejects.toThrow("远端电脑的 LinkShell 版本较旧");
      expect(releaseOutdated).toHaveBeenCalledTimes(1);
      expect(controller.stateOf("gw::old-mac").phase).toBe("error");
    });

    it("multiplexes tunnel mode connections with pre-open buffering, base64 return frames, stop cleanup & 48-icon batching", async () => {
      const eventBus = new EventTarget();
      const outboundMessages: Record<string, unknown>[] = [];
      const iconBatches: string[][] = [];

      const invoke = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "fusionStart") {
          return { mode: "tunnel" as const, tunnelId: "tun-1", port: 54001 };
        }
        if (method === "fusionState") {
          return {
            hubRunning: true,
            connected: true,
            hostLabel: "Remote Mini",
            hostSlug: "remote-mini",
            appsDir: "/tmp/apps",
            activeBundles: [],
            windowCounts: {},
            iconBundles: [],
            apps: [],
          };
        }
        if (method === "fusionIcons") {
          const bundles = (params?.bundles as string[]) ?? [];
          iconBatches.push(bundles);
          return {
            icons: Object.fromEntries(
              bundles.map((b) => [b, { src: `data:image/png;base64,${b}`, badged: true }]),
            ),
          };
        }
        if (method === "fusionStop") return { ok: true };
        return {};
      });

      let resolveStreamOpen!: (stream: HostStream) => void;
      let streamEvents!: HostStreamEvents;
      const writtenChunks: Uint8Array[] = [];
      const closeStream = vi.fn();

      const streams = {
        open: vi.fn((_port: number, events: HostStreamEvents) => {
          streamEvents = events;
          return new Promise<HostStream>((resolve) => {
            resolveStreamOpen = resolve;
          });
        }),
      };

      const controller = createFusionController({
        invoke: invoke as never,
        postMessage: (msg) => {
          outboundMessages.push(msg);
          return true;
        },
        eventTarget: eventBus,
      });

      const releaseTunnel = vi.fn();
      await controller.startFusion({
        computerKey: "gw::mini",
        name: "Remote Mini",
        link: {
          call: vi.fn(async () => ({
            port: 60123,
            token: "secret",
            hosts: [],
          })),
        } as never,
        streams,
        releaseConnection: releaseTunnel,
      });

      // Connection stays retained while tunnel is active!
      expect(releaseTunnel).not.toHaveBeenCalled();

      // Emit "open" followed immediately by buffered "data" BEFORE streams.open resolves.
      eventBus.dispatchEvent(
        new CustomEvent(DESKTOP_FUSION_TUNNEL_EVENT, {
          detail: { tunnelId: "tun-1", connId: "c-1", type: "open" },
        }),
      );
      const helloBytes = new TextEncoder().encode("fusion-hello");
      eventBus.dispatchEvent(
        new CustomEvent(DESKTOP_FUSION_TUNNEL_EVENT, {
          detail: {
            tunnelId: "tun-1",
            connId: "c-1",
            type: "data",
            data: encodeFusionBase64(helloBytes),
          },
        }),
      );
      expect(writtenChunks).toHaveLength(0);

      // Resolve stream: buffered chunk flushes immediately in order.
      resolveStreamOpen({
        write: (chunk) => writtenChunks.push(chunk),
        close: closeStream,
      });
      await Promise.resolve();
      expect(writtenChunks).toHaveLength(1);
      expect(new TextDecoder().decode(writtenChunks[0]!)).toBe("fusion-hello");

      // Host sends return bytes -> forwarded to Electron main via postMessage("fusionTunnel").
      const replyBytes = new TextEncoder().encode("fusion-ack");
      streamEvents.data(replyBytes);
      expect(outboundMessages).toContainEqual({
        action: "fusionTunnel",
        tunnelId: "tun-1",
        connId: "c-1",
        type: "data",
        data: encodeFusionBase64(replyBytes),
      });
      expect(new TextDecoder().decode(decodeFusionBase64(encodeFusionBase64(replyBytes)))).toBe(
        "fusion-ack",
      );

      // Verify 48-bundle icon batching across 110 bundles (48 + 48 + 14).
      const manyBundles = Array.from({ length: 110 }, (_, idx) => `com.example.app${idx}`);
      const loadedIcons = await controller.loadFusionIcons(
        "gw::mini",
        "remote-mini",
        manyBundles,
      );
      expect(iconBatches.map((b) => b.length)).toEqual([
        FUSION_ICON_BATCH_SIZE,
        FUSION_ICON_BATCH_SIZE,
        14,
      ]);
      expect(Object.keys(loadedIcons)).toHaveLength(110);

      // Stopping Fusion closes tunnel streams and releases the retained Host connection.
      await controller.stopFusion("gw::mini", "Remote Mini");
      expect(closeStream).toHaveBeenCalledTimes(1);
      expect(releaseTunnel).toHaveBeenCalledTimes(1);
      expect(controller.stateOf("gw::mini").phase).toBe("idle");
    });

    it("preserves phase='starting', hubRunning=true, and cached apps during the 15s startup grace window before --fusion-local binds its socket", async () => {
      let socketReady = false;
      const invoke = vi.fn(async (method: string) => {
        if (method === "fusionStart") {
          return { mode: "direct" as const, host: "192.168.1.88", port: 9200 };
        }
        if (method === "fusionState") {
          if (!socketReady) {
            // Simulates Electron main returning live === null before Unix socket handshake completes
            return {
              hubRunning: false,
              connected: false,
              activeBundles: [],
              windowCounts: {},
              apps: [],
            };
          }
          return {
            hubRunning: true,
            connected: true,
            hostLabel: "Studio M4",
            hostSlug: "studio-m4",
            activeBundles: [],
            windowCounts: {},
            apps: [{ bundle: "com.apple.Safari", name: "Safari" }],
          };
        }
        return {};
      });

      const controller = createFusionController({
        invoke: invoke as never,
        postMessage: () => true,
        eventTarget: new EventTarget(),
      });

      await controller.startFusion({
        computerKey: "gw::studio-m4",
        name: "Studio M4",
        link: {
          call: vi.fn(async () => ({
            port: 50100,
            token: "tok-grace",
            hosts: ["192.168.1.88"],
          })),
        } as never,
        streams: { open: vi.fn() },
      });

      // Early poll returned hubRunning:false, connected:false, apps:[] -> MUST stay in "starting" with hubRunning:true!
      const duringStartup = controller.stateOf("gw::studio-m4");
      expect(duringStartup.phase).toBe("starting");
      expect(duringStartup.hubRunning).toBe(true);

      // Once helper socket binds and catalog arrives -> transitions to "connected" with apps populated
      socketReady = true;
      await controller.refreshFusionState("gw::studio-m4", "Studio M4");
      const readyState = controller.stateOf("gw::studio-m4");
      expect(readyState.phase).toBe("connected");
      expect(readyState.connected).toBe(true);
      expect(readyState.apps).toHaveLength(1);

      // Subsequent transient empty apps snapshot must NOT wipe cached catalog
      socketReady = false;
      await controller.refreshFusionState("gw::studio-m4", "Studio M4");
      expect(controller.stateOf("gw::studio-m4").apps).toHaveLength(1);
    });

    it("enforces zero trailing ellipses across DESKTOP_DICTIONARIES (zh / en / ja)", () => {
      for (const [locale, dict] of Object.entries(DESKTOP_DICTIONARIES)) {
        for (const [key, val] of Object.entries(dict)) {
          expect(
            val.endsWith("…") || val.endsWith("..."),
            `Unexpected trailing ellipsis in ${locale}.${key}: "${val}"`,
          ).toBe(false);
        }
      }
    });
  });

  describe("Single-Shell Router Store & Non-Unmounting System Modal", () => {
    it("opens #view=manage[:<page>] as a modal without unmounting activeRoute and restores workspace hash on close", () => {
      let currentHash = "";
      const router = createRouterStore({
        location: {
          getHash: () => currentHash,
          setHash: (next) => {
            currentHash = next;
          },
        },
      });

      router.getState().openSession("gw::mac-pro", "sess-42");
      expect(router.getState().activeRoute).toEqual({
        kind: "session",
        computerKey: "gw::mac-pro",
        sessionId: "sess-42",
      });
      expect(currentHash).toBe("#view=session%3Agw%253A%253Amac-pro%3Asess-42");

      // Navigate via URL hash to `#view=manage:devices` (e.g. from macOS menu bar / tray).
      currentHash = "#view=manage:devices";
      router.getState().syncFromHash();

      expect(router.getState().systemModal).toEqual({ open: true, page: "devices" });
      // Underlying active session route MUST stay intact!
      expect(router.getState().activeRoute).toEqual({
        kind: "session",
        computerKey: "gw::mac-pro",
        sessionId: "sess-42",
      });

      // Closing System Modal restores the exact underlying session hash!
      router.getState().closeSystemModal();
      expect(router.getState().systemModal.open).toBe(false);
      expect(currentHash).toBe("#view=session%3Agw%253A%253Amac-pro%3Asess-42");

      // Navigate to Fusion and Screen routes, then exercise back() / forward().
      router.getState().openFusion("gw::mac-pro");
      expect(parseWorkspaceView(formatWorkspaceView(router.getState().activeRoute))).toEqual({
        kind: "fusion",
        computerKey: "gw::mac-pro",
      });
      router.getState().openScreen("gw::mac-pro");
      expect(router.getState().canGoBack).toBe(true);

      router.getState().back();
      expect(router.getState().activeRoute).toEqual({
        kind: "fusion",
        computerKey: "gw::mac-pro",
      });
      router.getState().forward();
      expect(router.getState().activeRoute).toEqual({
        kind: "screen",
        computerKey: "gw::mac-pro",
      });
    });

    it("guards route changes when unsaved work is registered and user declines confirmation", () => {
      const releaseUnsaved = registerUnsavedWork();
      const confirmNavigate = vi.fn(() => false);
      const router = createRouterStore({
        location: { getHash: () => "", setHash: () => {} },
        confirmNavigate,
      });

      const moved = router.getState().openSession(DESKTOP_LOCAL, "sess-1");
      expect(moved).toBe(false);
      expect(confirmNavigate).toHaveBeenCalledTimes(1);
      expect(router.getState().activeRoute).toEqual({ kind: "home" });

      releaseUnsaved();
      expect(router.getState().openSession(DESKTOP_LOCAL, "sess-1")).toBe(true);
    });

    it("parses both single-encoded and double-encoded #view= hashes across desktop:local, relay, direct ws, and Windows paths", () => {
      const cases: Array<{
        singleHash: string;
        route: Parameters<typeof formatWorkspaceView>[0];
      }> = [
        {
          singleHash: "#view=terminals:desktop%3Alocal",
          route: { kind: "terminals", computerKey: DESKTOP_LOCAL },
        },
        {
          singleHash: "#view=terminals:desktop%3Alocal:term_1",
          route: { kind: "terminals", computerKey: DESKTOP_LOCAL, terminalId: "term_1" },
        },
        {
          singleHash: "#view=session:ws%3A%2F%2F127.0.0.1%3A8787%23m_1:sess_1",
          route: { kind: "session", computerKey: "ws://127.0.0.1:8787#m_1", sessionId: "sess_1" },
        },
        {
          singleHash: "#view=session:ws%3A%2F%2F%5B%3A%3A1%5D%3A8787%23m_ipv6:sess_v6",
          route: { kind: "session", computerKey: "ws://[::1]:8787#m_ipv6", sessionId: "sess_v6" },
        },
        {
          singleHash: "#view=session:ws%3A%2F%2F127.0.0.1%3A7878:sess_direct",
          route: { kind: "session", computerKey: "ws://127.0.0.1:7878", sessionId: "sess_direct" },
        },
        {
          singleHash: "#view=session:gw%3A%3Amac-pro:sess-42",
          route: { kind: "session", computerKey: "gw::mac-pro", sessionId: "sess-42" },
        },
        {
          singleHash:
            "#view=files:wss%3A%2F%2Fgateway.itool.tech%23mac_1:%2FUsers%2Fdev%2Fsrc%2Findex.ts",
          route: {
            kind: "files",
            computerKey: "wss://gateway.itool.tech#mac_1",
            path: "/Users/dev/src/index.ts",
          },
        },
        {
          singleHash:
            "#view=files:ws%3A%2F%2F127.0.0.1%3A7878:%2FUsers%2Fdev%2FREADME.md%23L10",
          route: {
            kind: "files",
            computerKey: "ws://127.0.0.1:7878",
            path: "/Users/dev/README.md#L10",
          },
        },
        {
          singleHash: "#view=files:desktop%3Alocal:C%3A%5CUsers%5Cdev%5Capp.ts",
          route: {
            kind: "files",
            computerKey: DESKTOP_LOCAL,
            path: "C:\\Users\\dev\\app.ts",
          },
        },
        {
          singleHash: "#view=ports:desktop%3Alocal:5173",
          route: { kind: "ports", computerKey: DESKTOP_LOCAL, port: 5173 },
        },
        {
          singleHash: "#view=ports:ws%3A%2F%2F127.0.0.1%3A7878:5173",
          route: { kind: "ports", computerKey: "ws://127.0.0.1:7878", port: 5173 },
        },
        {
          singleHash: "#view=new-session:desktop%3Alocal:%2FUsers%2Fdev%2Frepo",
          route: {
            kind: "new-session",
            computerKey: DESKTOP_LOCAL,
            cwd: "/Users/dev/repo",
          },
        },
        {
          singleHash:
            "#view=new-session:ws%3A%2F%2F127.0.0.1%3A8787%23m_1:C%3A%5CUsers%5Cdev%5Crepo",
          route: {
            kind: "new-session",
            computerKey: "ws://127.0.0.1:8787#m_1",
            cwd: "C:\\Users\\dev\\repo",
          },
        },
      ];

      let currentHash = "#view=terminals:desktop%3Alocal";
      const router = createRouterStore({
        location: {
          getHash: () => currentHash,
          setHash: (next) => {
            currentHash = next;
          },
        },
      });
      // Cold-boot initial single-encoded hash resolves `desktop:local` intact (not `computerKey: "desktop", terminalId: "local"`).
      expect(router.getState().activeRoute).toEqual({
        kind: "terminals",
        computerKey: DESKTOP_LOCAL,
      });

      for (const { singleHash, route } of cases) {
        // 1. Single-encoded `#view=` hash via `syncFromHash`
        router.getState().navigate({ kind: "home" });
        router.getState().syncFromHash(singleHash);
        expect(router.getState().activeRoute).toEqual(route);

        // 2. Double-encoded `#view=` hash emitted by `navigate(route)` round-tripped back through `syncFromHash`
        router.getState().navigate({ kind: "home" });
        router.getState().navigate(route);
        const doubleEncodedHash = currentHash;
        router.getState().navigate({ kind: "computers" });
        router.getState().syncFromHash(doubleEncodedHash);
        expect(router.getState().activeRoute).toEqual(route);
      }

      // Incomplete `session:desktop%3Alocal` (missing sessionId) must not split `desktop:local` into a bogus session route.
      expect(parseWorkspaceView("session:desktop:local")).toBeUndefined();
      router.getState().navigate({ kind: "computers" });
      router.getState().syncFromHash("#view=session:desktop%3Alocal");
      expect(router.getState().activeRoute).toEqual({ kind: "computers" });
    });
  });

  describe("Unified Screen Preferences, Native Metal Occlusion, Drafts, Device Revocation & i18n", () => {
    it("migrates legacy split screen keys into unified screen:linkshell.screen.v2 store and preserves Metal stage rect when overlays open", () => {
      resetDesktopStorageForTests({
        remoteScreenCodec: "h264",
        "screen:linkshell.screen.maxFps": "120",
        desktopScreenPacing: "immediate",
      });

      const prefs = createScreenPreferencesStore();
      expect(prefs.getState().codec).toBe("h264");
      expect(prefs.getState().maxFps).toBe("120");
      expect(prefs.getState().pacing).toBe("immediate");
      expect(readLocal(STORAGE_KEYS.screenPreferences, null)).toMatchObject({
        codec: "h264",
        maxFps: "120",
        pacing: "immediate",
      });

      // Phase 7 Wave 2 (`#73` B.3): Native Metal ScreenClip stays live at snapped stage bounds
      // when HTML popovers/dialogs open (cutout holes mask the overlay instead of collapsing to 0x0):
      const stageRect = { x: 48.2, y: 36.7, width: 1280, height: 720 };
      expect(effectiveNativeScreenRect(stageRect, false, 2)).toEqual({
        x: 48,
        y: 36.5,
        width: 1280,
        height: 720,
      });
      const closeOverlay = registerOverlayOpen("system-dialog");
      expect(effectiveNativeScreenRect(stageRect, true, 1)).toEqual({
        x: 48,
        y: 37,
        width: 1280,
        height: 720,
      });
      expect(getOpenOverlayRects()).toEqual([]);
      closeOverlay();
      expect(effectiveNativeScreenRect({ x: 10, y: 20, width: 0, height: 680 })).toEqual({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });

      // Router store defaults Right Side Panel to `new-tab` and increments `inspectorTabRequestSeq`:
      const router = createRouterStore({
        location: { getHash: () => "", setHash: () => {} },
      });
      expect(router.getState().inspectorTab).toBe("new-tab");
      const initialSeq = router.getState().inspectorTabRequestSeq;
      router.getState().setInspectorTab("side");
      expect(router.getState().inspectorTab).toBe("side");
      expect(router.getState().inspectorTabRequestSeq).toBe(initialSeq + 1);
      router.getState().toggleInspector(true, "tasks");
      expect(router.getState().inspectorOpen).toBe(true);
      expect(router.getState().inspectorTab).toBe("tasks");
      expect(router.getState().inspectorTabRequestSeq).toBe(initialSeq + 2);

      // ScreenGate generation stamping:
      const gate = new ScreenGate();
      expect(gate.capabilities({ version: 1, configure: true, pause: true })).toBe(true);
      const req = gate.request({ display: 0, width: 1920, maxFps: 60, paused: false });
      expect(gate.allowsInput).toBe(false);
      expect(
        gate.configured({
          requestId: req.requestId,
          display: 0,
          paused: false,
          generation: 7,
          width: 1920,
          maxFps: 60,
        }),
      ).toBe(true);
      expect(gate.allowsInput).toBe(true);
      expect(gate.stamp({ t: "key", k: "return" })).toEqual({
        t: "key",
        k: "return",
        screenGeneration: 7,
      });
    });

    it("preserves composer draft on failed delivery and clears only on Host confirmation", async () => {
      const memory = new Map<string, string>();
      const drafts = createTextDrafts({
        read: (key) => memory.get(key) ?? "",
        write: (key, text) => {
          if (text === undefined) memory.delete(key);
          else memory.set(key, text);
        },
      });
      drafts.getState().update("draft.local.s1", "Fix race condition in tunnel");

      await expect(
        finishComposerSend(Promise.resolve("failed"), () =>
          drafts.getState().clearSubmitted("draft.local.s1", "Fix race condition in tunnel"),
        ),
      ).rejects.toThrow();
      expect(drafts.getState().read("draft.local.s1")).toBe("Fix race condition in tunnel");

      await finishComposerSend(Promise.resolve("sent"), () =>
        drafts.getState().clearSubmitted("draft.local.s1", "Fix race condition in tunnel"),
      );
      expect(drafts.getState().read("draft.local.s1")).toBe("");
    });

    it("revokes paired phone devices via devices.revoke RPC and refreshes management snapshot", async () => {
      management.setState({
        snapshot: {
          status: "running",
          gateway: {
            status: "online",
            devices: [
              { id: "dev-iphone", name: "iPhone 16 Pro", online: true },
              { id: "dev-ipad", name: "iPad Pro", online: false },
            ],
          },
        },
      });

      const rpcCall = vi.fn(async () => ({}));
      const invoke = vi.fn(async (method: string) => {
        if (method === "snapshot") {
          return {
            status: "running",
            gateway: {
              status: "online",
              devices: [{ id: "dev-ipad", name: "iPad Pro", online: false }],
            },
          };
        }
        return {};
      });

      const ok = await revokePairedDevice("dev-iphone", {
        localLink: { call: rpcCall } as never,
        invoke: invoke as never,
      });
      expect(ok).toBe(true);
      expect(rpcCall).toHaveBeenCalledWith("devices.revoke", { deviceId: "dev-iphone" });
      expect(management.getState().snapshot?.gateway?.devices).toEqual([
        { id: "dev-ipad", name: "iPad Pro", online: false },
      ]);
    });

    it("provides complete zh / en / ja desktop translations and stable Markdown streaming blocks", () => {
      const zhKeys = Object.keys(DESKTOP_DICTIONARIES.zh);
      expect(Object.keys(DESKTOP_DICTIONARIES.en)).toEqual(zhKeys);
      expect(Object.keys(DESKTOP_DICTIONARIES.ja)).toEqual(zhKeys);
      expect(translateDesktop("ja", "desktop.fusion.title")).toBe("融合モード");

      const release = new SmoothRelease(0);
      release.arrive(120, 1.0);
      expect(release.pending).toBe(true);
      expect(release.drain(1.0)).toBe(0);
      expect(release.drain(1.05)).toBeGreaterThan(0);
      expect(release.flush()).toBe(120);

      const blocks = markdownBlocks(
        "First paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nFinal paragraph.",
      );
      expect(blocks).toHaveLength(3);
    });
  });
});
