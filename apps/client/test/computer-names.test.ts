import { beforeEach, expect, it, vi } from "vitest";
import type { HostLink } from "@linkshell/client-core";
import type { MachineInfo } from "@linkshell/wire";
import type { Computer } from "../src/lib/computers";

const mocks = vi.hoisted(() => ({ value: "{}", write: vi.fn(), subscribe: vi.fn(), updateComputerName: vi.fn() }));
vi.mock("expo-sqlite/kv-store", () => ({ default: {
  getItemSync: () => mocks.value,
  setItemSync: (_key: string, value: string) => { mocks.write(value); mocks.value = value; },
} }));
vi.mock("../src/lib/computers", () => ({
  updateComputerName: mocks.updateComputerName,
  useComputers: { subscribe: mocks.subscribe },
}));
const computer = { key: "wss://example.test#machine-a", kind: "relay", gateway: "wss://example.test", machine: { id: "machine-a", name: "server-a", online: false } } as Extract<Computer, { kind: "relay" }>;
const machineInfo = (name: string, configured = true): MachineInfo => ({
  machineId: "host-id", hostname: name, platform: "darwin", hostVersion: "test", agents: [],
  naming: { defaultName: "server-a", configured, ...(name !== "server-a" ? { customName: name } : {}) },
});
const rpc = (machine: MachineInfo) => {
  const call = vi.fn().mockResolvedValue(machine);
  return { link: { call } as Pick<HostLink, "call">, call };
};

beforeEach(() => {
  vi.resetModules();
  mocks.value = "{}";
  mocks.write.mockReset();
  mocks.subscribe.mockReset();
  mocks.updateComputerName.mockReset();
});

it("preserves a legacy alias until explicit shared rename/reset, then keeps authority after reload", async () => {
  mocks.value = JSON.stringify({ [computer.key]: "旧手机别名", "direct:ws://localhost:7878": "开发机" });
  const names = await import("../src/lib/computer-names");
  names.syncComputerName(computer, machineInfo("server-a", false));
  expect(names.computerDisplayName(computer, names.useComputerNames.getState().names)).toBe("旧手机别名");
  expect(mocks.write).not.toHaveBeenCalled();
  const before = structuredClone(computer);
  const { link, call } = rpc(machineInfo("办公室电脑"));
  await names.renameComputer(computer, "  办公室电脑  ", link);
  expect(call).toHaveBeenCalledWith("machine.rename", { name: "办公室电脑" });
  expect(names.useComputerNames.getState().names[computer.key]).toBeUndefined();
  expect(names.useComputerNames.getState().names[`@shared:${computer.key}`]).toBe("办公室电脑");
  expect(mocks.updateComputerName).toHaveBeenLastCalledWith(computer, "办公室电脑", true);
  expect(computer).toEqual(before);

  call.mockResolvedValueOnce(machineInfo("server-a"));
  await names.renameComputer(computer, "   ", link);
  expect(call).toHaveBeenLastCalledWith("machine.rename", { name: "" });
  vi.resetModules();
  const restored = await import("../src/lib/computer-names");
  expect(restored.computerDisplayName(computer, restored.useComputerNames.getState().names)).toBe("server-a");
  expect(restored.useComputerNames.getState().names[computer.key]).toBeUndefined();
  expect(restored.useComputerNames.getState().names["direct:ws://localhost:7878"]).toBe("开发机");
});

it("learns a configured name from gateway discovery and prevents stale aliases from returning offline", async () => {
  mocks.value = JSON.stringify({ [computer.key]: "旧别名", [`@shared:${computer.key}`]: "旧共享名" });
  const names = await import("../src/lib/computer-names");
  const announced = { ...computer, machine: { ...computer.machine, name: "最新共享名", online: true, namingConfigured: true } };
  expect(names.computerDisplayName(announced, names.useComputerNames.getState().names)).toBe("最新共享名");
  const changed = mocks.subscribe.mock.calls[0]![0] as (state: unknown, previous: unknown) => void;
  changed({ live: { [computer.gateway]: [announced.machine] } }, { live: {} });
  expect(names.useComputerNames.getState().names[computer.key]).toBeUndefined();
  vi.resetModules();
  const restored = await import("../src/lib/computer-names");
  expect(restored.computerDisplayName(computer, restored.useComputerNames.getState().names)).toBe("最新共享名");
});

it("does not mutate caches when RPC fails or an invalid name is rejected", async () => {
  mocks.value = JSON.stringify({ [computer.key]: "原来的别名" });
  const names = await import("../src/lib/computer-names");
  const { link, call } = rpc(machineInfo("新共享名"));
  call.mockRejectedValueOnce(new Error("电脑已离线"));
  await expect(names.renameComputer(computer, "新共享名", link)).rejects.toThrow("电脑已离线");
  await expect(names.renameComputer(computer, "名".repeat(41), link)).rejects.toThrow("40");
  expect(call).toHaveBeenCalledTimes(1);
  expect(names.useComputerNames.getState().names).toEqual({ [computer.key]: "原来的别名" });
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.updateComputerName).not.toHaveBeenCalled();
});

it("accepts a successful host rename even when the phone cannot persist its local cache", async () => {
  mocks.value = JSON.stringify({ [computer.key]: "旧手机别名" });
  const names = await import("../src/lib/computer-names");
  const { link } = rpc(machineInfo("新共享名"));
  mocks.write.mockImplementationOnce(() => { throw new Error("disk full"); });
  await expect(names.renameComputer(computer, "新共享名", link)).resolves.toMatchObject({ hostname: "新共享名" });
  expect(names.computerDisplayName(computer, names.useComputerNames.getState().names)).toBe("新共享名");
  expect(names.useComputerNames.getState().names[computer.key]).toBeUndefined();
  expect(mocks.updateComputerName).toHaveBeenCalledWith(computer, "新共享名", true);
});
