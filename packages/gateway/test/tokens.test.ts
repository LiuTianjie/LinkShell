import { describe, expect, it, vi } from "vitest";
import { TokenManager } from "../src/tokens.js";
import type { GatewayStateStore, StoredPairingRecord, StoredTokenRecord } from "../src/state-store.js";

function store(records: StoredTokenRecord[]): GatewayStateStore {
  return {
    loadTokens: vi.fn(async () => records),
    saveToken: vi.fn(async () => {}),
    deleteToken: vi.fn(async () => {}),
    loadPairings: vi.fn(async (): Promise<StoredPairingRecord[]> => []),
    savePairing: vi.fn(async () => {}),
    deletePairing: vi.fn(async () => {}),
  };
}

describe("TokenManager", () => {
  it("refreshes token ownership from the persistent store on a local miss", async () => {
    const manager = new TokenManager(store([{
      token: "device-token",
      sessionIds: ["session-1"],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    }]));

    expect(manager.owns("device-token", "session-1")).toBe(false);
    await expect(manager.ownsFresh("device-token", "session-1")).resolves.toBe(true);
    expect(manager.owns("device-token", "session-1")).toBe(true);

    manager.destroy();
  });
});
