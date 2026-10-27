import type { ChildProcess } from "node:child_process";
import { WorkspacePolicy } from "./policy.js";
import type { Runtime } from "./runtime.js";

/**
 * The capability-protected local server (`linkshell desktop-workspace`) that serves the page,
 * keeps the client identity and drafts, and proxies the local Host. It is owned by this window
 * process; the user's Host keeps running when it ends.
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
      this.stop();
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

  stop(): void {
    this.generation++;
    const child = this.child;
    this.child = undefined;
    this.url = undefined;
    this.policy = undefined;
    if (!child) return;
    child.removeAllListeners("exit");
    // EOF gives the sidecar time to close its proxies. A wedged owned child must not outlive the app.
    child.stdin?.end();
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, 2000);
    child.once("exit", () => clearTimeout(timer));
  }
}
