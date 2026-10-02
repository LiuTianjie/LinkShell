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
// desktop app is running, or to put a message into it, without stopping the
// app.
//
// The bus is the app's own, not a published interface: each method carries a
// version the receiver checks, and a request it doesn't recognise is refused.
// So everything here is one question with a yes or a no; a no is reported as
// "can't be done from here", never retried in another shape.

/** Where the desktop app's bus listens (the first Codex window to start serves it). */
export function desktopBusSocket(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "ipc", "ipc.sock");
}

/** The versions of the requests the installed apps accept. */
const VERSIONS = {
  owner: 1,
  start: 2,
  steer: 1,
  /** With the turn it is meant for, or (older) without. */
  interrupt: { withTurn: 4, anyTurn: 3 },
};

/**
 * The window that runs a thread says so at once. A thread no window runs is
 * only reported after the bus has waited ten seconds for every client that
 * doesn't answer it, which is too long to keep a phone waiting for a no.
 */
const OWNER_TIMEOUT_MS = 3000;

type Frame = Record<string, unknown>;

/**
 * The window that runs the thread was asked and didn't say how it went: the
 * app gives its own windows five seconds to answer each other, and starting a
 * turn can take it longer than that. What was asked for usually still happens.
 */
export class DesktopUnconfirmed extends Error {}

function frame(message: Frame): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * One request to the window that runs `threadId`: found first, then asked.
 * Rejects when the app isn't there, no window runs the thread, or the window
 * refuses.
 */
async function askOwner(socketPath: string, threadId: string, method: string, params: Frame, version: number, timeoutMs: number): Promise<unknown> {
  if (!existsSync(socketPath)) throw new Error("the Codex desktop app isn't running");
  const socket = connect(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const bus = busClient(socket);
    const registered = await bus.request("initialize", { clientType: "linkshell" }, 0, OWNER_TIMEOUT_MS);
    bus.clientId = String((registered.result as { clientId?: unknown } | undefined)?.clientId ?? "");
    const found = await bus.request("thread-owner-discovery", { hostId: "local", conversationId: threadId }, VERSIONS.owner, OWNER_TIMEOUT_MS).catch((error: Error) => {
      throw new Error(`no window of the Codex desktop app runs this thread (${error.message})`);
    });
    const owner = typeof found.handledByClientId === "string" ? found.handledByClientId : undefined;
    const answered = await bus.request(method, params, version, timeoutMs, owner).catch((error: Error) => {
      throw /timeout$/.test(error.message) ? new DesktopUnconfirmed(error.message) : error;
    });
    return answered.result;
  } finally {
    socket.destroy();
  }
}

/**
 * Asks the window that runs `threadId` to stop its turn, as its own Stop
 * button does. Resolves when that window says it has.
 */
export async function interruptThroughDesktop(socketPath: string, threadId: string, turnId: string | undefined): Promise<void> {
  await askOwner(
    socketPath,
    threadId,
    "thread-follower-interrupt-turn",
    { conversationId: threadId, mode: "user-stop", ...(turnId ? { expectedTurnId: turnId } : {}) },
    turnId ? VERSIONS.interrupt.withTurn : VERSIONS.interrupt.anyTurn,
    12_000,
  );
}

export interface DesktopMessage {
  /** Codex's own input items (text, images). */
  input: unknown[];
  text: string;
  clientMessageId: string;
  cwd?: string;
}

/**
 * Puts a message into the turn the window that runs `threadId` is running, as
 * its own "Steer" does for a message waiting in its queue.
 */
export async function steerThroughDesktop(socketPath: string, threadId: string, message: DesktopMessage): Promise<void> {
  await askOwner(
    socketPath,
    threadId,
    "thread-follower-steer-turn",
    {
      conversationId: threadId,
      clientUserMessageId: message.clientMessageId,
      input: message.input,
      attachments: [],
      // What the window puts back in its composer if the turn ends before the
      // message is taken: the app builds one for every message it steers, and
      // reads the fields below from it without checking that it is there.
      restoreMessage: {
        id: message.clientMessageId,
        text: message.text,
        context: { prompt: message.text, addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments: [], commentAttachments: [] },
        cwd: message.cwd ?? null,
        createdAt: Date.now(),
      },
    },
    VERSIONS.steer,
    20_000,
  );
}

/** Starts a turn with a message in the window that runs `threadId`, as typing it there does. */
export async function startThroughDesktop(socketPath: string, threadId: string, message: DesktopMessage): Promise<void> {
  await askOwner(
    socketPath,
    threadId,
    "thread-follower-start-turn",
    {
      conversationId: threadId,
      turnStart: { request: { threadId, input: message.input, clientUserMessageId: message.clientMessageId }, context: {} },
    },
    VERSIONS.start,
    30_000,
  );
}

/** One connection to the bus: length-prefixed JSON, requests answered by `requestId`. */
function busClient(socket: Socket) {
  const pending = new Map<string, { resolve: (response: Frame) => void; reject: (error: Error) => void }>();
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
        if (message.resultType === "success") waiting.resolve(message);
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
    request(method: string, params: Frame, version: number, timeoutMs: number, targetClientId?: string): Promise<Frame> {
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("timeout"));
        }, timeoutMs);
        pending.set(requestId, {
          resolve: (response) => {
            clearTimeout(timer);
            resolve(response);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.write(
          frame({ type: "request", requestId, sourceClientId: client.clientId, version, method, params, timeoutMs, ...(targetClientId ? { targetClientId } : {}) }),
        );
      });
    },
  };
  return client;
}
