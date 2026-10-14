import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  computerName,
  computerOption,
  createComputerNames,
  parseComputerNames,
} from "../src/live/computer-names";
import type { Computer } from "../src/live/engine";

const computer = (id: string, gateway = "wss://one.example") =>
  ({
    key: `${gateway}#${id}`,
    gateway,
    machine: { id, name: "Mac.lan", online: true, platform: "darwin" },
  }) as Computer;

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("persists a user name per computer and gateway without changing the host identity", () => {
  const first = computer("abc12345"),
    second = computer("def67890"),
    otherGateway = computer("abc12345", "wss://two.example");
  const names = createComputerNames();
  names.rename(first, "  办公室 Mac mini  ");
  const restored = createComputerNames();
  expect(computerName(first, restored.store.getState())).toBe(
    "办公室 Mac mini",
  );
  expect(computerName(second, restored.store.getState())).toBe("Mac.lan");
  expect(computerName(otherGateway, restored.store.getState())).toBe("Mac.lan");
  expect(first.machine.name).toBe("Mac.lan");
  expect(computerOption(first, restored.store.getState())).toContain(
    "abc12345",
  );
  restored.rename(first, " ");
  expect(computerName(first, createComputerNames().store.getState())).toBe(
    "Mac.lan",
  );
});

it("retains edits made by another tab and survives presence/hostname refresh", () => {
  const first = computer("abc12345"),
    second = computer("def67890");
  const tabOne = createComputerNames(),
    tabTwo = createComputerNames();
  tabOne.rename(first, "办公室");
  tabTwo.rename(second, "家里");
  const refreshed = {
    ...first,
    machine: { ...first.machine, name: "New Hostname", online: false },
  };
  expect(computerName(refreshed, tabTwo.store.getState())).toBe("办公室");
  expect(computerName(second, createComputerNames().store.getState())).toBe(
    "家里",
  );
});

it("does not report success when storage is unavailable or input is too long", () => {
  const names = createComputerNames(),
    first = computer("abc12345");
  names.rename(first, "办公室");
  expect(() => names.rename(first, "字".repeat(41))).toThrow("40");
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });
  expect(() => names.rename(first, "家里")).toThrow("名称未保存");
  expect(computerName(first, names.store.getState())).toBe("办公室");
});

it("ignores malformed saved names", () => {
  expect(parseComputerNames(["invalid"])).toEqual({});
  expect(
    parseComputerNames({
      a: 2,
      b: "",
      c: " ",
      d: "字".repeat(41),
      e: "办公室",
    }),
  ).toEqual({ e: "办公室" });
});
