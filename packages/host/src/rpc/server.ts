import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, rmSync } from "node:fs";
import WebSocket, { WebSocketServer } from "ws";
import {
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RpcError,
  RpcPeer,
  isMethodName,
  methods,
  type GatewayStatus,
  type MachineInfo,
  type MethodName,
  type MethodResult,
  type NotificationName,
  type NotificationParams,
} from "@linkshell/wire";
import type { GatewayLink } from "../gateway.js";
import type { SessionHub, Subscriber } from "../hub.js";
import { listDirectory, makeDirectory, readFile, searchDirectories, uploadFile } from "../fs.js";
import { listPorts, ProxyStreams } from "../ports.js";
import { ScreenShare } from "../screen.js";
import { DirectPeer } from "../direct.js";
import { ComputerPreviewServer } from "../computer-preview.js";
import { imageOf, parseImageUri, slimEvent } from "../slim.js";
import type { OutputListener, TerminalManager } from "../terminals.js";

// How a development client names this machine: loopback, or the Android emulator's alias for its host's loopback.
const DEVELOPMENT_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "10.0.2.2"]);

/**
 * Whether a WebSocket handshake on the development port comes from a development client and not from a web
 * page. Browsers let any page open a socket to 127.0.0.1, and this API runs commands. A page can't hide its
 * Origin, so one from elsewhere is refused; the Host must be this machine by address, so a name the page's
 * site has pointed at 127.0.0.1 (DNS rebinding) is refused too. Native clients send no Origin, or their own
 * server's (React Native on Android).
 */
export function isLocalDevelopmentClient(headers: { host?: string; origin?: string }): boolean {
  const host = headers.host?.toLowerCase();
  if (!host || !DEVELOPMENT_HOSTS.has(host.replace(/:\d+$/, ""))) return false;
  if (headers.origin === undefined) return true;
  try {
    return new URL(headers.origin).host === host;
  } catch {
    return false;
  }
}

export interface HostRpcServerOptions {
  hub: SessionHub;
  terminals: TerminalManager;
  machineInfo: () => MachineInfo;
  /** Unix socket for local clients (terminal shims, CLI). */
  socketPath: string;
  /** Optional loopback TCP port, for local development clients. */
  tcpPort?: number;
  log: (message: string) => void;
}

type Handler = (params: never, context: ConnectionContext) => Promise<unknown> | unknown;

/** Anything that carries JSON-RPC text both ways: a local WebSocket, or an encrypted tunnel through the gateway. */
export interface RpcTransport {
  send(text: string): void;
  close(): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
  /** Local transports (this machine's own sockets) may use desktop.* methods. */
  local: boolean;
}

interface ConnectionContext {
  peer: RpcPeer;
  local: boolean;
  subscriptions: Map<string, Subscriber>;
  /** Handoff sessions this connection (a terminal shim) drives. */
  desktops: Map<string, { unregister: () => void; pendingYield?: () => void }>;
  /** Terminals this connection receives output from. */
  terminals: Map<string, OutputListener>;
  /** Preview streams to the host's local servers. */
  proxy: ProxyStreams;
  /** The connection's peer-to-peer channel for those streams, once the device has offered one. */
  direct: DirectPeer;
}

/**
 * JSON-RPC over WebSocket for host clients. Each connection gets live
 * `session.summary` notifications, plus `session.event` for the sessions it
 * subscribed to.
 */
export class HostRpcServer {
  private readonly servers: Server[] = [];
  private readonly sockets = new Set<WebSocket>();
  private readonly connections = new Set<RpcPeer>();
  private gateway?: GatewayLink;
  private refreshGateway?: () => GatewayStatus;
  private readonly screen: ScreenShare;
  private readonly computerPreview: ComputerPreviewServer;
  private readonly handlers: { [M in MethodName]: (params: never, context: ConnectionContext) => Promise<MethodResult<M>> | MethodResult<M> };

