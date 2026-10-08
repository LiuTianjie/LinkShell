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

const NativeProbe = Platform.OS === "ios" && requireOptionalNativeModule("LinkLayout") ? requireNativeView<Props>("LinkLayout") : null;

export function LayoutProbe({ onMetrics, revision = "" }: { onMetrics: (metrics: LayoutMetrics) => void; revision?: string }) {
  return NativeProbe ? <NativeProbe revision={revision} pointerEvents="none" style={{ position: "absolute", inset: 0 }} onMetrics={(event) => onMetrics(event.nativeEvent)} /> : null;
}
