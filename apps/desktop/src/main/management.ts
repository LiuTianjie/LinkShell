import { readFile, open } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "./runtime.js";

/**
 * This Mac's service: the same `linkshell desktop` JSON the native dashboard used. Mutations
 * take input on stdin (passwords, activation codes), never on the command line.
 */
export class Management {
  private login?: AbortController;

  constructor(private readonly runtime: Runtime) {}

  /** A command whose output is for a terminal, not JSON: only whether it succeeded. */
  exec(args: string[], timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.runtime.spawnCLI(args);
      const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
      child.stdout?.resume(); child.stderr?.resume(); child.stdin?.end();
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`exit ${code}`)); });
    });
  }

  run(args: string[], options: { timeout?: number; input?: unknown; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const child = this.runtime.spawnCLI(args);
      let out = "";
      let settled = false;
      const finish = (error?: Error, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value ?? {});
      };
      const timer = setTimeout(() => { child.kill("SIGTERM"); finish(new Error("操作超时，请重试")); }, options.timeout ?? 20_000);
      const abort = () => { child.kill("SIGTERM"); finish(new Error("已取消")); };
      options.signal?.addEventListener("abort", abort);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { out += chunk; if (out.length > 4_000_000) child.kill("SIGTERM"); });
      child.stderr?.resume();
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        let parsed: Record<string, unknown> | undefined;
        try { parsed = JSON.parse(out) as Record<string, unknown>; } catch { /* reported below */ }
        if (code === 0 && parsed) return finish(undefined, parsed);
        const message = typeof parsed?.error === "string" ? parsed.error : "无法运行 CLI。请确认已安装新版 LinkShell，或从终端执行 linkshell app。";
        finish(new Error(message));
      });
      if (options.input !== undefined) child.stdin?.end(JSON.stringify(options.input));
      else child.stdin?.end();
    });
  }

  snapshot() { return this.run(["desktop"]); }

  /** Recover updates first; never replace a running or temporarily unreachable host. */
  async startup() {
    const recovered = await this.run(["desktop", "--action", "recover-update"], { timeout: 45_000 })
      .catch((error: Error) => { throw new Error(`服务恢复需要处理：${error.message}`); });
    if (recovered.status !== "stopped") return recovered;
    return this.run(["desktop", "--action", "start"], { timeout: 45_000 })
      .catch((error: Error) => { throw new Error(`后台服务启动失败：${error.message}`); });
  }

  action(name: string, input?: unknown) {
    const allowed: Record<string, number> = {
      start: 45_000, stop: 45_000, restart: 45_000, logout: 60_000, "connect-gateway": 60_000,
      "account-refresh": 60_000, "set-password": 45_000, "remove-password": 45_000, "redeem-pro": 90_000,
      "prepare-update": 45_000, "recover-update": 45_000, "stop-update-host": 45_000, pair: 30_000, "pair-qr": 30_000,
    };
    if (!(name in allowed)) return Promise.reject(new Error("不支持的操作"));
    return this.run(["desktop", "--action", name], { timeout: allowed[name], input });
  }

  async signIn() {
    this.login?.abort();
    const control = new AbortController();
    this.login = control;
    try { return await this.run(["desktop", "--action", "login"], { timeout: 350_000, signal: control.signal }); }
    finally { if (this.login === control) this.login = undefined; }
  }

  cancelSignIn() { this.login?.abort(); }

  usage(days: number, agent: string) {
    if (![1, 7, 30].includes(days) || !/^[A-Za-z0-9_.-]{1,128}$/.test(agent)) return Promise.reject(new Error("无效的统计范围"));
    return this.run(["desktop", "--action", `usage-${days}-${agent}`], { timeout: 125_000 });
  }

  /** The last 64 KB of the Host's log. */
  async log(home: string): Promise<string> {
    const path = join(home, "host.log");
    try {
      const file = await open(path, "r");
      try {
        const { size } = await file.stat();
        const length = Math.min(size, 65_536);
        const buffer = Buffer.alloc(length);
        await file.read(buffer, 0, length, size - length);
        return buffer.toString("utf8");
      } finally { await file.close(); }
    } catch { return "暂无日志。启动服务后，这里会显示 Host 日志。"; }
  }

  async standaloneInfo(): Promise<Record<string, unknown> | undefined> {
    if (!this.runtime.bundle) return undefined;
    try { return JSON.parse(await readFile(join(this.runtime.bundle, "Contents/Resources/standalone.json"), "utf8")) as Record<string, unknown>; }
    catch { return undefined; }
  }
}
