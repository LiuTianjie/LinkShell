// Types-only module. The original `useSession` hook implementation was dead
// (no call sites — `useSessionManager` is the live state machine) and has been
// removed to stop the two from drifting. These shared types are still consumed
// by SessionScreen, TerminalView, and session-connection-policy.

export type ConnectionStatus =
  | "idle"
  | "claiming"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "session_exited"
  | "host_disconnected"
  | `error:${string}`;

export interface UseSessionOptions {
  gatewayBaseUrl: string;
}

export interface TerminalStreamSnapshot {
  sessionId: string;
  chunks: string[];
}

export interface TerminalStreamEventReset {
  type: "reset";
  snapshot: TerminalStreamSnapshot;
}

export interface TerminalStreamEventAppend {
  type: "append";
  sessionId: string;
  chunk: string;
}

export type TerminalStreamEvent =
  | TerminalStreamEventReset
  | TerminalStreamEventAppend;

export interface TerminalStream {
  getSnapshot: () => TerminalStreamSnapshot;
  subscribe: (listener: (event: TerminalStreamEvent) => void) => () => void;
}

export interface SessionHandle {
  status: ConnectionStatus;
  sessionId: string;
  deviceId: string;
  controllerId: string | null;
  terminalStream: TerminalStream;
  connectionDetail: string | null;
  screenStatus: {
    active: boolean;
    mode: "webrtc" | "fallback" | "off";
    error?: string;
  };
  screenFrame: {
    data: string;
    width: number;
    height: number;
    frameId: number;
  } | null;
  pendingOffer: { sdp: string } | null;
  pendingIceCandidates: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }[];
  claim: (pairingCode: string) => Promise<string | null>;
  connectToSession: (
    sessionId: string,
    gatewayBaseUrlOverride?: string,
  ) => void;
  sendInput: (data: string) => void;
  sendImage: (base64Data: string, filename: string) => void;
  sendResize: (cols: number, rows: number) => void;
  claimControl: () => void;
  releaseControl: () => void;
  startScreen: (fps: number, quality: number, scale: number) => void;
  stopScreen: () => void;
  sendScreenSignal: (
    type: "screen.answer" | "screen.ice",
    payload: any,
  ) => void;
  reconnect: () => void;
  disconnect: () => void;
  requestHistory: (count?: number) => void;
  historyEntries: string[];
}
