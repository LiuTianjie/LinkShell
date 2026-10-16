import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const configure = require("../app.config.js") as (input: { config: Record<string, unknown> }) => { ios: { entitlements?: Record<string, string>; infoPlist?: Record<string, unknown> } };
afterEach(() => vi.unstubAllEnvs());

it("leaves remote updates out of the public build", () => {
  vi.stubEnv("LINKSHELL_LIVE_ACTIVITY_PUSH", ""); vi.stubEnv("APP_VARIANT", "");
  const app = configure({ config: { ios: { bundleIdentifier: "com.bd.linkshell" } } });
  expect(app.ios.infoPlist?.LinkShellLiveActivityPushURL).toBeUndefined();
  expect(app.ios.entitlements?.["aps-environment"]).toBeUndefined();
});

it("uses only production APNs in the official build, with no client secret", () => {
  vi.stubEnv("LINKSHELL_LIVE_ACTIVITY_PUSH", "1"); vi.stubEnv("APP_VARIANT", ""); vi.stubEnv("LINKSHELL_PUSH_SERVICE_URL", "");
  const app = configure({ config: { ios: { bundleIdentifier: "com.bd.linkshell" } } });
  expect(app.ios.entitlements?.["aps-environment"]).toBe("production");
  expect(app.ios.infoPlist).toEqual({ LinkShellLiveActivityPushURL: "https://push.itool.tech", LinkShellURLScheme: "linkshell" });
});

it("rejects the production push service for development and rejects insecure service URLs", () => {
  vi.stubEnv("LINKSHELL_LIVE_ACTIVITY_PUSH", "1"); vi.stubEnv("APP_VARIANT", "development");
  vi.stubEnv("LINKSHELL_PUSH_SERVICE_URL", "");
  expect(() => configure({ config: {} })).toThrow(/sandbox/);
  vi.stubEnv("APP_VARIANT", ""); vi.stubEnv("LINKSHELL_PUSH_SERVICE_URL", "http://push.itool.tech");
  expect(() => configure({ config: {} })).toThrow(/HTTPS/);
});

it("keeps a development push service and URL scheme separate from production", () => {
  vi.stubEnv("LINKSHELL_LIVE_ACTIVITY_PUSH", "1"); vi.stubEnv("APP_VARIANT", "development");
  vi.stubEnv("LINKSHELL_PUSH_SERVICE_URL", "https://push-dev.itool.tech");
  const app = configure({ config: {} });
  expect(app.ios.entitlements?.["aps-environment"]).toBe("development");
  expect(app.ios.infoPlist).toEqual({ LinkShellLiveActivityPushURL: "https://push-dev.itool.tech", LinkShellURLScheme: "linkshell-dev" });
});
