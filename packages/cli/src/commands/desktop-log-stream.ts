import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

const DEFAULT_TAIL_BYTES = 65_536;
const EMPTY_LOG_TEXT = "暂无日志。启动服务后，这里会显示 Host 日志。";

export interface LogTailResult {
  text: string;
  path: string;
  offset: number;
}

/** Reads the last `maxBytes` of `host.log` together with the current byte offset. */
export async function readHostLogTail(home: string, maxBytes = DEFAULT_TAIL_BYTES): Promise<LogTailResult> {
  const path = join(home, "host.log");
  try {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      if (length > 0) await file.read(buffer, 0, length, size - length);
      return { text: buffer.toString("utf8") || EMPTY_LOG_TEXT, path, offset: size };
    } finally {
      await file.close();
    }
  } catch {
    return { text: EMPTY_LOG_TEXT, path, offset: 0 };
  }
}

async function readRange(path: string, start: number, end: number): Promise<string> {
  const length = Math.max(0, end - start);
  if (length === 0) return "";
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}

/**
 * Streams `host.log` over SSE (`init`, incremental `append`, and rotation `reset`)
 * using `fs.watch` on the state directory plus a lightweight stat safety check.
 * Releases every handle as soon as the client disconnects or `signal` aborts.
 */
export async function streamHostLog(
  home: string,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-accel-buffering": "no",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    connection: "keep-alive",
  });

  const emit = (event: string, data: unknown) => {
    if (response.destroyed || response.writableEnded) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const initial = await readHostLogTail(home);
  let offset = initial.offset;
  let hadContent = initial.offset > 0;
  emit("init", { text: initial.text, path: initial.path });

  let syncing = false;
  let dirty = false;
  let closed = false;

  const sync = async () => {
    if (closed || syncing) {
      dirty = true;
      return;
    }
    syncing = true;
    try {
      const info = await stat(initial.path).catch(() => undefined);
      if (closed) return;
      if (!info) {
        if (hadContent) {
          hadContent = false;
          offset = 0;
          emit("reset", { text: EMPTY_LOG_TEXT, path: initial.path });
        }
        return;
      }
      if (info.size < offset || (!hadContent && info.size > 0) || info.size - offset > DEFAULT_TAIL_BYTES) {
        // Log was created, rotated, truncated, or jumped >64KB: send a fresh bounded tail.
        const fresh = await readHostLogTail(home);
        if (closed) return;
        offset = fresh.offset;
        hadContent = fresh.offset > 0;
        emit("reset", { text: fresh.text, path: fresh.path });
        return;
      }
      if (info.size > offset) {
        const chunk = await readRange(initial.path, offset, info.size);
        if (closed) return;
        offset = info.size;
        hadContent = true;
        if (chunk) emit("append", { chunk });
      }
    } catch {
      // File may be mid-rotation; the next watch event or stat check recovers cleanly.
    } finally {
      syncing = false;
      if (dirty && !closed) {
        dirty = false;
        void sync();
      }
    }
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(home, { persistent: false }, (_eventType, filename) => {
      if (!filename || String(filename) === "host.log") void sync();
    });
    watcher.on("error", () => { /* Stat fallback still runs cleanly. */ });
  } catch {
    // State directory may not exist yet; stat fallback picks up host.log once created.
  }

  const statTimer = setInterval(() => void sync(), 2_500);
  const keepaliveTimer = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(": keepalive\n\n");
  }, 25_000);

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(statTimer);
      clearInterval(keepaliveTimer);
      try { watcher?.close(); } catch { /* Already closed. */ }
      signal.removeEventListener("abort", cleanup);
      response.off("close", cleanup);
      if (!response.destroyed && !response.writableEnded) response.end();
      resolve();
    };
    if (signal.aborted || response.destroyed || response.writableEnded) {
      cleanup();
      return;
    }
    signal.addEventListener("abort", cleanup, { once: true });
    response.once("close", cleanup);
  });
}
