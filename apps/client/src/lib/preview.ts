import type { HostStream, HostStreams } from "@linkshell/client-core";
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
 * inside the page still resolve. Each connection is a stream of `streams`:
 * peer to peer when the computer can be reached directly, through the
 * gateway otherwise.
 */
export async function forwardPort(streams: HostStreams, port: number): Promise<Forward> {
  const sockets = new Set<Socket>();

  const server = TcpSocket.createServer((socket) => {
    sockets.add(socket);
    let stream: HostStream | undefined;
    let queue: Buffer[] = [];
    let ended = false;
    socket.on("data", (data) => {
      const chunk = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
      if (stream) stream.write(chunk);
      else queue.push(chunk);
    });
    socket.on("close", () => {
      ended = true;
      sockets.delete(socket);
      stream?.close();
    });
    socket.on("error", () => socket.destroy());
    streams
      .open(port, {
        data: (bytes) => socket.write(Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)),
        // The computer's end closed, or the path under the stream went away.
        closed: (error) => (error ? socket.destroy() : socket.end()),
      })
      .then((opened) => {
        if (ended) return opened.close();
        stream = opened;
        for (const chunk of queue) opened.write(chunk);
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
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
    },
  };
}
