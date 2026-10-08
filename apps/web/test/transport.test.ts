import { describe, it, expect } from "vitest";
import { encodeWs, WsDecoder, splitHttp } from "../src/live/transport";

const text = new TextEncoder();
describe("encrypted preview transport framing", () => {
  it("decodes chunked HTTP without confusing binary body bytes with headers", () => {
    const result = splitHttp(
      text.encode(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
      ),
    );
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe("hello world");
  });
  it("rejects truncated HTTP bodies", () => {
    expect(() =>
      splitHttp(
        text.encode("HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\nshort"),
      ),
    ).toThrow("截断");
    expect(() =>
      splitHttp(
        text.encode(
          "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhi",
        ),
      ),
    ).toThrow("不完整");
  });
  it("accepts HEAD and not-modified responses whose content length describes the resource", () => {
    expect(
      splitHttp(
        text.encode("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n"),
        true,
      ).body.length,
    ).toBe(0);
    expect(
      splitHttp(
        text.encode("HTTP/1.1 304 Not Modified\r\nContent-Length: 100\r\n\r\n"),
      ).body.length,
    ).toBe(0);
  });
  it.each([0, 30, 126, 65536])(
    "handles masked websocket frames split into transport chunks, size %i",
    (length) => {
      const payload = Uint8Array.from({ length }, (_, index) => index % 251);
      const encoded = encodeWs(payload, 2);
      const decoder = new WsDecoder();
      const output = [
        ...decoder.push(encoded.slice(0, 1)),
        ...decoder.push(encoded.slice(1, 7)),
        ...decoder.push(encoded.slice(7)),
      ];
      expect(output).toEqual([{ opcode: 2, bytes: payload }]);
      expect(encoded[1] & 128).toBe(128);
    },
  );
  it("reassembles continuation frames while retaining ping control frames", () => {
    const decoder = new WsDecoder();
    expect(
      decoder.push(Uint8Array.from([1, 2, 104, 105, 137, 1, 33, 128, 1, 33])),
    ).toEqual([
      { opcode: 9, bytes: Uint8Array.from([33]) },
      { opcode: 1, bytes: text.encode("hi!") },
    ]);
  });
  it("refuses oversized frame allocations", () => {
    const header = new Uint8Array(10);
    header[0] = 130;
    header[1] = 127;
    new DataView(header.buffer).setBigUint64(2, BigInt(100_000_000));
    expect(() => new WsDecoder().push(header)).toThrow("过大");
  });
});
