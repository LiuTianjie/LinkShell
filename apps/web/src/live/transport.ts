import type { HostStream, HostStreams } from "@linkshell/client-core";

export const joinBytes = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(
    chunks.reduce((size, chunk) => size + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};
const utf8 = new TextEncoder();
export function splitHttp(
  bytes: Uint8Array,
  head = false,
): {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
} {
  const text = new TextDecoder("latin1").decode(bytes);
  const end = text.indexOf("\r\n\r\n");
  if (end < 0) throw new Error("HTTP 响应头不完整");
  const lines = text.slice(0, end).split("\r\n");
  const status = Number(lines.shift()?.split(" ")[1]);
  if (!Number.isFinite(status)) throw new Error("无效的 HTTP 响应");
  const headers = lines.map((line) => {
    const index = line.indexOf(":");
    return [
      line.slice(0, index).toLowerCase(),
      line.slice(index + 1).trim(),
    ] as [string, string];
  });
  let body = bytes.slice(end + 4);
  if (head || [204, 205, 304].includes(status))
    return { status, headers, body: new Uint8Array() };
  if (
    headers.some(
      ([name, value]) => name === "transfer-encoding" && /chunked/i.test(value),
    )
  ) {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (offset < body.length) {
      let at = offset;
      while (at < body.length - 1 && !(body[at] === 13 && body[at + 1] === 10))
        at++;
      const size = parseInt(
        new TextDecoder().decode(body.slice(offset, at)).split(";")[0],
        16,
      );
      if (!Number.isFinite(size) || size < 0 || at + 2 + size > body.length)
        throw new Error("HTTP 分块响应不完整");
      if (size === 0) return { status, headers, body: joinBytes(chunks) };
      chunks.push(body.slice(at + 2, at + 2 + size));
      offset = at + 2 + size + 2;
    }
    throw new Error("HTTP 分块响应未结束");
  }
  const length = headers.find(([name]) => name === "content-length");
  if (length && !head && body.length < Number(length[1]))
    throw new Error("HTTP 响应被截断");
  if (length) body = body.slice(0, Number(length[1]));
  return { status, headers, body };
}
export async function httpRequest(
  streams: HostStreams,
  port: number,
  path: string,
  method = "GET",
  headers: [string, string][] = [],
  body = new Uint8Array(),
): Promise<ReturnType<typeof splitHttp>> {
  if (!path.startsWith("/") || /[\r\n]/.test(path) || !/^[A-Z]+$/.test(method))
    throw new Error("无效的预览请求");
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let stream: HostStream | undefined;
    let ended = false;
    const finish = (error?: string) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      stream?.close();
      if (error) {
        reject(new Error(error));
        return;
      }
      try {
        resolve(splitHttp(joinBytes(chunks), method === "HEAD"));
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(() => finish("预览请求超时"), 60000);
    void streams
      .open(port, {
        data(bytes) {
          size += bytes.length;
          if (size > 32 * 1024 * 1024) return finish("单次预览响应超过 32 MB");
          chunks.push(bytes);
        },
        closed: finish,
      })
      .then(
        (opened) => {
          if (ended) return opened.close();
          stream = opened;
          const safe = headers.filter(
            ([key, value]) =>
              !/[\r\n]/.test(key + value) &&
              !/^(host|connection|content-length|transfer-encoding|accept-encoding|origin|referer)$/i.test(
                key,
              ),
          );
          const request = `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nAccept-Encoding: identity\r\nContent-Length: ${body.length}\r\n${safe.map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`;
          stream.write(utf8.encode(request));
          if (body.length) stream.write(body);
        },
        (error) => finish(String(error)),
      );
  });
}

