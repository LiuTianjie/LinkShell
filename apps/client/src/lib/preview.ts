import type { HostLink } from "@linkshell/client-core";
import { Buffer } from "buffer";
import * as Device from "expo-device";
import TcpSocket from "react-native-tcp-socket";

type Server = InstanceType<typeof TcpSocket.Server>;
type Socket = InstanceType<typeof TcpSocket.Socket>;

// Port previews, like `ssh -L`: a listener on the phone's loopback carries
// each connection to the same port on the computer, through the encrypted
// channel. The WebView talks to 127.0.0.1 as if the server ran here, so the
// page, its hot-reload WebSocket and its cookies all work unchanged.

export interface Forward {
  /** The port on the computer. */
  port: number;
  /** Where the phone listens (the same number when it was free). */
  localPort: number;
  url: string;
  stop(): void;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ port, host: "127.0.0.1", reuseAddress: true }, () => {
      server.off("error", onError);
      const address = server.address();
      resolve(address && typeof address === "object" ? address.port : port);
    });
  });
}

/**
 * Starts forwarding `port` on the computer to the phone's loopback. Keeps
 * the port number when it's free here, so absolute `localhost:<port>` URLs
 * inside the page still resolve.
 */
export async function forwardPort(link: HostLink, port: number): Promise<Forward> {
  const sockets = new Map<string, Socket>();
  const pending = new Set<Socket>();

  const offData = link.on("proxy.data", ({ streamId, data }) => sockets.get(streamId)?.write(Buffer.from(data, "base64")));
  const offClosed = link.on("proxy.closed", ({ streamId }) => {
    const socket = sockets.get(streamId);
    sockets.delete(streamId);
    socket?.end();
  });
  // The channel dropped: the computer already closed its ends.
  const offStatus = link.onStatus((status) => {
    if (status === "online") return;
    for (const socket of [...sockets.values(), ...pending]) socket.destroy();
    sockets.clear();
    pending.clear();
  });

  const server = TcpSocket.createServer((socket) => {
    pending.add(socket);
    let streamId: string | undefined;
    let queue: Buffer[] = [];
    let ended = false;
    const send = (chunk: Buffer) => {
      void link.call("proxy.write", { streamId: streamId!, data: chunk.toString("base64") }).catch(() => socket.destroy());
    };
    socket.on("data", (data) => {
      const chunk = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
      if (streamId) send(chunk);
      else queue.push(chunk);
    });
    const hangUp = () => {
      ended = true;
      pending.delete(socket);
      if (streamId && sockets.delete(streamId)) void link.call("proxy.close", { streamId }).catch(() => {});
    };
    socket.on("close", hangUp);
    socket.on("error", () => socket.destroy());
    link
      .call("proxy.open", { port })
      .then((result) => {
        pending.delete(socket);
        if (ended) {
          void link.call("proxy.close", { streamId: result.streamId }).catch(() => {});
          return;
        }
        streamId = result.streamId;
        sockets.set(streamId, socket);
        for (const chunk of queue) send(chunk);
        queue = [];
      })
      .catch(() => socket.destroy());
  });

  // A simulator shares the computer's loopback: taking the same number there
  // would put this listener where the computer looks for its own server.
  let localPort: number;
  try {
    localPort = await listen(server, Device.isDevice ? port : 0);
  } catch {
    localPort = await listen(server, 0);
  }

  return {
    port,
    localPort,
    url: `http://127.0.0.1:${localPort}/`,
    stop() {
      offData();
      offClosed();
      offStatus();
      for (const socket of [...sockets.values(), ...pending]) socket.destroy();
      sockets.clear();
      pending.clear();
      server.close();
    },
  };
}
