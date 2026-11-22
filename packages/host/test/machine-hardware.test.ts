import { expect, it } from "vitest";
import { machineInfoSchema, methods } from "@linkshell/wire";
import { macHardware } from "../src/machine-form-factor.js";

it("keeps Apple's hardware family across generic Apple silicon IDs and named Intel IDs, without guessing unknown models", () => {
  expect(macHardware("MacBook Pro (14-inch, Nov 2023)", "Mac15,10")).toMatchObject({ hardwareModel: { family: "MacBook Pro", productName: "MacBook Pro (14-inch, Nov 2023)" } });
  expect(macHardware(undefined, "MacBookAir10,1")).toMatchObject({ formFactor: "notebook", hardwareModel: { family: "MacBook Air" } });
  expect(macHardware("Mac mini", "Mac16,10")).toMatchObject({ formFactor: "mac-mini", hardwareModel: { family: "Mac mini" } });
  expect(macHardware("Mac Studio (2023)", "Mac14,13")).toMatchObject({ formFactor: "desktop", hardwareModel: { family: "Mac Studio", productName: "Mac Studio (2023)" } });
  expect(macHardware("iMac (24-inch, 2024)", "Mac16,2")).toMatchObject({ formFactor: "all-in-one", hardwareModel: { family: "iMac", productName: "iMac (24-inch, 2024)" } });
  expect(macHardware("air3", "Mac15,10")).toBeUndefined();
});

it("validates machine.artwork RPC params/results and drops malformed hardwareModel fields safely", () => {
  const validId = "a".repeat(64);
  expect(methods["machine.artwork"].params.parse({ id: validId })).toEqual({ id: validId });
  expect(() => methods["machine.artwork"].params.parse({ id: "not-a-sha256" })).toThrow();
  expect(methods["machine.artwork"].result.parse({ webp: "UklGRg==" })).toEqual({ webp: "UklGRg==" });
  expect(methods["machine.artwork"].result.parse({})).toEqual({});
  expect(machineInfoSchema.parse({
    machineId: "m1",
    hostname: "air3",
    platform: "darwin",
    hostVersion: "0.4.110",
    agents: [],
    hardwareModel: { family: "Future Mac" },
  }).hardwareModel).toBeUndefined();
});
