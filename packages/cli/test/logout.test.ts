import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuth, loadAuth } from "../src/auth.js";
import { refreshGateway, withRunningHost } from "../src/commands/host.js";
import { runLogout } from "../src/commands/logout.js";
import { GatewayAccountLeaveError, leaveGatewayAccount } from "../src/gateway-account.js";

vi.mock("../src/auth.js", () => ({ clearAuth: vi.fn(), loadAuth: vi.fn() }));
vi.mock("../src/gateway-account.js", () => ({
  leaveGatewayAccount: vi.fn(),
  GatewayAccountLeaveError: class extends Error { constructor(message: string, readonly replaced: boolean) { super(message); } },
}));
vi.mock("../src/commands/host.js", () => ({
  OFFICIAL_GATEWAY: "wss://gateway.itool.tech",
  sameGateway: (url: string | undefined, other: string) => url === other,
  refreshGateway: vi.fn(),
  withRunningHost: vi.fn(),
}));

describe("explicit computer logout", () => {
  const signedIn = { accessToken: "access", refreshToken: "refresh", expiresAt: 1, userId: "alice" };
  const status = { status: "online", url: "wss://gateway.itool.tech", account: { userId: "alice" }, devices: [] };
  let call: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.mocked(loadAuth).mockReturnValue(signedIn);
    vi.mocked(clearAuth).mockImplementation(() => { vi.mocked(loadAuth).mockReturnValue(null); });
    call = vi.fn(async (method: string) => method === "gateway.status" ? status : {});
    vi.mocked(withRunningHost).mockImplementation(async (use) => use({ call } as never));
    vi.mocked(refreshGateway).mockResolvedValue({ status: "off", devices: [] });
    vi.mocked(leaveGatewayAccount).mockRejectedValue(new Error("offline"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("clears local credentials, requests remote unbinding, and refreshes the running host", async () => {
    await runLogout();
    expect(loadAuth()).toBeNull();
    expect(call.mock.calls.map(([method]) => method)).toEqual(["gateway.status", "gateway.account.leave"]);
    expect(refreshGateway).toHaveBeenCalledWith(0);
    expect(vi.mocked(process.stderr.write).mock.calls.join(" ")).not.toContain("could not confirm");
  });

  it("still disconnects locally when the remote logout request fails, and reports that it was not confirmed", async () => {
    call.mockImplementation(async (method: string) => {
      if (method === "gateway.account.leave") throw new Error("offline");
      return status;
    });
    await runLogout();
    expect(loadAuth()).toBeNull();
    expect(refreshGateway).toHaveBeenCalledWith(0);
    expect(vi.mocked(process.stderr.write).mock.calls.join(" ")).toContain("could not confirm removing");
  });

  it("does not claim logout succeeded if the local credentials could not be cleared", async () => {
    vi.mocked(clearAuth).mockImplementation(() => {});
    await expect(runLogout()).rejects.toThrow("Could not remove the local account credentials");
    expect(vi.mocked(process.stderr.write).mock.calls.join(" ")).not.toContain("Logged out locally");
  });

  it("uses the machine key to revoke when an older Host does not support account.leave", async () => {
    call.mockImplementation(async (method: string) => {
      if (method === "gateway.account.leave") throw new Error("unknown_method");
      return status;
    });
    vi.mocked(leaveGatewayAccount).mockResolvedValue(undefined);
    await runLogout();
    expect(leaveGatewayAccount).toHaveBeenCalledWith(expect.objectContaining({ url: status.url, token: "access" }));
    expect(refreshGateway).toHaveBeenCalledWith(0);
    expect(vi.mocked(process.stderr.write).mock.calls.join(" ")).not.toContain("could not confirm");
  });

  it("does not reconnect an older Host after takeover when an old gateway cannot revoke", async () => {
    call.mockImplementation(async (method: string) => {
      if (method === "gateway.account.leave") throw new Error("unknown_method");
      return { ...status, status: "offline" };
    });
    vi.mocked(leaveGatewayAccount).mockRejectedValue(new GatewayAccountLeaveError("unsupported", true));
    await runLogout();
    expect(refreshGateway).not.toHaveBeenCalled();
    expect(vi.mocked(process.stderr.write).mock.calls.join(" ")).toContain("could not confirm removing");
  });
});
