import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForPairing } from "../src/commands/pair.js";

// A host client that only has the notification `linkshell pair` waits for.
function fakeClient() {
  const listeners = new Set<(params: { device: { id: string; name: string } }) => void>();
  return {
    listeners,
    on: ((_name: string, listener: (params: never) => void) => {
      listeners.add(listener as never);
      return () => listeners.delete(listener as never);
    }) as Parameters<typeof waitForPairing>[0]["on"],
    paired: (name: string) => [...listeners].forEach((listener) => listener({ device: { id: "d1", name } })),
  };
}

describe("waiting for a phone to pair", () => {
  let sigintBefore: ReturnType<typeof process.listeners>;
  beforeEach(() => {
    vi.useFakeTimers();
    sigintBefore = process.listeners("SIGINT");
  });
  afterEach(() => vi.useRealTimers());

  // Nothing may outlive the wait: a timer would keep the command running, a SIGINT listener would swallow Ctrl-C.
  const nothingLeft = (client: ReturnType<typeof fakeClient>) => {
    expect(vi.getTimerCount()).toBe(0);
    expect(process.listeners("SIGINT")).toEqual(sigintBefore);
    expect(client.listeners.size).toBe(0);
  };

  it("ends with the device once it pairs", async () => {
    const client = fakeClient();
    const wait = waitForPairing(client, Date.now() + 600_000);
    client.paired("iPhone");
    expect(await wait).toMatchObject({ name: "iPhone" });
    nothingLeft(client);
  });

  it("ends when the window closes", async () => {
    const client = fakeClient();
    const wait = waitForPairing(client, Date.now() + 600_000);
    vi.advanceTimersByTime(600_000);
    expect(await wait).toBe("expired");
    nothingLeft(client);
  });

  it("ends on Ctrl-C", async () => {
    const client = fakeClient();
    const wait = waitForPairing(client, Date.now() + 600_000);
    // Only the listener the wait added: emitting the signal would also reach the test runner's own.
    const added = process.listeners("SIGINT").filter((listener) => !sigintBefore.includes(listener));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    expect(await wait).toBe("interrupted");
    nothingLeft(client);
  });
});
