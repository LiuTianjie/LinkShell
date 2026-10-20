import { createHash } from "node:crypto";
import { connect } from "node:net";
import { win32 } from "node:path";
import WebSocket from "ws";

export const isNamedPipe = (path: string): boolean => path.startsWith("\\\\.\\pipe\\");

/** Stable across callers, separate for each state directory, without the Unix path limit. */
export function windowsPipe(home: string, name: string): string {
  const key = win32.resolve(home).replace(/[\\/]+$/, "").toLowerCase();
  const tag = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return `\\\\.\\pipe\\linkshell-${tag}-${name}`;
}

export function localWebSocket(target: string, timeout = 10_000): WebSocket {
  const options = { perMessageDeflate: false, handshakeTimeout: timeout };
  // URL parsers treat Windows backslashes and drive letters as URL syntax. Connect directly.
  if (isNamedPipe(target)) return new WebSocket("ws://localhost/", {
    ...options,
    createConnection: () => connect(target),
  });
  return new WebSocket(/^wss?:\/\//.test(target) ? target : `ws+unix://${target}:/`, options);
}
