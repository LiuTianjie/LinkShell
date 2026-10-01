import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { RTCPeerConnection } from "werift";
import { afterEach, describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "@linkshell/host";
import { DIRECT_LABEL } from "@linkshell/wire";
import { HostLink, type SocketLike } from "../src/host-link.js";
import { HostStreams, type DirectConnector, type HostStream } from "../src/streams.js";

// Streams to the computer's ports, peer to peer: a real host, and werift
// playing the phone's WebRTC stack.

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** What an app provides with its platform's WebRTC. `made` collects the connections, to break them from outside. */
function connector(made: RTCPeerConnection[] = []): DirectConnector {
  return (iceServers) => {
    const connection = new RTCPeerConnection({ iceServers: iceServers.map((urls) => ({ urls })) });
    made.push(connection);
    const channel = connection.createDataChannel(DIRECT_LABEL);
    return {
      async offer() {
        await connection.setLocalDescription(await connection.createOffer());
        if (connection.iceGatheringState !== "complete") {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2000);
            connection.iceGatheringStateChange.subscribe((state) => state === "complete" && (clearTimeout(timer), resolve()));
          });
        }
        return connection.localDescription!.sdp;
      },
      accept: (sdp) => connection.setRemoteDescription({ type: "answer", sdp }),
      send: (bytes) => channel.send(Buffer.from(bytes)),
      onState(listener) {
        channel.stateChanged.subscribe((state) => (state === "open" ? listener("open") : state === "closed" ? listener("closed") : undefined));
        connection.connectionStateChange.subscribe((state) => (state === "failed" || state === "closed") && listener("closed"));
      },
      onMessage: (listener) => channel.onMessage.subscribe((message) => typeof message !== "string" && listener(message)),
      close: () => void connection.close().catch(() => {}),
    };
  };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function listen(onSocket: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      onSocket(socket);
    });
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise((done) => server.close(() => done(undefined)));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

async function setup(iceServers: string[] | false = []) {
  const home = mkdtempSync(join(tmpdir(), "lsh-direct-"));
  const logs: string[] = [];
  const host: RunningHost = await startHost({ home, version: "test", tcpPort: 0, drivers: () => [], iceServers, log: (message) => logs.push(message) });
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  cleanups.push(() => host.stop());
  const link = new HostLink({
    url: `ws://127.0.0.1:${host.server.tcpAddress()}`,
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    minBackoffMs: 50,
    maxBackoffMs: 200,
    heartbeatMs: 0,
  });
  cleanups.push(() => link.stop());
  link.start();
  await waitFor(() => link.status === "online");
  const machine = await link.call("machine.info", {});
  return { host, link, machine, logs };
}

/** A stream with what came back on it. */
async function opened(streams: HostStreams, port: number) {
  const chunks: Uint8Array[] = [];
  const state: { closed?: string | true } = {};
  const stream: HostStream = await streams.open(port, {
    data: (bytes) => chunks.push(bytes.slice()),
    closed: (error) => (state.closed = error ?? true),
  });
  return { stream, state, received: () => Buffer.concat(chunks) };
}

