import { describe, expect, it } from "vitest";
import { judgeWifi } from "../src/commands/wifi.js";

const report = (channel?: string) => ({
  SPAirPortDataType: [{
    spairport_airport_interfaces: [
      { _name: "en0", ...(channel ? { spairport_current_network_information: { spairport_network_channel: channel } } : {}) },
      { _name: "awdl0" },
    ],
  }],
});

describe("Wi-Fi channel check", () => {
  it("is quiet on the channel AWDL shares", () => {
    expect(judgeWifi(report("149 (5GHz, 80MHz)"))).toEqual({ ok: true, detail: "channel 149 (5GHz, 80MHz)" });
  });

  it("names the stutter and the remedy on another 5 GHz channel", () => {
    expect(judgeWifi(report("157 (5GHz, 80MHz)"))?.detail).toMatch(/^channel 157 .*channel 149/);
  });

  it("points a 2.4 GHz network to 5 GHz", () => {
    expect(judgeWifi(report("6 (2GHz, 20MHz)"))?.detail).toMatch(/5 GHz network on channel 149/);
  });

  it("says nothing without a joined network or a readable report", () => {
    expect(judgeWifi(report())).toBeUndefined();
    expect(judgeWifi({})).toBeUndefined();
    expect(judgeWifi(null)).toBeUndefined();
  });

  it("does not mistake a low-numbered 6 GHz channel for 2.4 GHz", () => {
    expect(judgeWifi(report("5 (6GHz, 160MHz)"))).toEqual({ ok: true, detail: "channel 5 (6GHz, 160MHz)" });
  });
});
