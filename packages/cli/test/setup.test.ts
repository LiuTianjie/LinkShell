import { describe, expect, it, vi } from "vitest";

vi.mock("../src/auth.js", () => ({
  isLoggedIn: vi.fn(() => false),
  loadAuth: vi.fn(() => null),
}));

vi.mock("../src/commands/host.js", () => ({
  OFFICIAL_GATEWAY: "wss://gateway.itool.tech",
  assertHostRuntime: vi.fn(),
  ensureHostRunning: vi.fn(async () => "/tmp/host.sock"),
  joinGatewayAfterLogin: vi.fn(async () => {}),
  readHostConfig: vi.fn(() => ({})),
  sameGateway: vi.fn(() => true),
  withRunningHost: vi.fn(async () => ({ status: "off", devices: [] })),
  writeHostConfig: vi.fn(),
}));

vi.mock("../src/commands/screen.js", () => ({
  setUpScreen: vi.fn(async () => true),
}));

const { runSetup } = await import("../src/commands/setup.js");

describe("linkshell setup", () => {
  it("highlights the 7-day free trial (no card needed) alongside LAN and self-hosted options", async () => {
    let output = "";
    const origStdinTty = process.stdin.isTTY;
    const origStdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await runSetup("0.10.99");
      expect(output).toContain("7-day free trial");
      expect(output).toContain("no card needed");
      expect(output).toContain("linkshell host --lan");
      expect(output).toContain("linkshell pair");
    } finally {
      spy.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", { value: origStdinTty, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: origStdoutTty, configurable: true });
    }
  });
});
