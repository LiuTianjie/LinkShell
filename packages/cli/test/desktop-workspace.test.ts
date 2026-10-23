import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { createServer as createSocketServer, type Socket } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostPaths, windowsPipe } from "@linkshell/host";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { startDesktopWorkspace, type DesktopWorkspace } from "../src/commands/desktop-workspace.js";
import { DesktopClientState } from "../src/commands/desktop-workspace-state.js";
import { getValidToken, loadAuth } from "../src/auth.js";
import { runLogin } from "../src/commands/login.js";
import { runLogout } from "../src/commands/logout.js";
import { refreshGateway } from "../src/commands/host.js";

vi.mock("../src/auth.js", () => ({ loadAuth: vi.fn(), getValidToken: vi.fn() }));
vi.mock("../src/commands/login.js", () => ({ runLogin: vi.fn() }));
vi.mock("../src/commands/logout.js", () => ({ runLogout: vi.fn() }));
vi.mock("../src/commands/host.js", () => ({ silenceSqliteWarning: vi.fn(), refreshGateway: vi.fn(), followAccountGateway: vi.fn() }));

let directory: string;
let assets: string;
let home: string;
let hostSocket: string;
const cleanups: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), "linkshell-workspace-"));
  assets = join(directory, "assets");
  home = join(directory, "home");
  hostSocket = process.platform === "win32" ? windowsPipe(home, "workspace-test") : join(directory, "host.sock");
  await mkdir(join(assets, "preview"), { recursive: true });
  await mkdir(join(assets, "assets"), { recursive: true });
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Workspace</title>");
  await writeFile(join(assets, "assets", "app.js"), "window.workspace = true;");
  await writeFile(join(assets, "preview", "bridge.html"), "<!doctype html><title>Preview</title>");
  await writeFile(join(assets, "preview", "worker.js"), "self.preview = true;");
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function workspace() {
  const server = await startDesktopWorkspace({ assets, home, hostSocket });
  cleanups.push(() => server.stop());
  const url = new URL(server.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("desktop")!;
  const origin = url.origin;
  const headers = { authorization: `Bearer ${token}`, origin };
  return { ...server, origin, token, headers, ws: `${origin.replace("http:", "ws:")}/desktop/host?token=${token}` };
}

function http(origin: string, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request(`${origin}${path}`, { headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
    });
    req.on("error", reject); req.end();
  });
}

