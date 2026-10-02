import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { clientIp, trustedProxySet } from "../src/rate-limit.js";

const request = (peer: string, forwarded?: string) =>
  ({ socket: { remoteAddress: peer }, headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded } }) as unknown as IncomingMessage;

describe("the reverse proxies a gateway trusts", () => {
  it("are known by address, however a dual-stack socket writes it", () => {
    const proxies = trustedProxySet([" 10.0.0.5 ", "", "::1"]);
    expect(proxies.has("10.0.0.5")).toBe(true);
    expect(proxies.has("::ffff:10.0.0.5")).toBe(true);
    expect(proxies.has("::1")).toBe(true);
    expect(proxies.has("10.0.0.6")).toBe(false);
  });

  it("can be a whole network", () => {
    const proxies = trustedProxySet(["172.16.0.0/12", "10.1.2.3/24", "192.0.2.7/32"]);
    expect(proxies.has("172.16.0.1")).toBe(true);
    expect(proxies.has("::ffff:172.31.255.255")).toBe(true);
    expect(proxies.has("172.32.0.1")).toBe(false);
    // The network a written address belongs to, not only addresses above it.
    expect(proxies.has("10.1.2.1")).toBe(true);
    expect(proxies.has("10.1.3.1")).toBe(false);
    expect(proxies.has("192.0.2.7")).toBe(true);
    expect(proxies.has("192.0.2.8")).toBe(false);
    expect(proxies.has("not an address")).toBe(false);
  });

  it("trust nobody by a range that can't be read", () => {
    for (const range of ["10.0.0.0/33", "10.0.0/8", "10.0.0.0/", "10.0.0.0/8/8", "/8"]) {
      expect(trustedProxySet([range]).has("10.0.0.1"), range).toBe(false);
    }
    expect(trustedProxySet(["0.0.0.0/0"]).has("203.0.113.9")).toBe(true);
  });
});

describe("who is connecting", () => {
  const proxies = trustedProxySet(["10.0.0.0/8"]);

  it("is the peer itself when it isn't a trusted proxy, whatever it claims", () => {
    expect(clientIp(request("203.0.113.9", "198.51.100.1"), proxies)).toBe("203.0.113.9");
    expect(clientIp(request("203.0.113.9"), trustedProxySet([]))).toBe("203.0.113.9");
  });

  it("is the last address a trusted proxy reports that isn't a proxy too", () => {
    expect(clientIp(request("10.0.0.2", "203.0.113.9"), proxies)).toBe("203.0.113.9");
    expect(clientIp(request("10.0.0.2", "203.0.113.9, 10.0.0.7"), proxies)).toBe("203.0.113.9");
    // What the caller wrote first is theirs to invent.
    expect(clientIp(request("10.0.0.2", "1.1.1.1, 203.0.113.9"), proxies)).toBe("203.0.113.9");
  });

  it("is the proxy when the proxy reports nobody", () => {
    expect(clientIp(request("10.0.0.2"), proxies)).toBe("10.0.0.2");
    expect(clientIp(request("10.0.0.2", "10.0.0.9"), proxies)).toBe("10.0.0.9");
  });
});
