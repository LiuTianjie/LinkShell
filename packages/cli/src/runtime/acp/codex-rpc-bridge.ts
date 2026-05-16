import { createEnvelope } from "@linkshell/protocol";
import type { Envelope } from "@linkshell/protocol";
import { JsonRpcStdioTransport, type JsonRpcMessage } from "./json-rpc.js";
import { resolveAgentCommand } from "./provider-resolver.js";

export class CodexRpcBridge {
  private transport: JsonRpcStdioTransport | undefined;

  constructor(
    private readonly input: {
      command?: string;
      cwd: string;
      hostDeviceId: string;
      send: (envelope: Envelope) => void;
      verbose?: boolean;
    },
  ) {}

  send(message: unknown): void {
    this.ensureTransport();
    this.transport?.send(message as JsonRpcMessage);
  }

  stop(): void {
    this.transport?.stop();
    this.transport = undefined;
  }

  private ensureTransport(): void {
    if (this.transport) return;
    const config = resolveAgentCommand({
      provider: "codex",
      command: this.input.command,
    });
    if (!config || config.protocol !== "codex-app-server") {
      throw new Error("Codex app-server command is unavailable.");
    }
    this.transport = new JsonRpcStdioTransport(
      config.command,
      config.framing,
      () => {},
      () => ({}),
      (message) => this.emitError(message),
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
