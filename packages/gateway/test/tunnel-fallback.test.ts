import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  parseTunnelCookie,
  shouldUseTunnelCookieFallback,
} from "../src/tunnel.js";

function req(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("tunnel cookie fallback", () => {
  it("parses tokens containing colons", () => {
    const parsed = parseTunnelCookie(req({
      cookie: "theme=dark; lsh_tunnel=session-1%3A3000%3Ajwt%3Awith%3Acolons; other=1",
    }));

    expect(parsed).toEqual({
      sessionId: "session-1",
      port: 3000,
      token: "jwt:with:colons",
    });
  });

  it("does not hijack root, reserved API paths, or normal top-level documents", () => {
    const reserved = (pathname: string) => pathname.startsWith("/sessions");

    expect(shouldUseTunnelCookieFallback(req({}), "/", reserved)).toBe(false);
    expect(shouldUseTunnelCookieFallback(req({}), "/sessions/mine", reserved)).toBe(false);
    expect(shouldUseTunnelCookieFallback(req({ "sec-fetch-dest": "document" }), "/zh", reserved)).toBe(false);
  });

  it("allows tunneled iframe routes and absolute assets", () => {
    const reserved = () => false;

    expect(shouldUseTunnelCookieFallback(req({ "sec-fetch-dest": "iframe" }), "/zh", reserved)).toBe(true);
    expect(shouldUseTunnelCookieFallback(req({ "sec-fetch-dest": "style" }), "/assets/app.css", reserved)).toBe(true);
    expect(shouldUseTunnelCookieFallback(req({
      "sec-fetch-dest": "document",
      referer: "https://gateway.example/tunnel/session-1/3000/",
    }), "/zh", reserved)).toBe(true);
  });
});
