import { createEnvelope } from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";
import { JsonRpcStdioTransport, type JsonRpcMessage } from "./json-rpc.js";
import { resolveCodexAppServerCommands, type AgentCommandConfig } from "./provider-resolver.js";

const CODEX_PROXY_STARTUP_GRACE_MS = 250;

export class CodexRpcBridge {
  private transport: JsonRpcStdioTransport | undefined;
  private transportReady = false;
  private starting = false;
  private stopping = false;
  private candidateIndex = 0;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private queuedMessages: JsonRpcMessage[] = [];

  constructor(
    private readonly input: {
      command?: string;
      commandCandidates?: AgentCommandConfig[];
      cwd: string;
      hostDeviceId: string;
      send: (envelope: Envelope) => void;
      verbose?: boolean;
    },
  ) {}

  send(message: unknown): void {
    this.ensureTransport();
    const jsonMessage = message as JsonRpcMessage;
    if (!this.transportReady) {
      this.queuedMessages.push(jsonMessage);
      return;
    }
    this.transport?.send(jsonMessage);
  }

  stop(): void {
    this.stopping = true;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    this.transport?.stop();
    this.transport = undefined;
    this.transportReady = false;
    this.starting = false;
    this.queuedMessages = [];
    this.stopping = false;
  }

  private ensureTransport(): void {
    if (this.transport || this.starting) return;
    const candidates = this.commandCandidates();
    if (candidates.length === 0) {
      throw new Error("Codex app-server command is unavailable.");
    }
    this.startCandidate(this.candidateIndex);
  }

  private commandCandidates(): AgentCommandConfig[] {
    return this.input.commandCandidates ?? resolveCodexAppServerCommands({
      command: this.input.command,
    });
  }

  private startCandidate(index: number): void {
    const config = this.commandCandidates()[index];
    if (!config) {
      this.failQueued("Codex app-server command is unavailable.");
      return;
    }
    this.candidateIndex = index;
    this.starting = true;
    this.transportReady = false;
    this.transport = new JsonRpcStdioTransport(
      config.command,
      config.framing,
      () => {},
      () => ({}),
      (message) => this.handleTransportExit(message),
      (message) => {
        this.input.send(createEnvelope({
          type: "agent.codex.rpc",
          hostDeviceId: this.input.hostDeviceId,
          payload: message,
        }));
        return true;
      },
    );
    this.transport.start(this.input.cwd);
    if (this.input.verbose) {
      process.stderr.write(`[agent:codex-rpc] started ${config.command}\n`);
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      this.transportReady = true;
      this.starting = false;
      this.flushQueued();
    }, CODEX_PROXY_STARTUP_GRACE_MS);
  }

  private handleTransportExit(message: string): void {
    if (this.stopping) return;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    const wasReady = this.transportReady;
    this.transport = undefined;
    this.transportReady = false;
    this.starting = false;
    const nextIndex = this.candidateIndex + 1;
    if (!wasReady && nextIndex < this.commandCandidates().length) {
      if (this.input.verbose) {
        process.stderr.write(`[agent:codex-rpc] ${message}; falling back\n`);
      }
      this.startCandidate(nextIndex);
      return;
    }
    this.failQueued(message);
    this.emitError(message);
  }

  private flushQueued(): void {
    const messages = this.queuedMessages.splice(0);
    for (const message of messages) {
      this.transport?.send(message);
    }
  }

  private failQueued(message: string): void {
    const queued = this.queuedMessages.splice(0);
    for (const item of queued) {
      if (!("id" in item) || item.id === undefined || item.id === null) continue;
      this.input.send(createEnvelope({
        type: "agent.codex.rpc",
        hostDeviceId: this.input.hostDeviceId,
        payload: {
          jsonrpc: "2.0",
          id: item.id,
          error: { code: -32000, message },
        },
      }));
    }
    if (this.input.verbose) {
      process.stderr.write(`[agent:codex-rpc] ${message}\n`);
    }
  }

  private emitError(message: string): void {
    this.input.send(createEnvelope({
      type: "agent.codex.rpc",
      hostDeviceId: this.input.hostDeviceId,
      payload: {
        jsonrpc: "2.0",
        id: "linkshell-codex-rpc-error",
        error: { code: -32000, message },
      },
    }));
  }
}
