import type { HostLink, HostStreams } from "@linkshell/client-core";
import type {
  ScreenCodecChoice,
  ScreenFpsChoice,
  ScreenPacingChoice,
  ScreenWidthChoice,
} from "../../core/screen-client";

export type ScreenTransportMode = "auto" | "compat";

export interface ScreenDisplayInfo {
  index: number;
  name: string;
}

export interface RemoteTelemetrySnapshot {
  engine: "metal" | "webrtc" | "compat";
  path?: "direct" | "lan" | "relay" | "socket";
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  bitrateMbps?: number;
  rttMs?: number;
  hardware?: boolean;
  displayFps?: number;
}

export interface RemoteStageStatus {
  phase: "connecting" | "retrying" | "live" | "paused" | "error";
  live: boolean;
  displays: ScreenDisplayInfo[];
  controlling: boolean;
  controlRequested: boolean;
  canControl: boolean;
  taken?: boolean;
  idle?: boolean;
  error?: string;
  notice?: string;
  telemetry: RemoteTelemetrySnapshot;
}

export interface SharedStageProps {
  link: HostLink;
  streams: HostStreams;
  active: boolean;
  fullscreen: boolean;
  display: number;
  widthChoice: ScreenWidthChoice;
  fpsChoice: ScreenFpsChoice;
  codecChoice: ScreenCodecChoice;
  pacingChoice: ScreenPacingChoice;
  transportMode: ScreenTransportMode;
  controlWanted: boolean;
  remotePlatform?: string;
  revision: number;
  onDisplayChange: (display: number) => void;
  onExitFullScreen: () => void;
  onStatusChange: (status: RemoteStageStatus) => void;
  onFallback?: (reason: string) => void;
}