describe("streams to the computer's ports", () => {
  it("go peer to peer when a direct channel can be made, in both directions and in order", async () => {
    const { link, machine, logs } = await setup();
    expect(machine.direct).toEqual({ iceServers: [] });
    const echo = await listen((socket) => socket.pipe(socket));
    const streams = new HostStreams(link, { connector: connector(), iceServers: () => machine.direct?.iceServers });
    cleanups.push(() => streams.stop());
    const paths: string[] = [];
    streams.onPath((path) => paths.push(path));
    await waitFor(() => streams.path === "direct");
    expect(logs.some((line) => line.includes("[direct] channel open"))).toBe(true);

    const a = await opened(streams, echo.port);
    const b = await opened(streams, echo.port);
    expect([a.stream.direct, b.stream.direct]).toEqual([true, true]);
    // More than one message's worth, so it is cut up and put together again.
    const big = Buffer.alloc(300_000);
    for (let index = 0; index < big.length; index++) big[index] = (index * 31) % 251;
    a.stream.write(big);
    b.stream.write(Buffer.from("second stream"));
    await waitFor(() => a.received().length === big.length && b.received().length === 13);
    expect(a.received().equals(big)).toBe(true);
    expect(b.received().toString()).toBe("second stream");

    // Closing one from the device ends that stream on the computer; the other goes on.
    a.stream.close();
    b.stream.write(Buffer.from("!"));
    await waitFor(() => b.received().toString() === "second stream!");
    expect(b.state.closed).toBeUndefined();
    b.stream.close();
  });

  it("carry what a server says before it is asked, and say when the server hangs up", async () => {
    const { link, machine } = await setup();
    const greeter = await listen((socket) => {
      socket.write("hello from the server\n");
      socket.on("data", () => socket.end("bye\n"));
    });
    const streams = new HostStreams(link, { connector: connector(), iceServers: () => machine.direct?.iceServers });
    cleanups.push(() => streams.stop());
    await waitFor(() => streams.path === "direct");
    const stream = await opened(streams, greeter.port);
    await waitFor(() => stream.received().toString() === "hello from the server\n");
    stream.stream.write(Buffer.from("x"));
    await waitFor(() => stream.state.closed === true);
    expect(stream.received().toString()).toBe("hello from the server\nbye\n");
    // Nothing listens there: refused like any other stream.
    greeter.server.close();
    await expect(opened(streams, 1)).rejects.toMatchObject({ appCode: "not_found" });
  });

  it("deliver a server's burst whole when it writes faster than the channel carries (the computer holds it back)", async () => {
    const { link, machine } = await setup();
    const total = 12 * 1024 * 1024;
    const blob = Buffer.alloc(total);
    for (let index = 0; index < total; index += 97) blob[index] = (index / 97) % 256;
    const source = await listen((socket) => socket.end(blob));
    const streams = new HostStreams(link, { connector: connector(), iceServers: () => machine.direct?.iceServers });
    cleanups.push(() => streams.stop());
    await waitFor(() => streams.path === "direct");
    let length = 0;
    let sum = 0;
    let closed = false;
    await streams.open(source.port, {
      data: (bytes) => {
        for (let index = 0; index < bytes.length; index += 1) sum = (sum + bytes[index]! * ((length + index) % 13 + 1)) >>> 0;
        length += bytes.length;
      },
      closed: () => (closed = true),
    });
    await waitFor(() => closed, 30_000);
    let expected = 0;
    for (let index = 0; index < total; index += 1) expected = (expected + blob[index]! * ((index % 13) + 1)) >>> 0;
    expect(length).toBe(total);
    expect(sum).toBe(expected);
  }, 40_000);

  it("go through the gateway channel when there is no direct one, and move back to it when a direct one is lost", async () => {
    const { link, machine } = await setup();
    const echo = await listen((socket) => socket.pipe(socket));
    // An app without WebRTC, or a computer that doesn't offer it.
    const plain = new HostStreams(link, { iceServers: () => machine.direct?.iceServers });
    cleanups.push(() => plain.stop());
    const relayed = await opened(plain, echo.port);
    expect([plain.path, relayed.stream.direct]).toEqual(["relay", false]);
    relayed.stream.write(Buffer.from("through the gateway"));
    await waitFor(() => relayed.received().toString() === "through the gateway");
    relayed.stream.close();

    const made: RTCPeerConnection[] = [];
    const streams = new HostStreams(link, { connector: connector(made), iceServers: () => machine.direct?.iceServers, retryMs: [200] });
    cleanups.push(() => streams.stop());
    await waitFor(() => streams.path === "direct");
    const direct = await opened(streams, echo.port);
    expect(direct.stream.direct).toBe(true);
    // The path goes away (the phone changed networks): its streams end, new ones use the gateway…
    await made[0]!.close();
    await waitFor(() => direct.state.closed === "直连中断了");
    expect(streams.path).not.toBe("direct");
    const meanwhile = await opened(streams, echo.port);
    expect(meanwhile.stream.direct).toBe(false);
    meanwhile.stream.write(Buffer.from("still works"));
    await waitFor(() => meanwhile.received().toString() === "still works");
    // …until a direct channel is up again.
    await waitFor(() => streams.path === "direct");
    expect(made).toHaveLength(2);
    expect((await opened(streams, echo.port)).stream.direct).toBe(true);
  });

  it("stay on the gateway channel for a computer that turned the direct channel off", async () => {
    const { link, machine } = await setup(false);
    expect(machine.direct).toBeUndefined();
    const echo = await listen((socket) => socket.pipe(socket));
    const streams = new HostStreams(link, { connector: connector(), iceServers: () => machine.direct?.iceServers });
    cleanups.push(() => streams.stop());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(streams.path).toBe("relay");
    const stream = await opened(streams, echo.port);
    stream.stream.write(Buffer.from("ok"));
    await waitFor(() => stream.received().toString() === "ok");
    expect(stream.stream.direct).toBe(false);
  });
});
