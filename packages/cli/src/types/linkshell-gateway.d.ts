declare module "@linkshell/gateway/embedded" {
  export interface EmbeddedGatewayOptions {
    port?: number;
    logLevel?: "debug" | "info" | "warn" | "error";
    silent?: boolean;
  }

  export interface EmbeddedGateway {
    port: number;
    httpUrl: string;
    wsUrl: string;
    close: () => Promise<void>;
  }

  export function startEmbeddedGateway(
    options?: EmbeddedGatewayOptions,
  ): Promise<EmbeddedGateway>;
}
