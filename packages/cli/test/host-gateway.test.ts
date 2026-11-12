import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth.js", () => ({ isLoggedIn: vi.fn(() => false), getValidToken: vi.fn(async () => null), loadAuth: vi.fn(() => null) }));
const auth = await import("../src/auth.js");
const {
  OFFICIAL_GATEWAY,
  describeGateway,
  describePowerAndKeepAwake,
  findLanIpv4,
  parseKeepAwakeOption,
  parseLanOption,
  resolveGateway,
  sameGateway,
  writeHostConfig,
} = await import("../src/commands/host.js");

describe("host gateway choice", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lsh-gwcfg-"));
    delete process.env.LINKSHELL_GATEWAY;
    vi.mocked(auth.isLoggedIn).mockReturnValue(false);
  });
  afterEach(() => {
    delete process.env.LINKSHELL_GATEWAY;
    rmSync(home, { recursive: true, force: true });
  });

  it("uses no gateway when logged out and nothing is chosen", () => {
    expect(resolveGateway(home)).toBeUndefined();
  });

  it("uses the official gateway once logged in", () => {
    vi.mocked(auth.isLoggedIn).mockReturnValue(true);
    expect(resolveGateway(home)).toBe(OFFICIAL_GATEWAY);
  });

  it("keeps an explicit choice, including off, over the login default", () => {
    vi.mocked(auth.isLoggedIn).mockReturnValue(true);
    writeHostConfig(home, { gateway: "off" });
    expect(resolveGateway(home)).toBeUndefined();
    writeHostConfig(home, { gateway: "wss://my-gateway.example" });
    expect(resolveGateway(home)).toBe("wss://my-gateway.example");
    process.env.LINKSHELL_GATEWAY = "ws://127.0.0.1:8798";
    expect(resolveGateway(home)).toBe("ws://127.0.0.1:8798");
  });

  it("knows the official gateway however its address is written, and no other for it", () => {
    // The account's token goes only to the official gateway: one of your own has no accounts and would refuse it.
    expect(sameGateway(OFFICIAL_GATEWAY, OFFICIAL_GATEWAY)).toBe(true);
    expect(sameGateway("https://gateway.itool.tech/", OFFICIAL_GATEWAY)).toBe(true);
    expect(sameGateway("WSS://Gateway.itool.tech", OFFICIAL_GATEWAY)).toBe(true);
    expect(sameGateway("wss://gateway.itool.tech:443/v2/connect", OFFICIAL_GATEWAY)).toBe(true);
    expect(sameGateway("wss://gateway.itool.tech:8443", OFFICIAL_GATEWAY)).toBe(false);
    expect(sameGateway("wss://my-gateway.example", OFFICIAL_GATEWAY)).toBe(false);
    expect(sameGateway("wss://gateway.itool.tech.evil.example", OFFICIAL_GATEWAY)).toBe(false);
    expect(sameGateway(undefined, OFFICIAL_GATEWAY)).toBe(false);
  });

  it("keeps an explicit official gateway off after logout, including on a fresh host start", () => {
    writeHostConfig(home, { gateway: OFFICIAL_GATEWAY });
    vi.mocked(auth.isLoggedIn).mockReturnValue(true);
    expect(resolveGateway(home)).toBe(OFFICIAL_GATEWAY);
    vi.mocked(auth.isLoggedIn).mockReturnValue(false);
    expect(resolveGateway(home)).toBeUndefined();
    process.env.LINKSHELL_GATEWAY = "https://gateway.itool.tech/";
    expect(resolveGateway(home)).toBeUndefined();
    process.env.LINKSHELL_GATEWAY = "wss://gateway.itool.tech:443/v2/connect";
    expect(resolveGateway(home)).toBeUndefined();
    process.env.LINKSHELL_GATEWAY = "wss://my-gateway.example";
    expect(resolveGateway(home)).toBe("wss://my-gateway.example");
  });

  it("parses --lan and --keep-awake options and formats power/keep-awake status", () => {
    expect(parseKeepAwakeOption("smart")).toBe("smart");
    expect(parseKeepAwakeOption("ALWAYS")).toBe("always");
    expect(parseKeepAwakeOption("off")).toBe("off");
    expect(() => parseKeepAwakeOption("invalid")).toThrow(/Invalid --keep-awake/);

    expect(parseLanOption(true)).toBe(8787);
    expect(parseLanOption("9000")).toBe(9000);
    expect(parseLanOption("off")).toBe("off");
    expect(() => parseLanOption("70000")).toThrow(/Invalid --lan/);

    expect(
      findLanIpv4({
        utun0: [{ address: "100.64.0.2", netmask: "255.255.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "100.64.0.2/16" }],
        en0: [{ address: "192.168.1.42", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:01", internal: false, cidr: "192.168.1.42/24" }],
      }),
    ).toBe("192.168.1.42");

    expect(
      describePowerAndKeepAwake({
        keepAwake: { mode: "smart", active: true, reason: "session_active" },
        power: { onBattery: true, percent: 83, charging: true },
      }),
    ).toBe("keep-awake smart (active: session active) · battery 83% (charging)");

    expect(
      describePowerAndKeepAwake({
        keepAwake: { mode: "smart", active: false },
        power: { onBattery: false, percent: 100 },
      }),
    ).toBe("keep-awake smart (idle) · AC power 100%");

    expect(describeGateway({ status: "off", devices: [] })).toContain("7-day free trial");
    expect(describeGateway({ status: "off", devices: [] })).toContain("--lan");
  });
});
