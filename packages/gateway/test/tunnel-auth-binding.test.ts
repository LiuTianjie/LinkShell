import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenManager } from "../src/tokens.js";

function request(): any {
  const req = new Readable({
    read() {
      this.push(null);
    },
  }) as any;
  req.method = "GET";
  req.headers = { "x-forwarded-proto": "https" };
  req.socket = {};
  return req;
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
      request(),
      res,
      sessions,
      tokens,
      { sessionId: "session-1", port: 3000, path: "/zh" },
      url,
    );

    expect(tokens.owns("browser-token", "session-1")).toBe(true);
    expect(sent).toHaveLength(1);

    const envelope = JSON.parse(sent[0]!);
    handleTunnelResponse({
      requestId: envelope.payload.requestId,
      statusCode: 200,
      headers: { "content-type": "text/html" },
      body: "",
      isFinal: true,
    });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toContain(
      "lsh_tunnel=session-1%3A3000%3Abrowser-token",
    );
    expect(String(res.headers["set-cookie"])).not.toContain("jwt-token");

    tokens.destroy();
  });
});
