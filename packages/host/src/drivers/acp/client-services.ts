import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { RpcError } from "@linkshell/wire";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
export interface AcpScope { cwd: string; additionalDirectories?: string[] }
export interface AcpTerminalSnapshot { output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal?: string | null } }
interface Terminal {
  sessionId: string; child: ChildProcess; output: string; truncated: boolean; limit: number;
  exited: Promise<AcpTerminalSnapshot["exitStatus"]>; exitStatus?: AcpTerminalSnapshot["exitStatus"];
}

const invalid = (message: string) => new RpcError(-32602, message);
const cancelled = () => new RpcError(-32800, "请求已取消");
const within = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };

/** Resolve the nearest existing ancestor so new files cannot escape through a symlink. */
export async function scopedPath(scope: AcpScope, path: string): Promise<string> {
  if (!isAbsolute(path)) throw invalid("文件路径必须是绝对路径");
  const target = resolve(path);
  let ancestor = target;
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  for (const root of [scope.cwd, ...(scope.additionalDirectories ?? [])]) {
    const canonical = await realpath(root).catch(() => undefined);
    if (canonical && within(canonical, ancestor)) return target;
  }
  throw new RpcError(-32000, "这个文件不在会话的工作目录中");
}

export class AcpClientServices {
  private readonly terminals = new Map<string, Terminal>();
  constructor(private readonly options: {
    scope: (sessionId: string) => AcpScope | undefined;
    env: NodeJS.ProcessEnv;
    output: (sessionId: string, terminalId: string, text: string, snapshot: AcpTerminalSnapshot) => void;
  }) {}

  private scope(sessionId: unknown): AcpScope {
    const scope = typeof sessionId === "string" ? this.options.scope(sessionId) : undefined;
    if (!scope) throw invalid("文件或终端请求没有有效的会话");
    return scope;
  }

