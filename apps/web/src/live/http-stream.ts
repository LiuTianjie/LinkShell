import type { HostStream, HostStreams } from "@linkshell/client-core";
import { joinBytes, splitHttp } from "./transport";
type Head = { status: number; headers: [string, string][] };
const crlf = (bytes: Uint8Array) => {
  for (let i = 0; i < bytes.length - 1; i++)
    if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
  return -1;
};
/** Keeps transfer framing out of the body while delivering long-lived responses incrementally. */
export class HttpStreamDecoder {
  private buffer: Uint8Array = new Uint8Array();
  private started = false;
  private remaining: number | undefined;
  private chunked = false;
  private chunk: number | undefined;
  private delimiter = false;
  private trailers = false;
  done = false;
  constructor(
    private headOnly: boolean,
    private onHead: (head: Head) => void,
    private onData: (data: Uint8Array) => void,
  ) {}
  push(bytes: Uint8Array) {
    if (this.done) return;
    this.buffer = joinBytes([this.buffer, bytes]);
    if (!this.started) {
      const text = new TextDecoder("latin1").decode(this.buffer);
      const end = text.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.buffer.length > 65536) throw new Error("HTTP 响应头过大");
        return;
      }
      const head = splitHttp(this.buffer.slice(0, end + 4), true);
      this.buffer = this.buffer.slice(end + 4);
      if (head.status >= 100 && head.status < 200) {
        this.push(new Uint8Array());
        return;
      }
      this.started = true;
      this.chunked = head.headers.some(
        ([name, value]) =>
          name === "transfer-encoding" && /chunked/i.test(value),
      );
      const length = head.headers.find(
        ([name]) => name === "content-length",
      )?.[1];
      if (length !== undefined && !this.chunked) {
        if (!/^\d+$/.test(length)) throw new Error("无效的响应长度");
        this.remaining = Number(length);
      }
      this.onHead({ status: head.status, headers: head.headers });
      if (this.headOnly || [204, 205, 304].includes(head.status)) {
        this.done = true;
        return;
      }
    }
    if (!this.chunked) {
      const take =
        this.remaining === undefined
          ? this.buffer.length
          : Math.min(this.remaining, this.buffer.length);
      if (take) this.onData(this.buffer.slice(0, take));
      this.buffer = this.buffer.slice(take);
      if (this.remaining !== undefined) {
        this.remaining -= take;
        if (this.remaining === 0) this.done = true;
      }
      return;
    }
    while (this.buffer.length) {
      if (this.trailers) {
        const end = crlf(this.buffer);
        if (end < 0) return;
        this.buffer = this.buffer.slice(end + 2);
        if (end === 0) {
          this.done = true;
          return;
        }
        continue;
      }
      if (this.delimiter) {
        if (this.buffer.length < 2) return;
        if (crlf(this.buffer) !== 0) throw new Error("无效的 HTTP 分块边界");
        this.buffer = this.buffer.slice(2);
        this.delimiter = false;
      }
      if (this.chunk === undefined) {
        const end = crlf(this.buffer);
        if (end < 0) return;
        const size = new TextDecoder()
          .decode(this.buffer.slice(0, end))
          .split(";")[0];
        if (!/^[0-9a-f]+$/i.test(size)) throw new Error("无效的 HTTP 分块长度");
        this.chunk = parseInt(size, 16);
        if (!Number.isSafeInteger(this.chunk)) throw new Error("HTTP 分块过大");
        this.buffer = this.buffer.slice(end + 2);
        if (this.chunk === 0) {
          this.trailers = true;
          continue;
        }
      }
      const take = Math.min(this.chunk, this.buffer.length);
      if (take) this.onData(this.buffer.slice(0, take));
      this.buffer = this.buffer.slice(take);
      this.chunk -= take;
      if (this.chunk === 0) {
        this.chunk = undefined;
        this.delimiter = true;
      } else return;
    }
  }
  end() {
    if (
      !this.started ||
      (!this.done && (this.chunked || (this.remaining ?? 0) > 0))
    )
      throw new Error("HTTP 响应被截断");
    this.done = true;
  }
}
export function httpStreamRequest(
  streams: HostStreams,
  port: number,
  path: string,
  method: string,
  headers: [string, string][],
  body: Uint8Array,
  signal: AbortSignal,
): Promise<Head & { body: ReadableStream<Uint8Array<ArrayBuffer>> }> {
  if (!path.startsWith("/") || /[\r\n]/.test(path) || !/^[A-Z]+$/.test(method))
    return Promise.reject(new Error("无效的预览请求"));
  return new Promise((resolve, reject) => {
    let connection: HostStream | undefined;
    let ended = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    const bodyStream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(value) {
        controller = value;
      },
      cancel() {
        finish(new Error("预览请求已取消"));
      },
    });
    const abort = () => finish(new Error("预览请求已取消"));
    function finish(error?: Error) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      connection?.close();
      if (error) {
        reject(error);
        controller.error(error);
      } else controller.close();
    }
    const decoder = new HttpStreamDecoder(
      method === "HEAD",
      (head) => resolve({ ...head, body: bodyStream }),
      (bytes) => controller.enqueue(new Uint8Array(bytes)),
    );
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error("预览响应超时")), 60000);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    touch();
    void streams
      .open(port, {
        data(bytes) {
          if (ended) return;
          try {
            touch();
            decoder.push(bytes);
            if (decoder.done) finish();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        },
        closed(error) {
          if (ended) return;
          try {
            if (error) throw new Error(error);
            decoder.end();
            finish();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        },
      })
      .then(
        (opened) => {
          if (ended) {
            opened.close();
            return;
          }
          connection = opened;
          const safe = headers.filter(
            ([key, value]) =>
              !/[\r\n]/.test(key + value) &&
              !/^(host|connection|content-length|transfer-encoding|accept-encoding|origin|referer)$/i.test(
                key,
              ),
          );
          opened.write(
            new TextEncoder().encode(
              `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nAccept-Encoding: identity\r\nContent-Length: ${body.length}\r\n${safe.map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`,
            ),
          );
          if (body.length) opened.write(body);
        },
        (error) => finish(new Error(String(error))),
      );
  });
}
