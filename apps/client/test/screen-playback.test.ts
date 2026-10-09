import { describe, expect, it } from "vitest";
import { initialScreenPlayback, screenPlayback } from "../src/lib/screen-playback";

describe("automatic screen playback", () => {
  it("starts with the native receiver where available, otherwise the standard receiver", () => {
    expect(initialScreenPlayback(true).mode).toBe("native");
    expect(initialScreenPlayback(false).mode).toBe("standard");
  });

  it("tries standard video before the relay and does not loop after the last route", () => {
    let state = initialScreenPlayback(true);
    state = screenPlayback(state, { type: "unavailable", mode: "native", generation: 0 });
    expect(state.mode).toBe("standard");
    expect(screenPlayback(state, { type: "unavailable", mode: "native", generation: 0 })).toBe(state);
    state = screenPlayback(state, { type: "unavailable", mode: "standard", generation: 0 });
    expect(state.mode).toBe("relay");
    expect(screenPlayback(state, { type: "unavailable", mode: "relay", generation: 0 })).toBe(state);
  });

  it("retries the native path on a new attempt while ignoring callbacks from the old attempt", () => {
    let state = initialScreenPlayback(true);
    state = screenPlayback(state, { type: "unavailable", mode: "native", generation: 0 });
    state = screenPlayback(state, { type: "restart", nativeAvailable: true });
    expect(state).toEqual({ mode: "native", generation: 1 });
    expect(screenPlayback(state, { type: "unavailable", mode: "native", generation: 0 })).toBe(state);
    expect(screenPlayback(state, { type: "unavailable", mode: "standard", generation: 0 })).toBe(state);
  });
});
