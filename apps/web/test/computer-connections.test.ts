import { expect, it, vi } from "vitest";
import { ComputerConnections } from "../src/live/computer-connections";
import type { Computer, Connection } from "../src/live/engine";

const computer = (key: string) => ({ key }) as Computer;
const connection = (computer: Computer) => ({ computer, streams: { start: vi.fn(), stop: vi.fn() } }) as unknown as Connection;
it("keeps a screen connected when the workspace switches to another computer", () => {
  const close = vi.fn();
  const open = vi.fn((computer: Computer) => ({ connection: connection(computer), close: () => close(computer.key) }));
  const pool = new ComputerConnections(open);
  const selected = pool.acquire(computer("mac")), screen = pool.acquire(computer("mac"));
  expect(open).toHaveBeenCalledTimes(1);
  expect(selected.connection).toBe(screen.connection);
  const other = pool.acquire(computer("linux"));
  selected.release(); selected.release();
  expect(close).not.toHaveBeenCalled();
  screen.release();
  expect(close.mock.calls).toEqual([["mac"]]);
  expect(pool.values()).toEqual([other.connection]);
  other.release();
  expect(close.mock.calls).toEqual([["mac"], ["linux"]]);
});

it("closes every tunnel on logout without letting an old card close a new login's tunnel", () => {
  const close = vi.fn();
  const pool = new ComputerConnections((computer) => ({ connection: connection(computer), close }));
  const old = pool.acquire(computer("mac")); pool.acquire(computer("linux"));
  pool.clear();
  expect(close).toHaveBeenCalledTimes(2);
  const fresh = pool.acquire(computer("mac")); old.release();
  expect(pool.values()).toEqual([fresh.connection]);
  pool.remove("mac"); fresh.release();
  expect(close).toHaveBeenCalledTimes(3);
});

it("stops an unused bulk connection while the project overview keeps its RPC tunnel, and respects screen leases", () => {
  const close = vi.fn();
  const pool = new ComputerConnections((computer) => ({ connection: connection(computer), close }));
  const overview = pool.acquire(computer("mac"), { metadataOnly: true });
  const streams = overview.connection.streams;
  expect(streams.start).not.toHaveBeenCalled();
  const selected = pool.acquire(computer("mac"));
  expect(selected.connection).toBe(overview.connection);
  expect(streams.start).toHaveBeenCalledTimes(1);
  const other = pool.acquire(computer("linux"));
  selected.release(); selected.release();
  expect(streams.stop).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  expect(pool.values()).toContain(overview.connection);
  const selectedAgain = pool.acquire(computer("mac"));
  const screen = pool.acquire(computer("mac"));
  expect(streams.start).toHaveBeenCalledTimes(2);
  selectedAgain.release();
  expect(streams.stop).toHaveBeenCalledTimes(1);
  screen.release();
  expect(streams.stop).toHaveBeenCalledTimes(2);
  expect(close).not.toHaveBeenCalled();
  overview.release(); other.release();
  expect(close).toHaveBeenCalledTimes(2);
});
