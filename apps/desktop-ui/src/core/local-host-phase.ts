import type { ManagementState } from "./management-store";

export type LocalHostPhase =
  | "starting"
  | "running"
  | "stopped"
  | "unreachable"
  | "error";

/**
 * Single canonical state derivation for the local Host across the entire desktop UI
 * (sidebar capsule, sidebar tree, home hub, sessions, new session, and standalone tools).
 */
export function resolveLocalHostPhase(
  state: Pick<ManagementState, "starting" | "snapshot" | "problem">,
): LocalHostPhase {
  if (state.snapshot?.status === "running" && !state.problem) return "running";
  if (state.starting || (!state.snapshot && !state.problem)) return "starting";
  if (state.snapshot?.status === "stopped") return "stopped";
  if (state.snapshot?.status === "unreachable") return "unreachable";
  return "error";
}

export function isLocalHostUnavailable(
  state: Pick<ManagementState, "starting" | "snapshot" | "problem">,
): boolean {
  const phase = resolveLocalHostPhase(state);
  return phase === "stopped" || phase === "unreachable" || phase === "error";
}
