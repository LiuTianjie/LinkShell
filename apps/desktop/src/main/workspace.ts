import type { ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { WorkspacePolicy } from "./policy.js";
import type { Runtime } from "./runtime.js";

/** Signals that the warm sidecar isn't available or lacks the requested route (allowing CLI fallback). */
export class SidecarUnavailableError extends Error {
  constructor(message = "sidecar unavailable") {
    super(message);
    this.name = "SidecarUnavailableError";
  }
}

/**
 * The capability-protected local server (`linkshell desktop-workspace`) that serves the page,
 * keeps the client identity and drafts, proxies the local Host, and acts as the single warm
 * control plane for in-process management & auth calls (eliminating per-click CLI spawns).
 */
export class WorkspaceServer {
  private child?: ChildProcess;
  private generation = 0;
  url?: URL;
  policy?: WorkspacePolicy;

  constructor(private readonly runtime: Runtime) {}

  start(onReady: (url: URL) => void, onFail: (message: string) => void): void {
    if (this.child) return;
    const generation = ++this.generation;
    const child = this.runtime.spawnCLI(["desktop-workspace", "--assets", this.runtime.workspaceAssets]);
    this.child = child;
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => fail("工作台启动超时。请确认配套 CLI 可用后重试。"), 30_000);
    const fail = (message: string) => {
      if (generation !== this.generation) return;
      clearTimeout(deadline);
      void this.stop();
      onFail(message.replace(/desktop=[A-Za-z0-9_-]+/g, "desktop=[已隐藏]"));
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (generation !== this.generation || this.url) return;
      stdout += chunk;
      if (stdout.length > 65_536) return fail("工作台启动响应过长，请更新配套 CLI 后重试。");
      const end = stdout.indexOf("\n");
      if (end < 0) return;
      try {
        const url = WorkspacePolicy.readyURL(stdout.slice(0, end));
        clearTimeout(deadline);
        this.url = url;
        this.policy = new WorkspacePolicy(url);
        onReady(url);
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.on("error", (error) => fail(`无法启动工作台：${error.message}`));
    child.on("exit", () => {
      const detail = stderr.trim();
      fail(detail ? `工作台启动失败：${detail}` : "工作台服务已退出，请重新连接。");
    });
  }

  private endpoint(): { hostname: string; port: number; origin: string; token: string } | undefined {
    const url = this.url;
    if (!url || !this.child || this.child.exitCode !== null) return undefined;
    const token = new URLSearchParams(url.hash.slice(1)).get("desktop");
    if (!token) return undefined;
    return { hostname: url.hostname, port: Number(url.port), origin: url.origin, token };
  }

  /** Loopback HTTP request immune to HTTP_PROXY env vars. Throws `SidecarUnavailableError` on 404/offline. */
  request<T = Record<string, unknown>>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    const target = this.endpoint();
    if (!target) return Promise.reject(new SidecarUnavailableError());
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      authorization: `Bearer ${target.token}`,
      origin: target.origin,
      ...(payload !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
    };
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value as T);
      };
      const req = httpRequest(
        { hostname: target.hostname, port: target.port, path, method, headers, timeout: timeoutMs },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
            if (text.length > 4_000_000) { req.destroy(); done(new Error("响应内容过长")); }
          });
          res.on("end", () => {
            if (res.statusCode === 404) return done(new SidecarUnavailableError("route not supported"));
            let parsed: unknown;
            try { parsed = text ? JSON.parse(text) : {}; }
            catch { return done(new SidecarUnavailableError("invalid sidecar json")); }
            if ((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300) {
              return done(undefined, parsed as T);
            }
            const errMsg = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
              ? (parsed as { error: string }).error
              : "操作失败，请重试";
            done(new Error(errMsg));
          });
        },
      );
      req.on("timeout", () => { req.destroy(); done(new Error("操作超时，请重试")); });
      req.on("error", () => done(new SidecarUnavailableError("sidecar connection error")));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  async snapshot(options?: { fresh?: boolean }): Promise<Record<string, unknown> | undefined> {
    const path = options?.fresh ? "/desktop/snapshot?fresh=1" : "/desktop/snapshot";
    try { return await this.request<Record<string, unknown>>("GET", path, undefined, 10_000); }
    catch { return undefined; }
  }

  action(name: string, input?: unknown, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/desktop/action", { name, ...(input !== undefined ? { input } : {}) }, timeoutMs);
  }

  login(body: Record<string, unknown>, timeoutMs = 350_000): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/desktop/login", body, timeoutMs);
  }

  cancelLogin(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("DELETE", "/desktop/login", undefined, 5_000);
  }

  logout(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("POST", "/desktop/logout", {}, 60_000);
  }

  log(): Promise<{ text: string; path: string }> {
    return this.request<{ text: string; path: string }>("GET", "/desktop/log", undefined, 10_000);
  }

  stop(): Promise<void> {
    this.generation++;
    const child = this.child;
    this.child = undefined;
    this.url = undefined;
    this.policy = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    child.removeAllListeners("exit");
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(giveUpTimer);
        resolve();
      };
      child.once("exit", done);
      // EOF gives the sidecar time to flush drafts and close its proxies. A wedged owned child must not outlive the app.
      try { child.stdin?.end(); } catch { /* Already closed. */ }
      const termTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGTERM"); } catch { /* Already gone. */ }
        }
      }, 1500);
      const giveUpTimer = setTimeout(done, 2500);
    });
  }
}
