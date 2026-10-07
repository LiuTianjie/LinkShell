import { createContext, use } from "react";
import { useAppWindowDimensions as useWindowDimensions } from "@/lib/window-dimensions";

export const ContentHeight = createContext<number | null>(null);

/** A floating composer must fit its local pane, including a sheet's detent. */
export function useContentHeight() {
  const pane = use(ContentHeight);
  const window = useWindowDimensions();
  return pane ?? window.height;
}
