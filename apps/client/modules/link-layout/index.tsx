import { requireNativeView, requireOptionalNativeModule } from "expo";
import { Platform, type NativeSyntheticEvent, type ViewProps } from "react-native";

export interface DivisionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  active: boolean;
}

export interface LayoutMetrics {
  revision?: string;
  width: number;
  height: number;
  insets: { top: number; right: number; bottom: number; left: number };
  divisions: DivisionRegion[];
  occlusions: DivisionRegion[];
}

interface Props extends ViewProps {
  revision: string;
  onMetrics: (event: NativeSyntheticEvent<LayoutMetrics>) => void;
}

const nativeLayout = requireOptionalNativeModule<{
  requestLandscape?: () => Promise<void>;
  clearOrientationRequest?: () => Promise<void>;
}>("LinkLayout");
const NativeProbe = Platform.OS === "ios" && nativeLayout ? requireNativeView<Props>("LinkLayout") : null;

/** Enter wide once; subsequent physical rotations remain available. */
export function requestLandscape(): Promise<void> {
  return nativeLayout?.requestLandscape?.() ?? Promise.resolve();
}

export function clearOrientationRequest(): Promise<void> {
  return nativeLayout?.clearOrientationRequest?.() ?? Promise.resolve();
}

export function LayoutProbe({ onMetrics, revision = "" }: { onMetrics: (metrics: LayoutMetrics) => void; revision?: string }) {
  return NativeProbe ? <NativeProbe revision={revision} pointerEvents="none" style={{ position: "absolute", inset: 0 }} onMetrics={(event) => onMetrics(event.nativeEvent)} /> : null;
}
