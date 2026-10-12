import type { AgentCapabilities, AgentTier } from "@linkshell/wire";

/** Host-side semantics, independent of how a driver reaches its agent. */
export interface DriverBehavior {
  readonly desktop: AgentTier;
  /** What attaching an existing session can recover; cached history stays in the host. */
  readonly history: "native-snapshot" | "load-replay" | "resume-replay" | "resume-only" | "unavailable";
  /** What ends a host-driven turn. An acknowledgment need not mean completion. */
  readonly turnCompletion: "native-events" | "prompt-response" | "state-update";
  /** Concurrent prompts and native steering have different delivery guarantees. */
  readonly busyInput: "native-steer" | "concurrent-prompt" | "queue";
  /** Unresolved requires initialization before choosing a native fork or context fallback. */
  readonly fork: "native-turn" | "native-session" | "context" | "unresolved";
  /** Detach releases this driver's attachment; it never deletes native history. */
  readonly detach: "native-unsubscribe" | "protocol-close" | "local-only";
}

/** Existing clients keep their wire shape; behavior has a single owner in the host. */
export function behaviorCapabilities(behavior: DriverBehavior): Pick<AgentCapabilities, "steer" | "fork"> {
  return { steer: behavior.busyInput !== "queue", fork: behavior.fork === "native-turn" || behavior.fork === "native-session" };
}

export function canForkNatively(behavior: DriverBehavior, fromTurn: boolean): boolean {
  return behavior.fork === "native-turn" || (!fromTurn && behavior.fork === "native-session");
}
