import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredLanHost } from "../modules/link-layout";
import type { Computer } from "../src/lib/computers";
import type { LanDiscoveryBridge } from "../src/lib/lan-discovery";

vi.stubGlobal("__DEV__", false);
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync: vi.fn() },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, AppState: { currentState: "active", addEventListener: vi.fn() } }));
vi.mock("expo-device", () => ({ deviceName: "Test phone" }));
vi.mock("../src/lib/identity", () => ({ deviceIdentity: () => ({ id: "test-phone" }) }));
vi.mock("../src/lib/socket", () => ({ createSocket: vi.fn() }));
vi.mock("../src/lib/account", () => ({
  useAccount: Object.assign(() => undefined, {
    getState: () => ({ session: undefined, token: async () => undefined }),
    subscribe: () => () => {},
  }),
}));

const lan = await import("../src/lib/lan-discovery");
const computers = await import("../src/lib/computers");

describe("LAN mDNS discovery helpers", () => {
  beforeEach(() => {
    computers.useComputers.setState({
      saved: { relay: [], direct: [] },
      live: {},
      lanHosts: [],
    });
  });

  it("computes SHA-256 fingerprints matching host mdns implementation", () => {
    const id = "machine-identity-123";
    const nodeSha = createHash("sha256").update(id).digest("hex").slice(0, 24);
    const nodeFallback = createHash("sha256")
      .update(`linkshell-machine:${id}`)
      .digest("hex")
      .slice(0, 24);

    expect(lan.lanHostFingerprint(id)).toBe(nodeSha);
    expect(lan.lanHostMachineFallbackFingerprint(id)).toBe(nodeFallback);
  });

  it("formats IPv4, .local, and IPv6 LAN host URLs and rejects invalid endpoints", () => {
    expect(lan.lanHostUrl({ host: "192.168.1.42", port: 7878 })).toBe("ws://192.168.1.42:7878");
    expect(lan.lanHostUrl({ host: "studio.local", port: 8080 })).toBe("ws://studio.local:8080");
    expect(lan.lanHostUrl({ host: "fe80::1", port: 7878 })).toBe("ws://[fe80::1]:7878");
    expect(lan.lanHostUrl({ host: "", port: 7878 })).toBeUndefined();
    expect(lan.lanHostUrl({ host: "192.168.1.42", port: 0 })).toBeUndefined();
    expect(lan.lanHostUrl({ host: "192.168.1.42", port: 70000 })).toBeUndefined();
  });

  it("matches discovered hosts to saved computers by machineId, fingerprint, and direct URL", () => {
    const relayComputer: Computer = {
      key: "wss://gateway.itool.tech#id-alpha",
      kind: "relay",
      gateway: "wss://gateway.itool.tech",
      machine: {
        id: "id-alpha",
        signKey: "sign-a",
        boxKey: "box-a",
        name: "Alpha Mac",
        online: true,
        via: "paired",
      },
    };
    const directComputer: Computer = {
      key: "direct:ws://10.0.0.5:7878",
      kind: "direct",
      url: "ws://10.0.0.5:7878",
      name: "Direct PC",
    };

    expect(
      lan.matchLanHostToComputer(
        { name: "alpha", host: "192.168.1.10", port: 7878, machineId: "id-alpha" },
        relayComputer,
      ),
    ).toBe("machineId");

    expect(
      lan.matchLanHostToComputer(
        {
          name: "alpha",
          host: "192.168.1.10",
          port: 7878,
          fingerprint: lan.lanHostFingerprint("id-alpha").toUpperCase(),
        },
        relayComputer,
      ),
    ).toBe("fingerprint");

    expect(
      lan.matchLanHostToComputer(
        { name: "pc", host: "10.0.0.5", port: 7878 },
        directComputer,
      ),
    ).toBe("url");

    expect(
      lan.matchLanHostToComputer(
        { name: "other", host: "192.168.1.99", port: 7878, machineId: "id-beta" },
        relayComputer,
      ),
    ).toBeUndefined();
  });

  it("annotates saved computers cleanly and exposes unmatched LAN hosts", () => {
    const relayComputer: Computer = {
      key: "wss://gateway.itool.tech#id-alpha",
      kind: "relay",
      gateway: "wss://gateway.itool.tech",
      machine: {
        id: "id-alpha",
        signKey: "sign-a",
        boxKey: "box-a",
        name: "Alpha Mac",
        online: true,
        via: "paired",
      },
    };
    const hosts: DiscoveredLanHost[] = [
      {
        name: "Alpha",
        displayName: "Alpha Studio",
        host: "192.168.1.10",
        port: 7878,
        fingerprint: lan.lanHostFingerprint("id-alpha"),
      },
      {
        name: "Fresh-Box",
        host: "192.168.1.25",
        port: 7878,
        machineId: "id-fresh",
      },
    ];

    const annotated = lan.annotateComputersWithLan([relayComputer], hosts);
    expect(annotated[0]).toMatchObject({
      key: relayComputer.key,
      lanReachable: true,
      lanDiscoveredUrl: "ws://192.168.1.10:7878",
      lanMatchedBy: "fingerprint",
    });

    const unmatched = lan.findUnmatchedLanHosts([relayComputer], hosts);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.machineId).toBe("id-fresh");
  });

  it("manages refcounted native LAN discovery lifecycle and prevents stale snapshot overwrite", async () => {
    let emitHosts: ((event: { hosts: DiscoveredLanHost[] }) => void) | undefined;
    let resolveInitial!: (hosts: DiscoveredLanHost[]) => void;
    const bridge: LanDiscoveryBridge = {
      hasDiscovery: () => true,
      start: vi.fn(async () => true),
      stop: vi.fn(async () => {}),
      getHosts: vi.fn(
        () =>
          new Promise<DiscoveredLanHost[]>((resolve) => {
            resolveInitial = resolve;
          }),
      ),
      subscribe: vi.fn((listener) => {
        emitHosts = listener;
        return () => {
          emitHosts = undefined;
        };
      }),
    };

    const received: DiscoveredLanHost[][] = [];
    const controller = lan.createLanDiscoveryController(bridge, (hosts) => {
      received.push(hosts);
    });

    const rel1 = controller.acquire();
    const rel2 = controller.acquire();
    expect(controller.activeCount()).toBe(2);
    expect(bridge.start).toHaveBeenCalledTimes(1);

    // Live subscription arrives before initial getHosts resolves; stale initial snapshot must be ignored.
    emitHosts?.({
      hosts: [{ name: "Live", host: "192.168.1.50", port: 7878, machineId: "live-1" }],
    });
    resolveInitial([{ name: "Stale", host: "192.168.1.2", port: 7878, machineId: "stale-1" }]);
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]?.[0]?.machineId).toBe("live-1");

    rel1();
    expect(bridge.stop).not.toHaveBeenCalled();
    rel2();
    expect(controller.activeCount()).toBe(0);
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });

  it("binds discovered LAN fast-path on matching relay computers in useComputers store", () => {
    const fp = lan.lanHostFingerprint("id-mac-1");
    computers.useComputers.setState({
      saved: {
        relay: [
          {
            gateway: "wss://gateway.itool.tech",
            machine: {
              id: "id-mac-1",
              signKey: "sign-1",
              boxKey: "box-1",
              name: "Mac mini",
              via: "paired",
            },
          },
        ],
        direct: [],
      },
      live: {},
      lanHosts: [],
    });

    computers.useComputers.getState().setLanHosts([
      { name: "Mac mini", host: "192.168.31.18", port: 7878, fingerprint: fp },
    ]);
    const listed = computers.listComputers(computers.useComputers.getState());
    expect(listed[0]).toMatchObject({
      lanReachable: true,
      lanDiscoveredUrl: "ws://192.168.31.18:7878",
      lanMatchedBy: "fingerprint",
    });

    const boundKey = computers.useComputers.getState().discoverLanHost({
      url: "ws://192.168.31.18:7878",
      fingerprint: fp,
      e2ee: true,
    });
    expect(boundKey).toBe("wss://gateway.itool.tech#id-mac-1");
    expect(computers.listComputers(computers.useComputers.getState())[0]).toMatchObject({
      lanUrl: "ws://192.168.31.18:7878",
      lanE2ee: true,
    });
  });
});
