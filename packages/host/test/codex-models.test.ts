import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDriver } from "../src/drivers/codex/driver.js";
import type { CodexModel, CodexSettings } from "../src/drivers/codex/settings.js";
import type { SessionConfigOption, SessionUpdate } from "@linkshell/wire";

afterEach(() => vi.restoreAllMocks());

const model = (id: string): CodexModel => ({ id, model: id, displayName: id });
function driverWithRpc() {
  const driver = new CodexDriver({ socketPath: "/unused", hostVersion: "test", desktopBusPath: false, sharedSocketPath: false });
  const rpc = vi.spyOn(driver as unknown as { rpc: (method: string, params: Record<string, unknown>) => Promise<unknown> }, "rpc");
  return { driver, rpc };
}

function sessionConfig(driver: CodexDriver, settings: CodexSettings, memory = new Map<string, string>()) {
  const configs: SessionConfigOption[][] = [];
  const attached = new Set(["existing"]);
  Object.assign(driver, {
    attached,
    syncTasks: async () => {},
    settings: new Map([["existing", settings]]),
    host: { log: vi.fn(), state: () => memory, update: (_agent: string, _id: string, update: SessionUpdate) => {
      if (update.sessionUpdate === "ls_config") configs.push(update.options);
    } },
  });
  return {
    option: (id: string) => configs.at(-1)?.find((option) => option.id === id),
    close: () => { attached.clear(); driver.watched("existing", false); },
  };
}

describe("Codex model discovery", () => {
  it("reads every page again when a picker reopens, including newly available models", async () => {
    const { driver, rpc } = driverWithRpc();
    const models = [model("first"), model("second")];
    rpc.mockImplementation(async (method, params) => {
      if (method === "config/read") return { config: { model: "first" } };
      if (method === "model/list") return params.cursor
        ? { data: models.slice(1), nextCursor: null }
        : { data: models.slice(0, 1), nextCursor: "next" };
      throw new Error(`Unexpected method: ${method}`);
    });
    expect((await driver.listModels()).models.map((entry) => entry.value)).toEqual(["first", "second"]);
    models.push(model("new"));
    expect((await driver.listModels()).models.map((entry) => entry.value)).toEqual(["first", "second", "new"]);
    expect(rpc.mock.calls.filter(([method]) => method === "model/list")).toEqual([
      ["model/list", { includeHidden: false }], ["model/list", { includeHidden: false, cursor: "next" }],
      ["model/list", { includeHidden: false }], ["model/list", { includeHidden: false, cursor: "next" }],
    ]);
  });

  it("shares an in-flight listing and allows retry after a later refresh fails", async () => {
    const { driver, rpc } = driverWithRpc();
    let complete!: (value: unknown) => void;
    let page = new Promise<unknown>((resolve) => { complete = resolve; });
    rpc.mockImplementation(async (method) => method === "config/read" ? { config: {} } : page);
    const first = driver.listModels();
    const second = driver.listModels();
    expect(rpc.mock.calls.filter(([method]) => method === "model/list")).toHaveLength(1);
    complete({ data: [model("first")], nextCursor: null });
    expect((await Promise.all([first, second])).map((result) => result.models[0]?.value)).toEqual(["first", "first"]);

    page = Promise.reject(new Error("model service unavailable"));
    await expect(driver.listModels()).rejects.toThrow("model service unavailable");
    page = Promise.resolve({ data: [model("recovered")], nextCursor: null });
    expect((await driver.listModels()).models[0]?.value).toBe("recovered");
  });

  it("refreshes existing composers on re-entry after cache expiry and on explicit picker refresh", async () => {
    const { driver, rpc } = driverWithRpc();
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let models = [model("first")];
    let fail = false;
    rpc.mockImplementation(async (method) => {
      if (method === "config/read") return { config: { model: "first" } };
      if (method === "model/list") {
        if (fail) throw new Error("temporarily unavailable");
        return { data: models, nextCursor: null };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const configs: SessionConfigOption[][] = [];
    const attached = new Set(["existing"]);
    Object.assign(driver, {
      attached,
      syncTasks: async () => {},
      settings: new Map([["existing", { model: "first" }]]),
      host: { log: vi.fn(), state: () => new Map(), update: (_agent: string, _id: string, update: SessionUpdate) => {
        if (update.sessionUpdate === "ls_config") configs.push(update.options);
      } },
    });
    const latest = () => configs.at(-1)?.find((option) => option.category === "model");
    driver.watched("existing", true);
    await vi.waitFor(() => expect(latest()?.values.map((entry) => entry.value)).toEqual(["first"]));
    driver.watched("existing", false);
    driver.watched("existing", true);
    await Promise.resolve();
    expect(rpc.mock.calls.filter(([method]) => method === "model/list")).toHaveLength(1);

    now += 60_000;
    models = [model("first"), model("new")];
    driver.watched("existing", false);
    driver.watched("existing", true);
    await vi.waitFor(() => expect(latest()?.values.map((entry) => entry.value)).toEqual(["first", "new"]));
    expect(latest()?.current).toBe("first");

    models = [...models, model("newer")];
    await driver.listModels();
    expect(latest()?.values.map((entry) => entry.value)).toEqual(["first", "new", "newer"]);
    expect(latest()?.current).toBe("first");

    now += 60_000;
    fail = true;
    driver.watched("existing", false);
    driver.watched("existing", true);
    await expect(driver.listModels()).rejects.toThrow("temporarily unavailable");
    expect(latest()?.values.map((entry) => entry.value)).toEqual(["first", "new", "newer"]);
    attached.clear();
    driver.watched("existing", false);
  });

  it("publishes a known session's permissions and Plan when its first model request fails", async () => {
    const { driver, rpc } = driverWithRpc();
    rpc.mockRejectedValue(new Error("catalogue unavailable"));
    const state = sessionConfig(driver, { model: "first", sandbox: { type: "readOnly" } }, new Map([["overrides", JSON.stringify({ plan: true })]]));
    driver.watched("existing", true);
    await vi.waitFor(() => expect(state.option("permissions")?.current).toBe("read-only"));
    expect(state.option("permissions")?.values.map((value) => value.value)).toContain("auto");
    expect(state.option("plan")?.current).toBe("on");
    await expect(driver.listModels()).rejects.toThrow("catalogue unavailable");
    state.close();
  });

  it("announces a saved permission change with the last model choices when its follow-up refresh fails", async () => {
    const { driver, rpc } = driverWithRpc();
    let now = 1_000;
    let fail = false;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    rpc.mockImplementation(async (method) => {
      if (method === "config/read") return { config: { model: "first" } };
      if (fail) throw new Error("catalogue unavailable");
      return { data: [model("first"), model("second")], nextCursor: null };
    });
    await driver.listModels();
    const memory = new Map<string, string>();
    const save = memory.set.bind(memory);
    vi.spyOn(memory, "set").mockImplementation((key, value) => {
      save(key, value);
      // The setting is persisted before the subsequent catalogue read fails.
      if (key === "overrides") { now += 60_000; fail = true; }
      return memory;
    });
    const state = sessionConfig(driver, { model: "first", sandbox: { type: "readOnly" } }, memory);
    await driver.setConfig("existing", "permissions", "auto");
    expect(JSON.parse(memory.get("overrides")!)).toMatchObject({ permissions: "auto" });
    expect(state.option("permissions")?.current).toBe("auto");
    expect(state.option("model")?.current).toBe("first");
    expect(state.option("model")?.values.map((value) => value.value)).toEqual(["first", "second"]);
    await expect(driver.listModels()).rejects.toThrow("catalogue unavailable");
    state.close();
  });
});
