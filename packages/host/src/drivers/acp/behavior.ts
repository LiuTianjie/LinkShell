import type { AgentTier } from "@linkshell/wire";
import type { DriverBehavior } from "../behavior.js";
import type { AcpInitializeResult } from "./connection.js";

/** Resolve only a completed handshake, never the version the client hoped to negotiate. */
export function acpBehavior(desktop: AgentTier, initialized?: AcpInitializeResult): DriverBehavior {
  const info = initialized?.protocolVersion === 1 || initialized?.protocolVersion === 2 ? initialized : undefined;
  const caps = info?.agentCapabilities;
  const v2 = info?.protocolVersion === 2;
  const meta = { ...caps?._meta, ...info?._meta };
  const steering = (meta.steering as { supported?: boolean } | undefined)?.supported === true;
  const queueing = (meta.claudeCode as { promptQueueing?: boolean } | undefined)?.promptQueueing === true;
  return {
    desktop,
    history: caps?.sessions === false ? "unavailable"
      : v2 ? "resume-replay"
      : caps?.loadSession ? "load-replay"
      : caps?.sessionCapabilities?.resume ? "resume-only" : "unavailable",
    turnCompletion: v2 ? "state-update" : "prompt-response",
    busyInput: steering || queueing ? "concurrent-prompt" : "queue",
    fork: !info ? "unresolved" : caps?.sessionCapabilities?.fork ? "native-session" : "context",
    detach: caps?.sessionCapabilities?.close ? "protocol-close" : "local-only",
  };
}
