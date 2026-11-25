import type { ChildProcess } from "node:child_process";
import { killTreeOnWindows, spawnAgent } from "../../process.js";
import { trackChild } from "../../children.js";
import { lstat, mkdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { RpcError } from "@linkshell/wire";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
export interface AcpScope { cwd: string; additionalDirectories?: string[] }
export interface AcpTerminalSnapshot { output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal?: string | null } }
interface Terminal {
  sessionId: string;
  child: ChildProcess;
  chunks: Buffer[];
  headOffset: number;
  totalBytes: number;
  cachedOutput?: string;
  truncated: boolean;
  limit: number;
  exited: Promise<AcpTerminalSnapshot["exitStatus"]>;
  exitStatus?: AcpTerminalSnapshot["exitStatus"];
}

const invalid = (message: string) => new RpcError(-32602, message);
const notFound = (message: string) => new RpcError(-32002, message);
const cancelled = () => new RpcError(-32800, "请求已取消");
const within = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const MAX_SYMLINK_HOPS = 40;

async function resolveLexicalTarget(inputPath: string, depth = 0): Promise<string> {
  if (depth > MAX_SYMLINK_HOPS) throw invalid("符号链接层级过深或存在循环");
  const target = resolve(inputPath);
  const trailing: string[] = [];
  let ancestor = target;
  let canonicalAncestor: string;
  while (true) {
    try {
      canonicalAncestor = await realpath(ancestor);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP") throw invalid("符号链接层级过深或存在循环");
      if ((code !== "ENOENT" && code !== "ENOTDIR") || dirname(ancestor) === ancestor) throw error;
      const parent = dirname(ancestor);
      trailing.unshift(ancestor.slice(parent.endsWith(sep) ? parent.length : parent.length + 1));
      ancestor = parent;
    }
  }
  let current = canonicalAncestor;
  for (let i = 0; i < trailing.length; i += 1) {
    const segment = trailing[i]!;
    const candidate = join(current, segment);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) {
        // Resolve dangling or nested symlinks relative to their parent before checking scope,
        // so creating a file through a dangling symlink cannot write outside the workspace.
        const linkTarget = await readlink(candidate);
        const redirected = resolve(resolve(current, linkTarget), ...trailing.slice(i + 1));
        return resolveLexicalTarget(redirected, depth + 1);
      }
      current = candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP") throw invalid("符号链接层级过深或存在循环");
      if (code === "ENOENT" || code === "ENOTDIR") {
        return join(current, ...trailing.slice(i));
      }
      throw error;
    }
  }
  return current;
}

