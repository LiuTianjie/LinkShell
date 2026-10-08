import { describe, it, expect } from "vitest";
import { HttpStreamDecoder } from "../src/live/http-stream";
import { fileTarget } from "../src/live/file-target";
import { replayTerminal } from "../src/live/terminal-replay";
const bytes = (value: string) => new TextEncoder().encode(value);
describe("streaming port previews", () => {
  it("delivers SSE before the TCP connection closes, across arbitrary framing boundaries", () => {
    let status = 0;
    const output: Uint8Array[] = [];
    const decoder = new HttpStreamDecoder(
      false,
      (head) => {
        status = head.status;
      },
      (chunk) => output.push(chunk),
    );
    const wire = bytes(
      "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n9\r\ndata: 1\n\n\r\n",
    );
    for (const byte of wire) decoder.push(Uint8Array.of(byte));
    expect(status).toBe(200);
    expect(
      new TextDecoder().decode(
        Uint8Array.from(output.flatMap((chunk) => [...chunk])),
      ),
    ).toBe("data: 1\n\n");
    expect(decoder.done).toBe(false);
    decoder.push(bytes("0\r\nX-Trailer: ok\r\n\r\n"));
    expect(decoder.done).toBe(true);
    decoder.end();
  });
  it("finishes content-length responses without waiting for a close and rejects truncation", () => {
    const response = new HttpStreamDecoder(
      false,
      () => {},
      () => {},
    );
    response.push(bytes("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"));
    expect(response.done).toBe(true);
    const short = new HttpStreamDecoder(
      false,
      () => {},
      () => {},
    );
    short.push(bytes("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhi"));
    expect(() => short.end()).toThrow("截断");
  });
  it("handles informational responses and bodyless HEAD responses", () => {
    const statuses: number[] = [];
    const response = new HttpStreamDecoder(
      true,
      (head) => statuses.push(head.status),
      () => {
        throw new Error("HEAD body");
      },
    );
    response.push(
      bytes(
        "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 123\r\n\r\n",
      ),
    );
    expect(statuses).toEqual([200]);
    expect(response.done).toBe(true);
  });
  it("rejects malformed chunk delimiters", () => {
    const response = new HttpStreamDecoder(
      false,
      () => {},
      () => {},
    );
    expect(() =>
      response.push(
        bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\naXX"),
      ),
    ).toThrow("边界");
  });
});
describe("host file links", () => {
  it("resolves relative, encoded, and line-qualified paths", () => {
    expect(fileTarget("src/a.ts#L42", "/project")).toEqual({
      path: "/project/src/a.ts",
      line: 42,
    });
    expect(fileTarget("file:///project/my%20file.ts:3:8")).toEqual({
      path: "/project/my file.ts",
      line: 3,
    });
    expect(fileTarget("/tmp/a.ts:7")).toEqual({ path: "/tmp/a.ts", line: 7 });
  });
  it("keeps web URLs, anchors and executable schemes out of filesystem RPC", () => {
    for (const value of [
      "https://example.com/a:8",
      "#heading",
      "javascript:alert(1)",
      "mailto:a@b.com",
    ])
      expect(fileTarget(value, "/project")).toBeUndefined();
  });
});
it("replays terminal pages with original geometry and waits for parser completion", async () => {
  const log: string[] = [];
  let done: (() => void) | undefined;
  const task = replayTerminal(
    {
      reset() {
        log.push("reset");
      },
      resize(cols, rows) {
        log.push(`${cols}x${rows}`);
      },
      write(data, callback) {
        log.push(data);
        done = callback;
      },
    },
    {
      reset: true,
      replay: "wrong legacy",
      terminal: { cols: 80, rows: 24 },
      recording: { afterFrame: 0, throughFrame: 2 },
    },
    async (after) =>
      after === 0
        ? {
            frames: [{ frame: 1, cols: 40, rows: 10, data: "first" }],
            nextFrame: 1,
            done: false,
          }
        : {
            frames: [{ frame: 2, cols: 80, rows: 24, data: "second" }],
            nextFrame: 2,
            done: true,
          },
    () => true,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(log).toEqual(["reset", "40x10", "first"]);
  done!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(log).toEqual(["reset", "40x10", "first", "80x24", "second"]);
  done!();
  await task;
});
