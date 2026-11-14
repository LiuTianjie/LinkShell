import { describe, expect, it } from "vitest";
import { gatewayAddress } from "@/lib/gateway-address";

describe("gatewayAddress", () => {
  it("takes an address with or without its scheme", () => {
    expect(gatewayAddress("wss://gateway.itool.tech")).toBe("wss://gateway.itool.tech");
    expect(gatewayAddress("  gateway.example.com  ")).toBe("wss://gateway.example.com");
    expect(gatewayAddress("ws://192.168.1.8:8787")).toBe("ws://192.168.1.8:8787");
    expect(gatewayAddress("https://gateway.example.com")).toBe("https://gateway.example.com");
  });

  it("refuses what no connection can be opened to", () => {
    expect(gatewayAddress("")).toBeUndefined();
    expect(gatewayAddress("   ")).toBeUndefined();
    expect(gatewayAddress("ftp://gateway.example.com")).toBeUndefined();
    expect(gatewayAddress("wss://")).toBeUndefined();
    expect(gatewayAddress("my gateway")).toBeUndefined();
  });
});
