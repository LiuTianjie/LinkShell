import { expect, it, vi } from "vitest";
import { ComputerConnections } from "../src/live/computer-connections";
import type { Computer, Connection } from "../src/live/engine";

const computer = (key: string) => ({ key }) as Computer;
it("keeps a screen connected when the workspace switches to another computer", () => {
  const close = vi.fn();
  const open = vi.fn((computer: Computer) => ({ connection: { computer } as Connection, close: () => close(computer.key) }));
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
  const pool = new ComputerConnections((computer) => ({ connection: { computer } as Connection, close }));
  const old = pool.acquire(computer("mac")); pool.acquire(computer("linux"));
  pool.clear();
  expect(close).toHaveBeenCalledTimes(2);
  const fresh = pool.acquire(computer("mac")); old.release();
  expect(pool.values()).toEqual([fresh.connection]);
  pool.remove("mac"); fresh.release();
  expect(close).toHaveBeenCalledTimes(3);
});
