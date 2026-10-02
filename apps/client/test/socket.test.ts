import { describe, expect, it, vi } from "vitest";

// The native transport exists only in the app.
vi.mock("../modules/link-socket/src", () => ({ LinkSocket: null }));
const { isLocalHost } = await import("@/lib/socket");

describe("which computers are reached without a proxy", () => {
  it("takes loopback, LAN, link-local, Tailscale and mDNS addresses for local", () => {
    for (const url of [
      "ws://127.0.0.1:7878",
      "ws://localhost:7878",
      "ws://[::1]:7878",
      "ws://10.0.0.8:7878",
      "ws://172.16.4.2:7878",
      "ws://172.31.255.255:7878",
      "ws://192.168.1.5:7878",
      "ws://169.254.10.1:7878",
      "ws://100.64.0.1:7878",
      "ws://100.127.255.254:7878",
      "ws://my-mac.local:7878",
      "ws://[fd7a:115c:a1e0::1]:7878",
      "ws://[fe80::1]:7878",
    ]) {
      expect(isLocalHost(url), url).toBe(true);
    }
  });

  it("takes everything else for the internet", () => {
    for (const url of [
      "wss://gateway.itool.tech/v2/connect",
      "ws://8.8.8.8:7878",
      "ws://172.15.0.1:7878",
      "ws://172.32.0.1:7878",
      "ws://100.63.0.1:7878",
      "ws://100.128.0.1:7878",
      "ws://192.169.1.5:7878",
      "ws://localhost.example.com:7878",
      "not a url",
    ]) {
      expect(isLocalHost(url), url).toBe(false);
    }
  });
});
