import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth.js", () => ({ isLoggedIn: vi.fn(() => false), getValidToken: vi.fn(async () => null) }));
const auth = await import("../src/auth.js");
const { OFFICIAL_GATEWAY, resolveGateway, writeHostConfig } = await import("../src/commands/host.js");

describe("host gateway choice", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lsh-gwcfg-"));
    delete process.env.LINKSHELL_GATEWAY;
    vi.mocked(auth.isLoggedIn).mockReturnValue(false);
  });
  afterEach(() => delete process.env.LINKSHELL_GATEWAY);

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
});
