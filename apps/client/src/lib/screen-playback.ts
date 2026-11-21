import type { ScreenMode, ScreenPacing, ScreenWidth } from "./settings";

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

export interface ScreenFailureResolution {
  nextPlayback?: ScreenPlaybackMode;
  failure?: string;
}

/**
 * Resolves the 3-layer fallback transition (`native` -> `standard` WebView WebRTC -> `relay` RPC byte relay)
 * uniformly for iOS and Android unless the screen was taken over or ended idle.
 */
export function resolveScreenPlaybackFailure(params: {
  failedPlayback: ScreenPlaybackMode;
  description?: string;
  takenMessage: string;
  idleMessage: string;
  defaultFailureMessage?: string;
}): ScreenFailureResolution {
  const { failedPlayback, description, takenMessage, idleMessage, defaultFailureMessage = "屏幕显示已中断，请重新连接" } = params;
  if (failedPlayback === "relay" || description === takenMessage || description === idleMessage) {
    return { failure: description || defaultFailureMessage };
  }
  return { nextPlayback: failedPlayback === "native" ? "standard" : "relay" };
}

/** Builds the viewer page query parameters shared identically by iOS and Android receivers. */
export function buildScreenViewerQuery(params: {
  token: string;
  playback: ScreenPlaybackMode;
  display: number;
  width: ScreenWidth | string;
  mode: ScreenMode;
  via: "direct" | "relay";
  isDirectComputer: boolean;
  pacing: ScreenPacing;
  audio: boolean;
}): URLSearchParams {
  const query = new URLSearchParams({
    token: params.token,
    video: params.playback === "relay" ? "0" : "1",
    display: String(params.display),
    width: params.width,
    mode: params.mode,
  });
  if (params.via === "relay" && !params.isDirectComputer) query.set("q", "low");
  if (params.playback !== "relay") query.set("fallback", "relay");
  if (params.pacing === "smooth") query.set("pacing", "smooth");
  if (params.audio && params.playback !== "native") query.set("audio", "1");
  query.set("turn", "1");
  return query;
}

/** Host WebSocket control payload toggling remote audio streaming. */
export function screenAudioControlMessage(enabled: boolean): { t: "audio"; enabled: boolean } {
  return { t: "audio", enabled };
}

/**
 * Generates idempotent JS injected into the WebView viewer to sync Web Audio state,
 * unlock suspended `AudioContext`, and send `{ t: "audio", enabled }` over the viewer WS.
 */
export function screenAudioInjectScript(enabled: boolean): string {
  const flag = enabled ? "true" : "false";
  return `(function(){var en=${flag};if(typeof window!=="undefined"){window.__linkshellTargetAudio=en;if(!window.__linkshellAudioUnlockBound&&typeof addEventListener==="function"){window.__linkshellAudioUnlockBound=true;var unlock=function(){if(window.__linkshellTargetAudio&&typeof unlockScreenAudio==="function")unlockScreenAudio();};["pointerdown","touchstart","click","keydown"].forEach(function(ev){addEventListener(ev,unlock,{capture:true,passive:true});});}if(typeof audioEnabled!=="undefined"){if(audioEnabled!==en){if(typeof toggleAudio==="function"){window.__linkshellSyncingAudio=true;try{toggleAudio();}finally{window.__linkshellSyncingAudio=false;}}else{audioEnabled=en;if(en&&typeof unlockScreenAudio==="function")unlockScreenAudio();if(typeof refreshAudioButton==="function")refreshAudioButton();if(typeof send==="function")send({t:"audio",enabled:en});}}else if(en&&typeof unlockScreenAudio==="function"){unlockScreenAudio();}}else if(typeof send==="function"){send({t:"audio",enabled:en});}}})();true;`;
}

/** Hooks WebView `#audiobar` toggles back into React Native so RN header controls stay in sync. */
export function screenAudioBridgeInstallScript(): string {
  return `(function(){if(typeof window!=="undefined"&&!window.__linkshellAudioHooked&&typeof toggleAudio==="function"){window.__linkshellAudioHooked=true;var orig=toggleAudio;toggleAudio=function(){var res=orig.apply(this,arguments);if(!window.__linkshellSyncingAudio&&window.ReactNativeWebView&&typeof audioEnabled==="boolean"){window.ReactNativeWebView.postMessage(JSON.stringify({type:"audio",enabled:audioEnabled}));}return res;};}})();true;`;
}

export function isScreenAudioAvailable(playback: ScreenPlaybackMode, nativeAudioAvailable?: boolean): boolean {
  return playback === "native" ? nativeAudioAvailable !== false : true;
}
