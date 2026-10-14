import { expect, it } from "vitest";
import { screenComputerKey, screenView } from "../src/live/screen-route";

it("preserves the gateway and device identity across a detail URL round trip", () => {
  const key = "wss://gateway.example:8787#machine+a/b=中文";
  const hash = new URLSearchParams({ view: screenView(key) }).toString();
  expect(screenComputerKey(new URLSearchParams(hash).get("view")!)).toBe(key);
});

it("keeps the desktop list and agent session routes separate from device details", () => {
  for (const view of ["screen", "screen:", "codex:screen:abc", "claude:abc", "home"]) {
    expect(screenComputerKey(view)).toBeUndefined();
  }
});