  constructor(private readonly options: HostRpcServerOptions) {
    this.screen = new ScreenShare(options.log, () => options.machineInfo().direct?.iceServers ?? []);
    const hub = options.hub;
    this.computerPreview = new ComputerPreviewServer(hub.previews);
    const terminals = options.terminals;
    type P<M extends MethodName> = import("zod").infer<(typeof methods)[M]["params"]>;
    this.handlers = {
      "machine.info": () => {
        void hub.refreshAuthIfStale();
        return options.machineInfo();
      },
      "projects.list": async (params: P<"projects.list">) => ({ projects: await hub.listProjects(params.limit) }),
      "sessions.list": (params: P<"sessions.list">) => hub.listSessions(params),
      "sessions.create": async (params: P<"sessions.create">) => ({ session: await hub.createSession(params) }),
      "sessions.fork": async (params: P<"sessions.fork">) => ({ session: await hub.fork(params.sessionId, { itemId: params.itemId, worktree: params.worktree }) }),
      "git.info": async (params: P<"git.info">) => ({ git: await hub.gitInfo(params.path) }),
      "worktrees.list": async () => ({ worktrees: await hub.listWorktrees() }),
      "worktrees.remove": async (params: P<"worktrees.remove">) => {
        await hub.removeWorktree(params.path, params.force);
        return {};
      },
      "sessions.subscribe": async (params: P<"sessions.subscribe">, context) => {
        const previous = context.subscriptions.get(params.sessionId);
        if (previous) hub.unsubscribe(params.sessionId, previous);
        const slim = { lazyImages: params.lazyImages };
        const subscriber: Subscriber = {
          event: (event) => context.peer.notify("session.event", slimEvent(event, slim)),
          window: (startSeq) => context.peer.notify("session.window", { sessionId: params.sessionId, startSeq }),
        };
        context.subscriptions.set(params.sessionId, subscriber);
        return hub.subscribe(params.sessionId, params.fromSeq, subscriber);
      },
      "sessions.history": (params: P<"sessions.history">) => {
        const page = hub.history(params.sessionId, params.beforeSeq);
        return { startSeq: page.startSeq, events: page.events.map((event) => slimEvent(event, { lazyImages: params.lazyImages })) };
      },
      "sessions.tasks": (params: P<"sessions.tasks">) => ({ tasks: hub.tasks(params.sessionId) }),
      "sessions.taskOutput": (params: P<"sessions.taskOutput">) => hub.taskOutput(params.sessionId, params.taskId, params.before, params.limit),
      "sessions.stopTask": (params: P<"sessions.stopTask">) => hub.stopTask(params.sessionId, params.taskId).then(() => ({})),
      "sessions.subagents": (params: P<"sessions.subagents">) => ({ subagents: hub.subagents(params.sessionId) }),
      "sessions.subagent": (params: P<"sessions.subagent">) => ({
        events: hub.subagent(params.sessionId, params.toolCallId).map((event) => slimEvent(event, { lazyImages: params.lazyImages })),
      }),
      "sessions.preview": (params: P<"sessions.preview">, context) => {
        hub.getSession(params.sessionId);
        return this.computerPreview.open(params.sessionId, params.direct === true && context.direct.open);
      },
      "desktop.preview.show": (params: P<"desktop.preview.show">) => {
        hub.getSession(params.sessionId);
        this.broadcast("session.preview.show", params);
        return {};
      },
      "sessions.image": (params: P<"sessions.image">) => {
        const ref = parseImageUri(params.uri);
        const event = ref && hub.readEvent(params.sessionId, ref.seq);
        const image = event && imageOf(event, ref.index);
        if (!image) throw RpcError.app("not_found", "这张图片已经不在会话记录里");
        return image;
      },
      "sessions.unsubscribe": (params: P<"sessions.unsubscribe">, context) => {
        const subscriber = context.subscriptions.get(params.sessionId);
        if (subscriber) hub.unsubscribe(params.sessionId, subscriber);
        context.subscriptions.delete(params.sessionId);
        return {};
      },
      "sessions.prompt": async (params: P<"sessions.prompt">) => ({
        delivery: await hub.prompt(params.sessionId, params.clientMessageId, params.content, params.whenBusy),
      }),
      "sessions.cancel": async (params: P<"sessions.cancel">) => {
        await hub.cancel(params.sessionId);
        return {};
      },
      "sessions.permission": async (params: P<"sessions.permission">) => {
        await hub.respondPermission(params.sessionId, params.requestId, params.optionId);
        return {};
      },
      "sessions.answer": async (params: P<"sessions.answer">) => {
        await hub.answerQuestion(params.sessionId, params.requestId, params.answers);
        return {};
      },
      "sessions.sendQueued": async (params: P<"sessions.sendQueued">) => {
        await hub.sendQueuedNow(params.sessionId, params.clientMessageId);
        return {};
      },
      "sessions.reorderQueue": (params: P<"sessions.reorderQueue">) => {
        hub.reorderQueue(params.sessionId, params.clientMessageIds);
        return {};
      },
      "sessions.unqueue": (params: P<"sessions.unqueue">) => ({ removed: hub.unqueue(params.sessionId, params.clientMessageId) }),
      "sessions.archive": async (params: P<"sessions.archive">) => ({ session: await hub.archive(params.sessionId, params.archived) }),
      "sessions.rename": async (params: P<"sessions.rename">) => ({ session: await hub.rename(params.sessionId, params.title) }),
      "sessions.delete": async (params: P<"sessions.delete">) => {
        await hub.delete(params.sessionId, params.worktree);
        return {};
      },
      "sessions.goal": (params: P<"sessions.goal">) => hub.goal(params.sessionId, params.change),
      "sessions.setConfig": async (params: P<"sessions.setConfig">) => {
        await hub.setConfig(params.sessionId, params.optionId, params.value);
        return {};
      },
      "sessions.takeover": async (params: P<"sessions.takeover">) => ({ driver: (await hub.takeover(params.sessionId)).driver }),
      "sessions.release": (params: P<"sessions.release">) => ({ driver: hub.getSession(params.sessionId).driver }),
      "desktop.launch": async (params: P<"desktop.launch">, context) => {
        const launch = await hub.desktopLaunch(params.agent, params.args, params.sessionId, { cwd: params.cwd, env: params.env });
        if (launch.sessionId) this.adoptDesktop(launch.sessionId, context);
        return launch;
      },
      "desktop.yielded": (params: P<"desktop.yielded">, context) => {
        const entry = context.desktops.get(params.sessionId);
        entry?.pendingYield?.();
        if (entry) entry.pendingYield = undefined;
        return {};
      },
      "gateway.status": () => this.gateway?.status() ?? { status: "off" as const, devices: [] },
      "gateway.refresh": (_params: P<"gateway.refresh">, context) => {
        if (!context.local) throw RpcError.app("forbidden", "the gateway is chosen on the computer itself");
        return this.refreshGateway?.() ?? this.gateway?.status() ?? { status: "off" as const, devices: [] };
      },
      "pairing.start": (_params: P<"pairing.start">, context) => {
        if (!context.local) throw RpcError.app("forbidden", "pairing starts on the computer itself");
        if (!this.gateway) throw RpcError.app("not_supported", "no gateway: run linkshell login for the official one, or linkshell host --gateway <url>");
        return this.gateway.startPairing();
      },
      "devices.revoke": async (params: P<"devices.revoke">) => {
        await this.gateway?.revoke(params.deviceId);
        return {};
      },
      "fs.list": (params: P<"fs.list">) => listDirectory(params),
      "fs.search": (params: P<"fs.search">) => searchDirectories(params),
      "fs.read": (params: P<"fs.read">) => readFile(params),
      "fs.upload": (params: P<"fs.upload">) => uploadFile(params),
      "fs.mkdir": (params: P<"fs.mkdir">) => makeDirectory(params),
      "terminals.list": () => ({ terminals: terminals.list() }),
      "terminals.create": (params: P<"terminals.create">) => ({ terminal: terminals.create(params) }),
      "terminals.attach": (params: P<"terminals.attach">, context) => {
        const previous = context.terminals.get(params.terminalId);
        if (previous) terminals.detach(params.terminalId, previous);
        const listener: OutputListener = (seq, data, geometry) =>
          context.peer.notify("terminal.output", { terminalId: params.terminalId, seq, data, ...geometry });
        const attached = terminals.attach(params.terminalId, listener, params.fromSeq, params.replayFormat, params.fromFrame, params.snapshot);
        context.terminals.set(params.terminalId, listener);
        return attached;
      },
      "terminals.replay": (params: P<"terminals.replay">) => terminals.replay(params.terminalId, params.afterFrame, params.throughFrame),
      "terminals.state": (params: P<"terminals.state">) => terminals.state(params.terminalId, params.snapshotId, params.offset),
      "terminals.detach": (params: P<"terminals.detach">, context) => {
        const listener = context.terminals.get(params.terminalId);
        if (listener) terminals.detach(params.terminalId, listener);
        context.terminals.delete(params.terminalId);
        return {};
      },
      "terminals.input": (params: P<"terminals.input">) => {
        terminals.input(params.terminalId, params.data);
        return {};
      },
      "terminals.resize": (params: P<"terminals.resize">) => {
        terminals.resize(params.terminalId, params.cols, params.rows);
        return {};
      },
      "ports.list": async () => ({ ports: await listPorts() }),
      "screen.start": () => this.screen.start(),
      "screen.access": (params: P<"screen.access">) => this.screen.access(params.ask === true),
      "proxy.open": async (params: P<"proxy.open">, context) => context.proxy.open(params.port, params.direct),
      "direct.offer": async (params: P<"direct.offer">, context) => ({ sdp: await context.direct.answer(params.sdp) }),
      "proxy.write": (params: P<"proxy.write">, context) => {
        context.proxy.write(params.streamId, params.data);
        return {};
      },
      "proxy.close": (params: P<"proxy.close">, context) => {
        context.proxy.close(params.streamId);
        return {};
      },
      "terminals.close": (params: P<"terminals.close">) => {
        terminals.close(params.terminalId);
        return {};
      },
      "desktop.reclaim": async (params: P<"desktop.reclaim">, context) => {
        const launch = await hub.reclaim(params.sessionId, {});
        this.adoptDesktop(params.sessionId, context);
        return launch;
      },
    };
  }

