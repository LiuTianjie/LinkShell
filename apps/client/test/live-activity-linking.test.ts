import { describe, expect, it } from "vitest";
import { extractExpoPathFromURL } from "expo-router/build/fork/extractPathFromURL";
import { redirectSystemPath } from "../src/app/+native-intent";

const computer = "wss://gateway.itool.tech#oxQ5_VGrQw5CrpjHcnVZkQ";

function parse(path: string, initial: boolean) {
  const redirected = redirectSystemPath({ path, initial });
  expect(redirected).not.toBeNull();
  return new URL(extractExpoPathFromURL([], redirected!), "https://local/");
}

describe("Live Activity native deep links", () => {
  for (const scheme of ["linkshell", "linkshell-dev"]) {
    for (const initial of [true, false]) {
      it(`keeps the exact computer and session through Expo (${scheme}, initial=${initial})`, () => {
        const url = parse(`${scheme}:///activity?computer=${encodeURIComponent(computer)}&session=task%23one%26two`, initial);
        expect(url.pathname).toBe("/activity");
        expect(url.searchParams.get("computer")).toBe(computer);
        expect(url.searchParams.get("session")).toBe("task#one&two");
        expect(url.hash).toBe("");
      });
    }
  }
  it("keeps collection filters and already-relative routes", () => {
    for (const prefix of ["linkshell-dev://", ""]) {
      const url = parse(`${prefix}/activity?computer=${encodeURIComponent(computer)}&filter=attention`, false);
      expect(url.searchParams.get("computer")).toBe(computer);
      expect(url.searchParams.get("filter")).toBe("attention");
    }
  });
  it("leaves pairing and external URLs intact and suppresses OAuth callback routes", () => {
    for (const path of ["linkshell://pair?code=123456", "https://example.com/activity?computer=other"]) {
      expect(redirectSystemPath({ path, initial: true })).toBe(path);
    }
    for (const path of ["auth-callback?code=abc", "linkshell://auth-callback?code=abc", "linkshell-dev:///auth-callback?code=abc"]) {
      expect(redirectSystemPath({ path, initial: false })).toBeNull();
    }
  });
});
