import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import * as daemon from "../utils/daemon.js";
import { LINUX_GATEWAY_SERVICE_UNIT, LINUX_SERVICE_UNIT } from "./service.js";

export type LogService = "host" | "gateway" | "upgrade";

const VALID_SERVICES: readonly LogService[] = ["host", "gateway", "upgrade"];

export function parseLogService(raw: string | undefined): LogService {
  const value = (raw ?? "host").trim().toLowerCase();
  if ((VALID_SERVICES as readonly string[]).includes(value)) {
    return value as LogService;
  }
  throw new Error(`Invalid --service "${raw}". Expected one of: host, gateway, upgrade.`);
}

export function resolveLogPath(service: LogService, home = daemon.linkshellDir()): string {
  return join(home, `${service}.log`);
}

/** Reads the last `count` lines from `filePath` in reverse chunks without loading huge logs into memory. */
export function readLastLines(filePath: string, count: number): string[] {
  if (count <= 0) return [];
  const size = statSync(filePath).size;
  if (size === 0) return [];

  const chunkSize = 64 * 1024;
  const fd = openSync(filePath, "r");
  try {
    let position = size;
    const chunks: Buffer[] = [];
    let newlineCount = 0;

    while (position > 0 && newlineCount <= count) {
      const readLen = Math.min(chunkSize, position);
      position -= readLen;
      const buf = Buffer.allocUnsafe(readLen);
      const bytesRead = readSync(fd, buf, 0, readLen, position);
      const slice = bytesRead === readLen ? buf : buf.subarray(0, bytesRead);
      chunks.unshift(slice);
      for (let i = 0; i < slice.length; i += 1) {
        if (slice[i] === 0x0a) newlineCount += 1;
      }
    }

    const text = Buffer.concat(chunks).toString("utf8");
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-count);
  } finally {
    closeSync(fd);
  }
}

function runJournalctl(unit: string, lines: number, follow: boolean): Promise<number> {
  return new Promise((resolve) => {
    const args = ["--user", "-u", unit, "-n", String(lines), "--no-pager", ...(follow ? ["-f"] : [])];
    const child = spawn("journalctl", args, { stdio: "inherit" });
    child.once("error", (error) => {
      process.stderr.write(`  Could not run journalctl: ${error.message}\n`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
}

export async function runLogs(options: {
  service?: string;
  lines?: number;
  follow?: boolean;
  journal?: boolean;
  home?: string;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
} = {}): Promise<void> {
  const stdout = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const service = parseLogService(options.service);
  const lines = options.lines ?? 50;
  if (!Number.isInteger(lines) || lines < 1) {
    throw new Error(`Invalid --lines value "${options.lines}". Expected a positive integer.`);
  }

  if (options.journal) {
    if (process.platform !== "linux") {
      stderr("  --journal is only supported on Linux (systemd journald).\n");
      process.exitCode = 1;
      return;
    }
    if (service === "upgrade") {
      stderr("  Upgrade logs are stored as a file; omit --journal for --service upgrade.\n");
      process.exitCode = 1;
      return;
    }
    const unit = service === "gateway" ? LINUX_GATEWAY_SERVICE_UNIT : LINUX_SERVICE_UNIT;
    const code = await runJournalctl(unit, lines, options.follow === true);
    if (code !== 0) process.exitCode = code;
    return;
  }

  const filePath = resolveLogPath(service, options.home);
  if (!existsSync(filePath)) {
    stderr(`  No ${service} log file yet at ${filePath}.\n`);
    if (process.platform === "linux" && (service === "host" || service === "gateway")) {
      stderr(`  If running under systemd journald, try: linkshell logs --journal --service ${service}\n`);
    } else if (service === "host") {
      stderr("  Start the host with: linkshell host --daemon\n");
    }
    process.exitCode = 1;
    return;
  }

  const initial = readLastLines(filePath, lines);
  if (initial.length > 0) {
    stdout(`${initial.join("\n")}\n`);
  }

  if (!options.follow) return;

  let offset = statSync(filePath).size;

  const drainNew = () => {
    try {
      const currentSize = statSync(filePath).size;
      // Handle copytruncate or recreated log file cleanly.
      if (currentSize < offset) offset = 0;
      if (currentSize === offset) return;
      const fd = openSync(filePath, "r");
      try {
        const len = currentSize - offset;
        const buf = Buffer.allocUnsafe(len);
        const bytesRead = readSync(fd, buf, 0, len, offset);
        offset += bytesRead;
        if (bytesRead > 0) stdout(buf.subarray(0, bytesRead).toString("utf8"));
      } finally {
        closeSync(fd);
      }
    } catch {
      // File may be mid-rotation; retry on next event/poll.
    }
  };

  await new Promise<void>((resolve) => {
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      watcher = watch(filePath, () => drainNew());
    } catch {
      // Polling below handles environments where fs.watch is unavailable.
    }
    const poll = setInterval(drainNew, 500);
    const stop = () => {
      clearInterval(poll);
      try { watcher?.close(); } catch {}
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
