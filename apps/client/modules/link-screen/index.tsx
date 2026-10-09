import { requireNativeView, requireOptionalNativeModule } from "expo";
import { forwardRef, useImperativeHandle, useRef } from "react";
import { Platform, type NativeSyntheticEvent, type ViewProps } from "react-native";

export interface ScreenState {
  state: "connecting" | "ready" | "failed" | "control";
  message?: string;
  trusted?: boolean;
  maxFps?: number;
  width?: number;
  height?: number;
}

export interface ScreenMetrics {
  decodedFps?: number;
  presentedFps?: number;
  requestedFps?: number;
  decodeP95Ms?: number;
  decodeToPresentP95Ms?: number;
  rttMs?: number;
  replacedFrames?: number;
  presentationSamples?: number;
  decodeSamples?: number;
  sampleEvery?: number;
  width?: number;
  height?: number;
  sender?: { encodeMs?: number; sendDelayMs?: number; frameRate?: number };
}

export interface NativeScreenHandle {
  fit(): Promise<void>;
  sendText(text: string): Promise<void>;
  sendKey(key: string, modifiers: string[]): Promise<void>;
  requestPermission(): Promise<void>;
}

interface Props extends ViewProps {
  url: string;
  mode: "view" | "trackpad" | "touch";
  diagnostics: boolean;
  onState: (state: ScreenState) => void;
  onMetrics: (metrics: ScreenMetrics) => void;
}

interface NativeProps extends Omit<Props, "onState" | "onMetrics"> {
  ref?: React.Ref<NativeScreenHandle>;
  onState: (event: NativeSyntheticEvent<ScreenState>) => void;
  onMetrics: (event: NativeSyntheticEvent<ScreenMetrics>) => void;
}

export const nativeScreenAvailable = Platform.OS === "ios" && !!requireOptionalNativeModule("LinkScreen");
const ScreenView = nativeScreenAvailable ? requireNativeView<NativeProps>("LinkScreen") : null;

export const NativeScreen = forwardRef<NativeScreenHandle, Props>(function NativeScreen({ onState, onMetrics, ...props }, ref) {
  const view = useRef<NativeScreenHandle>(null);
  useImperativeHandle(ref, () => ({
    fit: async () => { await view.current?.fit(); },
    sendText: async (text) => { await view.current?.sendText(text); },
    sendKey: async (key, modifiers) => { await view.current?.sendKey(key, modifiers); },
    requestPermission: async () => { await view.current?.requestPermission(); },
  }), []);
  return ScreenView ? <ScreenView {...props} ref={view} onState={(event) => onState(event.nativeEvent)} onMetrics={(event) => onMetrics(event.nativeEvent)} /> : null;
});