  async start(): Promise<void> {
    if (existsSync(this.options.socketPath)) rmSync(this.options.socketPath, { force: true });
    await this.listen((server) => server.listen(this.options.socketPath));
    if (this.options.tcpPort !== undefined) {
      // The unix socket is guarded by its directory's permissions; a TCP port is open to every
      // browser tab on this machine, so it checks who is asking.
      await this.listen((server) => server.listen(this.options.tcpPort, "127.0.0.1"), isLocalDevelopmentClient);
    }
  }

  async stop(): Promise<void> {
    this.screen.stop();
    this.computerPreview.stop();
    // A connection tidies up after itself when its socket closes, and that reaches into the hub. The close
    // comes a moment after terminate(): waited for here, so that it isn't still to come when the hub and
    // its database are gone.
    const closed = [...this.sockets].map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())));
    for (const socket of this.sockets) socket.terminate();
    await Promise.all(closed);
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    rmSync(this.options.socketPath, { force: true });
  }

  /** The TCP port actually bound (useful when started with port 0). */
  tcpAddress(): number | undefined {
    const address = this.servers[1]?.address();
    return address && typeof address === "object" ? address.port : undefined;
  }

  private listen(bind: (server: Server) => void, allowed?: (headers: { host?: string; origin?: string }) => boolean): Promise<void> {
    const server = createServer((_, response) => {
      response.writeHead(426, { "content-type": "text/plain" });
      response.end("LinkShell host: WebSocket required\n");
    });
    const wss = new WebSocketServer({
      server,
      perMessageDeflate: false,
      maxPayload: 32 * 1024 * 1024,
      verifyClient: allowed && (({ req }: { req: IncomingMessage }) => allowed({ host: req.headers.host, origin: req.headers.origin })),
    });
    wss.on("connection", (socket) => this.accept(socket));
    this.servers.push(server);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => {
        server.off("error", reject);
        resolve();
      });
      bind(server);
    });
  }

  /** Makes this connection the terminal driving a handoff session. */
  private adoptDesktop(sessionId: string, context: ConnectionContext): void {
    // Already this terminal's session (e.g. after reclaim): keep the registration.
    if (context.desktops.has(sessionId)) return;
    const entry: { unregister: () => void; pendingYield?: () => void } = { unregister: () => {} };
    entry.unregister = this.options.hub.registerDesktop(sessionId, {
      yield: () =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(done, 15_000);
          function done() {
            clearTimeout(timer);
            resolve();
          }
          entry.pendingYield = done;
          context.peer.notify("desktop.yield", { sessionId });
        }),
      activity: (line) => context.peer.notify("desktop.remoteActivity", { sessionId, line }),
    });
    context.desktops.set(sessionId, entry);
  }

  private accept(socket: WebSocket): void {
    this.sockets.add(socket);
    const listeners: { message?: (text: string) => void; close?: () => void } = {};
    socket.on("message", (data) => listeners.message?.(data.toString()));
    socket.on("close", () => {
      this.sockets.delete(socket);
      listeners.close?.();
    });
    this.connect({
      local: true,
      send: (text) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(text);
      },
      close: () => socket.close(),
      onMessage: (listener) => (listeners.message = listener),
      onClose: (listener) => (listeners.close = listener),
    });
  }

  setGateway(gateway: GatewayLink | undefined): void {
    this.gateway = gateway;
  }

  onGatewayRefresh(refresh: () => GatewayStatus): void {
    this.refreshGateway = refresh;
  }

  /** A notification to every connected client. */
  broadcast<N extends NotificationName>(name: N, params: NotificationParams<N>): void {
    for (const peer of this.connections) peer.notify(name, params);
  }

  /** Serves one client connection over `transport` until it closes. */
  connect(transport: RpcTransport): void {
    const peer = new RpcPeer({
      send: (text) => transport.send(text),
      onRequest: (method, params) => this.dispatch(method, params, context),
    });
    const direct = new DirectPeer(this.options.machineInfo().direct?.iceServers ?? [], this.options.log);
    const context: ConnectionContext = {
      local: transport.local,
      desktops: new Map(),
      subscriptions: new Map(),
      terminals: new Map(),
      proxy: new ProxyStreams(
        {
          data: (streamId, data) => peer.notify("proxy.data", { streamId, data }),
          closed: (streamId, error) => peer.notify("proxy.closed", error ? { streamId, error } : { streamId }),
        },
        direct,
      ),
      direct,
      peer,
    };
    this.connections.add(context.peer);
    const stopSummaries = this.options.hub.onSummary((session) => context.peer.notify("session.summary", { session }));
    const stopRemoved = this.options.hub.onRemoved((sessionId) => {
      context.subscriptions.delete(sessionId);
      context.peer.notify("session.removed", { sessionId });
    });
    const stopTerminals = this.options.terminals.onChange((terminal, closed) =>
      context.peer.notify("terminal.changed", closed ? { terminal, closed } : { terminal }),
    );
    transport.onMessage((text) => context.peer.receive(text));
    transport.onClose(() => {
      this.connections.delete(context.peer);
      stopSummaries();
      stopRemoved();
      stopTerminals();
      for (const [terminalId, listener] of context.terminals) this.options.terminals.detach(terminalId, listener);
      context.terminals.clear();
      for (const [sessionId, subscriber] of context.subscriptions) this.options.hub.unsubscribe(sessionId, subscriber);
      context.subscriptions.clear();
      // A terminal that went away can't be driving anything; release waiters.
      for (const entry of context.desktops.values()) {
        entry.pendingYield?.();
        entry.unregister();
      }
      context.desktops.clear();
      context.proxy.closeAll();
      context.direct.close();
      context.peer.close();
    });
  }

  private async dispatch(method: string, params: unknown, context: ConnectionContext): Promise<unknown> {
    if (!isMethodName(method)) throw new RpcError(RPC_METHOD_NOT_FOUND, `unknown method ${method}`);
    // The terminal shim's methods launch local processes with a given environment: never over the network.
    if (method.startsWith("desktop.") && !context.local) throw RpcError.app("forbidden", `${method} is only available locally`);
    const parsed = methods[method].params.safeParse(params ?? {});
    if (!parsed.success) {
      throw new RpcError(RPC_INVALID_PARAMS, `invalid params for ${method}`, {
        code: "invalid_params",
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }
    const handler = this.handlers[method] as Handler;
    try {
      return await handler(parsed.data as never, context);
    } catch (error) {
      if (!(error instanceof RpcError)) this.options.log(`[rpc] ${method} failed: ${error instanceof Error ? error.stack : String(error)}`);
      throw error;
    }
  }
}
