import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenManager } from "../src/tokens.js";

function request(headers: Record<string, string> = {}): any {
  const req = new Readable({
    read() {
      this.push(null);
    },
  }) as any;
  req.method = "GET";
  req.headers = { "x-forwarded-proto": "https", ...headers };
  req.socket = {};
  return req;
}

class FakeWs extends EventEmitter {
  closeCode?: number;
  closeReason?: string;

  close(code?: number, reason?: string) {
    this.closeCode = code;
    this.closeReason = reason;
  }
}

function response(): any {
  return {
    headersSent: false,
    statusCode: 0,
    headers: {} as Record<string, string | string[]>,
    writeHead(statusCode: number, headers?: Record<string, string | string[]>) {
      this.statusCode = statusCode;
      this.headers = headers ?? {};
      this.headersSent = true;
    },
    write() {},
    end() {},
  };
}

describe("tunnel auth binding", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("binds an explicit device token after JWT ownership and stores that token in the fallback cookie", async () => {
    vi.stubEnv("AUTH_REQUIRED", "true");
    vi.stubEnv("SUPABASE_URL", "https://supabase.example");
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-key");
    vi.resetModules();

    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ id: "user-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const { handleTunnelRequest, handleTunnelResponse } = await import("../src/tunnel.js");
    const tokens = new TokenManager();
    const sent: string[] = [];
    const sessions = {
      get(sessionId: string) {
        if (sessionId !== "session-1") return undefined;
        return {
          id: "session-1",
          userId: "user-1",
          host: {
            socket: {
              OPEN: 1,
              readyState: 1,
              send(message: string) {
                sent.push(message);
              },
            },
          },
        };
      },
    } as any;
    const res = response();
    const url = new URL("https://gateway.example/tunnel/session-1/3000/zh?token=browser-token&auth_token=jwt-token");

    await handleTunnelRequest(
      request({ cookie: "app_session=keep; lsh_tunnel=session-1%3A3000%3Ajwt-token; lsh_token=old" }),
      res,
      sessions,
      tokens,
      { sessionId: "session-1", port: 3000, path: "/zh" },
      url,
    );

    expect(tokens.owns("browser-token", "session-1")).toBe(true);
    expect(sent).toHaveLength(1);

    const envelope = JSON.parse(sent[0]!);
    expect(envelope.payload.url).toBe("/zh");
    expect(envelope.payload.headers.cookie).toBe("app_session=keep");
    handleTunnelResponse({
      requestId: envelope.payload.requestId,
      statusCode: 307,
      headers: { "content-type": "text/html", location: "/zh?token=leaked&auth_token=leaked-jwt" },
      body: "",
      isFinal: true,
    });

    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toBe("/tunnel/session-1/3000/zh");
    expect(String(res.headers["set-cookie"])).toContain(
      "lsh_tunnel=session-1%3A3000%3Abrowser-token",
    );
    expect(String(res.headers["set-cookie"])).not.toContain("jwt-token");

    tokens.destroy();
  });

  it("uses fallback websocket cookie auth without binding the cookie JWT as a device token", async () => {
    vi.stubEnv("AUTH_REQUIRED", "true");
    vi.stubEnv("SUPABASE_URL", "https://supabase.example");
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-key");
    vi.resetModules();

    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ id: "user-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ));

    const { handleTunnelWsUpgrade } = await import("../src/tunnel.js");
    const tokens = new TokenManager();
    const sent: string[] = [];
    const sessions = {
      get(sessionId: string) {
        if (sessionId !== "session-1") return undefined;
        return {
          id: "session-1",
          userId: "user-1",
          host: {
            socket: {
              OPEN: 1,
              readyState: 1,
              send(message: string) {
                sent.push(message);
              },
            },
          },
        };
      },
    } as any;
    const ws = new FakeWs();
    const url = new URL("https://gateway.example/_next/webpack-hmr?page=/zh");

    await handleTunnelWsUpgrade(
      ws as any,
      { sessionId: "session-1", port: 3000, path: "/_next/webpack-hmr" },
      url,
      sessions,
      tokens,
      "jwt-token",
    );

    expect(ws.closeCode).toBeUndefined();
    expect(tokens.owns("jwt-token", "session-1")).toBe(false);
    expect(sent).toHaveLength(1);
    const envelope = JSON.parse(sent[0]!);
    expect(envelope.payload.url).toBe("/_next/webpack-hmr?page=%2Fzh");

    ws.emit("close", 1000, Buffer.from(""));
    tokens.destroy();
  });
});
