import type { SocketLike } from "@linkshell/client-core";
import { LinkSocket } from "../../modules/link-socket/src";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Loopback, LAN, link-local, CGNAT/Tailscale and mDNS hosts — never behind a proxy. */
export function isLocalHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".local") || host === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

const sockets = new Map<string, NativeSocket>();
let listening = false;
let counter = 0;

function listen() {
  if (listening || !LinkSocket) return;
  listening = true;
  LinkSocket.addListener("onOpen", ({ id }) => sockets.get(id)?.handleOpen());
  LinkSocket.addListener("onMessage", ({ id, data }) => sockets.get(id)?.onmessage?.({ data }));
  LinkSocket.addListener("onError", ({ id, message }) => sockets.get(id)?.onerror?.({ message }));
  LinkSocket.addListener("onClose", ({ id, code, reason }) => sockets.get(id)?.handleClose(code, reason));
}

class NativeSocket implements SocketLike {
  readyState = CONNECTING;
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  onmessage: SocketLike["onmessage"] = null;
  private readonly id = `s${Date.now().toString(36)}${(counter++).toString(36)}`;

  constructor(url: string) {
    listen();
    sockets.set(this.id, this);
    try {
      LinkSocket!.connect(this.id, url, true);
    } catch (error) {
      sockets.delete(this.id);
      throw error;
    }
  }

  send(data: string): void {
    if (this.readyState === OPEN) LinkSocket!.send(this.id, data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    LinkSocket!.close(this.id, code, reason);
  }

  handleOpen(): void {
    this.readyState = OPEN;
    this.onopen?.({});
  }

  handleClose(code: number, reason: string): void {
    this.readyState = CLOSED;
    sockets.delete(this.id);
    this.onclose?.({ code, reason });
  }
}

/**
 * Opens a socket to the host. Local-network hosts go straight to the native
 * transport (no proxy); everything else uses the platform WebSocket.
 */
export function createSocket(url: string): SocketLike {
  if (LinkSocket && isLocalHost(url)) return new NativeSocket(url);
  return new WebSocket(url) as unknown as SocketLike;
}