async function fakeHost() {
  const server = createServer();
  const peers = new WebSocketServer({ server });
  const received: { method: string; id?: number | string }[] = [];
  peers.on("connection", (client) => client.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    received.push(message);
    const result = message.method === "machine.info"
      ? { machineId: "this-mac", hostname: "Studio.local", platform: "darwin", hostVersion: "1.0.0", agents: [] }
      : { sessions: [] };
    client.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  }));
  await new Promise<void>((resolve) => server.listen(hostSocket, resolve));
  cleanups.push(async () => {
    for (const client of peers.clients) client.terminate();
    await Promise.all([
      new Promise<void>((resolve) => peers.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
  });
  return { peers, received };
}

async function connected(url: string, origin: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { origin });
  cleanups.push(async () => { socket.terminate(); });
  await once(socket, "open");
  return socket;
}

function nextMessage(socket: WebSocket) {
  return once(socket, "message").then(([value]) => JSON.parse(String(value)));
}

describe("native desktop workspace service", () => {
  it("isolates the preview origin and exposes no capability or account data in static configuration", async () => {
    const server = await workspace();
    const config = await fetch(`${server.origin}/config.js`);
    const text = await config.text();
    expect(text).toContain('"desktop":true');
    expect(text).toContain(`"desktopPlatform":"${process.platform}"`);
    expect(text).toContain('"deployment":"official"');
    expect(text).toContain(server.origin.replace("127.0.0.1", "localhost"));
    expect(text).not.toContain(server.token);
    expect(text).not.toMatch(/accessToken|refreshToken|signSecret/);
    expect((await fetch(`${server.origin}/`)).headers.get("x-frame-options")).toBe("DENY");
    expect((await fetch(`${server.origin}/preview/worker.js`)).status).toBe(404);
    const previewHeaders = { host: new URL(server.origin).host.replace("127.0.0.1", "localhost") };
    expect((await http(server.origin, "/preview/bridge.html", previewHeaders)).status).toBe(200);
    expect((await http(server.origin, "/preview/worker.js", previewHeaders)).status).toBe(200);
    for (const path of ["/", "/config.js", "/desktop/bootstrap", "/desktop/account", "/assets/app.js"]) {
      expect((await http(server.origin, path, { ...previewHeaders, ...server.headers })).status).toBe(404);
    }
  });

  it("requires a capability and exact Host and Origin, without enabling CORS", async () => {
    const server = await workspace();
    expect((await fetch(`${server.origin}/desktop/bootstrap`)).status).toBe(401);
    const badToken = await fetch(`${server.origin}/desktop/bootstrap`, { headers: { ...server.headers, authorization: "Bearer invalid" } });
    expect(badToken.status).toBe(401);
    expect(badToken.headers.has("access-control-allow-origin")).toBe(false);
    expect((await http(server.origin, "/desktop/bootstrap", { ...server.headers, host: "hostile.example" })).status).toBe(403);
    expect((await fetch(`${server.origin}/desktop/bootstrap`, { headers: { ...server.headers, origin: "https://hostile.example" } })).status).toBe(403);
    expect((await fetch(`${server.origin}/desktop/bootstrap`, { headers: { ...server.headers, origin: "null" } })).status).toBe(403);
    expect((await fetch(`${server.origin}/desktop/logout`, { method: "POST", headers: { authorization: server.headers.authorization } })).status).toBe(403);
    expect((await fetch(`${server.origin}/desktop/bootstrap`, { headers: { authorization: server.headers.authorization } })).status).toBe(200);
    expect(runLogout).not.toHaveBeenCalled();
  });

  it("retains an independent private device identity and serialized preferences across launches", async () => {
    const server = await workspace();
    const initial = await (await fetch(`${server.origin}/desktop/bootstrap`, { headers: server.headers })).json();
    expect(initial).toMatchObject({ storage: {}, identity: { signSecret: expect.any(String), boxSecret: expect.any(String) } });
    expect(initial).not.toHaveProperty("localComputer");
    if (process.platform !== "win32") expect((await stat(join(home, "desktop-client.json"))).mode & 0o777).toBe(0o600);
    const save = async (key: string, value: unknown) => fetch(`${server.origin}/desktop/storage`, {
      method: "PUT", headers: { ...server.headers, "content-type": "application/json" }, body: JSON.stringify({ key, value }),
    });
    const saved = await Promise.all(Array.from({ length: 30 }, (_, index) => save(`draft.wss://gateway.example/${index}`, { text: `草稿 ${index}` })));
    expect(saved.every((response) => response.status === 200)).toBe(true);
    await save("draft.wss://gateway.example/0", null);
    await server.stop();
    const next = await workspace();
    const restored = await (await fetch(`${next.origin}/desktop/bootstrap`, { headers: next.headers })).json();
    expect(restored.identity).toEqual(initial.identity);
    expect(Object.keys(restored.storage)).toHaveLength(29);
    expect(restored.storage["draft.wss://gateway.example/29"]).toEqual({ text: "草稿 29" });
    expect(next.token).not.toBe(server.token);
    expect((await readdir(home)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects prototype keys, oversized bodies and malformed state without losing existing pairings", async () => {
    const server = await workspace();
    const put = (payload: unknown) => fetch(`${server.origin}/desktop/storage`, {
      method: "PUT", headers: { ...server.headers, "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    expect((await put({ key: "__proto__", value: { polluted: true } })).status).toBe(400);
    expect((await put({ key: "constructor", value: "bad" })).status).toBe(400);
    expect((await put({ key: "draft", value: "a".repeat(1024 * 1024) })).status).toBe(413);
    expect((await put({ key: "draft" })).status).toBe(400);
    const state = await DesktopClientState.open(home);
    await expect(state.set("huge", "x".repeat(9 * 1024 * 1024))).rejects.toThrow();
    await state.set("small", "kept");
    expect(state.snapshot().storage).toEqual({ small: "kept" });
    await server.stop();
    await writeFile(join(home, "desktop-client.json"), "damaged pairing file");
    await expect(workspace()).rejects.toThrow();
    expect(await readFile(join(home, "desktop-client.json"), "utf8")).toBe("damaged pairing file");
  });

  it.skipIf(process.platform === "win32")("serves only regular bundled files, never a symlink or a filesystem path", async () => {
    await writeFile(join(directory, "private.txt"), "private-host-secret");
    await symlink(join(directory, "private.txt"), join(assets, "private.txt"));
    const server = await workspace();
    for (const path of ["/private.txt", "/..%2fprivate.txt", "/%2e%2e/private.txt"]) {
      const result = await http(server.origin, path, {});
      expect(result.status).toBe(404);
      expect(result.body).not.toContain("private-host-secret");
    }
  });

  it("shares only current access credentials and delegates account actions without starting a host", async () => {
    vi.mocked(loadAuth).mockReturnValue({ userId: "u1", email: "me@example.com", accessToken: "access-current", refreshToken: "refresh-private", expiresAt: 1 });
    vi.mocked(getValidToken).mockResolvedValue("access-current");
    const server = await workspace();
    const account = await (await fetch(`${server.origin}/desktop/account`, { headers: server.headers })).json();
    expect(account).toEqual({ userId: "u1", email: "me@example.com", accessToken: "access-current" });
    expect(JSON.stringify(account)).not.toContain("refresh-private");
    vi.mocked(getValidToken).mockResolvedValue("stale-user-token");
    expect(await (await fetch(`${server.origin}/desktop/account`, { headers: server.headers })).json()).not.toHaveProperty("accessToken");
    vi.mocked(runLogin).mockResolvedValue({ success: true, userId: "u1", email: "me@example.com", accessToken: "access-current", plan: "pro" });
    expect((await fetch(`${server.origin}/desktop/login`, { method: "POST", headers: server.headers })).status).toBe(200);
    expect(runLogin).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect((await fetch(`${server.origin}/desktop/logout`, { method: "POST", headers: server.headers })).status).toBe(200);
    expect(runLogout).toHaveBeenCalledOnce();
    expect((await readdir(home)).sort()).toEqual(["desktop-client.json"]);
  });

  it("reports a session the server ended as signed out, and has the host leave the account", async () => {
    vi.mocked(loadAuth).mockReturnValueOnce({ userId: "u1", email: "me@example.com", accessToken: "access-dead", refreshToken: "refresh-dead", expiresAt: 1 });
    vi.mocked(loadAuth).mockReturnValue(null);
    vi.mocked(getValidToken).mockResolvedValue(null);
    const server = await workspace();
    expect(await (await fetch(`${server.origin}/desktop/account`, { headers: server.headers })).json()).toEqual({});
    expect(refreshGateway).toHaveBeenCalledOnce();
  });

  it("cancels pending browser login on shutdown and hides internal exception details", async () => {
    const server = await workspace();
    let aborted = false;
    vi.mocked(runLogin).mockImplementation(({ signal } = {}) => new Promise((resolve) => {
      signal!.addEventListener("abort", () => { aborted = true; resolve(null); });
    }));
    const pending = fetch(`${server.origin}/desktop/login`, { method: "POST", headers: server.headers }).catch(() => undefined);
    await vi.waitFor(() => expect(runLogin).toHaveBeenCalledOnce());
    await server.stop();
    await pending;
    expect(aborted).toBe(true);
    const restarted = await workspace();
    vi.mocked(getValidToken).mockRejectedValue(new Error("secret-refresh-token=/sensitive/path"));
    const failed = await fetch(`${restarted.origin}/desktop/account`, { headers: restarted.headers });
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toMatch(/secret-refresh|sensitive/);
  });

  it("discovers the running local host and proxies client RPC and notifications while refusing shim methods", async () => {
    const host = await fakeHost();
    const server = await workspace();
    const result = await (await fetch(`${server.origin}/desktop/local`, { headers: server.headers })).json();
    expect(result.computer).toMatchObject({ key: "desktop:local", gateway: "desktop:local", machine: { id: "this-mac", name: "Studio", online: true } });
    const client = await connected(server.ws, server.origin);
    let response = nextMessage(client);
    client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sessions.list", params: {} }));
    expect(await response).toEqual({ jsonrpc: "2.0", id: 1, result: { sessions: [] } });
    response = nextMessage(client);
    for (const peer of host.peers.clients) peer.send(JSON.stringify({ jsonrpc: "2.0", method: "session.notice", params: { sessionId: "s1" } }));
    expect(await response).toMatchObject({ method: "session.notice" });
    for (const method of ["desktop.attach", "desktop.yielded", "made.up", "__proto__"]) {
      response = nextMessage(client);
      client.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method, params: {} }));
      expect(await response).toMatchObject({ id: 2, error: { code: -32601 } });
      expect(host.received.some((item) => item.method === method)).toBe(false);
    }
    const closed = once(client, "close");
    await server.stop();
    await closed;
    await vi.waitFor(() => expect(host.peers.clients.size).toBe(0));
  });

  it("rejects unauthorized WebSocket upgrades and explains an offline local host", async () => {
    const server = await workspace();
    for (const [url, options] of [
      [server.ws, { origin: "https://hostile.example" }],
      [server.ws, {}],
      [server.ws.replace(server.token, "invalid"), { origin: server.origin }],
      [server.ws, { origin: server.origin, headers: { host: "localhost:9999" } }],
    ] as const) {
      const rejected = await new Promise<number>((resolve, reject) => {
        const client = new WebSocket(url, options);
        client.on("unexpected-response", (_request, response) => { response.resume(); client.terminate(); resolve(response.statusCode!); });
        client.on("error", () => {});
        client.on("open", () => { client.terminate(); reject(new Error("unauthorized upgrade accepted")); });
      });
      expect(rejected).toBe(403);
    }
    const client = await connected(server.ws, server.origin);
    const [code, reason] = await once(client, "close");
    expect(code).toBe(1013);
    expect(String(reason)).toContain("本机服务未运行");
  });

  it("bounds unresponsive local handshakes and aborts discovery sockets when the workspace closes", async () => {
    const hanging = createSocketServer();
    const sockets = new Set<Socket>();
    hanging.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.resume();
    });
    await new Promise<void>((resolve) => hanging.listen(hostSocket, resolve));
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    });
    const server = await workspace();
    const started = Date.now();
    const bootstrap = await (await fetch(`${server.origin}/desktop/bootstrap`, { headers: server.headers })).json();
    expect(bootstrap).toMatchObject({ identity: { id: expect.any(String) }, storage: {} });
    expect(bootstrap).not.toHaveProperty("localComputer");
    expect(Date.now() - started).toBeLessThan(3_000);
    await vi.waitFor(() => expect(sockets.size).toBe(0));
    const pending = fetch(`${server.origin}/desktop/local`, { headers: server.headers }).catch(() => undefined);
    await vi.waitFor(() => expect(sockets.size).toBe(1));
    await server.stop();
    await pending;
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });
});

