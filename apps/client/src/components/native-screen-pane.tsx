import type { ReactNode } from "react";
import { NativeScreen, type ScreenState } from "../../modules/link-screen";

/** The host's existing viewer owns every control; only the video surface is native. */
export function NativeScreenPane({ url, active = true, onState, onUnavailable, children }: {
  url: string;
  active?: boolean;
  onState?: (state: ScreenState) => void;
  onUnavailable: () => void;
  children: ReactNode;
}) {
  return <NativeScreen url={url} active={active} maxFps={120} onState={(state) => {
    onState?.(state);
    if (active && state.state === "failed") onUnavailable();
  }} style={{ flex: 1 }}>{children}</NativeScreen>;
}
