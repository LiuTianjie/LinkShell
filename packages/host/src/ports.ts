import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { RpcError, type PortInfo } from "@linkshell/wire";

// Previews of the host's local servers. `listPorts` finds what's listening
// (and what looks like a dev server); `ProxyStreams` carries TCP streams to
// those ports over a device's encrypted channel, like `ssh -L`.

const run = promisify(execFile);

interface Listener {
  port: number;
  pid?: number;
  process: string;
}

/** `lsof -F` output: `p<pid>`, `c<command>`, then an `n<address>` per socket. */
function parseLsof(output: string): Listener[] {
  const found: Listener[] = [];
  let pid: number | undefined;
  let command = "";
  for (const line of output.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) pid = Number(value);
    else if (line.startsWith("c")) command = value;
    else if (line.startsWith("n")) {
      const port = Number(/:(\d+)$/.exec(value)?.[1]);
      if (port) found.push({ port, pid, process: command });
    }
  }
  return found;
}

/** `ss -ltnpH`: `LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1234,fd=20))`. */
function parseSs(output: string): Listener[] {
  const found: Listener[] = [];
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    const port = Number(/:(\d+)$/.exec(columns[3] ?? "")?.[1]);
    if (!port) continue;
    const owner = /\("([^"]+)",pid=(\d+)/.exec(line);
    found.push({ port, process: owner?.[1] ?? "", pid: owner ? Number(owner[2]) : undefined });
  }
  return found;
}

async function listeners(): Promise<Listener[]> {
  if (process.platform === "darwin") {
    const { stdout } = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeout: 5000, maxBuffer: 4_000_000 }).catch(
      (error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }),
    );
    return parseLsof(stdout);
  }
  if (process.platform === "linux") {
    const { stdout } = await run("ss", ["-ltnpH"], { timeout: 5000 }).catch(() => ({ stdout: "" }));
    return parseSs(stdout);
  }
  return [];
}

async function workingDirectories(pids: number[]): Promise<Map<number, string>> {
  const cwd = new Map<number, string>();
  if (!pids.length) return cwd;
  if (process.platform === "darwin") {
    const { stdout } = await run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { timeout: 5000 }).catch(
      (error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }),
    );
    let pid: number | undefined;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid !== undefined) cwd.set(pid, line.slice(1));
    }
  } else if (process.platform === "linux") {
    await Promise.all(pids.map(async (pid) => cwd.set(pid, await readlink(`/proc/${pid}/cwd`).catch(() => ""))));
  }
  return cwd;
}

/** Connects to a port on this machine's loopback, IPv4 first. */
function connectLoopback(port: number): Promise<Socket> {
  const attempt = (host: string) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host, port });
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        resolve(socket);
      });
      socket.once("error", reject);
    });
  return attempt("127.0.0.1").catch(() => attempt("::1"));
}

/** Whether the port answers HTTP, and the page's <title> if it serves HTML. */
async function probeHttp(port: number, timeoutMs = 1200): Promise<{ http: boolean; title?: string }> {
  let socket: Socket | undefined;
  try {
    socket = await connectLoopback(port);
    const open = socket;
    return await new Promise((resolve) => {
      let head = "";
      const done = () => {
        open.destroy();
        const http = head.startsWith("HTTP/");
        const html = /content-type:\s*text\/html/i.test(head);
        const title = html ? /<title[^>]*>([^<]{1,200})<\/title>/i.exec(head)?.[1]?.trim() : undefined;
        resolve({ http, title: title || undefined });
      };
      const timer = setTimeout(done, timeoutMs);
      open.on("data", (chunk) => {
        head += chunk.toString("utf8");
        if (head.length > 64_000 || /<\/title>/i.test(head)) {
          clearTimeout(timer);
          done();
        }
      });
      open.on("end", () => {
        clearTimeout(timer);
        done();
      });
      open.on("error", () => {
        clearTimeout(timer);
        done();
      });
      open.write(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\nAccept: text/html\r\nConnection: close\r\n\r\n`);
    });
  } catch {
    socket?.destroy();
    return { http: false };
  }
}

/**
 * The host's web servers worth previewing: ones that answer HTTP and were
 * started from a directory (system services run from `/`), minus this host's
 * own ports. Databases, app helpers and build daemons listen too, but aren't
 * pages.
 */
export async function listPorts(options: { exclude?: number[] } = {}): Promise<PortInfo[]> {
  const exclude = new Set(options.exclude ?? []);
  const seen = new Map<number, Listener>();
  for (const listener of await listeners()) {
    if (exclude.has(listener.port) || listener.pid === process.pid || seen.has(listener.port)) continue;
    seen.set(listener.port, listener);
  }
  const all = [...seen.values()];
  const cwd = await workingDirectories([...new Set(all.flatMap((listener) => (listener.pid ? [listener.pid] : [])))]);
  const candidates = all
    .map((listener) => ({ ...listener, cwd: listener.pid ? cwd.get(listener.pid) : undefined }))
    .filter((listener) => listener.cwd && listener.cwd !== "/")
    .slice(0, 40);
  const probed = await Promise.all(candidates.map(async (listener) => ({ ...listener, ...(await probeHttp(listener.port)) })));
  return probed
    .filter((entry) => entry.http)
    .map(({ port, pid, process: name, cwd: dir, http, title }) => ({ port, pid, process: name, cwd: dir, http, title }))
    .sort((a, b) => a.port - b.port);
}

const MAX_STREAMS = 96;

/** One device connection's open streams; all end when the connection does. */
export class ProxyStreams {
  private readonly streams = new Map<string, Socket>();

  constructor(
    private readonly send: {
      data: (streamId: string, data: string) => void;
      closed: (streamId: string, error?: string) => void;
    },
  ) {}

  async open(port: number): Promise<string> {
    if (this.streams.size >= MAX_STREAMS) throw RpcError.app("busy", "too many open preview connections");
    let socket: Socket;
    try {
      socket = await connectLoopback(port);
    } catch (error) {
      throw RpcError.app("not_found", `nothing is listening on port ${port}`, { cause: String(error) });
    }
    const streamId = randomUUID();
    this.streams.set(streamId, socket);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.send.data(streamId, chunk.toString("base64")));
    let failure: string | undefined;
    socket.on("error", (error) => (failure = error.message));
    socket.on("close", () => {
      if (this.streams.delete(streamId)) this.send.closed(streamId, failure);
    });
    return streamId;
  }

  write(streamId: string, data: string): void {
    const socket = this.streams.get(streamId);
    if (!socket) throw RpcError.app("not_found", "this preview connection has closed");
    socket.write(Buffer.from(data, "base64"));
  }

  /** The device hung up: finish sending, then close. */
  close(streamId: string): void {
    const socket = this.streams.get(streamId);
    if (!socket) return;
    this.streams.delete(streamId);
    socket.end();
    setTimeout(() => socket.destroy(), 5000).unref();
  }

  closeAll(): void {
    for (const socket of this.streams.values()) socket.destroy();
    this.streams.clear();
  }
}