/** Resolve all symlinks (including dangling targets) so reads and writes cannot escape scope. */
export async function scopedPath(scope: AcpScope, path: string): Promise<string> {
  if (!isAbsolute(path)) throw invalid("文件路径必须是绝对路径");
  const resolvedTarget = await resolveLexicalTarget(path);
  for (const root of [scope.cwd, ...(scope.additionalDirectories ?? [])]) {
    const canonical = await realpath(root).catch(() => undefined);
    if (canonical && within(canonical, resolvedTarget)) return resolvedTarget;
  }
  throw invalid("这个文件不在会话的工作目录中");
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
        try {
          await writeFile(path, p.content, { encoding: "utf8", signal });
        } catch (error) {
          if (signal?.aborted || (error as NodeJS.ErrnoException).name === "AbortError") throw cancelled();
          throw error;
        }
        return {};
      }
      for (const key of ["line", "limit"] as const) {
        if (p[key] != null && (!Number.isSafeInteger(p[key]) || Number(p[key]) < (key === "line" ? 1 : 0))) throw invalid(`${key} 必须是${key === "line" ? "正" : "非负"}整数`);
      }
      let info;
      try {
        info = await stat(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") throw notFound("找不到这个文件");
        throw error;
      }
      if (info.isDirectory()) throw invalid("路径是目录，不是文本文件");
      if (info.size > 16 * 1024 * 1024) throw invalid("文本文件超过 16 MB");
      let bytes: Buffer;
      try {
        bytes = await readFile(path, { signal });
      } catch (error) {
        if (signal?.aborted || (error as NodeJS.ErrnoException).name === "AbortError") throw cancelled();
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") throw notFound("找不到这个文件");
        throw error;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (error) {
        if (error instanceof TypeError) throw invalid("文件不是有效的 UTF-8 文本");
        throw error;
      }
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
      const child = spawnAgent(p.command, (p.args ?? []) as string[], { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      trackChild(child, "agent command", p.command, (p.args ?? []) as string[], process.platform !== "win32");
      const terminalId = randomUUID();
      let finish!: (status: AcpTerminalSnapshot["exitStatus"]) => void;
      const terminal: Terminal = { sessionId: String(p.sessionId), child, chunks: [], headOffset: 0, totalBytes: 0, cachedOutput: "", truncated: false,
        limit: Math.min(Number(p.outputByteLimit ?? 256 * 1024), 4 * 1024 * 1024), exited: new Promise((resolve) => { finish = resolve; }) };
      this.terminals.set(terminalId, terminal);
      const append = (text: string) => {
        if (!text) return;
        const buf = Buffer.from(text, "utf8");
        if (terminal.limit === 0) {
          terminal.truncated = true;
          terminal.chunks = [];
          terminal.headOffset = 0;
          terminal.totalBytes = 0;
          terminal.cachedOutput = "";
        } else if (buf.length >= terminal.limit) {
          terminal.truncated = true;
          let start = buf.length - terminal.limit;
          while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
          terminal.chunks = start < buf.length ? [buf.subarray(start)] : [];
          terminal.headOffset = 0;
          terminal.totalBytes = terminal.chunks[0]?.length ?? 0;
          terminal.cachedOutput = undefined;
        } else {
          terminal.chunks.push(buf);
          terminal.totalBytes += buf.length;
          terminal.cachedOutput = undefined;
          if (terminal.totalBytes > terminal.limit) {
            terminal.truncated = true;
            let excess = terminal.totalBytes - terminal.limit;
            while (excess > 0 && terminal.chunks.length > 0) {
              const head = terminal.chunks[0]!;
              const avail = head.length - terminal.headOffset;
              if (excess >= avail) {
                terminal.chunks.shift();
                terminal.headOffset = 0;
                terminal.totalBytes -= avail;
                excess -= avail;
              } else {
                terminal.headOffset += excess;
                terminal.totalBytes -= excess;
                excess = 0;
              }
            }
            // Keep the ring buffer aligned to a UTF-8 character boundary.
            while (terminal.chunks.length > 0) {
              const head = terminal.chunks[0]!;
              if ((head[terminal.headOffset]! & 0xc0) !== 0x80) break;
              terminal.headOffset += 1;
              terminal.totalBytes -= 1;
              if (terminal.headOffset >= head.length) {
                terminal.chunks.shift();
                terminal.headOffset = 0;
              }
            }
          }
        }
        this.options.output(terminal.sessionId, terminalId, text, this.liveSnapshot(terminal));
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
        this.options.output(terminal.sessionId, terminalId, "", this.liveSnapshot(terminal));
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
  private renderOutput(terminal: Terminal): string {
    if (terminal.cachedOutput !== undefined) return terminal.cachedOutput;
    if (terminal.chunks.length === 0) {
      terminal.cachedOutput = "";
      return "";
    }
    if (terminal.chunks.length === 1) {
      terminal.cachedOutput = terminal.chunks[0]!.subarray(terminal.headOffset).toString("utf8");
      return terminal.cachedOutput;
    }
    const merged = Buffer.allocUnsafe(terminal.totalBytes);
    let offset = 0;
    for (let i = 0; i < terminal.chunks.length; i += 1) {
      const chunk = terminal.chunks[i]!;
      const start = i === 0 ? terminal.headOffset : 0;
      offset += chunk.copy(merged, offset, start);
    }
    terminal.chunks = [merged];
    terminal.headOffset = 0;
    terminal.cachedOutput = merged.toString("utf8");
    return terminal.cachedOutput;
  }
  private liveSnapshot(terminal: Terminal): AcpTerminalSnapshot {
    const render = () => this.renderOutput(terminal);
    return {
      get output() { return render(); },
      truncated: terminal.truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
    };
  }
  private snapshot(terminal: Terminal): AcpTerminalSnapshot {
    return { output: this.renderOutput(terminal), truncated: terminal.truncated, ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}) };
  }
  private async kill(terminal: Terminal): Promise<void> {
    const kill = (signal: NodeJS.Signals) => {
      try { if (!terminal.child.pid) return; if (process.platform === "win32") killTreeOnWindows(terminal.child.pid); else process.kill(-terminal.child.pid, signal); }
      catch { /* The process may have exited between the status check and the signal. */ }
    };
    // The launcher may exit while a detached-from-stdio child still owns its
    // process group. Releasing the terminal must also release those children.
    if (terminal.exitStatus) { kill("SIGKILL"); return; }
    kill("SIGTERM");
    const sigkillTimer = setTimeout(() => kill("SIGKILL"), 1500);
    sigkillTimer.unref();
    // Bound total wait: an orphaned grandchild holding inherited stdio FDs can keep `close`
    // (and thus `terminal.exited`) pending forever even after SIGKILL.
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<void>((resolve) => {
      giveUpTimer = setTimeout(() => {
        kill("SIGKILL");
        terminal.child.stdout?.destroy();
        terminal.child.stderr?.destroy();
        terminal.child.stdin?.destroy();
        resolve();
      }, 3500);
      giveUpTimer.unref();
    });
    await Promise.race([terminal.exited, giveUp]);
    kill("SIGKILL");
    clearTimeout(sigkillTimer);
    clearTimeout(giveUpTimer);
  }
  async close(sessionId?: string): Promise<void> {
    for (const [id, terminal] of this.terminals) {
      if (sessionId && terminal.sessionId !== sessionId) continue;
      await this.kill(terminal);
      this.terminals.delete(id);
    }
  }
}