export function encodeWs(payload: Uint8Array, opcode: number): Uint8Array {
  const header = payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10;
  const result = new Uint8Array(header + 4 + payload.length);
  result[0] = 0x80 | opcode;
  result[1] = 0x80 | (header === 2 ? payload.length : header === 4 ? 126 : 127);
  const view = new DataView(result.buffer);
  if (header === 4) view.setUint16(2, payload.length);
  if (header === 10) view.setBigUint64(2, BigInt(payload.length));
  const mask = crypto.getRandomValues(new Uint8Array(4));
  result.set(mask, header);
  for (let index = 0; index < payload.length; index++)
    result[header + 4 + index] = payload[index] ^ mask[index % 4];
  return result;
}
export class WsDecoder {
  private buffer = new Uint8Array();
  private fragments: Uint8Array[] = [];
  private opcode = 0;
  push(bytes: Uint8Array): { opcode: number; bytes: Uint8Array }[] {
    this.buffer = joinBytes([this.buffer, bytes]);
    const out: { opcode: number; bytes: Uint8Array }[] = [];
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 15;
      let length = second & 127;
      let header = 2;
      if (length === 126) {
        if (this.buffer.length < 4) break;
        length = new DataView(this.buffer.buffer).getUint16(2);
        header = 4;
      }
      if (length === 127) {
        if (this.buffer.length < 10) break;
        const big = new DataView(this.buffer.buffer).getBigUint64(2);
        if (big > BigInt(32 * 1024 * 1024)) throw new Error("WebSocket 帧过大");
        length = Number(big);
        header = 10;
      }
      const masked = (second & 128) !== 0;
      const total = header + (masked ? 4 : 0) + length;
      if (this.buffer.length < total) break;
      const payload = this.buffer.slice(header + (masked ? 4 : 0), total);
      if (masked)
        for (let index = 0; index < payload.length; index++)
          payload[index] ^= this.buffer[header + (index % 4)];
      this.buffer = this.buffer.slice(total);
      if (opcode >= 8) {
        out.push({ opcode, bytes: payload });
        continue;
      }
      if (opcode !== 0) {
        this.opcode = opcode;
        this.fragments = [];
      }
      this.fragments.push(payload);
      if (
        this.fragments.reduce((size, chunk) => size + chunk.length, 0) >
        32 * 1024 * 1024
      )
        throw new Error("WebSocket 消息过大");
      if ((first & 128) !== 0) {
        out.push({ opcode: this.opcode, bytes: joinBytes(this.fragments) });
        this.fragments = [];
      }
    }
    return out;
  }
}
export async function openWebSocket(
  streams: HostStreams,
  port: number,
  path: string,
  events: {
    open: () => void;
    data: (value: string | ArrayBuffer) => void;
    close: (reason?: string) => void;
  },
  protocols: string[] = [],
) {
  if (
    !path.startsWith("/") ||
    /[\r\n]/.test(path) ||
    protocols.some((value) => !/^[\w.!#$%&'*+\-^`|~]+$/.test(value))
  )
    throw new Error("无效的 WebSocket 地址");
  const key = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
  );
  const digest = await crypto.subtle.digest(
    "SHA-1",
    utf8.encode(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
  let stream: HostStream | undefined;
  let handshake = true;
  let buffer = new Uint8Array();
  let closed = false;
  const decoder = new WsDecoder();
  const close = (reason?: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    stream?.close();
    events.close(reason);
  };
  const timeout = setTimeout(() => close("WebSocket 握手超时"), 15000);
  const opened = await streams.open(port, {
    data(bytes) {
      try {
        if (handshake) {
          buffer = joinBytes([buffer, bytes]);
          const text = new TextDecoder().decode(buffer);
          const end = text.indexOf("\r\n\r\n");
          if (end < 0) {
            if (buffer.length > 32768) close("无效的 WebSocket 响应");
            return;
          }
          const header = text.slice(0, end);
          if (
            !/^HTTP\/1\.[01] 101\b/.test(header) ||
            !header
              .toLowerCase()
              .includes(`sec-websocket-accept: ${expected}`.toLowerCase())
          )
            return close("WebSocket 握手被拒绝");
          handshake = false;
          clearTimeout(timeout);
          bytes = buffer.slice(end + 4);
          buffer = new Uint8Array();
          events.open();
        }
        for (const frame of decoder.push(bytes)) {
          if (frame.opcode === 8) {
            close();
            break;
          }
          if (frame.opcode === 9) stream?.write(encodeWs(frame.bytes, 10));
          if (frame.opcode === 1)
            events.data(new TextDecoder().decode(frame.bytes));
          if (frame.opcode === 2) events.data(frame.bytes.slice().buffer);
        }
      } catch (error) {
        close(String(error));
      }
    },
    closed: close,
  });
  if (closed) opened.close();
  else {
    stream = opened;
    stream.write(
      utf8.encode(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:${port}\r\n${protocols.length ? `Sec-WebSocket-Protocol: ${protocols.join(", ")}\r\n` : ""}\r\n`,
      ),
    );
  }
  return {
    send(value: string | ArrayBuffer) {
      if (!closed && !handshake)
        stream?.write(
          encodeWs(
            typeof value === "string"
              ? utf8.encode(value)
              : new Uint8Array(value),
            typeof value === "string" ? 1 : 2,
          ),
        );
    },
    close,
  };
}
