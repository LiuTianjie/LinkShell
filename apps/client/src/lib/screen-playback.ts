export type ScreenPlaybackMode = "native" | "standard" | "relay";

export interface ScreenPlayback {
  mode: ScreenPlaybackMode;
  generation: number;
}

type Action =
  | { type: "restart"; nativeAvailable: boolean }
  | { type: "unavailable"; mode: ScreenPlaybackMode; generation: number };

export function initialScreenPlayback(nativeAvailable: boolean): ScreenPlayback {
  return { mode: nativeAvailable ? "native" : "standard", generation: 0 };
}

/** A delayed failure from a discarded player must not skip the next working route. */
export function screenPlayback(state: ScreenPlayback, action: Action): ScreenPlayback {
  if (action.type === "restart") return { ...initialScreenPlayback(action.nativeAvailable), generation: state.generation + 1 };
  if (action.generation !== state.generation || action.mode !== state.mode || state.mode === "relay") return state;
  return { ...state, mode: state.mode === "native" ? "standard" : "relay" };
}
