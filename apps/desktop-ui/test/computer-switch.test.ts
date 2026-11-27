// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { DESKTOP_LOCAL } from "../src/bridge/desktop-bridge";
import {
  ComputerConnections,
  engine,
  resetDesktopStorageForTests,
  type Computer,
  type Connection,
} from "../src/core";

function fakeComputer(id: string, name: string, online = true): Computer {
  return {
    key: `wss://gw.example#${id}`,
    gateway: "wss://gw.example",
    machine: {
      id,
      name,
      platform: "darwin",
      online,
      via: "paired",
    },
  };
}

function fakeConnection(computer: Computer) {
  const close = vi.fn();
  const reconnectNow = vi.fn();
  const streamsStart = vi.fn();
  const streamsStop = vi.fn();
  const connection = {
    computer,
    link: { reconnectNow, close: vi.fn(), call: vi.fn(), onStatus: () => () => {} },
    streams: { start: streamsStart, stop: streamsStop },
    store: createStore(() => ({ sessions: {}, status: "online", sessionsLoaded: true })),
    sessions: { close: vi.fn() },
  } as unknown as Connection;
  return { connection, close, reconnectNow, streamsStart, streamsStop };
}

describe("Desktop computer-switching stability (R5)", () => {
  beforeEach(() => {
    engine.stop();
    resetDesktopStorageForTests();
  });

  it("never throws when select() is invoked before the engine boots", () => {
    const compA = fakeComputer("mac-a", "Mac Studio");
    expect(() => engine.select(compA)).not.toThrow();
    expect(engine.state.getState().connection).toBeUndefined();
  });

  it("swaps active computer connections atomically without emitting a transient undefined connection", () => {
    const compA = fakeComputer("mac-a", "Mac Studio");
    const compB = fakeComputer("mac-b", "MacBook Pro");
    const compC = fakeComputer("win-c", "Workstation");

    const opened = new Map<string, ReturnType<typeof fakeConnection>>();
    const pool = new ComputerConnections((computer) => {
      const created = fakeConnection(computer);
      opened.set(computer.key, created);
      return { connection: created.connection, close: created.close };
    });

    // Inject controlled engine state to exercise rapid A -> B -> C -> A switching.
    const internal = engine as unknown as {
      active: boolean;
      identity: { id: string };
      connections: ComputerConnections;
    };
    const originalConnections = internal.connections;
    internal.active = true;
    internal.identity = { id: "dev-test" };
    internal.connections = pool;

    try {
      engine.state.setState({ computers: [compA, compB, compC] });
      const seenKeys: Array<string | undefined> = [];
      const unsub = engine.state.subscribe((state, prev) => {
        if (state.connection !== prev.connection) {
          seenKeys.push(state.connection?.computer.key);
        }
      });

      engine.select(compA);
      for (let i = 0; i < 12; i++) {
        engine.select(compB);
        engine.select(compC);
        engine.select(compA);
      }
      engine.select(compB);
      unsub();

      // Every transition after initial selection must move directly from one connection to the next.
      expect(seenKeys.length).toBeGreaterThan(30);
      expect(seenKeys.every((key) => key !== undefined)).toBe(true);
      expect(engine.state.getState().connection?.computer.key).toBe(compB.key);
      // Old connections with zero remaining leases were closed cleanly.
      expect(opened.get(compA.key)?.close).toHaveBeenCalled();
      expect(opened.get(compC.key)?.close).toHaveBeenCalled();
      expect(opened.get(compB.key)?.close).not.toHaveBeenCalled();
    } finally {
      engine.stop();
      internal.connections = originalConnections;
    }
  });

  it("keeps metadata-only leases alive across active-computer switches without crashing when switching back", () => {
    const compA = fakeComputer("mac-a", "Mac Studio");
    const compB = fakeComputer("mac-b", "MacBook Pro");
    const opened = new Map<string, ReturnType<typeof fakeConnection>>();
    const pool = new ComputerConnections((computer) => {
      const created = fakeConnection(computer);
      opened.set(computer.key, created);
      return { connection: created.connection, close: created.close };
    });

    const fleetLeaseA = pool.acquire(compA, { metadataOnly: true });
    const activeLeaseA = pool.acquire(compA);
    expect(opened.get(compA.key)?.streamsStart).toHaveBeenCalledTimes(1);

    // Switching away releases the active stream lease while fleet metadata still holds A open.
    const activeLeaseB = pool.acquire(compB);
    activeLeaseA.release();
    expect(opened.get(compA.key)?.streamsStop).toHaveBeenCalledTimes(1);
    expect(opened.get(compA.key)?.close).not.toHaveBeenCalled();

    // Switching back to A cleanly restarts streams on the reused connection.
    const activeLeaseA2 = pool.acquire(compA);
    expect(opened.get(compA.key)?.streamsStart).toHaveBeenCalledTimes(2);

    activeLeaseB.release();
    activeLeaseA2.release();
    fleetLeaseA.release();
    expect(opened.get(compA.key)?.close).toHaveBeenCalledTimes(1);
    expect(opened.get(compB.key)?.close).toHaveBeenCalledTimes(1);
  });

  it("handles DESKTOP_LOCAL gracefully when selected repeatedly", () => {
    const local: Computer = {
      key: DESKTOP_LOCAL,
      gateway: DESKTOP_LOCAL,
      machine: { id: "local", name: "This Mac", platform: "darwin", online: true, via: "paired" },
    };
    expect(() => {
      engine.select(local);
      engine.select(local);
    }).not.toThrow();
  });
});
