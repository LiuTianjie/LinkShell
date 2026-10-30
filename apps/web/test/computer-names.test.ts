import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostLink } from "@linkshell/client-core";
import type { MachineInfo } from "@linkshell/wire";
import {
  computerName,
  computerOption,
  createComputerNames,
  parseComputerNames,
} from "../src/live/computer-names";
import type { Computer } from "../src/live/engine";

const KEY = "linkshell.web.computer-names";
const computer = (id: string, gateway = "wss://one.example") =>
  ({
    key: `${gateway}#${id}`,
    gateway,
    machine: { id, name: "Mac.lan", online: true, platform: "darwin" },
  }) as Computer;
const machineInfo = (name: string, configured = true): MachineInfo => ({
  machineId: "host-id", hostname: name, platform: "darwin", hostVersion: "test", agents: [],
  naming: { defaultName: "Mac.lan", configured, ...(name !== "Mac.lan" ? { customName: name } : {}) },
});
const rpc = (machine: MachineInfo) => {
  const call = vi.fn().mockResolvedValue(machine);
  return { link: { call } as Pick<HostLink, "call">, call };
};

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps legacy aliases until the host has an explicitly configured shared name", () => {
  const first = computer("abc12345");
  localStorage.setItem(KEY, JSON.stringify({ [first.key]: "旧浏览器别名" }));
  const names = createComputerNames();
  names.sync(first, machineInfo("Mac.lan", false));
  names.remember(first);
  expect(computerName(first, names.store.getState())).toBe("旧浏览器别名");
  expect(computerName(first, createComputerNames().store.getState())).toBe("旧浏览器别名");
});

it("writes through the host before replacing an alias and keeps a reset authoritative after reload", async () => {
  const first = computer("abc12345"), second = computer("def67890");
  const identity = structuredClone(first);
  localStorage.setItem(KEY, JSON.stringify({ [first.key]: "旧别名", [second.key]: "另一台电脑" }));
  const names = createComputerNames();
  const { link, call } = rpc(machineInfo("办公室 Mac mini"));
  await names.rename(first, "  办公室 Mac mini  ", link);
  expect(call).toHaveBeenCalledWith("machine.rename", { name: "办公室 Mac mini" });
  expect(names.store.getState()[first.key]).toBeUndefined();
  expect(names.store.getState()[`@shared:${first.key}`]).toBe("办公室 Mac mini");
  expect(computerName(first, createComputerNames().store.getState())).toBe("办公室 Mac mini");
  expect(first).toEqual(identity);
  expect(computerOption(first, names.store.getState())).toContain("abc12345");

  call.mockResolvedValueOnce(machineInfo("Mac.lan"));
  await names.rename(first, " ", link);
  expect(call).toHaveBeenLastCalledWith("machine.rename", { name: "" });
  const restored = createComputerNames();
  expect(computerName(first, restored.store.getState())).toBe("Mac.lan");
  expect(restored.store.getState()[first.key]).toBeUndefined();
  expect(computerName(second, restored.store.getState())).toBe("另一台电脑");
  expect(computerName(computer("abc12345", "wss://two.example"), restored.store.getState())).toBe("Mac.lan");
});

it("prefers fresh gateway names over shared caches and retains authority after offline metadata loses its marker", () => {
  const first = computer("abc12345"), second = computer("def67890");
  localStorage.setItem(KEY, JSON.stringify({ [first.key]: "旧别名", [`@shared:${first.key}`]: "旧共享名" }));
  const tabOne = createComputerNames(), tabTwo = createComputerNames();
  const announced = { ...first, machine: { ...first.machine, name: "新共享名", namingConfigured: true } };
  expect(computerName(announced, tabOne.store.getState())).toBe("新共享名");
  tabOne.remember(announced);
  tabTwo.sync(second, machineInfo("家里"));
  const restored = createComputerNames();
  const offline = { ...first, machine: { ...first.machine, online: false } };
  expect(computerName(offline, restored.store.getState())).toBe("新共享名");
  expect(restored.store.getState()[first.key]).toBeUndefined();
  expect(computerName(second, restored.store.getState())).toBe("家里");
});

it("leaves caches unchanged on RPC failure but does not deny a successful host rename when local storage fails", async () => {
  const first = computer("abc12345");
  localStorage.setItem(KEY, JSON.stringify({ [first.key]: "原来的别名" }));
  const names = createComputerNames();
  const { link, call } = rpc(machineInfo("新共享名"));
  call.mockRejectedValueOnce(new Error("电脑已离线"));
  await expect(names.rename(first, "新共享名", link)).rejects.toThrow("电脑已离线");
  expect(names.store.getState()).toEqual({ [first.key]: "原来的别名" });
  expect(createComputerNames().store.getState()).toEqual(names.store.getState());
  await expect(names.rename(first, "字".repeat(41), link)).rejects.toThrow("40");
  expect(call).toHaveBeenCalledTimes(1);
  vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => { throw new Error("QuotaExceededError"); });
  await expect(names.rename(first, "新共享名", link)).resolves.toMatchObject({ hostname: "新共享名" });
  expect(computerName(first, names.store.getState())).toBe("新共享名");
  expect(names.store.getState()[first.key]).toBeUndefined();
});

it("retains unsaved shared names across other computers syncing, while accepting a newer shared name from another tab", async () => {
  const first = computer("abc12345"), second = computer("def67890");
  localStorage.setItem(KEY, JSON.stringify({ [first.key]: "旧别名", [`@shared:${first.key}`]: "之前的共享名" }));
  const writeFromAnotherTab = localStorage.setItem.bind(localStorage);
  const names = createComputerNames();
  const { link, call } = rpc(machineInfo("Mac.lan"));
  const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });

  await names.rename(first, "", link);
  names.sync(second, machineInfo("家里"));
  names.refresh();
  expect(computerName(first, names.store.getState())).toBe("Mac.lan");
  expect(names.store.getState()[first.key]).toBeUndefined();

  call.mockResolvedValueOnce(machineInfo("办公室"));
  await names.rename(first, "办公室", link);
  names.sync(second, machineInfo("家里电脑"));
  expect(computerName(first, names.store.getState())).toBe("办公室");
  expect(names.store.getState()[first.key]).toBeUndefined();

  writeFromAnotherTab(KEY, JSON.stringify({ [`@shared:${first.key}`]: "另一个标签页的新名称" }));
  names.refresh();
  names.sync(second, machineInfo("家里电脑"));
  expect(computerName(first, names.store.getState())).toBe("另一个标签页的新名称");
  write.mockRestore();
  names.sync(second, machineInfo("家里电脑"));
  const restored = createComputerNames();
  expect(computerName(first, restored.store.getState())).toBe("另一个标签页的新名称");
  expect(computerName(second, restored.store.getState())).toBe("家里电脑");
  expect(restored.store.getState()[first.key]).toBeUndefined();
});

it("ignores malformed legacy names while retaining longer host default names in shared caches", () => {
  expect(parseComputerNames(["invalid"])).toEqual({});
  expect(parseComputerNames({
    a: 2, b: "", c: " ", d: "字".repeat(41), e: "办公室",
    "@shared:valid-host": "a".repeat(80), "@shared:too-long": "a".repeat(121),
  })).toEqual({ e: "办公室", "@shared:valid-host": "a".repeat(80) });
});