  async request(method: string, raw: unknown, signal?: AbortSignal): Promise<unknown> {
    const p = object(raw);
    const scope = this.scope(p.sessionId);
    if (signal?.aborted) throw cancelled();
    if (method === "fs/read_text_file" || method === "fs/write_text_file") {
      if (typeof p.path !== "string") throw invalid("缺少文件路径");
      const path = await scopedPath(scope, p.path);
      if (method === "fs/write_text_file") {
        if (typeof p.content !== "string") throw invalid("文件内容必须是文本");
        if (Buffer.byteLength(p.content) > 16 * 1024 * 1024) throw invalid("文本文件超过 16 MB");
        if (signal?.aborted) throw cancelled();
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, p.content, { encoding: "utf8", signal });
        return {};
      }
      for (const key of ["line", "limit"] as const) {
        if (p[key] != null && (!Number.isSafeInteger(p[key]) || Number(p[key]) < (key === "line" ? 1 : 0))) throw invalid(`${key} 必须是${key === "line" ? "正" : "非负"}整数`);
      }
      if ((await stat(path)).size > 16 * 1024 * 1024) throw invalid("文本文件超过 16 MB");
      const bytes = await readFile(path, { signal });
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (p.line == null && p.limit == null) return { content };
      const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const from = Number(p.line ?? 1) - 1;
      return { content: lines.slice(from, p.limit == null ? undefined : from + Number(p.limit)).join("") };
    }
    if (method === "terminal/create") {
      if (this.terminals.size >= 64) throw invalid("请先释放不用的 ACP 终端");
      if (typeof p.command !== "string" || !p.command || (p.args != null && (!Array.isArray(p.args) || p.args.some((arg) => typeof arg !== "string")))) throw invalid("终端命令无效");
      const cwd = typeof p.cwd === "string" ? await scopedPath(scope, p.cwd) : scope.cwd;
      if (signal?.aborted) throw cancelled();
      const env = { ...this.options.env };
      for (const entry of Array.isArray(p.env) ? p.env : []) {
        const item = object(entry);
        if (typeof item.name !== "string" || typeof item.value !== "string") throw invalid("终端环境变量无效");
        env[item.name] = item.value;
      }
      if (p.outputByteLimit != null && (!Number.isSafeInteger(p.outputByteLimit) || Number(p.outputByteLimit) < 0)) throw invalid("终端输出上限必须是非负整数");
      const child = spawn(p.command, (p.args ?? []) as string[], { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      const terminalId = randomUUID();
      let finish!: (status: AcpTerminalSnapshot["exitStatus"]) => void;
      const terminal: Terminal = { sessionId: String(p.sessionId), child, output: "", truncated: false,
        limit: Math.min(Number(p.outputByteLimit ?? 256 * 1024), 4 * 1024 * 1024), exited: new Promise((resolve) => { finish = resolve; }) };
      this.terminals.set(terminalId, terminal);
      const append = (text: string) => {
        if (!text) return;
        const bytes = Buffer.from(terminal.output + text);
        let start = Math.max(0, bytes.length - terminal.limit);
        if (start) {
          terminal.truncated = true;
          while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
        }
        terminal.output = bytes.subarray(start).toString("utf8");
        this.options.output(terminal.sessionId, terminalId, text, this.snapshot(terminal));
      };
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder("utf8");
        stream?.on("data", (data: Buffer) => append(decoder.write(data)));
        stream?.on("end", () => append(decoder.end()));
      }
      const exited = (exitCode: number | null, exitSignal?: string | null) => {
        if (terminal.exitStatus) return;
        terminal.exitStatus = { exitCode, signal: exitSignal };
        finish(terminal.exitStatus);
        this.options.output(terminal.sessionId, terminalId, "", this.snapshot(terminal));
      };
      child.once("close", exited);
      child.once("error", (error) => { append(error.message); exited(1); });
      return { terminalId };
    }
    const terminal = typeof p.terminalId === "string" ? this.terminals.get(p.terminalId) : undefined;
    if (!terminal || terminal.sessionId !== p.sessionId) throw invalid("找不到这个会话的终端");
    if (method === "terminal/output") return this.snapshot(terminal);
    if (method === "terminal/wait_for_exit") {
      if (!signal) return terminal.exited;
      return new Promise((resolve, reject) => {
        const abort = () => reject(cancelled());
        signal.addEventListener("abort", abort, { once: true });
        void terminal.exited.then((status) => { signal.removeEventListener("abort", abort); resolve(status); });
      });
    }
    if (method === "terminal/kill" || method === "terminal/release") {
      await this.kill(terminal);
      if (method === "terminal/release") this.terminals.delete(String(p.terminalId));
      return {};
    }
    throw new RpcError(-32601, `不支持 ${method}`);
  }

  output(sessionId: string, terminalId: string): AcpTerminalSnapshot | undefined {
    const terminal = this.terminals.get(terminalId);
    return terminal?.sessionId === sessionId ? this.snapshot(terminal) : undefined;
  }
  private snapshot(terminal: Terminal): AcpTerminalSnapshot { return { output: terminal.output, truncated: terminal.truncated, ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}) }; }
  private async kill(terminal: Terminal): Promise<void> {
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== "win32" && terminal.child.pid) process.kill(-terminal.child.pid, signal); else terminal.child.kill(signal); }
      catch { /* The process may have exited between the status check and the signal. */ }
    };
    // The launcher may exit while a detached-from-stdio child still owns its
    // process group. Releasing the terminal must also release those children.
    if (terminal.exitStatus) { kill("SIGKILL"); return; }
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 1500);
    timer.unref();
    await terminal.exited;
    kill("SIGKILL");
    clearTimeout(timer);
  }
  async close(sessionId?: string): Promise<void> {
    for (const [id, terminal] of this.terminals) {
      if (sessionId && terminal.sessionId !== sessionId) continue;
      await this.kill(terminal);
      this.terminals.delete(id);
    }
  }
}
