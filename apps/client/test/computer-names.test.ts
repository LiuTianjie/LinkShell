import { beforeEach, expect, it, vi } from "vitest";
import type { Computer } from "../src/lib/computers";

const storage = vi.hoisted(() => ({ value: "{}", write: vi.fn() }));
vi.mock("expo-sqlite/kv-store", () => ({ default: {
  getItemSync: () => storage.value,
  setItemSync: (_key: string, value: string) => { storage.write(value); storage.value = value; },
} }));
const computer = { key: "gateway#machine-a", kind: "relay", gateway: "wss://example.test", machine: { id: "machine-a", name: "server-a", online: false } } as Computer;
beforeEach(() => { vi.resetModules(); storage.value = "{}"; storage.write.mockReset(); });

it("keeps offline aliases after reload and restores the latest gateway name without changing identity", async () => {
  const { renameComputer, useComputerNames, computerDisplayName } = await import("../src/lib/computer-names");
  const before = structuredClone(computer);
  renameComputer(computer.key, "  办公室电脑  ");
  renameComputer("direct:ws://localhost:7878", "开发机");
  expect(computerDisplayName(computer, useComputerNames.getState().names)).toBe("办公室电脑");
  expect(computer).toEqual(before);
  vi.resetModules();
  const reloaded = await import("../src/lib/computer-names");
  expect(reloaded.computerDisplayName(computer, reloaded.useComputerNames.getState().names)).toBe("办公室电脑");
  reloaded.renameComputer(computer.key, "   ");
  expect(reloaded.computerDisplayName(computer, reloaded.useComputerNames.getState().names)).toBe("server-a");
  expect(reloaded.useComputerNames.getState().names["direct:ws://localhost:7878"]).toBe("开发机");
});

it("does not report a saved name when persistence fails", async () => {
  const { renameComputer, useComputerNames } = await import("../src/lib/computer-names");
  renameComputer(computer.key, "原来的别名");
  storage.write.mockImplementationOnce(() => { throw new Error("disk full"); });
  expect(() => renameComputer(computer.key, "新别名")).toThrow("名称未保存");
  expect(useComputerNames.getState().names[computer.key]).toBe("原来的别名");
  expect(() => renameComputer(computer.key, "名".repeat(41))).toThrow("40");
});
