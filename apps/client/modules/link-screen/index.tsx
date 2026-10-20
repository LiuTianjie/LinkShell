import { requireNativeView, requireOptionalNativeModule } from "expo";
import { Platform, type NativeSyntheticEvent, type ViewProps } from "react-native";

export interface ScreenState {
  state: "connecting" | "ready" | "failed";
  message?: string;
  maxFps?: number;
  width?: number;
  height?: number;
}

interface Props extends ViewProps {
  url: string;
  maxFps: 60 | 120;
  active?: boolean;
  onState: (state: ScreenState) => void;
}

interface NativeProps extends Omit<Props, "onState"> {
  onState: (event: NativeSyntheticEvent<ScreenState>) => void;
}

export const nativeScreenAvailable = Platform.OS === "ios" && !!requireOptionalNativeModule("LinkScreen");
const ScreenView = nativeScreenAvailable ? requireNativeView<NativeProps>("LinkScreen") : null;

export function NativeScreen({ onState, active = true, ...props }: Props) {
  return ScreenView ? <ScreenView {...props} active={active} onState={(event) => onState(event.nativeEvent)} /> : null;
}
