import { hostname, userInfo } from "node:os";
import * as readline from "node:readline";

export interface Style {
  enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

/**
 * Honors NO_COLOR (no-color.org), FORCE_COLOR, TERM=dumb, and stream TTY state so piped output
 * never contains raw ANSI escapes.
 */
export function supportsColor(
  stream: { isTTY?: boolean } | undefined = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") {
    const normalized = env.FORCE_COLOR.trim().toLowerCase();
    return normalized !== "0" && normalized !== "false";
  }
  if (env.TERM?.trim().toLowerCase() === "dumb") return false;
  return stream?.isTTY === true;
}

export function createStyle(
  stream: { isTTY?: boolean } | undefined = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Style {
  const enabled = supportsColor(stream, env);
  const wrap = (code: string) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    enabled,
    bold: wrap("1"),
    dim: wrap("2"),
    green: wrap("32"),
    red: wrap("31"),
    yellow: wrap("33"),
    cyan: wrap("36"),
  };
}

export const stdoutStyle = () => createStyle(process.stdout);
export const stderrStyle = () => createStyle(process.stderr);

/** Detects SSH sessions where opening a local browser on the server is unhelpful or impossible. */
export function isSshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

/** Detects headless Linux or SSH sessions that cannot open a local desktop browser. */
export function isHeadlessSession(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (isSshSession(env)) return true;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

/** Builds an SSH local-forward command for loopback OAuth callbacks over SSH. */
export function formatSshTunnelHint(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
  hostFallback?: string,
): string {
  let user = env.USER?.trim() || env.LOGNAME?.trim();
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = undefined;
    }
  }
  let server: string | undefined;
  const sshConn = env.SSH_CONNECTION?.trim();
  if (sshConn) {
    // SSH_CONNECTION format: "<client_ip> <client_port> <server_ip> <server_port>"
    const parts = sshConn.split(/\s+/);
    const serverIp = parts[2]?.trim();
    if (serverIp && serverIp !== "127.0.0.1" && serverIp !== "::1") {
      server = serverIp.includes(":") ? `[${serverIp}]` : serverIp;
    }
  }
  if (!server) {
    const candidate = (hostFallback ?? hostname()).trim();
    if (candidate && candidate !== "localhost") server = candidate;
  }
  return `ssh -L ${port}:127.0.0.1:${port} ${user || "<user>"}@${server || "<server>"}`;
}

export type TtyReadable = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

/** Reads a line without echoing it; from a pipe, reads the first line cleanly. */
export function readHidden(
  prompt: string,
  options: {
    stdin?: TtyReadable;
    output?: { write: (chunk: string) => unknown };
  } = {},
): Promise<string> {
  const stdin = options.stdin ?? (process.stdin as TtyReadable);
  const output = options.output ?? process.stderr;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let text = "";
      stdin.setEncoding("utf8");
      const onData = (chunk: string | Buffer) => {
        text += String(chunk);
        const nl = text.indexOf("\n");
        if (nl >= 0) {
          cleanup();
          resolve(text.slice(0, nl).replace(/\r$/, ""));
        }
      };
      const onEnd = () => {
        cleanup();
        resolve((text.split(/\r?\n/)[0] ?? "").replace(/\r$/, ""));
      };
      const cleanup = () => {
        stdin.removeListener("data", onData);
        stdin.removeListener("end", onEnd);
        stdin.removeListener("close", onEnd);
        stdin.pause();
      };
      stdin.on("data", onData);
      stdin.once("end", onEnd);
      stdin.once("close", onEnd);
      stdin.resume();
    });
  }
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (result?: string) => {
      if (settled) return;
      settled = true;
      try { stdin.setRawMode?.(false); } catch {}
      stdin.pause();
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEof);
      stdin.removeListener("close", onEof);
      output.write("\n");
      if (result === undefined) reject(new Error("cancelled"));
      else resolve(result);
    };
    const onEof = () => done();
    const onData = (chunk: string | Buffer) => {
      const text = String(chunk);
      for (const char of text) {
        if (char === "\u0003" || char === "\u0004") return done();
        if (char === "\r" || char === "\n") return done(value);
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
    stdin.once("end", onEof);
    stdin.once("close", onEof);
  });
}

/** Reads a single visible line from stdin; resolves null on EOF or Ctrl-C. */
export function readPromptLine(
  prompt: string,
  options: {
    stdin?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  } = {},
): Promise<string | null> {
  const input = options.stdin ?? process.stdin;
  const output = options.output ?? process.stderr;
  return new Promise((resolve) => {
    let settled = false;
    const rl = readline.createInterface({ input, output });
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.once("SIGINT", () => {
      output.write("\n");
      finish(null);
    });
    rl.once("close", () => finish(null));
    rl.question(prompt, (answer) => finish(answer.trim()));
  });
}
