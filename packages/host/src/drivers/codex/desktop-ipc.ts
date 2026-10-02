import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// The Codex desktop app and its IDE extension keep the threads they run in
// app-servers of their own, which take no other clients. What they do share
// is a message bus between their windows, on a socket in Codex's home: a
// window that doesn't run a thread asks the one that does to act on it
// ("thread-follower-…" requests). That is the only way to stop a turn the
// desktop app is running without stopping the app.
//
// The bus is the app's own, not a published interface: each method carries a
// version the receiver checks, and a request it doesn't recognise is refused.
// So everything here is one question with a yes or a no; a no is reported as
// "can't be stopped from here", never retried in another shape.

/** Where the desktop app's bus listens (the first Codex window to start serves it). */
export function desktopBusSocket(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "ipc", "ipc.sock");
}

/** The version of the interrupt request the installed apps accept: with the turn it is meant for, or (older) without. */
const INTERRUPT_VERSION = { withTurn: 4, anyTurn: 3 };

type Frame = Record<string, unknown>;

function frame(message: Frame): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Asks whichever Codex window runs `threadId` to stop its turn, as its own
 * Stop button does. Resolves when that window says it has; rejects when no
 * window runs the thread, none answers in time, or the app isn't there.
 */
export async function interruptThroughDesktop(
  socketPath: string,
  threadId: string,
  turnId: string | undefined,
  timeoutMs = 12_000,
): Promise<void> {
  if (!existsSync(socketPath)) throw new Error("the Codex desktop app isn't running");
  const socket = connect(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const bus = busClient(socket, timeoutMs);
    const registered = await bus.request("initialize", { clientType: "linkshell" }, 0);
    bus.clientId = String((registered as { clientId?: unknown }).clientId ?? "");
    await bus.request(
      "thread-follower-interrupt-turn",
      { conversationId: threadId, mode: "user-stop", ...(turnId ? { expectedTurnId: turnId } : {}) },
      turnId ? INTERRUPT_VERSION.withTurn : INTERRUPT_VERSION.anyTurn,
    );
  } finally {
    socket.destroy();
  }
}

/** One connection to the bus: length-prefixed JSON, requests answered by `requestId`. */
function busClient(socket: Socket, timeoutMs: number) {
  const pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  let buffered = Buffer.alloc(0);
  const failAll = (error: Error) => {
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  };
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (buffered.length < 4 + length) return;
      let message: Frame;
      try {
        message = JSON.parse(buffered.subarray(4, 4 + length).toString("utf8")) as Frame;
      } catch {
        failAll(new Error("the Codex desktop app sent something unreadable"));
        socket.destroy();
        return;
      }
      buffered = buffered.subarray(4 + length);
      if (message.type === "response") {
        const waiting = pending.get(String(message.requestId));
        if (!waiting) continue;
        pending.delete(String(message.requestId));
        if (message.resultType === "success") waiting.resolve(message.result);
        else waiting.reject(new Error(String(message.error ?? "refused")));
      } else if (message.type === "client-discovery-request") {
        // The bus asks every client whether it runs the thread a request is about. Left
        // unanswered, the asker waits ten seconds for this client; it never does.
        socket.write(frame({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } }));
      } else if (message.type === "request") {
        socket.write(frame({ type: "response", requestId: message.requestId, resultType: "error", error: "no-handler-for-request" }));
      }
    }
  });
  socket.on("close", () => failAll(new Error("the Codex desktop app closed the connection")));
  socket.on("error", () => {});
  const client = {
    clientId: "initializing-client",
    request(method: string, params: Frame, version: number): Promise<unknown> {
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("timeout"));
        }, timeoutMs);
        pending.set(requestId, {
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.write(frame({ type: "request", requestId, sourceClientId: client.clientId, version, method, params, timeoutMs }));
      });
    },
  };
  return client;
}
