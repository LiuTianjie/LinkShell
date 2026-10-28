import { expect, it } from "vitest";
import {
  compactNumber,
  gatewayLabel,
  isManageView,
  managePage,
  manageView,
  membershipOf,
  newerVersion,
  parseHostLog,
  passwordProblem,
  redemptionProblem,
  serviceLabel,
  splitPath,
} from "../src/live/management-model";

it("routes management pages through one view id", () => {
  expect(manageView()).toBe("manage");
  expect(manageView("usage")).toBe("manage:usage");
  expect(isManageView("manage")).toBe(true);
  expect(isManageView("manage:log")).toBe(true);
  expect(isManageView("management")).toBe(false);
  expect(managePage("manage")).toBe("overview");
  expect(managePage("manage:password")).toBe("password");
  expect(managePage("manage:nothing")).toBe("overview");
});

it("reads membership the way the native dashboard did", () => {
  const now = Date.parse("2026-10-28T00:00:00Z");
  expect(membershipOf(undefined, now)).toEqual({ kind: "signed-out" });
  expect(membershipOf({ state: "signed-in", plan: "free" }, now)).toEqual({ kind: "free" });
  expect(membershipOf({ state: "signed-in", plan: "pro" }, now)).toEqual({ kind: "unknown" });
  expect(membershipOf({ state: "signed-in", plan: "pro", planExpiresAt: "garbage" }, now)).toEqual({ kind: "unknown" });
  // An expired Pro is a free account; a current one carries its date.
  expect(membershipOf({ state: "signed-in", plan: "pro", planExpiresAt: "2026-10-01T00:00:00Z" }, now)).toEqual({ kind: "free" });
  const pro = membershipOf({ state: "signed-in", plan: "pro", planExpiresAt: "2026-12-01T00:00:00.000Z" }, now);
  expect(pro.kind).toBe("pro");
});

it("checks passwords and activation codes before they leave the page", () => {
  expect(passwordProblem("abc")).toBeDefined();
  expect(passwordProblem("abcd")).toBeUndefined();
  expect(passwordProblem("x".repeat(128))).toBeUndefined();
  expect(passwordProblem("x".repeat(129))).toBeDefined();
  expect(redemptionProblem("   ")).toBeDefined();
  expect(redemptionProblem(" CODE-1 ")).toBeUndefined();
  expect(redemptionProblem("码".repeat(200))).toBeDefined();
});

it("labels the service and gateway, unknown unless healthy", () => {
  expect(serviceLabel({ status: "running" }, undefined)).toBe("运行中");
  expect(serviceLabel({ status: "running" }, "broken")).toBe("状态未知");
  expect(serviceLabel(undefined, undefined)).toBe("正在连接");
  expect(gatewayLabel({ status: "running", gateway: { status: "online", devices: [] } }, true)).toBe("已连接");
  expect(gatewayLabel({ status: "running", gateway: { status: "online", devices: [] } }, false)).toBe("未知");
});

it("compares versions numerically and shortens large numbers", () => {
  expect(newerVersion("0.10.10", "0.10.9")).toBe(true);
  expect(newerVersion("0.10.9", "0.10.10")).toBe(false);
  expect(newerVersion("1.0", "1.0.0")).toBe(false);
  expect(compactNumber(999)).toBe("999");
  expect(compactNumber(12_800_000)).toBe("12.8M");
});

it("reads the Host's log as stamped entries, a trace kept with its line", () => {
  const log = [
    "t] Codex: v0.162.1",
    "2026-10-28T09:37:13.279Z [host] Claude: v2.1.308",
    "2026-10-28T09:38:35.164Z [rpc] agents.models failed: TypeError",
    "    at HostRpcServer.dispatch (server.js:518:26)",
    "2026-10-28T09:38:36.000Z no source",
    "",
  ].join("\n");
  expect(parseHostLog(log)).toEqual([
    { at: Date.parse("2026-10-28T09:37:13.279Z"), tag: "host", text: "Claude: v2.1.308" },
    { at: Date.parse("2026-10-28T09:38:35.164Z"), tag: "rpc", text: "agents.models failed: TypeError\n    at HostRpcServer.dispatch (server.js:518:26)" },
    { at: Date.parse("2026-10-28T09:38:36.000Z"), tag: undefined, text: "no source" },
  ]);
  // A message without stamps (no log yet, a read error) is shown as it is.
  expect(parseHostLog("暂无日志。")).toEqual([{ text: "暂无日志。" }]);
});

it("keeps a path's last component whole when it is cut in the middle", () => {
  expect(splitPath("/Users/me/.linkshell/host.log")).toEqual(["/Users/me/.linkshell", "/host.log"]);
  expect(splitPath("/tmp/linkshell-electron-home")).toEqual(["/tmp", "/linkshell-electron-home"]);
  const long = `/a/${"x".repeat(40)}`;
  expect(splitPath(long).join("")).toBe(long);
  expect(splitPath(long)[1]).toHaveLength(16);
});
