import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { startHost } from "../src/host.js";
import { isLocalDevelopmentClient } from "../src/rpc/server.js";

describe("who may use the development port", () => {
  it("lets native development clients in", () => {
    // The iOS app and Node clients send no Origin.
    expect(isLocalDevelopmentClient({ host: "127.0.0.1:7878" })).toBe(true);
    expect(isLocalDevelopmentClient({ host: "localhost:7878" })).toBe(true);
    expect(isLocalDevelopmentClient({ host: "[::1]:7878" })).toBe(true);
    // React Native on Android sends the server's own origin, and the emulator calls its host 10.0.2.2.
    expect(isLocalDevelopmentClient({ host: "127.0.0.1:7878", origin: "http://127.0.0.1:7878" })).toBe(true);
    expect(isLocalDevelopmentClient({ host: "10.0.2.2:7878", origin: "http://10.0.2.2:7878" })).toBe(true);
  });

  it("refuses web pages", () => {
    expect(isLocalDevelopmentClient({ host: "127.0.0.1:7878", origin: "https://example.com" })).toBe(false);
    // Another local server's page is still a page.
    expect(isLocalDevelopmentClient({ host: "127.0.0.1:7878", origin: "http://localhost:3000" })).toBe(false);
    expect(isLocalDevelopmentClient({ host: "127.0.0.1:7878", origin: "null" })).toBe(false);
    // DNS rebinding: the page's own name now resolves to this machine, so Origin and Host agree.
    expect(isLocalDevelopmentClient({ host: "rebound.example:7878", origin: "http://rebound.example:7878" })).toBe(false);
    expect(isLocalDevelopmentClient({ host: "rebound.example:7878" })).toBe(false);
    expect(isLocalDevelopmentClient({})).toBe(false);
  });

  describe("on a running host", () => {
    const cleanups: (() => unknown)[] = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    /** Resolves "open", or the HTTP status the handshake was refused with. */
    function handshake(url: string, headers: Record<string, string>): Promise<"open" | number> {
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { headers });
        socket.once("open", () => {
          socket.close();
          resolve("open");
        });
        socket.once("unexpected-response", (_, response) => {
          socket.terminate();
          resolve(response.statusCode ?? 0);
        });
        socket.once("error", reject);
      });
    }

    it("refuses the handshake of a page and accepts a client's", async () => {
      const home = mkdtempSync(join(tmpdir(), "lsh-devport-"));
      const host = await startHost({ home, version: "test", tcpPort: 0, drivers: () => [], log: () => {} });
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));
      cleanups.push(() => host.stop());
      const url = `ws://127.0.0.1:${host.server.tcpAddress()}`;

      expect(await handshake(url, {})).toBe("open");
      expect(await handshake(url, { origin: "https://example.com" })).toBe(401);
      expect(await handshake(url, { host: "rebound.example:7878" })).toBe(401);
    });
  });
});
