import type { ReactNode } from "react";
import { NativeScreen } from "../../modules/link-screen";

/** The host's existing viewer owns every control; only the video surface is native. */
export function NativeScreenPane({ url, onUnavailable, children }: {
  url: string;
  onUnavailable: () => void;
  children: ReactNode;
}) {
  return <NativeScreen url={url} maxFps={120} onState={(state) => {
    if (state.state === "failed") onUnavailable();
  }} style={{ flex: 1 }}>{children}</NativeScreen>;
}