describe("desktop workspace process ownership", () => {
  it("ends the owned CLI after storage flush even when legacy logout is stuck on a Host handshake", async () => {
    await mkdir(join(home, "run"), { recursive: true });
    await writeFile(join(home, "auth.json"), JSON.stringify({ accessToken: "dummy-access", refreshToken: "dummy-refresh", expiresAt: Date.now() + 60_000, userId: "dummy-user" }));
    const hanging = createSocketServer();
    const sockets = new Set<Socket>();
    let received!: () => void;
    const requested = new Promise<void>((resolve) => { received = resolve; });
    hanging.on("connection", (socket) => { sockets.add(socket); socket.resume(); received(); });
    await new Promise<void>((resolve) => hanging.listen(hostPaths(home).hostSocket, resolve));
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    });
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", loader, entry, "desktop-workspace", "--assets", assets], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: "/usr/bin:/bin", LINKSHELL_HOME: home },
    });
    const exited = once(child, "exit");
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } });
    let stdout = "";
    const ready = await new Promise<{ url: string }>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("\n")) resolve(JSON.parse(stdout.split("\n")[0]!));
      });
      child.once("exit", () => reject(new Error("sidecar exited before ready")));
    });
    const url = new URL(ready.url);
    const token = new URLSearchParams(url.hash.slice(1)).get("desktop")!;
    const headers = { authorization: `Bearer ${token}`, origin: url.origin };
    expect((await fetch(`${url.origin}/desktop/storage`, {
      method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ key: "draft", value: "kept before logout" }),
    })).status).toBe(200);
    const logoutRequest = fetch(`${url.origin}/desktop/logout`, { method: "POST", headers }).catch(() => undefined);
    await requested;
    child.stdin.end();
    await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 1_500 });
    await exited;
    await logoutRequest;
    expect(JSON.parse(await readFile(join(home, "desktop-client.json"), "utf8")).storage.draft).toBe("kept before logout");
  }, process.platform === "win32" ? 30_000 : 10_000);

  it("exits during a stalled account refresh without losing saved desktop state or requiring a global CLI", async () => {
    let received!: () => void;
    const requested = new Promise<void>((resolve) => { received = resolve; });
    const hanging = createServer(() => received());
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    });
    const address = hanging.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "auth.json"), JSON.stringify({ accessToken: "dummy-access", refreshToken: "dummy-refresh", expiresAt: 0, userId: "dummy-user" }));
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const entry = new URL("../src/commands/desktop-workspace.ts", import.meta.url).href;
    const script = `const originalFetch = globalThis.fetch; globalThis.fetch = (input, init) => originalFetch(String(input).startsWith('https://mkbeusztkzffnzjdwmqk.supabase.co/') ? 'http://127.0.0.1:${address.port}/never' : input, init); const { runDesktopWorkspace } = await import(${JSON.stringify(entry)}); await runDesktopWorkspace(${JSON.stringify(assets)});`;
    const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "--eval", script], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: "/usr/bin:/bin", LINKSHELL_HOME: home },
    });
    const exited = once(child, "exit");
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } });
    let stdout = "";
    const ready = await new Promise<{ url: string }>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("\n")) resolve(JSON.parse(stdout.split("\n")[0]!));
      });
      child.once("exit", () => reject(new Error("sidecar exited before ready")));
    });
    const url = new URL(ready.url);
    const token = new URLSearchParams(url.hash.slice(1)).get("desktop")!;
    const headers = { authorization: `Bearer ${token}`, origin: url.origin };
    const bootstrap = await (await fetch(`${url.origin}/desktop/bootstrap`, { headers })).json();
    expect(bootstrap).not.toHaveProperty("localComputer");
    expect((await fetch(`${url.origin}/desktop/storage`, {
      method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ key: "draft", value: "kept on exit" }),
    })).status).toBe(200);
    const accountRequest = fetch(`${url.origin}/desktop/account`, { headers }).catch(() => undefined);
    await requested;
    child.stdin.end();
    await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 1_500 });
    await exited;
    await accountRequest;
    const state = JSON.parse(await readFile(join(home, "desktop-client.json"), "utf8"));
    expect(state.storage.draft).toBe("kept on exit");
    expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8")).refreshToken).toBe("dummy-refresh");
  }, process.platform === "win32" ? 30_000 : 10_000);

  it.each(process.platform === "win32" ? ["stdin EOF"] : ["stdin EOF", "SIGTERM"])("exits and releases its listener after %s", async (ending) => {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", loader, entry, "desktop-workspace", "--assets", assets], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LINKSHELL_HOME: home },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exited = once(child, "exit");
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } });
    let stdout = "";
    const ready = await new Promise<DesktopWorkspace>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("\n")) {
          try { resolve(JSON.parse(stdout.split("\n")[0]!)); } catch (error) { reject(error); }
        }
      });
      child.once("exit", () => reject(new Error(`sidecar exited before ready: ${stderr}`)));
    });
    expect((await fetch(new URL(ready.url).origin)).status).toBe(200);
    if (ending === "stdin EOF") child.stdin.end();
    else child.kill("SIGTERM");
    const [code] = await exited;
    expect(code).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    await expect(fetch(new URL(ready.url).origin)).rejects.toThrow();
  }, process.platform === "win32" ? 30_000 : 15_000);
});
