import WebSocket from "ws";
import {
  RpcPeer,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type NotificationName,
  type NotificationParams,
} from "@linkshell/wire";

export interface HostClient {
  call<M extends MethodName>(method: M, params: MethodParams<M>, timeoutMs?: number): Promise<MethodResult<M>>;
  on<N extends NotificationName>(name: N, listener: (params: NotificationParams<N>) => void): () => void;
  close(): void;
  readonly closed: Promise<void>;
}

/** Connects to a host over its unix socket (`path`) or a `ws://` URL. */
export async function connectHost(target: string): Promise<HostClient> {
  const url = target.startsWith("ws://") || target.startsWith("wss://") ? target : `ws+unix://${target}:/`;
  const socket = new WebSocket(url, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  const peer = new RpcPeer({
    send: (text) => socket.send(text),
    onNotification: (method, params) => {
      for (const listener of listeners.get(method) ?? []) listener(params);
    },
    requestTimeoutMs: 120_000,
  });
  socket.on("message", (data) => peer.receive(data.toString()));
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => {
      peer.close();
      resolve();
    });
  });
  return {
    call: (method, params, timeoutMs) => peer.request(method, params, timeoutMs),
    on(name, listener) {
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(listener as (params: unknown) => void);
      return () => set!.delete(listener as (params: unknown) => void);
    },
    close: () => socket.close(),
    closed,
  };
}
